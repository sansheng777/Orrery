// Vultr for Orrery, through the Vultr API v2 (https://www.vultr.com/api/; shapes checked against the
// official Go client, github.com/vultr/govultr). Vultr's hosted MCP server (https://mcp.vultr.com/mcp) is
// read-only, so control lives here: vultr_instances for both agents; power, delete, reinstall and any other
// API call only on the admin agent.
import fs from "node:fs";
import path from "node:path";
import { protectedIps, jsonRequest } from "../shared.js";

export const id = "vultr";
export const name = "Vultr";

export const API = "https://api.vultr.com/v2";
export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"]; // no OPTIONS: that is how Vultr hands out registry credentials
const TIMEOUT_MS = 30000;
const PER_PAGE = 500;
const PRIVATE_V4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The key comes from VULTR_API_KEY or $ORRERY_DIR/vultr.json ({"apiKey": "..."}).
export function loadConfig(env = process.env, dataDir) {
  if (env.VULTR_API_KEY) return { configured: true, apiKey: env.VULTR_API_KEY };
  const file = dataDir && path.join(dataDir, "vultr.json");
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (data.apiKey) return { configured: true, apiKey: data.apiKey };
    return { configured: false, error: `${file}: apiKey is missing` };
  } catch (e) {
    return e.code === "ENOENT" || !file ? { configured: false } : { configured: false, error: `${file}: ${e.code ? e.message : "not valid JSON"}` }; // never echo file content
  }
}

export class VultrError extends Error {
  constructor(status, body, method, pathAndQuery) {
    super(`Vultr ${method} ${pathAndQuery} failed with ${status}${body?.error ? ": " + body.error : ""}`);
    this.status = status;
  }
}

// The path exactly as fetch will send it (see linode/normalizePath): no dot or empty segments, no escapes.
export function normalizePath(pathAndQuery) {
  const [p, query] = String(pathAndQuery).split(/\?(.*)/s);
  if (!/^(\/[\w\-.:,]+)+\/?$/.test(p) || p.split("/").some((seg) => seg === "." || seg === "..")) throw new Error(`Invalid Vultr API path: ${pathAndQuery}`);
  if (query !== undefined && !/^[\w\-.,:=&+/]*$/.test(query)) throw new Error(`Invalid Vultr API query: ${pathAndQuery}`);
  return p.replace(/\/$/, "") + (query ? `?${query}` : "");
}


export function createApi(config, fetchImpl = fetch, { retryWaitMs = 1000 } = {}) {
  // query: extra parameters encoded here, after the path check (a pagination cursor is base64 and may end in
  // "=" padding, which encodeURIComponent turns into a "%" a literal path may not carry).
  async function request(method, pathAndQuery, { body, query } = {}) {
    if (!METHODS.includes(method)) throw new Error(`Unsupported method ${method}`);
    let p = normalizePath(pathAndQuery);
    if (query) p += (p.includes("?") ? "&" : "?") + new URLSearchParams(query).toString();
    // A GET is retried once on rate limiting or a 5xx; a change is never sent twice (jsonRequest).
    const { res, json, retryAfter } = await jsonRequest(fetchImpl, API + p, { method, headers: { authorization: `Bearer ${config.apiKey}` }, body, timeoutMs: TIMEOUT_MS, retryWaitMs });
    if (res.ok) return json ?? {};
    const err = new VultrError(res.status, json, method, p);
    if (res.status === 401) err.message += " (the API key is wrong or disabled, or this IP is not in the key's access control list; see docs/providers.md, Vultr)";
    if (res.status === 429) err.message += ` (rate limited${retryAfter ? `, retry after ${retryAfter}s` : ""})`;
    throw err;
  }

  // Every page of a cursor-paginated collection ({<key>: [...], meta: {links: {next}}}).
  async function all(base, key, maxPages = 20) {
    const out = [];
    let cursor = "";
    for (let page = 0; page < maxPages; page++) {
      const body = await request("GET", `${base}${base.includes("?") ? "&" : "?"}per_page=${PER_PAGE}`, { query: cursor ? { cursor } : undefined });
      out.push(...(body[key] || []));
      cursor = body.meta?.links?.next || "";
      if (!cursor) break;
    }
    return out;
  }
  return { request, all };
}

