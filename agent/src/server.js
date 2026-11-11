// The tool set, shared by the stdio entry (Claude desktop app) and the HTTP entry (claude.ai connector).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { addServer, updateServer, removeServer, DATA_DIR } from "./inventory.js";
import { stats, runInDir, exec, quote, dropConnections } from "./ssh.js";
import * as live from "./live.js";
import * as hostKeys from "./hostkeys.js";
import { buildOverview } from "./overview.js";
import { registerProviders } from "./cloud.js";
import { audited } from "./audit.js";
import { createDiscovery } from "./discovery.js";
import { createBootstrapper } from "./bootstrap.js";
import { KEY_PATH, publicKey } from "./keys.js";
import { instructionsFor } from "./instructions.js";
import * as aws from "../../providers/aws/index.js";
import * as netcup from "../../providers/netcup/index.js";
import * as gcp from "../../providers/gcp/index.js";
import * as aliyun from "../../providers/aliyun/index.js";
import { createScp, serverStateRequest, protectedIps as netcupProtectedIps } from "../../providers/netcup/admin.js";

// structuredContent must be a JSON object, so lists (SSH keys, snapshots, tasks) are wrapped as {items}.
// Orrery's own connector token must never come back in a result, whatever printed it: cloudflared
// logs the connector URL when the agent is unreachable, and a command can read the token file.
const hidden = new Set();
export const hideFromResults = (value) => value && hidden.add(String(value));
const scrub = (text) => {
  for (const secret of hidden) text = text.split(secret).join("[connector token]");
  return text;
};
const ok = (data) => {
  const raw = JSON.stringify(data) ?? "null";
  const text = scrub(raw);
  const value = text === raw ? data : JSON.parse(text);
  const structured = value && typeof value === "object" && !Array.isArray(value) ? value : { items: value };
  return { content: [{ type: "text", text }], structuredContent: structured };
};
const fail = (err) => ({ isError: true, content: [{ type: "text", text: scrub(err?.message || String(err)) }] });
const tool = (fn) => async (args) => {
  try {
    return ok(await fn(args ?? {}));
  } catch (err) {
    return fail(err);
  }
};

const READ = { readOnlyHint: true, openWorldHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: false };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true };

// ORRERY_ALLOW_EXEC=0 leaves out the tools that change a server (shell commands, container
// start/stop/restart). The inventory tools (add_server, update_server, labels) stay: the local
// dashboard uses them, so a leaked connector URL can still change the saved server list.
export const ALLOW_EXEC = process.env.ORRERY_ALLOW_EXEC !== "0";

const CONTAINER = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/, "container name or id");
// orrery-host marks the machine no tool may stop; only discovery hands it out.
const notHostTag = (t) => t.trim().toLowerCase() !== "orrery-host";
const RESERVED_TAG = "orrery-host marks the Orrery host and cannot be given by hand";

async function docker(srv, args, timeoutSec = 30) {
  const cmd = `if docker info >/dev/null 2>&1; then docker ${args}; else sudo -n docker ${args}; fi`;
  return exec(srv, `sh -c ${quote(cmd)} 2>&1`, { timeoutSec });
}

// ORRERY_ROLE=admin is the connector deployed for claude.ai ("Orrery"): cloud provider tools
// including the ones that start, stop, reinstall or delete machines, plus the SSH tools with command
// execution, and onboarding of discovered servers. Every change goes to the audit log.
// The default role ("hub") is a local desktop agent: SSH tools and read-only cloud views. The deployed dashboard talks to the admin role.
export const ROLE = process.env.ORRERY_ROLE === "admin" ? "admin" : "hub";

