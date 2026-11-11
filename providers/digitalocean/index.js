// DigitalOcean for Orrery, through the DigitalOcean API v2 (https://docs.digitalocean.com/reference/api/,
// spec: github.com/digitalocean/openapi). digitalocean_droplets for both agents; power, delete, rebuild and
// any other API call only on the admin agent.
import fs from "node:fs";
import path from "node:path";

export const id = "digitalocean";
export const name = "DigitalOcean";

export const API = "https://api.digitalocean.com/v2";
export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const TIMEOUT_MS = 30000;
const PAGE_SIZE = 200; // the API's maximum per_page

// The token comes from DIGITALOCEAN_TOKEN or $ORRERY_DIR/digitalocean.json ({"token": "..."}).
export function loadConfig(env = process.env, dataDir) {
  if (env.DIGITALOCEAN_TOKEN) return { configured: true, token: env.DIGITALOCEAN_TOKEN };
  const file = dataDir && path.join(dataDir, "digitalocean.json");
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (data.token) return { configured: true, token: data.token };
    return { configured: false, error: `${file}: token is missing` };
  } catch (e) {
    return e.code === "ENOENT" || !file ? { configured: false } : { configured: false, error: `${file}: ${e.code ? e.message : "not valid JSON"}` }; // never echo file content
  }
}

export class DigitalOceanError extends Error {
  constructor(status, body, method, pathAndQuery) {
    const reason = body?.message || body?.id || "";
    super(`DigitalOcean ${method} ${pathAndQuery} failed with ${status}${reason ? ": " + reason : ""}`);
    this.status = status;
    this.code = body?.id || null;
  }
}