const ip = (a) => (a && a !== "0.0.0.0" && a !== "::" ? a : null); // a new instance reports 0.0.0.0 until it has its address

// Vultr instance (GET /instances) -> the shape the tools return.
export const toInstance = (i) => ({
  id: i.id,
  label: i.label || i.hostname || i.id,
  hostname: i.hostname || null,
  status: i.status || null, // active, pending, suspended, resizing
  powerStatus: i.power_status || null, // running, stopped
  serverStatus: i.server_status || null, // none, locked, installingbooting, ok
  region: i.region || null,
  plan: i.plan || null,
  os: i.os || null,
  vcpus: i.vcpu_count ?? null,
  memoryMB: i.ram ?? null,
  diskGB: i.disk ?? null,
  bandwidthGB: i.allowed_bandwidth ?? null, // monthly transfer included in the plan
  ipv4: ip(i.main_ip),
  ipv6: ip(i.v6_main_ip),
  internalIp: i.internal_ip || null,
  firewallGroupId: i.firewall_group_id || null,
  tags: i.tags || [],
  features: i.features || [],
  created: i.date_created || null,
});

export async function instances(api, { matchHosts } = {}) {
  const list = (await api.all("/instances", "instances")).map(toInstance);
  const match = matchHosts ? await matchHosts() : () => null;
  for (const i of list) i.server = match([i.ipv4, i.ipv6].filter((a) => a && !PRIVATE_V4.test(a)));
  return { instances: list, collectedAt: new Date().toISOString() };
}

const iid = (s) => {
  if (!UUID.test(String(s))) throw new Error(`Invalid Vultr instance id: ${s}`);
  return String(s).toLowerCase();
};

export async function getInstance(api, instanceId) {
  return toInstance((await api.request("GET", `/instances/${iid(instanceId)}`)).instance || {});
}

export async function assertLabel(api, instanceId, confirmLabel) {
  const i = await getInstance(api, instanceId);
  if (String(confirmLabel || "").trim() !== i.label) throw new Error(`Refusing: confirmLabel must be "${i.label}".`);
  return i;
}

// Answers that hand out a key or credentials: a tool result lands in the chat.
const SECRET_REQUESTS = [
  ["POST", /^\/users\/[^/]+\/apikeys$/],
  ["POST", /^\/object-storage\/[^/]+\/regenerate-keys$/],
  ["GET", /^\/kubernetes\/clusters\/[^/]+\/config$/],
  ["POST", /^\/inference\/[^/]+\/apikey$/],
];
// Members that hold a secret inside otherwise ordinary answers: a new instance's root password, user and
// inference API keys, Object Storage keys, database passwords and access keys, a kubeconfig, and an instance's
// `kvm` web console URL (its token opens the screen and keyboard without the Vultr login: a Ctrl+Alt+Del and a
// boot-menu edit away from root). Any string holding a private key is redacted wherever it is.
const SECRET_FIELDS = /^(kvm|default_password|password|api_key|access_key|s3_access_key|s3_secret_key|secret|secret_key|private_key|kube_config|kubeconfig|token)$/i;

export const redactSecrets = (v) =>
  Array.isArray(v)
    ? v.map(redactSecrets)
    : typeof v === "string"
      ? (/PRIVATE KEY-----/.test(v) ? "[redacted]" : v)
      : v && Object.getPrototypeOf(v) === Object.prototype
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_FIELDS.test(k) && x != null && x !== "" ? "[redacted]" : redactSecrets(x)]))
        : v;