// Discovery, onboarding jobs and the login-failure backoff live as long as the process, across the
// stateless HTTP requests.
const AUTH_BACKOFF_MS = 10 * 60 * 1000;
let shared = null;
function sharedState() {
  if (shared) return shared;
  // A server that rejects our login is not tried again for 10 minutes, so the dashboard's polling of
  // machines that are not onboarded yet cannot trip fail2ban or similar on them.
  const authFailures = new Map(); // id -> { at, message }
  const discovery = createDiscovery();
  const remember = discovery.remember;
  discovery.remember = (id, patch) => {
    authFailures.delete(id);
    remember(id, patch);
  };
  // Credentials are read when an onboarding needs them, so added or rotated keys work without a restart.
  const netcupConfig = () => {
    const c = netcup.loadConfig(process.env, DATA_DIR);
    if (!c.configured) throw new Error(c.error || "netcup credentials are missing");
    return c;
  };
  const bootstrapper = createBootstrapper({
    exec,
    publicKey: () => publicKey(),
    keyPath: KEY_PATH,
    discovery,
    selfIp: discovery.selfIp,
    protectedIps: netcupProtectedIps(process.env),
    allowRescue: process.env.ORRERY_NETCUP_RESCUE === "1",
    get aws() {
      return { config: aws.loadConfig(process.env, DATA_DIR), sendSshPublicKey: aws.sendSshPublicKey, lightsailAccess: aws.lightsailAccess };
    },
    get netcup() {
      return netcup.loadConfig(process.env, DATA_DIR).configured ? { scp: createScp(netcupConfig), toServer: netcup.toServer, serverStateRequest } : null;
    },
    get gcp() {
      const c = gcp.loadConfig(process.env, DATA_DIR);
      return c.configured ? { addSshKey: (t) => gcp.addSshKey(gcp.createApi(c), t) } : null;
    },
    get aliyun() {
      const c = aliyun.loadConfig(process.env, DATA_DIR);
      return c.configured ? { runShell: (t) => aliyun.runShell(aliyun.createApi(c), t) } : null;
    },
    log: (m) => console.error(m),
  });
  return (shared = { discovery, bootstrapper, authFailures });
}

export function createServer(role = ROLE) {
  return role === "admin" ? createAdminServer() : createHubServer();
}

function registerCloudProviders(server, providers, role) {
  server.registerTool(
    "cloud_providers",
    {
      title: "Cloud providers",
      description: "Which cloud providers (AWS, netcup, Linode, Google Cloud, Alibaba Cloud, Vultr, DigitalOcean, Kamatera) this agent has credentials for, and the tools each one offers.",
      annotations: { readOnlyHint: true },
    },
    tool(async () => ({ role, providers })),
  );
}

function createAdminServer() {
  const server = new McpServer({ name: "orrery", version: "0.5.0" }, { instructions: instructionsFor("admin") });
  const adminTool = (name, fn) => tool(audited(name, fn));
  registerCloudProviders(server, registerProviders(server, { z, tool, adminTool, READ, WRITE, DESTRUCTIVE, admin: true }), "admin");
  registerSshTools(server, { allowExec: true, change: adminTool, onboarding: true });
  registerOnboarding(server, adminTool);
  return server;
}

function createHubServer() {
  const server = new McpServer({ name: "orrery-local", version: "0.5.0" }, { instructions: instructionsFor("hub") });
  registerSshTools(server, { allowExec: ALLOW_EXEC, change: (name, fn) => tool(fn) });
  // Cloud provider views. This connector only gets their read tools, whatever ORRERY_ALLOW_EXEC
  // says; starting, stopping or deleting machines is only on the admin connector.
  registerCloudProviders(server, registerProviders(server, { z, tool, READ }), "hub");
  return server;
}

