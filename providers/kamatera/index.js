// Kamatera for Orrery, through the cloudcli API (https://cloudcli.cloudwm.com; the endpoints come from
// its own schema at /schema and from github.com/Kamatera/terraform-provider-kamatera). kamatera_servers for
// both agents; power, delete and any other API call only on the admin agent.
//
// Two things set Kamatera apart: most calls are POSTs that name the server in the body ({"id"} or {"name"},
// where name is a regular expression that can match several servers), and changes are queued: they answer
// with command ids whose progress GET /service/queue?id=<id> reports.
import fs from "node:fs";
import path from "node:path";
import { protectedIps, sleep } from "../shared.js";

export const id = "kamatera";
export const name = "Kamatera";

export const API = "https://cloudcli.cloudwm.com";
export const METHODS = ["GET", "POST"];
const TIMEOUT_MS = 60000; // server/info and create are slow
const SERVER_ID = /^[\w-]{6,64}$/;
const PRIVATE_V4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

// The key comes from KAMATERA_API_CLIENT_ID + KAMATERA_API_SECRET or $ORRERY_DIR/kamatera.json
// ({"clientId": "...", "secret": "..."}), made under API → Keys in the Kamatera console.
export function loadConfig(env = process.env, dataDir) {
  if (env.KAMATERA_API_CLIENT_ID && env.KAMATERA_API_SECRET) return { configured: true, clientId: env.KAMATERA_API_CLIENT_ID, secret: env.KAMATERA_API_SECRET };
  const file = dataDir && path.join(dataDir, "kamatera.json");
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (data.clientId && data.secret) return { configured: true, clientId: data.clientId, secret: data.secret };
    return { configured: false, error: `${file}: clientId or secret is missing` };
  } catch (e) {
    return e.code === "ENOENT" || !file ? { configured: false } : { configured: false, error: `${file}: ${e.code ? e.message : "not valid JSON"}` }; // never echo file content
  }
}

export class KamateraError extends Error {
  constructor(status, body, method, pathAndQuery) {
    const reason = typeof body === "string" ? body : body?.message || body?.errors?.[0]?.info || body?.error || "";
    super(`Kamatera ${method} ${pathAndQuery} failed with ${status}${reason ? ": " + String(reason).slice(0, 300) : ""}`);
    this.status = status;
  }
}

// The path exactly as fetch will send it: no dot or empty segments, no escapes.
export function normalizePath(pathAndQuery) {
  const [p, query] = String(pathAndQuery).split(/\?(.*)/s);
  if (!/^(\/[\w\-.:,]+)+\/?$/.test(p) || p.split("/").some((seg) => seg === "." || seg === "..")) throw new Error(`Invalid Kamatera API path: ${pathAndQuery}`);
  if (query !== undefined && !/^[\w\-.,:=&+]*$/.test(query)) throw new Error(`Invalid Kamatera API query: ${pathAndQuery}`);
  return p.replace(/\/$/, "") + (query ? `?${query}` : "");
}

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

export function createApi(config, fetchImpl = fetch, { retryWaitMs = 1000 } = {}) {
  async function request(method, pathAndQuery, { body } = {}) {
    if (!METHODS.includes(method)) throw new Error(`Unsupported method ${method}`);
    const p = normalizePath(pathAndQuery);
    const headers = { AuthClientId: config.clientId, AuthSecret: config.secret, accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    // GETs and the read-only POSTs are retried once on rate limiting or a 5xx; a change is never sent twice.
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
      if (res.ok) return json ?? (text || {});
      if ((method === "GET" || READ_POSTS.has(p.split("?")[0].toLowerCase())) && attempt === 0 && RETRY_STATUS.has(res.status)) {
        await sleep(retryWaitMs);
        continue;
      }
      const err = new KamateraError(res.status, json ?? text, method, p);
      if (res.status === 401 || res.status === 403) err.message += " (the API key is wrong or disabled, or it does not allow this IP; see docs/providers.md, Kamatera)";
      throw err;
    }
  }
  return { request };
}

