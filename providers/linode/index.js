// Linode (Akamai Cloud) for Orrery, through the Linode API v4 (https://techdocs.akamai.com/linode-api/reference/api).
// Akamai's own MCP server (akamai-developers/akamai-cloud-mcp) is read-only, so control lives here:
// linode_instances for both agents; power, delete, rebuild and any other API call only on the admin agent.
import fs from "node:fs";
import path from "node:path";

export const id = "linode";
export const name = "Linode";

export const API = "https://api.linode.com/v4";
export const METHODS = ["GET", "POST", "PUT", "DELETE"];
const TIMEOUT_MS = 30000;
const PAGE_SIZE = 500;
const PRIVATE_V4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

// The token comes from LINODE_TOKEN or $ORRERY_DIR/linode.json ({"token": "..."}).
export function loadConfig(env = process.env, dataDir) {
  if (env.LINODE_TOKEN) return { configured: true, token: env.LINODE_TOKEN };
  const file = dataDir && path.join(dataDir, "linode.json");
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (data.token) return { configured: true, token: data.token };
    return { configured: false, error: `${file}: token is missing` };
  } catch (e) {
    return e.code === "ENOENT" || !file ? { configured: false } : { configured: false, error: `${file}: ${e.code ? e.message : "not valid JSON"}` }; // never echo file content
  }
}

export class LinodeError extends Error {
  constructor(status, body, method, pathAndQuery) {
    const reasons = Array.isArray(body?.errors) ? body.errors.map((e) => (e.field ? `${e.field}: ${e.reason}` : e.reason)).join("; ") : "";
    super(`Linode ${method} ${pathAndQuery} failed with ${status}${reasons ? ": " + reasons : ""}`);
    this.status = status;
  }
}

// The path exactly as fetch will send it, so the checks in guardRequest see what Linode sees: no dot
// segments, empty segments or percent-escapes that could turn into a different path on the way.
export function normalizePath(pathAndQuery) {
  const [p, query] = String(pathAndQuery).split(/\?(.*)/s);
  if (!/^(\/[\w\-.:,]+)+\/?$/.test(p) || p.split("/").some((seg) => seg === "." || seg === "..")) throw new Error(`Invalid Linode API path: ${pathAndQuery}`);
  if (query !== undefined && !/^[\w\-.,:=&+]*$/.test(query)) throw new Error(`Invalid Linode API query: ${pathAndQuery}`);
  return p.replace(/\/$/, "") + (query ? `?${query}` : "");
}

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_RETRY_WAIT_MS = 10000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createApi(config, fetchImpl = fetch, { retryWaitMs = 1000 } = {}) {
  async function request(method, pathAndQuery, { body } = {}) {
    if (!METHODS.includes(method)) throw new Error(`Unsupported method ${method}`);
    if (method === "GET") body = undefined; // a GET carries no body
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
      const err = new LinodeError(res.status, json, method, p);
      if (res.status === 401) err.message += " (the Linode token is invalid, expired or revoked; create a new one, see docs/providers.md, Linode)";
      if (res.status === 429) err.message += ` (rate limited${retryAfter ? `, retry after ${retryAfter}s` : ""})`;
      throw err;
    }
  }

  // Every page of a paginated collection ({data, page, pages}).
  async function all(base, maxPages = 20) {
    const out = [];
    for (let page = 1; page <= maxPages; page++) {
      const body = await request("GET", `${base}${base.includes("?") ? "&" : "?"}page=${page}&page_size=${PAGE_SIZE}`);
      out.push(...(body.data || []));
      if (page >= (body.pages || 1)) break;
    }
    return out;
  }
  return { request, all };
}