// Monitoring and shell access over SSH. `change(name, fn)` wraps tools that change something
// (audited on the admin connector).
function registerSshTools(server, { allowExec, change, onboarding = false }) {
  const { discovery, authFailures } = sharedState();
  const resolve = (id) => discovery.resolve(id);
  let overview = null; // the fleet_overview being built, if any
  // server_stats and the live sampler share the login backoff, so live figures cannot hammer a host that refuses us.
  async function probe(id, run) {
    const server = await resolve(id);
    const failed = authFailures.get(id);
    if (failed && Date.now() - failed.at < AUTH_BACKOFF_MS) throw new Error(failed.message);
    try {
      const r = await run(server);
      authFailures.delete(id);
      return r;
    } catch (e) {
      if (/authentication methods failed/i.test(e.message)) {
        authFailures.set(id, { at: Date.now(), message: `${e.message} (not retried for 10 minutes; onboarding the server or fixing its login resumes at once)` });
      }
      throw e;
    }
  }

  server.registerTool(
    "list_servers",
    {
      title: "List servers",
      description:
        "Every server Orrery can monitor: saved ones, hosts from ~/.ssh/config, and every netcup server, AWS EC2/Lightsail instance, Linode, Google Cloud, Alibaba Cloud and Vultr instance, DigitalOcean Droplet and Kamatera server discovered automatically (source netcup/aws/linode/gcp/aliyun/vultr/digitalocean/kamatera). " + (onboarding ? "Discovered servers need ssh_bootstrap once before server_stats works." : "A discovered server must trust this agent's SSH key (keys/id_ed25519.pub in the data directory, ~/.orrery by default) before server_stats works.") + " Passwords are never returned.",
      annotations: { readOnlyHint: true },
    },
    tool(async () => {
      const { servers, ignored, errors } = await discovery.list();
      return { servers, ignored, exec: allowExec, discoveryErrors: errors };
    }),
  );

  server.registerTool(
    "label_server",
    {
      title: "Label a server",
      description:
        "Give any server (saved or discovered) a display name that replaces the provider's name, role tags such as prod or shared shown on the dashboard, and a short note. An empty string or empty list removes that field. Nothing changes on the machine.",
      inputSchema: {
        id: z.string(),
        label: z.string().max(64).optional(),
        tags: z.array(z.string().min(1).max(24).refine(notHostTag, RESERVED_TAG)).max(8).optional(),
        note: z.string().max(200).optional(),
      },
      annotations: WRITE,
    },
    change("label_server", async ({ id, ...patch }) => {
      await resolve(id); // the id must exist
      const label = discovery.setLabel(id, patch);
      return { id, ...label };
    }),
  );

  server.registerTool(
    "ignore_server",
    {
      title: "Ignore a discovered server",
      description:
        "Hide a discovered netcup/AWS/Linode/Google Cloud/Alibaba Cloud/Vultr/DigitalOcean/Kamatera server from list_servers and the dashboard (ignored=true), or bring it back (ignored=false). Nothing changes on the machine. New machines still appear automatically.",
      inputSchema: { id: z.string().regex(/^(netcup|ec2|lightsail|linode|gcp|aliyun|vultr|digitalocean|kamatera):/, "id of a discovered server (netcup:…, ec2:…, lightsail:…, linode:…, gcp:…, aliyun:…, vultr:…, digitalocean:…, kamatera:…)"), ignored: z.boolean() },
      annotations: WRITE,
    },
    change("ignore_server", async ({ id, ignored }) => {
      const s = await discovery.ignore(id, ignored);
      return { id, name: s.name, host: s.host, ignored };
    }),
  );

  server.registerTool(
    "add_server",
    {
      title: "Add server",
      description:
        "Save a server that is not discovered automatically, or override a discovered one (same IP) with another user, key or port. Login: the password if given, then the key at keyPath (or, without keyPath, Orrery's own key and the default ~/.ssh keys), then ssh-agent if one is running.",
      inputSchema: {
        name: z.string().min(1).max(64),
        host: z.string().min(1),
        port: z.number().int().min(1).max(65535).optional(),
        username: z.string().min(1),
        keyPath: z.string().optional(),
        password: z.string().optional(),
        tags: z.array(z.string().refine(notHostTag, RESERVED_TAG)).optional(),
      },
      annotations: WRITE,
    },
    change("add_server", async (a) => {
      // A saved server replaces a listed one with the same address. It is the same machine, so it keeps
      // the pinned host keys instead of trusting whatever answers next.
      const covered = (await discovery.list()).servers.filter((s) => String(s.host).toLowerCase() === a.host.trim().toLowerCase());
      const pins = [...new Set(covered.flatMap((s) => hostKeys.pinned(s.id)))];
      const saved = addServer(a);
      if (pins.length) hostKeys.pin(saved.id, pins);
      authFailures.clear();
      return saved;
    }),
  );

  server.registerTool(
    "update_server",
    {
      title: "Update server",
      description: "Change fields of a saved server. Pass an empty string to clear keyPath or password.",
      inputSchema: {
        id: z.string(),
        name: z.string().min(1).max(64).optional(),
        host: z.string().min(1).optional(),
        port: z.number().int().min(1).max(65535).optional(),
        username: z.string().min(1).optional(),
        keyPath: z.string().optional(),
        password: z.string().optional(),
        tags: z.array(z.string().refine(notHostTag, RESERVED_TAG)).optional(),
      },
      annotations: WRITE,
    },
    change("update_server", async ({ id, ...patch }) => {
      authFailures.clear();
      const saved = updateServer(id, patch);
      dropConnections(id); // a new address or login must not keep using the old connection
      live.forget(id);
      // The pinned host key stays: if the new address is another machine, the next connection is
      // refused and accept_host_key decides.
      return saved;
    }),
  );

  server.registerTool(
    "remove_server",
    {
      title: "Remove server",
      description: "Delete a saved server from the inventory (does not touch the machine; discovered servers come back on their own).",
      inputSchema: { id: z.string() },
      annotations: DESTRUCTIVE,
    },
    change("remove_server", async ({ id }) => {
      const r = removeServer(id);
      dropConnections(id);
      live.forget(id);
      hostKeys.forget(id);
      return r;
    }),
  );

  server.registerTool(
    "accept_host_key",
    {
      title: "Accept a server's new SSH host key",
      description:
        "Orrery pins each server's SSH host key on the first connection and refuses to connect when the key changes. After a server was reinstalled or replaced, accept the new key here: fingerprint is the one in the refusal message (SHA256:...). Do this only when the user confirms the change is expected; an unexpected change can mean something else is answering at the server's address.",
      inputSchema: { id: z.string(), fingerprint: z.string().regex(hostKeys.FINGERPRINT, "SHA256:... as shown in the refusal message") },
      annotations: DESTRUCTIVE,
    },
    change("accept_host_key", async ({ id, fingerprint }) => {
      const s = await resolve(id);
      if (!hostKeys.wasRefused(id, fingerprint)) {
        throw new Error(`Orrery has not refused that key for ${s.name || id} in the last hour. Connect to the server first (server_stats): the refusal names the fingerprint that can be accepted.`);
      }
      hostKeys.pin(id, [fingerprint]);
      dropConnections(id);
      live.forget(id);
      authFailures.delete(id);
      return { id, name: s.name, host: s.host, fingerprint };
    }),
  );

  server.registerTool(
    "server_stats",
    {
      title: "Server stats",
      description:
        "One SSH round trip: OS, CPU %, load, memory, swap, disks, network totals, uptime, login banner, and Docker containers with CPU/memory. hostKeys are the fingerprints of the SSH host key pinned for the server.",
      inputSchema: { id: z.string() },
      annotations: READ,
    },
    tool(async ({ id }) => ({ ...(await probe(id, stats)), hostKeys: hostKeys.pinned(id) })),
  );

  server.registerTool(
    "fleet_overview",
    {
      title: "Fleet overview",
      description:
        "A ready-made status board of every server, in one call: state, CPU, memory, disk, load, containers, uptime and what needs attention, as a Markdown table. Use it when the user asks how their servers are doing, and as the dashboard where you cannot publish claude.ai Artifacts. Show the table as it is.",
      annotations: READ,
    },
    async () => {
      try {
        // Callers that ask at the same time share one round of probes.
        overview ||= discovery
          .list()
          .then(({ servers, errors }) => buildOverview({ servers, errors, probe: (s) => probe(s.id, stats) }))
          .finally(() => (overview = null));
        return { content: [{ type: "text", text: scrub(await overview) }] };
      } catch (err) {
        return fail(err);
      }
    },
  );
  // The same board as a prompt, which clients show as a command.
  server.registerPrompt(
    "overview",
    { title: "Fleet overview", description: "The status of every server, as one table" },
    () => ({ messages: [{ role: "user", content: { type: "text", text: "Call fleet_overview and show me its table as it is. Then say in a sentence or two what needs attention, if anything." } }] }),
  );

  server.registerTool(
    "server_pulse",
    {
      title: "Server pulse",
      description:
        "Live figures for the dashboard, one sample a second: CPU %, load, memory, swap and network rates (bytes/s). The first call on a server starts a light SSH sampler there (it stops two minutes after the last call), so the first answer may have no samples yet; later calls answer at once from memory. Give ids for several servers in one call; samples is how many of the latest to return (default 10, at most 120).",
      inputSchema: {
        id: z.string().optional(),
        ids: z.array(z.string()).max(50).optional(),
        samples: z.number().int().min(1).max(120).optional(),
      },
      annotations: READ,
    },
    tool(async ({ id, ids, samples = 10 }) => {
      const list = [...new Set(ids?.length ? ids : id ? [id] : [])];
      const servers = {};
      await Promise.all(
        list.map(async (sid) => {
          try {
            const target = await resolve(sid);
            const failed = authFailures.get(sid);
            if (failed && Date.now() - failed.at < AUTH_BACKOFF_MS) throw new Error(failed.message);
            servers[sid] = live.read(target, {
              count: samples,
              onAuthFailure: (e) => authFailures.set(sid, { at: Date.now(), message: `${e.message} (not retried for 10 minutes; onboarding the server or fixing its login resumes at once)` }),
            });
          } catch (e) {
            servers[sid] = { latest: null, samples: [], error: e.message, running: false };
          }
        }),
      );
      // A caller that asked for one id also gets its latest sample at the top level.
      if (id && !ids?.length) return { serverId: id, ...(servers[id].latest || {}), ...servers[id] };
      return { collectedAt: new Date().toISOString(), servers };
    }),
  );

  if (allowExec) server.registerTool(
    "run_command",
    {
      title: "Run command",
      description:
        "Run a shell command on the server (non-interactive, no TTY) in `cwd`. Returns combined output, exit code and the directory the command ended in.",
      inputSchema: {
        id: z.string(),
        command: z.string().min(1).max(8000),
        cwd: z.string().optional(),
        timeoutSec: z.number().int().min(1).max(300).optional(),
      },
      annotations: DESTRUCTIVE,
    },
    change("run_command", async ({ id, command, cwd, timeoutSec = 60 }) => runInDir(await resolve(id), command, cwd, timeoutSec)),
  );

  server.registerTool(
    "container_logs",
    {
      title: "Container logs",
      description: "Last N lines of a Docker container's logs.",
      inputSchema: { id: z.string(), container: CONTAINER, tail: z.number().int().min(1).max(2000).optional() },
      annotations: READ,
    },
    tool(async ({ id, container, tail = 200 }) => {
      const res = await docker(await resolve(id), `logs --tail ${tail} --timestamps ${container}`);
      return { container, output: res.stdout, exitCode: res.code, truncated: res.truncated };
    }),
  );

  if (allowExec) server.registerTool(
    "container_action",
    {
      title: "Container action",
      description: "Start, stop or restart a Docker container.",
      inputSchema: { id: z.string(), container: CONTAINER, action: z.enum(["start", "stop", "restart"]) },
      annotations: DESTRUCTIVE,
    },
    change("container_action", async ({ id, container, action }) => {
      const res = await docker(await resolve(id), `${action} ${container}`, 90);
      if (res.code !== 0) throw new Error(res.stdout.trim() || `docker ${action} failed (exit ${res.code})`);
      return { container, action, done: true };
    }),
  );
}