// Requests the generic tool refuses: deleting or reinstalling an instance (also by PATCH with a new os_id,
// app_id or image_id) goes through the tools that ask for its label; restoring over it and erasing a
// bare-metal server are left to the website, and so are answers that carry a key.
export function guardRequest(method, p, body) {
  const bare = normalizePath(p).split("?")[0];
  if (method === "DELETE" && /^\/instances\/[^/]+$/.test(bare)) throw new Error("Deleting an instance goes through vultr_delete, which asks for its label.");
  if (method === "POST" && /^\/instances\/[^/]+\/reinstall$/.test(bare)) throw new Error("Reinstalling an instance goes through vultr_reinstall, which asks for its label.");
  const reimage = method === "PATCH" && body && ["os_id", "app_id", "image_id"].some((k) => body[k] != null && body[k] !== "");
  if (reimage && /^\/instances\/[^/]+$/.test(bare)) {
    throw new Error("Changing an instance's os_id, app_id or image_id reinstalls it and erases its disk; use vultr_reinstall (osId, appId or imageId), which asks for its label.");
  }
  if (reimage && /^\/bare-metals\/[^/]+$/.test(bare)) throw new Error("Changing a bare-metal server's os_id, app_id or image_id reinstalls and erases it; do it in the Vultr website.");
  if (method === "POST" && /^\/(instances|bare-metals)\/[^/]+\/restore$/.test(bare)) throw new Error("Restoring a snapshot or backup overwrites the server's disk; do it in the Vultr website.");
  if ((method === "DELETE" && /^\/bare-metals\/[^/]+$/.test(bare)) || (method === "POST" && /^\/bare-metals\/[^/]+\/reinstall$/.test(bare))) {
    throw new Error("Deleting or reinstalling a bare-metal server erases it; do it in the Vultr website.");
  }
  if (SECRET_REQUESTS.some(([m, re]) => m === method && re.test(bare))) {
    throw new Error(`${method} ${bare} returns a key or credentials, which must not end up in the chat; do it in the Vultr website.`);
  }
}

export { protectedIps };

export function assertNotProtected(i, protect) {
  const hit = [i.ipv4, i.ipv6].find((a) => a && protect.includes(String(a).toLowerCase()));
  if (hit) throw new Error(`Refusing: Vultr instance ${i.id} (${i.label}) has the protected IP ${hit} (ORRERY_SELF_IP or ORRERY_PROTECTED_IPS) and must keep running. Do this in the Vultr website if you really mean it.`);
  return i;
}

// Instance ids a change names: /instances/<id>/..., and instance_id / instance_ids in the body (bulk halt and
// reboot, block storage and reserved IP attach, VPC and firewall membership...). Bulk start names none.
export function instanceIdsIn(method, p, body) {
  const bare = normalizePath(p).split("?")[0];
  if (method === "POST" && bare === "/instances/start") return { ids: [], rest: "" };
  // A snapshot only reads the instance, so it is allowed on protected machines too (as on the other providers).
  if (method === "POST" && bare === "/snapshots") return { ids: [], rest: "" };
  const named = body && typeof body === "object" ? [body.instance_id, ...[].concat(body.instance_ids ?? [])].filter((x) => x != null && x !== "").map(String) : [];
  const one = bare.match(/^\/instances\/([^/]+)(\/.*)?$/);
  if (one && !(["start", "halt", "reboot"].includes(one[1]) && !one[2])) return { ids: [...new Set([one[1], ...named])], rest: one[2] || "" };
  return { ids: [...new Set(named)], rest: "" };
}