// Linode instance (GET /linode/instances) -> the shape the tools return.
export const toInstance = (l) => ({
  id: l.id,
  label: l.label,
  status: l.status, // running, offline, booting, rebooting, shutting_down, provisioning, rebuilding, ...
  region: l.region,
  type: l.type,
  image: l.image || null,
  vcpus: l.specs?.vcpus ?? null,
  memoryMB: l.specs?.memory ?? null,
  diskMB: l.specs?.disk ?? null,
  transferGB: l.specs?.transfer ?? null, // monthly network transfer included in the plan
  ipv4: l.ipv4 || [],
  ipv6: l.ipv6 || null,
  tags: l.tags || [],
  backups: !!l.backups?.enabled,
  created: l.created || null,
});

export async function instances(api, { matchHosts } = {}) {
  const list = (await api.all("/linode/instances")).map(toInstance);
  const match = matchHosts ? await matchHosts() : () => null;
  // Only public addresses: a private 192.168.x.x of a Linode says nothing about which SSH host it is.
  for (const l of list) l.server = match([...l.ipv4.filter((ip) => !PRIVATE_V4.test(ip)), ...(l.ipv6 ? [l.ipv6.split("/")[0]] : [])]);
  return { instances: list, collectedAt: new Date().toISOString() };
}

const lid = (n) => {
  if (!Number.isInteger(Number(n)) || Number(n) <= 0) throw new Error(`Invalid Linode id: ${n}`);
  return Number(n);
};

export async function assertLabel(api, linodeId, confirmLabel) {
  const l = await api.request("GET", `/linode/instances/${lid(linodeId)}`);
  if (String(confirmLabel || "").trim() !== l.label) throw new Error(`Refusing: confirmLabel must be "${l.label}".`);
  return l;
}

// Answers that carry a token, secret key, password or kubeconfig: a tool result lands in the chat.
const SECRET_REQUESTS = [
  ["POST", /^\/profile\/tokens$/],
  ["POST", /^\/profile\/tfa-enable$/],
  ["POST", /^\/object-storage\/keys$/],
  ["POST", /^\/account\/oauth-clients$/],
  ["POST", /^\/account\/oauth-clients\/[^/]+\/reset-secret$/],
  ["POST", /^\/account\/child-accounts\/[^/]+\/token$/],
  ["GET", /^\/databases\/.+\/credentials$/],
  ["GET", /^\/lke\/clusters\/\d+\/kubeconfig$/],
];

// Requests the generic tool refuses: deleting or rebuilding a Linode goes through the tools that ask for
// its label; erasing its disks another way, answers with secrets and cancelling the account are not offered.
export function guardRequest(method, p, body) {
  const bare = normalizePath(p).split("?")[0];
  if (method === "DELETE" && /^\/linode\/instances\/\d+$/.test(bare)) throw new Error("Deleting a Linode goes through linode_delete, which asks for its label.");
  if (method === "POST" && /^\/linode\/instances\/\d+\/rebuild$/.test(bare)) throw new Error("Rebuilding a Linode goes through linode_rebuild, which asks for its label.");
  if (method === "POST" && /^\/linode\/instances\/\d+\/backups\/\d+\/restore$/.test(bare) && body?.overwrite) {
    throw new Error("Restoring a backup with overwrite erases every disk of the target Linode; restore without overwrite, or do it in Cloud Manager.");
  }
  if (method === "DELETE" && /^\/linode\/instances\/\d+\/disks\/\d+$/.test(bare)) throw new Error("Deleting a Linode's disk erases its data; do it in Cloud Manager.");
  if (/^\/account\/cancel$/.test(bare)) throw new Error("Cancelling the Linode account is not offered.");
  if (SECRET_REQUESTS.some(([m, re]) => m === method && re.test(bare))) {
    throw new Error(`${method} ${bare} returns a token, secret key, password or kubeconfig, which must not end up in the chat; do it in Cloud Manager.`);
  }
}

// ORRERY_SELF_IP (the Orrery host) plus ORRERY_PROTECTED_IPS (comma list, such as the user's
// proxy): Linodes a chat may boot but never shut down, reboot, delete, rebuild or change.
export const protectedIps = (env = process.env) =>
  [...new Set([env.ORRERY_SELF_IP, ...String(env.ORRERY_PROTECTED_IPS || "").split(/[\s,]+/)].map((ip) => String(ip || "").trim().toLowerCase()).filter(Boolean))];

