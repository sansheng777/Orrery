// netcup control tools for the admin agent (ORRERY_ROLE=admin): power, rename, snapshots, rescue
// system, reinstall, rDNS, tasks, and any other SCP REST API endpoint. Only the admin agent registers
// these; the dashboard's agent keeps the GET-only tools in index.js. Endpoints follow netcup's OpenAPI
// spec (https://www.servercontrolpanel.de/scp-core/api/v1/openapi), which is also checked at run time.
import net from "node:net";
import { API, SCP, accessToken, toServer } from "./index.js";
import { protectedIps } from "../shared.js";

// Built lazily: index.js imports this module, so its constants are not set yet at load time.
const userinfoUrl = () => `${SCP}/realms/scp/protocol/openid-connect/userinfo`;
const TIMEOUT_MS = 30000;
const SPEC_TTL_MS = 3600 * 1000;
export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

// Kept per credentials (keyed like the token sessions in index.js) and shared by every request the agent
// serves: the HTTP connector builds the tools, and so createScp, for each request.
const specCache = new Map(); // config.file ?? refresh token -> { at, version, endpoints }
const userIdCache = new Map(); // config.file ?? refresh token -> SCP user id
const cacheKey = (config) => config.file ?? config.refreshToken;

export class ScpError extends Error {
  constructor(status, body, method, pathAndQuery) {
    let msg = typeof body === "string" ? body.slice(0, 500) : body?.message || body?.code || "";
    const fields = Array.isArray(body?.errors) ? body.errors.map((e) => `${e.field}: ${e.message}`).join("; ") : "";
    if (fields) msg += ` (${fields})`;
    super(`netcup ${method} ${pathAndQuery} failed with ${status}${msg ? ": " + msg : ""}`);
    this.status = status;
  }
}