// Making a discovered server trust the agent's key, once.
function registerOnboarding(server, adminTool) {
  const { discovery, bootstrapper } = sharedState();

  server.registerTool(
    "ssh_public_key",
    {
      title: "Agent SSH public key",
      description:
        "The public key every monitored server must trust. When creating a server, install it up front: netcup reinstall with this key registered in the SCP account, EC2 RunInstances / Lightsail CreateInstances with it imported as a key pair, or a cloud-init authorized_keys line. Then no ssh_bootstrap is needed.",
      annotations: { readOnlyHint: true },
    },
    tool(async () => ({ publicKey: publicKey() })),
  );

  server.registerTool(
    "ssh_bootstrap",
    {
      title: "Onboard a discovered server",
      description:
        `Make a discovered server trust Orrery's SSH key so it can be monitored. Automatic, without a restart: EC2 (EC2 Instance Connect), Lightsail (its temporary SSH login), Google Cloud (ssh-keys metadata for user ${gcp.SSH_USER}; refused under OS Login) and Alibaba Cloud (Cloud Assistant). netcup, Linode, Vultr, DigitalOcean and Kamatera have no automatic path: the job fails with one command for the user to paste as root in the provider's web console, and a second ssh_bootstrap confirms the login. Runs in the background: returns a job to follow with ssh_bootstrap_status. Does nothing if the key already works. A machine created with ssh_public_key already installed needs none of this.`,
      inputSchema: { id: z.string().describe("Server id from list_servers (netcup:…, ec2:…, lightsail:…, linode:…, gcp:…, aliyun:…, vultr:…, digitalocean:…, kamatera:…)") },
      annotations: DESTRUCTIVE,
    },
    adminTool("ssh_bootstrap", async ({ id }) => bootstrapper.start(await discovery.resolve(id))),
  );

  server.registerTool(
    "ssh_bootstrap_status",
    {
      title: "Onboarding progress",
      description: "Progress of ssh_bootstrap jobs (all recent ones, or one by jobId).",
      inputSchema: { jobId: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    tool(async ({ jobId }) => ({ jobs: bootstrapper.status(jobId) })),
  );
}