// The path exactly as fetch will send it, so the checks in guardRequest see what DigitalOcean sees: no dot
// segments, empty segments or percent-escapes that could turn into a different path on the way. A leading
// /v2 (copied from the docs) is dropped, since API already ends in /v2.
export function normalizePath(pathAndQuery) {
  const [p, query] = String(pathAndQuery).split(/\?(.*)/s);
  if (!/^(\/[\w\-.:,]+)+\/?$/.test(p) || p.split("/").some((seg) => seg === "." || seg === "..")) throw new Error(`Invalid DigitalOcean API path: ${pathAndQuery}`);
  if (query !== undefined && !/^[\w\-.,:=&+]*$/.test(query)) throw new Error(`Invalid DigitalOcean API query: ${pathAndQuery}`);
  const bare = p.replace(/\/$/, "").replace(/^\/v2(?=\/)/, "");
  return bare + (query ? `?${query}` : "");
}

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_RETRY_WAIT_MS = 10000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createApi(config, fetchImpl = fetch, { retryWaitMs = 1000 } = {}) {
  async function request(method, pathAndQuery, { body } = {}) {
    if (!METHODS.includes(method)) throw new Error(`Unsupported method ${method}`);
    const p = normalizePath(pathAndQuery);
    const headers = { authorization: `Bearer ${config.token}`, accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    // GETs are retried once on rate limiting (429) or a 5xx; a change is never sent twice.
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(API + p, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {}
      if (res.ok) return json ?? {};
      const retryAfter = Number(res.headers.get("retry-after")) || 0;
      if (method === "GET" && attempt === 0 && RETRY_STATUS.has(res.status) && retryAfter * 1000 <= MAX_RETRY_WAIT_MS) {
        await sleep(retryAfter ? retryAfter * 1000 : retryWaitMs);
        continue;
      }
      const err = new DigitalOceanError(res.status, json, method, p);
      if (res.status === 401) err.message += " (the DigitalOcean token is invalid, expired or revoked; create a new one, see docs/providers.md, DigitalOcean)";
      if (res.status === 429) err.message += ` (rate limited${retryAfter ? `, retry after ${retryAfter}s` : ""})`;
      throw err;
    }
  }

  // Every page of a paginated collection ({<key>: [...], links: {pages: {next, last}}, meta: {total}}).
  async function all(base, key, maxPages = 20) {
    const out = [];
    for (let page = 1; page <= maxPages; page++) {
      const body = await request("GET", `${base}${base.includes("?") ? "&" : "?"}page=${page}&per_page=${PAGE_SIZE}`);
      out.push(...(body[key] || []));
      if (!body.links?.pages?.next) break;
    }
    return out;
  }
  return { request, all };
}

const addresses = (list, type) => (list || []).filter((n) => n.type === type).map((n) => n.ip_address);

// Droplet (GET /droplets) -> the shape the tools return.
export const toDroplet = (d) => ({
  id: d.id,
  name: d.name,
  status: d.status, // new, active, off, archive
  region: d.region?.slug ?? (typeof d.region === "string" ? d.region : null),
  size: d.size_slug ?? d.size?.slug ?? null,
  image: d.image?.slug || [d.image?.distribution, d.image?.name].filter(Boolean).join(" ") || null,
  vcpus: d.vcpus ?? null,
  memoryMB: d.memory ?? null,
  diskGB: d.disk ?? null,
  ipv4: addresses(d.networks?.v4, "public"),
  privateIpv4: addresses(d.networks?.v4, "private"),
  ipv6: addresses(d.networks?.v6, "public")[0] || null,
  tags: d.tags || [],
  created: d.created_at || null,
  locked: !!d.locked,
});

export async function droplets(api, { matchHosts } = {}) {
  const list = (await api.all("/droplets", "droplets")).map(toDroplet);
  const match = matchHosts ? await matchHosts() : () => null;
  // Only public addresses: a private 10.x VPC address says nothing about which SSH host it is.
  for (const d of list) d.server = match([...d.ipv4, ...(d.ipv6 ? [d.ipv6] : [])]);
  return { droplets: list, collectedAt: new Date().toISOString() };
}

const did = (n) => {
  if (!Number.isInteger(Number(n)) || Number(n) <= 0) throw new Error(`Invalid Droplet id: ${n}`);
  return Number(n);
};

export const getDroplet = async (api, dropletId) => toDroplet((await api.request("GET", `/droplets/${did(dropletId)}`)).droplet || {});

export async function assertName(api, dropletId, confirmName) {
  const d = await getDroplet(api, dropletId);
  if (String(confirmName || "").trim() !== d.name) throw new Error(`Refusing: confirmName must be "${d.name}".`);
  return d;
}

// Answers that carry a token, secret key, password, kubeconfig or private key: a tool result lands in the chat.
const SECRET_REQUESTS = [
  ["GET", /^\/kubernetes\/clusters\/[^/]+\/(kubeconfig|credentials)$/],
  ["GET", /^\/registry\/docker-credentials$/],
  ["GET", /^\/registries\/[^/]+\/docker-credentials$/],
  ["POST", /^\/spaces\/keys$/],
  ["GET", /^\/security\/secrets\/[^/]+$/],
  ["POST", /^\/functions\/namespaces\/[^/]+\/keys$/],
  ["POST", /^\/dedicated-inferences\/[^/]+\/tokens$/],
  ["POST", /^\/gen-ai\/agents\/[^/]+\/api_keys$/],
  ["PUT", /^\/gen-ai\/agents\/[^/]+\/api_keys\/[^/]+\/regenerate$/],
  ["POST", /^\/gen-ai\/models\/api_keys$/],
  ["PUT", /^\/gen-ai\/models\/api_keys\/[^/]+\/regenerate$/],
  ["POST", /^\/gen-ai\/oauth2\/dropbox\/tokens$/],
  ["POST", /^\/agents\/triggers\/[^/]+\/rotate-secret$/],
  ["GET", /^\/vector-databases\/[^/]+\/credentials$/],
  ["GET", /^\/databases\/metrics\/credentials$/],
  ["GET", /^\/partner_network_connect\/attachments\/[^/]+\/(bgp_auth_key|service_key)$/],
  ["POST", /^\/partner_network_connect\/attachments\/[^/]+\/service_key$/],
  ["GET", /^\/microvms\/[^/]+\/console$/],
];
const actionType = (body) => String(body?.type ?? "").toLowerCase();

// Requests the generic tool refuses: deleting or rebuilding a Droplet goes through the tools that ask for its
// name; deleting by tag, deleting with its associated resources, restoring a backup over its disk and answers
// with secrets are not offered.
export function guardRequest(method, p, body) {
  const bare = normalizePath(p).split("?")[0];
  if (method === "DELETE" && /^\/droplets\/\d+$/.test(bare)) throw new Error("Deleting a Droplet goes through digitalocean_delete, which asks for its name.");
  if (method === "DELETE" && bare === "/droplets") throw new Error("Deleting every Droplet with a tag is not offered; delete them one by one with digitalocean_delete.");
  if (/^\/droplets\/\d+\/destroy_with_associated_resources(\/|$)/.test(bare)) {
    throw new Error("Destroying a Droplet with its volumes, snapshots and IPs is not offered; use digitalocean_delete, then delete the other resources one by one.");
  }
  if (method === "POST" && /^\/droplets\/(\d+\/)?actions$/.test(bare)) {
    const type = actionType(body);
    const byTag = bare === "/droplets/actions";
    if (type === "rebuild") throw new Error(byTag ? "Rebuilding Droplets by tag is not offered." : "Rebuilding a Droplet goes through digitalocean_rebuild, which asks for its name.");
    if (type === "restore") throw new Error("Restoring a backup overwrites the Droplet's disk; do it in the DigitalOcean control panel.");
  }
  if (SECRET_REQUESTS.some(([m, re]) => m === method && re.test(bare))) {
    throw new Error(`${method} ${bare} returns a token, secret key, password or kubeconfig, which must not end up in the chat; do it in the DigitalOcean control panel.`);
  }
}

// Every API answer passes through here before it reaches the chat: managed databases return passwords and
// connection URIs with the password inside, Kafka users a private key, new keys their secret, and a
// Functions namespace (an object with api_host or namespace) its access key in a plain `key` field.
const SECRET_FIELDS = /(password|passwd|secret|secretkey|privatekey|token|kubeconfig|clientkeydata)$/i;
const SPACES_KEY_ID = /^[A-Z0-9]{16,40}$/; // a Spaces access key id is shown in the control panel, not a secret
const URI_PASSWORD = /^([a-z][\w+.-]*:\/\/[^/\s:@]*:)\S*@/i;
const redactString = (s) => (/PRIVATE KEY-----/.test(s) ? "[redacted]" : s.replace(URI_PASSWORD, "$1[redacted]@"));
const isSecretField = (k, x) => {
  if (x == null || x === "" || typeof x === "boolean" || typeof x === "number") return false;
  if (/^access_?key$/i.test(k)) return !(typeof x === "string" && SPACES_KEY_ID.test(x));
  return k === "auth" || SECRET_FIELDS.test(k.replace(/[-_]/g, ""));
};
export const redactSecrets = (v) =>
  Array.isArray(v)
    ? v.map(redactSecrets)
    : typeof v === "string"
      ? redactString(v)
      : v && Object.getPrototypeOf(v) === Object.prototype
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, isSecretField(k, x) || (k === "key" && typeof x === "string" && x !== "" && ("api_host" in v || "namespace" in v)) ? "[redacted]" : redactSecrets(x)]))
        : v;