// POSTs that only read: what kamatera_query may send.
export const READ_POSTS = new Set(["/service/server/info", "/service/server/options/images", "/server/history", "/server/statistics", "/server/report"]);

const toList = (r) => (Array.isArray(r) ? r : r && typeof r === "object" ? Object.values(r) : []);
const num = (v) => (v === undefined || v === null || v === "" || Number.isNaN(Number(v)) ? null : Number(v));

// POST /service/server/info -> the shape the tools return. Public addresses are on the networks whose name
// starts with "wan-".
export function toServer(s) {
  const nets = Array.isArray(s.networks) ? s.networks : [];
  const ips = (wan) => nets.filter((n) => String(n.network || "").startsWith("wan-") === wan).flatMap((n) => n.ips || []);
  const publicIps = ips(true);
  return {
    id: s.id,
    name: s.name || s.id,
    datacenter: s.datacenter || null,
    power: s.power || null, // on, off
    cpu: s.cpu || null, // cores + type, e.g. "1A"
    ramMB: num(s.ram),
    diskSizesGB: (s.diskSizes || []).map(Number),
    billing: s.billing || null, // hourly, monthly
    traffic: s.traffic || null, // monthly traffic package
    managed: s.managed ?? null,
    backup: s.backup ?? null,
    priceMonthlyOn: num(s.priceMonthlyOn),
    priceHourlyOn: num(s.priceHourlyOn),
    priceHourlyOff: num(s.priceHourlyOff),
    ipv4: publicIps.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) || null,
    publicIps,
    privateIps: ips(false),
  };
}

export async function getServer(api, serverId) {
  if (!SERVER_ID.test(String(serverId))) throw new Error(`Invalid Kamatera server id: ${serverId}`);
  const list = toList(await api.request("POST", "/service/server/info", { body: { id: String(serverId) } }));
  if (list.length !== 1) throw new Error(`Kamatera server ${serverId} not found`);
  return toServer(list[0]);
}

export async function servers(api, { matchHosts } = {}) {
  const list = toList(await api.request("GET", "/service/servers"));
  const out = await Promise.all(
    list.map(async (s) => {
      try {
        return await getServer(api, s.id);
      } catch (e) {
        return { ...toServer(s), error: e.message }; // the list still shows it, without addresses
      }
    }),
  );
  const match = matchHosts ? await matchHosts() : () => null;
  for (const s of out) s.server = match(s.publicIps.filter((a) => !PRIVATE_V4.test(a)));
  return { servers: out, collectedAt: new Date().toISOString() };
}

export async function assertName(api, serverId, confirmName) {
  const s = await getServer(api, serverId);
  if (String(confirmName || "").trim() !== s.name) throw new Error(`Refusing: confirmName must be "${s.name}".`);
  return s;
}

// A tool result lands in the chat: a server created with password "__generate__" answers with the password.
const SECRET_FIELDS = /^(password|passwordValidate|generated_password|secret|token|private_?key)$/i;

export const redactSecrets = (v) =>
  Array.isArray(v)
    ? v.map(redactSecrets)
    : v && Object.getPrototypeOf(v) === Object.prototype
      ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_FIELDS.test(k) && x != null && x !== "" ? "[redacted]" : redactSecrets(x)]))
      : v;

// Calls that act on existing servers: the body must name one server by "id" (a "name" is a regular
// expression and may hit several), and a protected server may only be read or powered on. Matched in
// lower case (paths are compared case-insensitively) and whatever the method.
const SERVER_ACTIONS = /^\/(service\/server\/(poweron|poweroff|reboot|terminate|password|ssh|sshkey|rename|suspend|resume)|server\/(description|snapshot|network|disk|configure|tags|hdlib))$/;
// Paths that change something, whatever the method: kamatera_query never sends to them.
export const isChangePath = (bare) => SERVER_ACTIONS.test(bare.toLowerCase()) || bare.toLowerCase() === "/service/cloneserver";