// `getConfig` re-reads the credentials on each call, so a refresh token rotated elsewhere is picked up.
export function createScp(getConfig, fetchImpl = fetch, env = process.env) {
  async function request(method, pathAndQuery, { body, contentType = "application/json" } = {}) {
    if (!METHODS.includes(method)) throw new Error(`Unsupported method ${method}`);
    if (!/^\/api\/v1\/[\w\-./:%?=&,]*$/.test(pathAndQuery) || pathAndQuery.includes("..")) throw new Error(`Invalid SCP path: ${pathAndQuery}`);
    const config = getConfig();
    for (let attempt = 0; ; attempt++) {
      const token = await accessToken(config, fetchImpl, attempt > 0);
      const headers = { authorization: `Bearer ${token}`, accept: "application/json" };
      // netcup rejects a POST/PUT/PATCH without a Content-Type (400 "must be 'type/subtype'"), even
      // for actions that take no input, such as turning the rescue system on: send an empty object.
      // A GET carries no body.
      const sendsBody = method !== "GET" && (body !== undefined || ["POST", "PUT", "PATCH"].includes(method));
      if (sendsBody) headers["content-type"] = contentType;
      const res = await fetchImpl(API + pathAndQuery, {
        method,
        headers,
        body: sendsBody ? JSON.stringify(body ?? {}) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 401 && attempt === 0) continue;
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {}
      if (!res.ok) throw new ScpError(res.status, json ?? text, method, pathAndQuery);
      return { status: res.status, body: json ?? (text || null) };
    }
  }

  // Endpoints under /users/{userId} need the SCP user id (not the customer number).
  async function getUserId() {
    if (env.NETCUP_USER_ID) return String(env.NETCUP_USER_ID);
    const key = cacheKey(getConfig());
    if (userIdCache.has(key)) return userIdCache.get(key);
    const found = (id) => (userIdCache.set(key, String(id)), String(id));
    try {
      const token = await accessToken(getConfig(), fetchImpl);
      const res = await fetchImpl(userinfoUrl(), { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      const info = res.ok ? await res.json() : {};
      if (/^\d+$/.test(String(info.id ?? ""))) return found(info.id);
    } catch {}
    // Fallback: every task records the user who started it.
    const { body } = await request("GET", "/api/v1/tasks?limit=1&offset=0");
    const id = Array.isArray(body) ? body[0]?.executingUser?.id : null;
    if (id) return found(id);
    throw new Error("Could not determine the SCP user id. Set NETCUP_USER_ID to your SCP user id.");
  }

  async function getSpec() {
    const key = cacheKey(getConfig());
    const hit = specCache.get(key);
    if (hit && Date.now() - hit.at < SPEC_TTL_MS) return hit;
    const { body } = await request("GET", "/api/v1/openapi");
    if (!body?.paths) throw new Error("Could not load netcup's OpenAPI spec");
    const spec = { at: Date.now(), version: body.info?.version || null, endpoints: endpointsOf(body) };
    specCache.set(key, spec);
    return spec;
  }

  return { request, getUserId, getSpec };
}

// [{method, path, summary, re, merge}] for every operation in an OpenAPI document.
export function endpointsOf(doc) {
  const out = [];
  for (const [p, ops] of Object.entries(doc.paths || {})) {
    for (const [m, op] of Object.entries(ops)) {
      const method = m.toUpperCase();
      if (!METHODS.includes(method)) continue;
      const re = new RegExp("^" + p.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{[^}]+\}/g, "[^/?#]+") + "$");
      const content = op.requestBody?.content || {};
      out.push({ method, path: p, summary: op.summary || "", re, merge: !!content["application/merge-patch+json"] && !content["application/json"] });
    }
  }
  return out;
}

// The documented operation for a concrete request path such as /api/v1/servers/42/snapshots.
export const matchEndpoint = (endpoints, method, concretePath) => endpoints.find((e) => e.method === method && e.re.test(concretePath.split("?")[0])) || null;

export function serverStateRequest(state, option) {
  const allowed = { ON: ["POWERCYCLE", "RESET"], OFF: ["POWEROFF"], SUSPENDED: [] };
  if (!(state in allowed)) throw new Error("state must be ON, OFF or SUSPENDED");
  if (option && !allowed[state].includes(option)) throw new Error(`option ${option} is not valid with state ${state} (allowed: ${allowed[state].join(", ") || "none"})`);
  return { query: option ? `?stateOption=${option}` : "", body: { state } };
}

// The caller has to name the server before an irreversible operation.
export async function assertServerName(scp, serverId, confirm) {
  const { body } = await scp.request("GET", `/api/v1/servers/${Number(serverId)}?loadServerLiveInfo=false`);
  const s = toServer(body);
  const names = [s.name, s.nickname, s.hostname].filter(Boolean);
  if (!names.includes(String(confirm || "").trim())) {
    throw new Error(`Refusing: confirmServerName must be one of ${names.map((n) => `"${n}"`).join(", ")} for server ${serverId}.`);
  }
  return s;
}

export { protectedIps };

const NO_SELF_IP =
  "Refusing: the Orrery host is not known, so no netcup server is stopped, restarted, rescued, reinstalled, reverted or reconfigured from a chat. Set ORRERY_SELF_IP (deploy/enable-ssh.sh).";

// The Orrery host is recognized by its IPv4 address; any other ORRERY_SELF_IP counts as unset.
function selfIpRefusal(selfIp) {
  if (!selfIp) return NO_SELF_IP;
  if (!net.isIPv4(selfIp)) {
    return `Refusing: ORRERY_SELF_IP (${selfIp}) is not an IPv4 address, so the Orrery host cannot be recognized among the netcup servers and it counts as unset: no netcup server is stopped, restarted, rescued, reinstalled, reverted or reconfigured from a chat. Set ORRERY_SELF_IP to the Orrery host's public IPv4 address (deploy/enable-ssh.sh).`;
  }
  return null;
}

// The first protected entry a server carries: an IPv4 address exactly, an IPv6 address (or prefix,
// without its length) inside one of the server's IPv6 prefixes.
export function protectedIpOf(s, ips) {
  const v4 = s.ipv4.find((a) => ips.includes(a));
  if (v4) return v4;
  for (const entry of ips) {
    const ip = entry.split("/")[0];
    if (!net.isIPv6(ip)) continue;
    for (const prefix of s.ipv6) {
      const [base, len] = prefix.split("/");
      if (!net.isIPv6(base)) continue;
      const block = new net.BlockList();
      block.addSubnet(base, Number(len ?? 64), "ipv6");
      if (block.check(ip, "ipv6")) return entry;
    }
  }
  return null;
}

// The Orrery host runs this connector: stopping, restarting, rescuing, reinstalling or reverting it
// would cut the assistant off mid-call with no way back from a chat. Those are refused for it (selfIp is
// ORRERY_SELF_IP, set by deploy/enable-ssh.sh) and for the other protected IPs, and left to
// the SCP website. Without ORRERY_SELF_IP no server is known to be safe, so all are refused.
export async function assertNotSelf(scp, serverId, selfIp, otherIps = []) {
  const refusal = selfIpRefusal(selfIp);
  if (refusal) throw new Error(refusal);
  const { body } = await scp.request("GET", `/api/v1/servers/${Number(serverId)}?loadServerLiveInfo=false`);
  const s = toServer(body);
  if (s.ipv4.includes(selfIp)) {
    throw new Error(`Refusing: server ${serverId} (${s.name}) is the Orrery host that runs this connector. Stopping, restarting, rescuing, reinstalling, reverting or reconfiguring it would cut the assistant off; do that in the netcup SCP website.`);
  }
  const ip = protectedIpOf(s, otherIps);
  if (ip) throw new Error(`Refusing: server ${serverId} (${s.name}) has the protected IP ${ip} (ORRERY_PROTECTED_IPS) and must keep running; do that in the netcup SCP website.`);
}

// Tool results land in the chat: any password in them (the rescue system's, for one) is replaced.
export const redactPasswords = (v) =>
  Array.isArray(v)
    ? v.map(redactPasswords)
    : v && typeof v === "object"
      ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, /password$/i.test(k) && x != null ? "[redacted]" : redactPasswords(x)]))
      : v;