// ORRERY_SELF_IP (the Orrery host) plus ORRERY_PROTECTED_IPS (comma list of other machines that must
// stay up): Droplets a chat may power on but never shut down, reboot, delete, rebuild or change.
export const protectedIps = (env = process.env) =>
  [...new Set([env.ORRERY_SELF_IP, ...String(env.ORRERY_PROTECTED_IPS || "").split(/[\s,]+/)].map((ip) => String(ip || "").trim().toLowerCase()).filter(Boolean))];

export function assertNotProtected(d, protect) {
  const ip = [...(d.ipv4 || []), d.ipv6].find((a) => a && protect.includes(String(a).toLowerCase()));
  if (ip) throw new Error(`Refusing: Droplet ${d.id} (${d.name}) has the protected IP ${ip} (ORRERY_SELF_IP or ORRERY_PROTECTED_IPS) and must keep running. Do this in the DigitalOcean control panel if you really mean it.`);
  return d;
}

// The generic tool's checks for a change (not a GET) while some IPs are protected: the protected Droplet
// itself (anything but power_on), bulk actions on a tag it carries, its reserved IP, requests that name it
// (droplet_id / droplet_ids / tag resources: firewalls, load balancers, volumes, reserved IPs), firewalls
// that cover it and deleting a tag it carries.
export async function assertRequestNotProtected(api, protect, method, p, body) {
  if (method === "GET" || !protect.length) return;
  const [bare, query = ""] = normalizePath(p).split("?");
  const type = actionType(body);
  const segs = bare.split("/");
  const ip = segs.find((s) => protect.includes(s.toLowerCase()));
  if (ip) throw new Error(`Refusing: ${method} ${bare} touches the protected IP ${ip} (ORRERY_SELF_IP or ORRERY_PROTECTED_IPS). Do this in the DigitalOcean control panel if you really mean it.`);
  const one = bare.match(/^\/droplets\/(\d+)(\/.*)?$/);
  if (one && !(one[2] === "/actions" && type === "power_on")) assertNotProtected(await getDroplet(api, one[1]), protect);

  let cached;
  const guarded = async () => (cached ??= (await api.all("/droplets", "droplets")).map(toDroplet).filter((d) => [...d.ipv4, d.ipv6].some((a) => a && protect.includes(a.toLowerCase()))));
  if (bare === "/droplets/actions" && type !== "power_on") {
    const tag = query.split("&").find((s) => s.startsWith("tag_name="))?.slice(9);
    const hit = tag && (await guarded()).find((d) => d.tags.includes(tag));
    if (hit) assertNotProtected(hit, protect);
  }
  const named = [body?.droplet_id, ...(Array.isArray(body?.droplet_ids) ? body.droplet_ids : []), ...(Array.isArray(body?.resources) ? body.resources.filter((r) => !r?.resource_type || r.resource_type === "droplet").map((r) => r?.resource_id) : [])]
    .filter((x) => x != null)
    .map(String);
  if (named.length) {
    const hit = (await guarded()).find((d) => named.includes(String(d.id)));
    if (hit) assertNotProtected(hit, protect);
  }
  const fw = bare.match(/^\/firewalls(?:\/([^/]+))?(\/.*)?$/);
  if (fw) {
    const current = fw[1] ? (await api.request("GET", `/firewalls/${fw[1]}`)).firewall || {} : {};
    const ids = [...(current.droplet_ids || []), ...(Array.isArray(body?.droplet_ids) ? body.droplet_ids : [])].map(String);
    const tags = [...(current.tags || []), ...(Array.isArray(body?.tags) ? body.tags : [])];
    const hit = (await guarded()).find((d) => ids.includes(String(d.id)) || d.tags.some((t) => tags.includes(t)));
    if (hit) assertNotProtected(hit, protect);
  }
  const tagDelete = method === "DELETE" && bare.match(/^\/tags\/([^/]+)$/);
  if (tagDelete) {
    const hit = (await guarded()).find((d) => d.tags.includes(tagDelete[1]));
    if (hit) assertNotProtected(hit, protect);
  }
}