// Requests the generic tool refuses: terminating goes through kamatera_delete (it asks for the name);
// reverting a snapshot overwrites the disk; setting a root password or opening a console session would put a
// credential in the chat. Those are left to the website. The checks hold for GET too, in case the API
// answers an action path on GET.
export function guardRequest(method, p, body) {
  const bare = normalizePath(p).split("?")[0].toLowerCase();
  if (bare === "/service/server/terminate") throw new Error("Deleting a server goes through kamatera_delete, which asks for its name.");
  if (/^\/service\/server\/(password|ssh|sshkey)$/.test(bare)) throw new Error(`POST ${bare} sets or hands out a credential, which must not end up in the chat; do it in the Kamatera website.`);
  if (bare === "/server/snapshot" && body?.revert) throw new Error("Reverting a snapshot overwrites the server's disk; do it in the Kamatera website.");
  if (bare === "/service/cloneserver") return { serverId: null };
  if (!SERVER_ACTIONS.test(bare)) return { serverId: null };
  if (body?.name !== undefined) throw new Error(`Name the server by "id", not "name": Kamatera treats a name as a regular expression that can match several servers.`);
  if (!SERVER_ID.test(String(body?.id ?? ""))) throw new Error(`POST ${bare} needs the server's "id" (from kamatera_servers).`);
  return { serverId: String(body.id), powerOn: bare === "/service/server/poweron" || bare === "/service/server/resume" };
}

export { protectedIps };