// An address as Linode writes it, without a /prefix (IPv6 SLAAC addresses and ranges carry one).
const bareIp = (a) => String(a || "").split("/")[0].trim().toLowerCase();

export function assertNotProtected(l, protect) {
  const ip = [...(l.ipv4 || []), ...(l.ipv6 ? [l.ipv6] : [])].map(bareIp).find((a) => a && protect.includes(a));
  if (ip) throw new Error(`Refusing: Linode ${l.id} (${l.label}) has the protected IP ${ip} (ORRERY_SELF_IP or ORRERY_PROTECTED_IPS) and must keep running. Do this in Cloud Manager if you really mean it.`);
  return l;
}

// Moving or sharing addresses (/networking/ips/assign, /networking/ipv4/share, ...) would take a
// protected address away from its Linode or hand it to another one.
export function assertIpsNotProtected(method, p, body, protect) {
  if (method !== "POST" || !/^\/networking\/(ips|ipv4)\/(assign|share)$/.test(normalizePath(p).split("?")[0])) return;
  const addresses = [...(Array.isArray(body?.assignments) ? body.assignments.map((a) => a?.address) : []), ...(Array.isArray(body?.ips) ? body.ips : [])];
  const ip = addresses.map(bareIp).find((a) => a && protect.includes(a));
  if (ip) throw new Error(`Refusing: ${ip} is a protected IP (ORRERY_SELF_IP or ORRERY_PROTECTED_IPS) and stays where it is. Do this in Cloud Manager if you really mean it.`);
}

// Linodes a request body names as its target (clone or backup restore target, IP assignments).
const bodyLinodeIds = (body) => [body?.linode_id, ...(Array.isArray(body?.assignments) ? body.assignments.map((a) => a?.linode_id) : [])].filter((x) => x !== undefined && x !== null);