// 202 responses carry a TaskInfo for the asynchronous operation; keep the useful part.
// Passwords are redacted here, so no tool that summarizes a result can return one.
export function summarize({ status, body }) {
  if (body && typeof body === "object" && body.uuid && body.state) {
    return redactPasswords({ accepted: true, task: { uuid: body.uuid, name: body.name, state: body.state, message: body.message ?? null, progress: body.taskProgress?.progressInPercent ?? null } });
  }
  return status === 204 || body === null ? { ok: true, status } : { ok: true, status, result: redactPasswords(body) };
}

export function registerAdmin(server, { z, tool, adminTool, READ, WRITE, DESTRUCTIVE, env = process.env }, getConfig, fetchImpl = fetch) {
  const scp = createScp(getConfig, fetchImpl, env);
  const selfIp = String(env.ORRERY_SELF_IP || "").trim() || null;
  const protect = protectedIps(env);
  const notSelf = (serverId) => assertNotSelf(scp, serverId, selfIp, protect);

  // Ids of the servers that carry a protected IP, looked up on first use. The HTTP connector builds the
  // tools per request, so in practice this is once per netcup_api_request call that changes a policy.
  let protectedIds = null;
  const protectedServerIds = () =>
    (protectedIds ??= (async () => {
      const refusal = selfIpRefusal(selfIp);
      if (refusal) throw new Error(refusal);
      const ids = [];
      for (let offset = 0; offset < 2000; offset += 100) {
        const { body: page } = await scp.request("GET", `/api/v1/servers?limit=100&offset=${offset}`);
        if (!Array.isArray(page)) throw new Error("Unexpected response from GET /api/v1/servers");
        for (const m of page) {
          const s = toServer((await scp.request("GET", `/api/v1/servers/${Number(m.id)}?loadServerLiveInfo=false`)).body);
          if (protectedIpOf(s, protect)) ids.push(Number(m.id));
        }
        if (page.length < 100) break;
      }
      return ids;
    })().catch((e) => {
      protectedIds = null;
      throw e;
    }));

  // A firewall policy attached to an interface of a protected server is not changed from a chat: a
  // policy that drops the replies cut the Orrery host's tunnel once (docs/architecture.md).
  async function assertPolicyNotProtected(policyId) {
    for (const id of await protectedServerIds()) {
      const live = (await scp.request("GET", `/api/v1/servers/${id}?loadServerLiveInfo=true`)).body?.serverLiveInfo;
      if (!live?.interfaces?.length) throw new Error(`Refusing: could not read the interfaces of protected server ${id}, so firewall policy ${policyId} cannot be checked.`);
      for (const { mac } of live.interfaces) {
        if (!/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i.test(mac || "")) throw new Error(`Refusing: protected server ${id} reports an interface without a valid MAC, so firewall policy ${policyId} cannot be checked.`);
        const fw = (await scp.request("GET", `/api/v1/servers/${id}/interfaces/${mac}/firewall`)).body;
        if ((fw?.userPolicies || []).some((p) => Number(p.id) === Number(policyId))) {
          throw new Error(`Refusing: firewall policy ${policyId} is attached to server ${id}, which has a protected IP. Changing it can cut that server off; do that in the netcup SCP website.`);
        }
      }
    }
  }

  // netcup_api_request changes nothing on a protected server, nor a firewall policy attached to one.
  async function assertChangeAllowed(p) {
    const server = p.match(/^\/api\/v1\/servers\/([^/:]+)/);
    if (server) {
      if (!/^\d+$/.test(server[1])) throw new Error("Use the numeric server id (from netcup_servers) in the path");
      await notSelf(server[1]);
    }
    const policy = p.match(/^\/api\/v1\/users\/[^/]+\/firewall-policies\/([^/:]+)/);
    if (policy) {
      // Plain numbers only: "0501" or "501." could reach the same policy as 501 past a string compare.
      if (!/^[1-9]\d*$/.test(policy[1])) throw new Error("Use the numeric firewall policy id (from GET /api/v1/users/{userId}/firewall-policies) in the path");
      await assertPolicyNotProtected(policy[1]);
    }
  }
  const tools = [];
  const add = (name, spec, handler) => {
    server.registerTool(name, spec, handler);
    tools.push(name);
  };
  const SERVER_ID = z.number().int().positive().describe("netcup server id (from netcup_servers)");
  const CONFIRM = z.string().describe("The server's name (v22...), nickname or hostname, repeated to confirm the target");
  const GUARDED = " Protected servers (the Orrery host and ORRERY_PROTECTED_IPS) are refused, and without ORRERY_SELF_IP everything except a plain start is refused.";
  const UUID = z.string().regex(/^[0-9a-f-]{8,64}$/i);
  const merge = { contentType: "application/merge-patch+json" };
  const sid = (n) => Number(n);

  // ---------- reads that the dashboard does not need ----------
  add("netcup_get_server", {
    title: "Get netcup server",
    description: "Full details of one server as the SCP API returns them, including live info (interfaces, disks, boot order).",
    inputSchema: { serverId: SERVER_ID },
    annotations: READ,
  }, tool(async ({ serverId }) => redactPasswords((await scp.request("GET", `/api/v1/servers/${sid(serverId)}?loadServerLiveInfo=true`)).body)));
  add("netcup_list_snapshots", {
    title: "List snapshots",
    description: "Snapshots of a server (name, creation time, online or offline, exported).",
    inputSchema: { serverId: SERVER_ID },
    annotations: READ,
  }, tool(async ({ serverId }) => (await scp.request("GET", `/api/v1/servers/${sid(serverId)}/snapshots`)).body));
  add("netcup_list_images", {
    title: "List installable images",
    description: "Operating system images that can be installed on this server with netcup_reinstall.",
    inputSchema: { serverId: SERVER_ID },
    annotations: READ,
  }, tool(async ({ serverId }) => ((await scp.request("GET", `/api/v1/servers/${sid(serverId)}/imageflavours`)).body || []).map((f) => ({ id: f.id, name: f.name, alias: f.alias, text: f.text }))));
  add("netcup_list_ssh_keys", {
    title: "List SSH keys",
    description: "SSH public keys stored in the SCP account (ids are used by netcup_reinstall).",
    annotations: READ,
  }, tool(async () => (await scp.request("GET", `/api/v1/users/${await scp.getUserId()}/ssh-keys`)).body));
  add("netcup_list_tasks", {
    title: "List tasks",
    description: "Recent asynchronous tasks (power changes, snapshots, reinstalls) and their state.",
    inputSchema: {
      serverId: SERVER_ID.optional(),
      state: z.enum(["PENDING", "RUNNING", "FINISHED", "ERROR", "WAITING_FOR_CANCEL", "CANCELED"]).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    annotations: READ,
  }, tool(async ({ serverId, state, limit = 20 }) => {
    const q = new URLSearchParams({ limit: String(limit), offset: "0", ...(serverId ? { serverId: String(sid(serverId)) } : {}), ...(state ? { state } : {}) });
    return redactPasswords((await scp.request("GET", `/api/v1/tasks?${q}`)).body);
  }));
  add("netcup_get_task", {
    title: "Get task",
    description: "State and progress of one task (uuid from a previous change).",
    inputSchema: { uuid: UUID },
    annotations: READ,
  }, tool(async ({ uuid }) => redactPasswords((await scp.request("GET", `/api/v1/tasks/${uuid}`)).body)));
  add("netcup_list_endpoints", {
    title: "List SCP API endpoints",
    description: "Every endpoint in netcup's current OpenAPI spec (method, path, summary), optionally filtered by text. Use with netcup_api_request for anything the dedicated tools do not cover.",
    inputSchema: { query: z.string().optional() },
    annotations: READ,
  }, tool(async ({ query }) => {
    const spec = await scp.getSpec();
    const q = query?.toLowerCase();
    return { specVersion: spec.version, endpoints: spec.endpoints.filter((e) => !q || `${e.method} ${e.path} ${e.summary}`.toLowerCase().includes(q)).map(({ method, path, summary }) => ({ method, path, summary })) };
  }));

  // ---------- changes ----------
  add("netcup_set_power", {
    title: "Start, stop or restart a netcup server",
    description:
      "ON starts a stopped server. ON with option POWERCYCLE or RESET restarts a running server (hard). OFF shuts down through ACPI; OFF with option POWEROFF cuts power at once. SUSPENDED pauses the server." + GUARDED,
    inputSchema: { serverId: SERVER_ID, state: z.enum(["ON", "OFF", "SUSPENDED"]), option: z.enum(["POWERCYCLE", "RESET", "POWEROFF"]).optional() },
    annotations: DESTRUCTIVE,
  }, adminTool("netcup_set_power", async ({ serverId, state, option }) => {
    const r = serverStateRequest(state, option);
    if (state !== "ON" || option) await notSelf(serverId);
    return summarize(await scp.request("PATCH", `/api/v1/servers/${sid(serverId)}${r.query}`, { body: r.body, ...merge }));
  }));
  add("netcup_update_server", {
    title: "Rename a netcup server",
    description: "Set a server's hostname and/or its nickname in the SCP.",
    inputSchema: { serverId: SERVER_ID, hostname: z.string().min(1).max(255).optional(), nickname: z.string().max(255).optional() },
    annotations: WRITE,
  }, adminTool("netcup_update_server", async ({ serverId, hostname, nickname }) => {
    if (hostname === undefined && nickname === undefined) throw new Error("Give hostname or nickname");
    // The PATCH body is one of several single-purpose shapes, so each field is its own request.
    const out = {};
    if (hostname !== undefined) out.hostname = summarize(await scp.request("PATCH", `/api/v1/servers/${sid(serverId)}`, { body: { hostname }, ...merge }));
    if (nickname !== undefined) out.nickname = summarize(await scp.request("PATCH", `/api/v1/servers/${sid(serverId)}`, { body: { nickname }, ...merge }));
    return out;
  }));
  add("netcup_create_snapshot", {
    title: "Create snapshot",
    description: "Snapshot a server. online=true snapshots it while running (not with UEFI).",
    inputSchema: { serverId: SERVER_ID, name: z.string().min(1).max(255), description: z.string().max(255).optional(), online: z.boolean().optional() },
    annotations: WRITE,
  }, adminTool("netcup_create_snapshot", async ({ serverId, name, description, online }) =>
    summarize(await scp.request("POST", `/api/v1/servers/${sid(serverId)}/snapshots`, { body: { name, ...(description ? { description } : {}), ...(online !== undefined ? { onlineSnapshot: online } : {}) } }))));
  add("netcup_revert_snapshot", {
    title: "Revert to snapshot",
    description: "Roll a server's disks back to a snapshot. Everything written since then is lost." + GUARDED,
    inputSchema: { serverId: SERVER_ID, name: z.string().min(1).max(255), confirmServerName: CONFIRM },
    annotations: DESTRUCTIVE,
  }, adminTool("netcup_revert_snapshot", async ({ serverId, name, confirmServerName }) => {
    await notSelf(serverId);
    await assertServerName(scp, serverId, confirmServerName);
    return summarize(await scp.request("POST", `/api/v1/servers/${sid(serverId)}/snapshots/${encodeURIComponent(name)}/revert`));
  }));
  add("netcup_delete_snapshot", {
    title: "Delete snapshot",
    description: "Delete one snapshot of a server.",
    inputSchema: { serverId: SERVER_ID, name: z.string().min(1).max(255) },
    annotations: DESTRUCTIVE,
  }, adminTool("netcup_delete_snapshot", async ({ serverId, name }) => summarize(await scp.request("DELETE", `/api/v1/servers/${sid(serverId)}/snapshots/${encodeURIComponent(name)}`))));
  add("netcup_rescue_system", {
    title: "Rescue system on or off",
    description: "Boot a server into netcup's rescue system (active=true) or back from it (active=false). The server restarts. The rescue password is not returned." + GUARDED,
    inputSchema: { serverId: SERVER_ID, active: z.boolean() },
    annotations: DESTRUCTIVE,
  }, adminTool("netcup_rescue_system", async ({ serverId, active }) => {
    await notSelf(serverId);
    return summarize(await scp.request(active ? "POST" : "DELETE", `/api/v1/servers/${sid(serverId)}/rescuesystem`));
  }));
  add("netcup_reinstall", {
    title: "Reinstall the operating system",
    description: "Install an image (id from netcup_list_images) on a server. ALL DATA ON THE TARGET DISK IS ERASED. Login uses the given SSH key ids (from netcup_list_ssh_keys)." + GUARDED,
    inputSchema: {
      serverId: SERVER_ID,
      imageFlavourId: z.number().int().positive(),
      confirmServerName: CONFIRM,
      sshKeyIds: z.array(z.number().int().positive()).optional(),
      hostname: z.string().optional(),
      diskName: z.string().optional(),
      rootPartitionFullDiskSize: z.boolean().optional(),
      locale: z.string().optional(),
      timezone: z.string().optional(),
      sshPasswordAuthentication: z.boolean().optional(),
      customScript: z.string().optional(),
    },
    annotations: DESTRUCTIVE,
  }, adminTool("netcup_reinstall", async ({ serverId, confirmServerName, ...setup }) => {
    await notSelf(serverId);
    await assertServerName(scp, serverId, confirmServerName);
    const body = Object.fromEntries(Object.entries(setup).filter(([, v]) => v !== undefined));
    return summarize(await scp.request("POST", `/api/v1/servers/${sid(serverId)}/image`, { body }));
  }));
  add("netcup_set_rdns", {
    title: "Set reverse DNS",
    description: "Set the reverse DNS (PTR) name of one of your IPv4 or IPv6 addresses.",
    inputSchema: { ip: z.string().min(2).max(64), rdns: z.string().min(3).max(253) },
    annotations: WRITE,
  }, adminTool("netcup_set_rdns", async ({ ip, rdns }) => summarize(await scp.request("POST", `/api/v1/rdns/${ip.includes(":") ? "ipv6" : "ipv4"}`, { body: { ip, rdns } }))));
  add("netcup_cancel_task", {
    title: "Cancel task",
    description: "Cancel a running task.",
    inputSchema: { uuid: UUID },
    annotations: WRITE,
  }, adminTool("netcup_cancel_task", async ({ uuid }) => summarize(await scp.request("PUT", `/api/v1/tasks/${uuid}:cancel`))));
  add("netcup_api_request", {
    title: "Call any SCP API endpoint",
    description:
      "Call any endpoint from netcup_list_endpoints (firewall policies, failover IPs, ISOs, VLANs, disks, rescue system status, ...). The path must match netcup's current OpenAPI spec; {userId} is filled in automatically. Prefer the dedicated tools when one fits; reinstall, disk format and snapshot revert go only through tools that ask for the server name. Changes to the Orrery host or another protected server, and to firewall policies attached to them, are refused. Passwords in results are redacted. Can change or delete anything else in the account.",
    inputSchema: {
      method: z.enum(METHODS),
      path: z.string().regex(/^\/api\/v1\//, "path starts with /api/v1/").describe("e.g. /api/v1/users/{userId}/firewall-policies or /api/v1/servers/42/rescuesystem (no query string: use query)"),
      query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
      body: z.any().optional(),
    },
    annotations: DESTRUCTIVE,
  }, adminTool("netcup_api_request", ({ method, path, query, body }) => request(method, path, query, body)));
  add("netcup_query", {
    title: "Read any SCP API endpoint",
    description:
      "Read-only twin of netcup_api_request: GET any endpoint from netcup_list_endpoints, e.g. /api/v1/users/{userId}/firewall-policies, /api/v1/users/{userId}/firewall-policies/{id}, /api/v1/servers/{id}/interfaces, /api/v1/servers/{id}/interfaces/{mac}/firewall, /api/v1/servers/{id}/rescuesystem, /api/v1/servers/{id}/disks. The path must match netcup's current OpenAPI spec; {userId} is filled in automatically. Passwords in results are redacted. Changes nothing.",
    inputSchema: {
      path: z.string().regex(/^\/api\/v1\//, "path starts with /api/v1/").describe("e.g. /api/v1/users/{userId}/firewall-policies (no query string: use query)"),
      query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    },
    annotations: READ,
  }, tool(({ path, query }) => request("GET", path, query)));
  return tools;
  async function request(method, path, query, body) {
    // Literal paths only, so the checks below see the path netcup sees: no query (it goes in `query`),
    // escapes, fragments, dot or empty segments.
    if (/[?%#]/.test(path) || !/^(\/[\w\-.:,{}]+)+$/.test(path) || path.split("/").some((s) => s === "." || s === "..")) {
      throw new Error("path must be a literal API path without ?, %, #, dot or empty segments; put query parameters in query");
    }
    let p = path.replaceAll("{userId}", path.includes("{userId}") ? await scp.getUserId() : "{userId}");
    if (/[{}]/.test(p)) throw new Error("Fill in every {placeholder} in the path except {userId}");
    if (method !== "GET" && /\/(image|user-image)$|:format$|\/snapshots\/[^/]+\/revert$/.test(p)) {
      throw new Error("Reinstalling, formatting a disk and reverting a snapshot go through netcup_reinstall / netcup_revert_snapshot, which ask for the server name.");
    }
    if (method !== "GET") await assertChangeAllowed(p);
    const spec = await scp.getSpec();
    const ep = matchEndpoint(spec.endpoints, method, p);
    if (!ep) throw new Error(`${method} ${p} is not in netcup's API spec (version ${spec.version}). Use netcup_list_endpoints.`);
    if (query && Object.keys(query).length) p += "?" + new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]));
    return summarize(await scp.request(method, p, { body, contentType: ep.merge ? "application/merge-patch+json" : "application/json" }));
  }
}