export function assertNotProtected(s, protect) {
  const hit = s.publicIps.find((a) => protect.includes(String(a).toLowerCase()));
  if (hit) throw new Error(`Refusing: Kamatera server ${s.id} (${s.name}) has the protected IP ${hit} (ORRERY_SELF_IP or ORRERY_PROTECTED_IPS) and must keep running. Do this in the Kamatera website if you really mean it.`);
  return s;
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

  add("kamatera_servers", {
    title: "Kamatera servers",
    description: "Kamatera cloud servers in every datacenter: power, CPU (cores + type, e.g. 1A), memory, disks, billing cycle, traffic package, monthly and hourly prices, public and private IPs. Each carries the matching Orrery server (by public IP), if any.",
    annotations: READ,
  }, tool(() => servers(api, { matchHosts })));
  if (!admin) return { id, name, configured: true, tools };

  const protect = protectedIps(env);
  const notProtected = async (serverId) => (protect.length ? assertNotProtected(await getServer(api, serverId), protect) : null);
  const request = async (method, p, body) => {
    const { serverId, powerOn } = guardRequest(method, p, body);
    if (serverId && !powerOn) await notProtected(serverId);
    return redactSecrets(await api.request(method, p, { body }));
  };
  const SERVER = z.string().regex(SERVER_ID, "Kamatera server id (from kamatera_servers)");

  add("kamatera_power", {
    title: "Power a Kamatera server on or off, or reboot it",
    description: "poweron a stopped server, poweroff (a powered-off server still pays for its disk and IP: priceHourlyOff) or reboot a running one. Queued: answers with command ids, see GET /service/queue?id=<id> through kamatera_query. A server with a protected IP can only be powered on.",
    inputSchema: { serverId: SERVER, action: z.enum(["poweron", "poweroff", "reboot"]) },
    annotations: DESTRUCTIVE,
  }, adminTool("kamatera_power", async ({ serverId, action }) => {
    if (action !== "poweron") await notProtected(serverId);
    const commandIds = await api.request("POST", `/service/server/${action}`, { body: { id: serverId } });
    return { ok: true, serverId, action, commandIds };
  }));
  add("kamatera_delete", {
    title: "Delete a Kamatera server",
    description: "Permanently terminate one server and its disks (forced, even when powered on); billing stops. confirmName must repeat its name. Servers with a protected IP are refused.",
    inputSchema: { serverId: SERVER, confirmName: z.string() },
    annotations: DESTRUCTIVE,
  }, adminTool("kamatera_delete", async ({ serverId, confirmName }) => {
    assertNotProtected(await assertName(api, serverId, confirmName), protect);
    const commandIds = await api.request("POST", "/service/server/terminate", { body: { id: serverId, force: true } });
    return { ok: true, deleted: serverId, commandIds };
  }));
  add("kamatera_api_request", {
    title: "Call any Kamatera API endpoint",
    description:
      "Call any Kamatera cloudcli API endpoint (paths relative to https://cloudcli.cloudwm.com, literal, JSON body). Reads: GET /service/servers, GET /service/server?datacenter=1 (datacenters; AS is Hong Kong, AS-TY Tokyo), GET /service/server?capabilities=1&datacenter=AS (CPU types and cores, RAM, disk sizes, traffic packages), GET /service/server?images=1&datacenter=AS (image ids such as \"AS:6000C29...\"), POST /service/server/info {\"id\"}, GET /service/queue?id=<commandId>. " +
      "Create: POST /service/server {\"name\": \"hk-1\", \"password\": \"__generate__\", \"passwordValidate\": \"__generate__\", \"datacenter\": \"AS\", \"image\": \"<id from images, e.g. AS:...>\", \"cpu\": \"1A\", \"ram\": 1024, \"disk\": \"size=20\", \"dailybackup\": \"no\", \"managed\": \"no\", \"network\": \"name=wan,ip=auto\", \"quantity\": \"1\", \"billingcycle\": \"hourly\", \"monthlypackage\": \"t1000\", \"poweronaftercreate\": \"yes\", \"script-file\": \"#!/bin/bash\\nmkdir -p /root/.ssh\\necho <ssh_public_key, no quotes> >> /root/.ssh/authorized_keys\\nchmod 700 /root/.ssh; chmod 600 /root/.ssh/authorized_keys\\n\"} (answers with command ids, the server shows up in GET /service/servers when the command completes; disk and network are space-separated strings, not arrays). " +
      "Never send \"ssh-key\" (Kamatera rejects the ed25519 key with 400 General Error) and write the key unquoted in script-file (quotes are kept literally and break authorized_keys). " +
      "Changes to one server take {\"id\"} (never \"name\", which Kamatera treats as a regular expression): /service/server/rename {\"id\", \"new-name\"}, /server/configure {\"id\", \"cpu\" | \"ram\" | \"billingcycle\" | \"monthlypackage\"}, /server/disk, /server/network, /server/snapshot, /server/tags, /service/server/suspend, /service/server/resume. Deleting goes through kamatera_delete; reverting a snapshot, setting a password and console sessions are refused; changes to a server with a protected IP are refused; passwords in answers are redacted.",
    inputSchema: {
      method: z.enum(METHODS),
      path: z.string().regex(/^\//, "path starts with /").describe("e.g. /service/server/info"),
      body: z.any().optional(),
    },
    annotations: DESTRUCTIVE,
  }, adminTool("kamatera_api_request", ({ method, path: p, body }) => request(method, p, body)));
  add("kamatera_query", {
    title: "Read any Kamatera API endpoint",
    description:
      "Read-only twin of kamatera_api_request: GET any path (/service/servers, /service/server?datacenter=1, /service/server?capabilities=1&datacenter=AS, /service/server?images=1&datacenter=AS, /service/queue?id=<commandId>, /svc/queue), or POST {\"id\"} to the read-only " +
      [...READ_POSTS].join(", ") +
      " (/server/report takes {\"id\", \"year\", \"month\"} and gives traffic and usage; /server/statistics takes {\"id\", \"startdate\", \"enddate\", \"period\"}). Server action paths (power, terminate, password, rename...) are refused whatever the method. Changes nothing.",
    inputSchema: {
      path: z.string().regex(/^\//, "path starts with /").describe("e.g. /service/servers"),
      body: z.record(z.string(), z.any()).optional().describe("only for the read-only POST endpoints"),
    },
    annotations: READ,
  }, tool(async ({ path: p, body }) => {
    const bare = normalizePath(p).split("?")[0];
    if (READ_POSTS.has(bare.toLowerCase())) return request("POST", p, body || {});
    if (isChangePath(bare)) throw new Error(`${bare} changes a server; kamatera_query only reads (use kamatera_power or kamatera_api_request).`);
    if (body !== undefined) throw new Error(`kamatera_query sends a body only to ${[...READ_POSTS].join(", ")}.`);
    return request("GET", p);
  }));
  return { id, name, configured: true, tools };
}