export function register(server, { z, tool, adminTool, READ, DESTRUCTIVE, admin, env, dataDir, matchHosts }, fetchImpl = fetch) {
  const config = loadConfig(env, dataDir);
  if (!config.configured) return { id, name, configured: false, error: config.error || null, tools: [] };
  const api = createApi(config, fetchImpl);
  const tools = [];
  const add = (toolName, spec, handler) => {
    server.registerTool(toolName, spec, handler);
    tools.push(toolName);
  };

  add("linode_instances", {
    title: "Linode instances",
    description: "Linode instances in every region: status, plan, image, vCPUs, memory, disk, included transfer, IPs and tags. Each carries the matching Orrery server (by public IP), if any.",
    annotations: READ,
  }, tool(() => instances(api, { matchHosts })));
  if (!admin) return { id, name, configured: true, tools };
  const request = async (method, p, body) => {
    guardRequest(method, p, body);
    if (method === "GET") body = undefined;
    const target = normalizePath(p).split("?")[0].match(/^\/linode\/instances\/(\d+)(\/.*)?$/);
    if (method !== "GET" && target && target[2] !== "/boot") await notProtected(target[1]);
    if (method !== "GET" && protect.length) {
      assertIpsNotProtected(method, p, body, protect);
      for (const linodeId of bodyLinodeIds(body)) await notProtected(linodeId);
    }
    return api.request(method, p, { body });
  };

  // A Linode with a protected IP is only ever booted or read from a chat.
  const protect = protectedIps(env);
  const notProtected = async (linodeId) => {
    if (protect.length) assertNotProtected(await api.request("GET", `/linode/instances/${lid(linodeId)}`), protect);
  };
  const LINODE_ID = z.number().int().positive().describe("Linode id (from linode_instances)");
  add("linode_power", {
    title: "Boot, shut down or reboot a Linode",
    description: "boot a stopped Linode, shutdown a running one, or reboot it. A Linode with a protected IP can only be booted.",
    inputSchema: { linodeId: LINODE_ID, action: z.enum(["boot", "shutdown", "reboot"]) },
    annotations: DESTRUCTIVE,
  }, adminTool("linode_power", async ({ linodeId, action }) => {
    if (action !== "boot") await notProtected(linodeId);
    await api.request("POST", `/linode/instances/${lid(linodeId)}/${action}`);
    return { ok: true, linodeId, action };
  }));
  add("linode_delete", {
    title: "Delete a Linode",
    description: "Permanently delete one Linode with its disks and backups. confirmLabel must repeat its label. Linodes with a protected IP are refused.",
    inputSchema: { linodeId: LINODE_ID, confirmLabel: z.string() },
    annotations: DESTRUCTIVE,
  }, adminTool("linode_delete", async ({ linodeId, confirmLabel }) => {
    assertNotProtected(await assertLabel(api, linodeId, confirmLabel), protect);
    await api.request("DELETE", `/linode/instances/${lid(linodeId)}`);
    return { ok: true, deleted: linodeId };
  }));
  add("linode_rebuild", {
    title: "Rebuild a Linode",
    description:
      "Reinstall a Linode from an image, erasing its disks. confirmLabel must repeat its label. Linodes with a protected IP are refused. body is the rebuild request, e.g. {\"image\": \"linode/debian12\", \"root_pass\": \"...\", \"authorized_keys\": [\"ssh-ed25519 ...\"]}.",
    inputSchema: { linodeId: LINODE_ID, confirmLabel: z.string(), body: z.record(z.string(), z.any()) },
    annotations: DESTRUCTIVE,
  }, adminTool("linode_rebuild", async ({ linodeId, confirmLabel, body }) => {
    assertNotProtected(await assertLabel(api, linodeId, confirmLabel), protect);
    return toInstance(await api.request("POST", `/linode/instances/${lid(linodeId)}/rebuild`, { body }));
  }));
  add("linode_api_request", {
    title: "Call any Linode API endpoint",
    description:
      "Call any Linode API v4 endpoint, e.g. GET /linode/instances/{id}/transfer, GET /linode/types, GET /regions, GET /account/events (progress of boots, creates, rebuilds), POST /linode/instances (create: {\"region\": \"jp-osa\", \"type\": \"g6-nanode-1\", \"image\": \"linode/debian12\", \"label\": \"test-1\", \"root_pass\": \"...\", \"tags\": [\"test\"]}), PUT /linode/instances/{id} (rename, tags), POST /linode/instances/{id}/resize, /networking/firewalls, /domains, /volumes, /account/invoices. Paths are relative to https://api.linode.com/v4 and must be literal (no {placeholders}). Tag short-lived test instances \"test\" so they are easy to find and delete. Deleting and rebuilding a Linode go through linode_delete / linode_rebuild; erasing disks, requests that return secrets, changes to a Linode with a protected IP (including cloning or restoring onto it) and assigning or sharing a protected IP are refused. Can change or delete anything else in the account.",
    inputSchema: {
      method: z.enum(METHODS),
      path: z.string().regex(/^\//, "path starts with /").describe("e.g. /linode/instances/123/transfer"),
      body: z.any().optional(),
    },
    annotations: DESTRUCTIVE,
  }, adminTool("linode_api_request", ({ method, path: p, body }) => request(method, p, body)));
  add("linode_query", {
    title: "Read any Linode API endpoint",
    description:
      "Read-only twin of linode_api_request: GET any Linode API v4 endpoint, e.g. /linode/instances/{id}, /linode/instances/{id}/transfer, /linode/types, /regions, /images, /account, /account/events, /account/invoices, /networking/firewalls, /networking/firewalls/{id}/rules, /domains, /domains/{id}/records, /volumes. Literal paths relative to https://api.linode.com/v4. Requests that return secrets are refused, as in linode_api_request. Changes nothing.",
    inputSchema: { path: z.string().regex(/^\//, "path starts with /").describe("e.g. /linode/instances/123/transfer") },
    annotations: READ,
  }, tool(({ path: p }) => request("GET", p)));
  return { id, name, configured: true, tools };
}