const actionSummary = (res) => ({ actionId: res.action?.id ?? null, status: res.action?.status ?? null });

export function register(server, { z, tool, adminTool, READ, DESTRUCTIVE, admin, env, dataDir, matchHosts }, fetchImpl = fetch) {
  const config = loadConfig(env, dataDir);
  if (!config.configured) return { id, name, configured: false, error: config.error || null, tools: [] };
  const api = createApi(config, fetchImpl);
  const tools = [];
  const add = (toolName, spec, handler) => {
    server.registerTool(toolName, spec, handler);
    tools.push(toolName);
  };

  add("digitalocean_droplets", {
    title: "DigitalOcean Droplets",
    description: "DigitalOcean Droplets in every region: status, size, image, vCPUs, memory, disk, public and private IPs, tags and whether an action has them locked. Each carries the matching Orrery server (by public IP), if any.",
    annotations: READ,
  }, tool(() => droplets(api, { matchHosts })));
  if (!admin) return { id, name, configured: true, tools };
  const request = async (method, p, body) => {
    guardRequest(method, p, body);
    await assertRequestNotProtected(api, protect, method, p, body);
    return redactSecrets(await api.request(method, p, { body }));
  };

  // A Droplet with a protected IP is only ever powered on or read from a chat.
  const protect = protectedIps(env);
  const notProtected = async (dropletId) => {
    if (protect.length) assertNotProtected(await getDroplet(api, dropletId), protect);
  };
  const DROPLET_ID = z.number().int().positive().describe("Droplet id (from digitalocean_droplets)");
  add("digitalocean_power", {
    title: "Power on, shut down or reboot a Droplet",
    description:
      "power_on a stopped Droplet; shutdown (clean, from the OS), power_off (hard), reboot (clean) or power_cycle (hard) a running one. Returns the action; follow it with digitalocean_query /actions/{actionId}. A Droplet with a protected IP can only be powered on.",
    inputSchema: { dropletId: DROPLET_ID, action: z.enum(["power_on", "shutdown", "power_off", "reboot", "power_cycle"]) },
    annotations: DESTRUCTIVE,
  }, adminTool("digitalocean_power", async ({ dropletId, action }) => {
    if (action !== "power_on") await notProtected(dropletId);
    const res = await api.request("POST", `/droplets/${did(dropletId)}/actions`, { body: { type: action } });
    return { ok: true, dropletId, action, ...actionSummary(res) };
  }));
  add("digitalocean_delete", {
    title: "Delete a Droplet",
    description: "Permanently destroy one Droplet with its disk and backups (snapshots, volumes and reserved IPs stay and keep billing). confirmName must repeat its name. Droplets with a protected IP are refused.",
    inputSchema: { dropletId: DROPLET_ID, confirmName: z.string() },
    annotations: DESTRUCTIVE,
  }, adminTool("digitalocean_delete", async ({ dropletId, confirmName }) => {
    assertNotProtected(await assertName(api, dropletId, confirmName), protect);
    await api.request("DELETE", `/droplets/${did(dropletId)}`);
    return { ok: true, deleted: dropletId };
  }));
  add("digitalocean_rebuild", {
    title: "Rebuild a Droplet",
    description:
      "Reinstall a Droplet from an image, erasing its disk; it keeps its id, IPs and size. confirmName must repeat its name. image is a public image slug (e.g. \"debian-12-x64\", \"ubuntu-24-04-x64\"; see GET /images?type=distribution) or an image id. Droplets with a protected IP are refused. Returns the action; follow it with digitalocean_query /actions/{actionId}, then check the connector can still log in as root.",
    inputSchema: { dropletId: DROPLET_ID, confirmName: z.string(), image: z.union([z.string(), z.number().int().positive()]) },
    annotations: DESTRUCTIVE,
  }, adminTool("digitalocean_rebuild", async ({ dropletId, confirmName, image }) => {
    assertNotProtected(await assertName(api, dropletId, confirmName), protect);
    const res = await api.request("POST", `/droplets/${did(dropletId)}/actions`, { body: { type: "rebuild", image } });
    return { ok: true, dropletId, image, ...actionSummary(res) };
  }));
  add("digitalocean_api_request", {
    title: "Call any DigitalOcean API endpoint",
    description:
      "Call any DigitalOcean API v2 endpoint, e.g. GET /sizes, GET /regions, GET /images?type=distribution, GET /account/keys (SSH key ids and fingerprints), POST /droplets (create: {\"name\": \"test-1\", \"region\": \"sgp1\", \"size\": \"s-1vcpu-512mb-10gb\", \"image\": \"debian-12-x64\", \"ssh_keys\": [<id or fingerprint>], \"tags\": [\"test\"]}), POST /droplets/{id}/actions ({\"type\": \"resize\", \"size\": \"s-1vcpu-1gb\"}, rename, snapshot, enable_backups), GET /actions/{id} (progress of an action), /firewalls, /domains, /domains/{name}/records, /volumes, /reserved_ips, /vpcs, /account, /customers/my/balance, /customers/my/invoices. Paths are relative to https://api.digitalocean.com/v2 and must be literal (no {placeholders}); add ?page=N&per_page=200 for long lists. Tag short-lived test Droplets \"test\" so they are easy to find and delete. Deleting and rebuilding a Droplet go through digitalocean_delete / digitalocean_rebuild; deleting by tag or with associated resources, restoring a backup over a disk, requests that return secrets and changes to a Droplet with a protected IP (or its firewalls, reserved IP, tags) are refused, and passwords, keys and tokens in answers are redacted. Can change or delete anything else in the account.",
    inputSchema: {
      method: z.enum(METHODS),
      path: z.string().regex(/^\//, "path starts with /").describe("e.g. /droplets/123/actions"),
      body: z.any().optional(),
    },
    annotations: DESTRUCTIVE,
  }, adminTool("digitalocean_api_request", ({ method, path: p, body }) => request(method, p, body)));
  add("digitalocean_query", {
    title: "Read any DigitalOcean API endpoint",
    description:
      "Read-only twin of digitalocean_api_request: GET any DigitalOcean API v2 endpoint, e.g. /account, /account/keys, /customers/my/balance, /customers/my/invoices, /sizes, /regions, /images?type=distribution, /droplets/{id}, /actions/{id}, /firewalls, /domains, /domains/{name}/records, /volumes, /reserved_ips, /vpcs, /snapshots. Literal paths relative to https://api.digitalocean.com/v2; add ?page=N&per_page=200 for long lists. Requests that return secrets are refused and passwords, keys and tokens in answers are redacted, as in digitalocean_api_request. Changes nothing.",
    inputSchema: { path: z.string().regex(/^\//, "path starts with /").describe("e.g. /droplets/123") },
    annotations: READ,
  }, tool(({ path: p }) => request("GET", p)));
  return { id, name, configured: true, tools };
}