export function register(server, { z, tool, adminTool, READ, DESTRUCTIVE, admin, env, dataDir, matchHosts }, fetchImpl = fetch) {
  const config = loadConfig(env, dataDir);
  if (!config.configured) return { id, name, configured: false, error: config.error || null, tools: [] };
  const api = createApi(config, fetchImpl);
  const tools = [];
  const add = (toolName, spec, handler) => {
    server.registerTool(toolName, spec, handler);
    tools.push(toolName);
  };

  add("vultr_instances", {
    title: "Vultr instances",
    description: "Vultr Cloud Compute instances in every region: status, power, plan, OS, vCPUs, memory, disk, included bandwidth, IPs, firewall group and tags. Each carries the matching Orrery server (by public IP), if any.",
    annotations: READ,
  }, tool(() => instances(api, { matchHosts })));
  if (!admin) return { id, name, configured: true, tools };
  const request = async (method, p, body) => {
    guardRequest(method, p, body);
    if (method !== "GET") {
      const { ids, rest } = instanceIdsIn(method, p, body);
      if (ids.length && rest !== "/start") await notProtected(ids);
      // Requests that name only the attached resource: detaching (or deleting) block storage reboots the
      // instance it is attached to unless live, and detaching (or deleting) a reserved IP takes its address away.
      const bare = normalizePath(p).split("?")[0];
      const res = protect.length && ((method === "POST" && bare.match(/^\/(blocks|reserved-ips)\/([^/]+)\/detach$/)) || (method === "DELETE" && bare.match(/^\/(blocks|reserved-ips)\/([^/]+)$/)));
      if (res) {
        const r = await api.request("GET", `/${res[1]}/${res[2]}`);
        const attached = res[1] === "blocks" ? r.block?.attached_to_instance : r.reserved_ip?.instance_id;
        const address = r.reserved_ip?.subnet;
        if (address && protect.includes(String(address).toLowerCase())) throw new Error(`Refusing: reserved IP ${res[2]} is the protected IP ${address} (ORRERY_SELF_IP or ORRERY_PROTECTED_IPS). Do this in the Vultr website if you really mean it.`);
        if (attached) await notProtected([attached]);
      }
    }
    return redactSecrets(await api.request(method, p, { body }));
  };

  // An instance with a protected IP is only ever started or read from a chat.
  const protect = protectedIps(env);
  const notProtected = async (ids) => {
    if (!protect.length) return;
    for (const one of ids) assertNotProtected(await getInstance(api, one), protect);
  };
  const INSTANCE_ID = z.string().regex(UUID, "Vultr instance id (a UUID, from vultr_instances)");
  add("vultr_power", {
    title: "Start, halt or reboot a Vultr instance",
    description: "start a stopped instance, halt (hard power off; a halted instance is still billed) or reboot a running one. An instance with a protected IP can only be started.",
    inputSchema: { instanceId: INSTANCE_ID, action: z.enum(["start", "halt", "reboot"]) },
    annotations: DESTRUCTIVE,
  }, adminTool("vultr_power", async ({ instanceId, action }) => {
    if (action !== "start") await notProtected([instanceId]);
    await api.request("POST", `/instances/${iid(instanceId)}/${action}`);
    return { ok: true, instanceId, action };
  }));
  add("vultr_delete", {
    title: "Delete a Vultr instance",
    description: "Permanently destroy one instance and its data; billing stops. confirmLabel must repeat its label. Instances with a protected IP are refused.",
    inputSchema: { instanceId: INSTANCE_ID, confirmLabel: z.string() },
    annotations: DESTRUCTIVE,
  }, adminTool("vultr_delete", async ({ instanceId, confirmLabel }) => {
    assertNotProtected(await assertLabel(api, instanceId, confirmLabel), protect);
    await api.request("DELETE", `/instances/${iid(instanceId)}`);
    return { ok: true, deleted: instanceId };
  }));
  add("vultr_reinstall", {
    title: "Reinstall a Vultr instance",
    description: "Reinstall the instance, erasing its disk (the IP stays). confirmLabel must repeat its label. Without osId, appId or imageId it reinstalls the current operating system (hostname optional); give one of them (ids from vultr_query /os or /applications) to install something else instead. Instances with a protected IP are refused.",
    inputSchema: {
      instanceId: INSTANCE_ID,
      confirmLabel: z.string(),
      hostname: z.string().optional(),
      osId: z.number().int().positive().optional().describe("Operating system id (GET /os)"),
      appId: z.number().int().positive().optional().describe("Marketplace application id (GET /applications)"),
      imageId: z.string().optional().describe("Marketplace application image id (GET /applications)"),
    },
    annotations: DESTRUCTIVE,
  }, adminTool("vultr_reinstall", async ({ instanceId, confirmLabel, hostname, osId, appId, imageId }) => {
    const image = { ...(osId != null ? { os_id: osId } : {}), ...(appId != null ? { app_id: appId } : {}), ...(imageId ? { image_id: imageId } : {}) };
    if (Object.keys(image).length > 1) throw new Error("Give at most one of osId, appId and imageId.");
    if (Object.keys(image).length && hostname) throw new Error("hostname only applies to reinstalling the current operating system, not with osId, appId or imageId.");
    assertNotProtected(await assertLabel(api, instanceId, confirmLabel), protect);
    if (Object.keys(image).length) {
      // A new OS, app or image is set by PATCH, which reinstalls the instance.
      const r = await api.request("PATCH", `/instances/${iid(instanceId)}`, { body: image });
      return toInstance(r.instance || {});
    }
    const r = await api.request("POST", `/instances/${iid(instanceId)}/reinstall`, { body: hostname ? { hostname } : {} });
    return toInstance(r.instance || {});
  }));
  add("vultr_api_request", {
    title: "Call any Vultr API endpoint",
    description:
      "Call any Vultr API v2 endpoint, e.g. GET /account, GET /account/bandwidth, GET /billing/invoices, GET /billing/history, GET /regions, GET /plans, GET /os, GET /ssh-keys, POST /ssh-keys ({\"name\", \"ssh_key\"}), POST /instances (create: {\"region\": \"nrt\", \"plan\": \"vc2-1c-1gb\", \"os_id\": 2136, \"label\": \"test-1\", \"hostname\": \"test-1\", \"sshkey_id\": [\"<id>\"], \"tags\": [\"test\"]}), PATCH /instances/{id} (label, tags, plan, firewall_group_id; a new os_id, app_id or image_id reinstalls, so that goes through vultr_reinstall), GET /instances/{id}/bandwidth, /firewalls, /domains, /snapshots, /blocks, /reserved-ips, /vpcs, /bare-metals, /kubernetes/clusters, /databases, /object-storage, /inference (usage: GET /inference/{id}/usage). Paths are relative to https://api.vultr.com/v2 and must be literal (no {placeholders}); pagination is ?per_page=…&cursor=…. Tag short-lived test instances \"test\" so they are easy to find and delete. Deleting and reinstalling an instance go through vultr_delete / vultr_reinstall; restores over a disk, erasing or reinstalling bare-metal servers, requests that hand out keys and changes to an instance with a protected IP (also through instance_id / instance_ids in the body, and detaching block storage or a reserved IP from it) are refused; passwords and keys in answers are redacted. Can change or delete anything else in the account.",
    inputSchema: {
      method: z.enum(METHODS),
      path: z.string().regex(/^\//, "path starts with /").describe("e.g. /instances/<id>/bandwidth"),
      body: z.any().optional(),
    },
    annotations: DESTRUCTIVE,
  }, adminTool("vultr_api_request", ({ method, path: p, body }) => request(method, p, body)));
  add("vultr_query", {
    title: "Read any Vultr API endpoint",
    description:
      "Read-only twin of vultr_api_request: GET any Vultr API v2 endpoint, e.g. /account, /account/bandwidth, /billing/invoices, /billing/history, /regions, /plans, /os, /ssh-keys, /instances/{id}, /instances/{id}/bandwidth, /firewalls, /firewalls/{id}/rules, /snapshots, /blocks, /reserved-ips, /vpcs, /inference, /inference/{id}/usage, /tickets, /tickets/{id}/replies. Literal paths relative to https://api.vultr.com/v2; pagination ?per_page=...&cursor=.... Requests that hand out keys are refused and passwords, keys and console URLs in answers are redacted, as in vultr_api_request. Changes nothing.",
    inputSchema: { path: z.string().regex(/^\//, "path starts with /").describe("e.g. /instances/<id>/bandwidth") },
    annotations: READ,
  }, tool(({ path: p }) => request("GET", p)));
  return { id, name, configured: true, tools };
}
