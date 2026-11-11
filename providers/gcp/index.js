// Google Cloud Compute Engine for Orrery, through the Compute Engine REST API v1
// (https://cloud.google.com/compute/docs/reference/rest/v1). Google's managed Compute Engine MCP server
// (https://compute.googleapis.com/mcp) needs a per-project OAuth client and has none of the checks below
// (protected machines, name confirmation, audit log), so control lives here: gcp_instances for both
// agents; power, delete and any other Compute Engine call only on the admin agent. A service account key
// signs its own token (RS256 JWT), so there is no SDK and no dependency.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const id = "gcp";
export const name = "Google Cloud";

export const API = "https://compute.googleapis.com/compute/v1";
export const SCOPE = "https://www.googleapis.com/auth/compute";
export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
// The login user ssh_bootstrap creates on Compute Engine instances through ssh-keys metadata (Google's
// guest agent gives it sudo). Set ORRERY_GCP_SSH_USER to keep a user your machines already trust.
export const SSH_USER = process.env.ORRERY_GCP_SSH_USER || "orrery";
const TIMEOUT_MS = 30000;
const PROJECT = /^[a-z][a-z0-9.:-]{4,62}$/; // includes domain-scoped ids such as example.com:my-project
const RESOURCE = /^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/;

// $ORRERY_DIR/gcp.json is a service account key exactly as Google hands it out (type, project_id,
// client_email, private_key, token_uri). Projects other than the key's own go in "projects" (or
// GCP_PROJECTS, comma separated); the service account needs roles in each of them.
export function loadConfig(env = process.env, dataDir) {
  const file = dataDir && path.join(dataDir, "gcp.json");
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return e.code === "ENOENT" || !file ? { configured: false } : { configured: false, error: `${file}: ${e.code ? e.message : "not valid JSON"}` }; // never echo file content
  }
  if (data.type !== "service_account" || !data.client_email || !data.private_key) {
    return { configured: false, error: `${file}: not a service account key (needs type "service_account", client_email and private_key)` };
  }
  const projects = (env.GCP_PROJECTS ? env.GCP_PROJECTS.split(/[\s,]+/) : Array.isArray(data.projects) && data.projects.length ? data.projects : [data.project_id])
    .map((p) => String(p || "").trim())
    .filter(Boolean);
  const bad = projects.filter((p) => !PROJECT.test(p));
  if (!projects.length || bad.length) return { configured: false, error: `${file}: invalid or missing project id ${bad.join(", ")}`.trim() };
  return { configured: true, clientEmail: data.client_email, privateKey: data.private_key, tokenUri: data.token_uri || "https://oauth2.googleapis.com/token", projects: [...new Set(projects)] };
}

export class GcpError extends Error {
  constructor(status, body, method, p) {
    const e = body?.error;
    const reason = typeof e === "string" ? `${e}${body.error_description ? ": " + body.error_description : ""}` : e?.message || "";
    super(`Google Cloud ${method} ${p} failed with ${status}${reason ? ": " + reason : ""}`);
    this.status = status;
  }
}

const b64url = (s) => Buffer.from(s).toString("base64url");

// A signed JWT the token endpoint trades for an access token (RFC 7523, as Google's client libraries do).
export function signedJwt(config, nowSec = Math.floor(Date.now() / 1000)) {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: config.clientEmail, scope: SCOPE, aud: config.tokenUri, iat: nowSec, exp: nowSec + 3600 }));
  const signature = crypto.sign("RSA-SHA256", Buffer.from(`${header}.${claims}`), config.privateKey).toString("base64url");
  return `${header}.${claims}.${signature}`;
}

// The path exactly as fetch will send it (see linode/normalizePath): no dot or empty segments, no escapes.
export function normalizePath(pathAndQuery) {
  const [p, query] = String(pathAndQuery).split(/\?(.*)/s);
  if (!/^(\/[\w\-.:,]+)+\/?$/.test(p) || p.split("/").some((seg) => seg === "." || seg === "..")) throw new Error(`Invalid Compute Engine API path: ${pathAndQuery}`);
  if (!p.startsWith("/projects/")) throw new Error(`Compute Engine API paths start with /projects/{project}: ${pathAndQuery}`);
  if (query !== undefined && !/^[\w\-.,:=&+]*$/.test(query)) throw new Error(`Invalid Compute Engine API query: ${pathAndQuery}`);
  return p.replace(/\/$/, "") + (query ? `?${query}` : "");
}

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createApi(config, fetchImpl = fetch, { retryWaitMs = 1000, now = () => Date.now() } = {}) {
  let token = null; // { value, expiresAt }

  async function accessToken() {
    if (token && now() < token.expiresAt) return token.value;
    const res = await fetchImpl(config.tokenUri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: signedJwt(config, Math.floor(now() / 1000)) }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.access_token) {
      const err = new GcpError(res.status, body, "POST", "token");
      err.message += " (the service account key is invalid, deleted or disabled; see docs/providers.md, Google Cloud)";
      throw err;
    }
    token = { value: body.access_token, expiresAt: now() + Math.max(60, (body.expires_in || 3600) - 300) * 1000 };
    return token.value;
  }

  // query: extra parameters encoded here (page tokens carry characters a literal path may not).
  async function request(method, pathAndQuery, { body, query } = {}) {
    if (!METHODS.includes(method)) throw new Error(`Unsupported method ${method}`);
    let p = normalizePath(pathAndQuery);
    if (query) p += (p.includes("?") ? "&" : "?") + new URLSearchParams(query).toString();
    const headers = { authorization: `Bearer ${await accessToken()}`, accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    // GETs are retried once on rate limiting or a 5xx; a change is never sent twice.
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(API + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {}
      if (res.ok) return json ?? {};
      if (method === "GET" && attempt === 0 && RETRY_STATUS.has(res.status)) {
        await sleep(retryWaitMs);
        continue;
      }
      const err = new GcpError(res.status, json, method, p);
      if (res.status === 403 && /has not been used|is disabled/i.test(err.message)) err.message += " (enable the Compute Engine API in that project)";
      throw err;
    }
  }
  return { request, accessToken };
}

const last = (url) => String(url || "").split("/").pop() || null;

// Compute Engine instance -> the shape the tools return.
export function toInstance(i, project) {
  const nics = i.networkInterfaces || [];
  const meta = Object.fromEntries((i.metadata?.items || []).map((m) => [m.key, m.value]));
  return {
    id: i.id ? String(i.id) : null,
    name: i.name,
    project,
    zone: last(i.zone),
    status: i.status || null, // RUNNING, TERMINATED (stopped), STOPPING, SUSPENDED, PROVISIONING, STAGING, REPAIRING
    machineType: last(i.machineType),
    externalIp: nics.flatMap((n) => (n.accessConfigs || []).map((a) => a.natIP)).find(Boolean) || null,
    internalIp: nics[0]?.networkIP || null,
    ipv6: nics.flatMap((n) => (n.ipv6AccessConfigs || []).map((a) => a.externalIpv6)).find(Boolean) || null,
    spot: i.scheduling?.provisioningModel === "SPOT" || !!i.scheduling?.preemptible,
    deletionProtection: !!i.deletionProtection,
    osLogin: /^true$/i.test(meta["enable-oslogin"] || "") ? true : /^false$/i.test(meta["enable-oslogin"] || "") ? false : null, // null: the project decides
    labels: i.labels || {},
    created: i.creationTimestamp || null,
  };
}

// Every instance in every configured project. One project failing (API disabled, no permission) is
// reported in projects[].error and does not hide the others.
export async function instances(api, config, { matchHosts } = {}) {
  const projects = await Promise.all(
    config.projects.map(async (project) => {
      const list = [];
      try {
        let pageToken = "";
        for (let page = 0; page < 20; page++) {
          const body = await api.request("GET", `/projects/${project}/aggregated/instances?maxResults=500&returnPartialSuccess=true`, { query: pageToken ? { pageToken } : undefined });
          for (const scope of Object.values(body.items || {})) for (const i of scope.instances || []) list.push(toInstance(i, project));
          if (!body.nextPageToken) break;
          pageToken = body.nextPageToken;
        }
        return { project, list, error: null };
      } catch (e) {
        return { project, list, error: e.message };
      }
    }),
  );
  const list = projects.flatMap((p) => p.list);
  if (list.length === 0 && projects.every((p) => p.error)) throw new Error(projects.map((p) => `${p.project}: ${p.error}`).join("; "));
  const match = matchHosts ? await matchHosts() : () => null;
  for (const i of list) i.server = match([i.externalIp, i.ipv6].filter(Boolean));
  return { instances: list, projects: projects.map(({ project, list, error }) => ({ project, count: list.length, error })), collectedAt: new Date().toISOString() };
}

// project, zone and instance name, checked before they go into a path.
export function target({ project, zone, name: instance }) {
  if (!PROJECT.test(String(project))) throw new Error(`Invalid project id: ${project}`);
  if (!/^[a-z]+-[a-z]+\d+-[a-z]$/.test(String(zone))) throw new Error(`Invalid zone: ${zone}`);
  if (!RESOURCE.test(String(instance))) throw new Error(`Invalid instance name: ${instance}`);
  return `/projects/${project}/zones/${zone}/instances/${instance}`;
}

// Custom methods on the instances collection itself, not on an instance of that name.
export const COLLECTION_VERBS = new Set(["bulkInsert"]);

// Requests the generic tool refuses: deleting an instance goes through gcp_delete, which asks for its
// name; deleting a disk erases its data and is left to the console; so are managed instance group calls
// that delete, recreate or abandon members, shrink the group or delete it, since they reach instances (a
// protected one among them) without naming them.
export function guardRequest(method, p) {
  const bare = normalizePath(p).split("?")[0];
  if (method === "DELETE" && /^\/projects\/[^/]+\/zones\/[^/]+\/instances\/[^/]+$/.test(bare)) throw new Error("Deleting an instance goes through gcp_delete, which asks for its name.");
  if (method === "DELETE" && /^\/projects\/[^/]+\/(zones|regions)\/[^/]+\/disks\/[^/]+$/.test(bare)) throw new Error("Deleting a disk erases its data; do it in the Google Cloud console.");
  const mig = bare.match(/^\/projects\/[^/]+\/(?:zones|regions)\/[^/]+\/instanceGroupManagers\/[^/]+(\/(?:deleteInstances|recreateInstances|abandonInstances|resize))?$/i);
  if (mig && (mig[1] ? method === "POST" : method === "DELETE")) {
    throw new Error(`${method} ${bare} deletes, recreates, detaches or resizes away instances of a managed instance group (or deletes the group) without naming them, so a protected instance could be among them; do it in the Google Cloud console.`);
  }
}

// ORRERY_SELF_IP plus ORRERY_PROTECTED_IPS: instances a chat may start but never stop, reset,
// delete or change.
export const protectedIps = (env = process.env) =>
  [...new Set([env.ORRERY_SELF_IP, ...String(env.ORRERY_PROTECTED_IPS || "").split(/[\s,]+/)].map((ip) => String(ip || "").trim().toLowerCase()).filter(Boolean))];

export function assertNotProtected(i, protect) {
  const ip = [i.externalIp, i.ipv6].find((a) => a && protect.includes(String(a).toLowerCase()));
  if (ip) throw new Error(`Refusing: instance ${i.name} (${i.project}/${i.zone}) has the protected IP ${ip} (ORRERY_SELF_IP or ORRERY_PROTECTED_IPS) and must keep running. Do this in the Google Cloud console if you really mean it.`);
  return i;
}

export async function getInstance(api, t) {
  return toInstance(await api.request("GET", target(t)), t.project);
}

// Waits for a zonal operation (start, stop, setMetadata, ...) to finish and throws its error, if any.
export async function waitOperation(api, project, zone, op, { timeoutMs = 90000, pollMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let cur = op;
  while (cur.status !== "DONE") {
    if (Date.now() > deadline) throw new Error(`Operation ${op.name} still ${cur.status} after ${Math.round(timeoutMs / 1000)}s`);
    await sleep(pollMs);
    cur = await api.request("GET", `/projects/${project}/zones/${zone}/operations/${op.name}`);
  }
  if (cur.error?.errors?.length) throw new Error(`Operation ${op.name} failed: ${cur.error.errors.map((e) => e.message || e.code).join("; ")}`);
  return cur;
}

// ssh_bootstrap: adds "user:key" to the instance's ssh-keys metadata. Google's guest agent creates the
// user (with sudo) and installs the key within seconds; no restart. OS Login ignores metadata keys, so
// an instance under OS Login is refused with the reason.
export async function addSshKey(api, { project, zone, name: instance, user = SSH_USER, publicKey }, waitOpts) {
  const p = target({ project, zone, name: instance });
  const inst = await api.request("GET", p);
  const items = inst.metadata?.items || [];
  const own = items.find((m) => m.key === "enable-oslogin")?.value;
  let osLogin = /^true$/i.test(own || "");
  if (own === undefined) {
    const proj = await api.request("GET", `/projects/${project}`);
    osLogin = /^true$/i.test((proj.commonInstanceMetadata?.items || []).find((m) => m.key === "enable-oslogin")?.value || "");
  }
  if (osLogin) throw new Error(`Instance ${instance} has OS Login on (enable-oslogin=TRUE), which ignores keys in metadata. Set enable-oslogin to FALSE in the instance metadata, or add the key from ssh_public_key to authorized_keys on the instance by hand`);
  const line = `${user}:${publicKey}`;
  const current = items.find((m) => m.key === "ssh-keys")?.value || "";
  if (current.split("\n").some((l) => l.trim() === line)) return { changed: false, user };
  const next = [...items.filter((m) => m.key !== "ssh-keys"), { key: "ssh-keys", value: current ? `${current.replace(/\n+$/, "")}\n${line}` : line }];
  const op = await api.request("POST", `${p}/setMetadata`, { body: { fingerprint: inst.metadata?.fingerprint, items: next } });
  await waitOperation(api, project, zone, op, waitOpts);
  return { changed: true, user };
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

  add("gcp_instances", {
    title: "Google Cloud instances",
    description: `Compute Engine instances in every zone of the configured projects (${config.projects.join(", ")}): status, machine type, external and internal IP, IPv6, spot, deletion protection, OS Login, labels. Each carries the matching Orrery server (by public IP), if any.`,
    annotations: READ,
  }, tool(() => instances(api, config, { matchHosts })));
  if (!admin) return { id, name, configured: true, projects: config.projects, tools };
  const request = async (method, p, body) => {
    guardRequest(method, p);
    const m = normalizePath(p).split("?")[0].match(/^\/projects\/([^/]+)\/zones\/([^/]+)\/instances\/([^/]+)(\/[^/]+)?$/);
    if (method !== "GET" && m && !(COLLECTION_VERBS.has(m[3]) && !m[4]) && m[4] !== "/start" && m[4] !== "/resume") await notProtected({ project: m[1], zone: m[2], name: m[3] });
    return api.request(method, p, { body });
  };

  const protect = protectedIps(env);
  const notProtected = async (t) => {
    if (protect.length) assertNotProtected(await getInstance(api, t), protect);
  };
  const where = {
    project: z.string().describe(`Project id (from gcp_instances; configured: ${config.projects.join(", ")})`),
    zone: z.string().describe("Zone, e.g. asia-east1-b"),
    name: z.string().describe("Instance name"),
  };
  add("gcp_power", {
    title: "Start, stop, reset, suspend or resume a Compute Engine instance",
    description: "start or resume a stopped/suspended instance; stop (clean shutdown), reset (hard restart) or suspend a running one. Returns the operation; follow it with gcp_query /projects/{project}/zones/{zone}/operations/{name}. An instance with a protected IP can only be started or resumed.",
    inputSchema: { ...where, action: z.enum(["start", "stop", "reset", "suspend", "resume"]) },
    annotations: DESTRUCTIVE,
  }, adminTool("gcp_power", async ({ project, zone, name: instance, action }) => {
    const t = { project, zone, name: instance };
    if (action !== "start" && action !== "resume") await notProtected(t);
    const op = await api.request("POST", `${target(t)}/${action}`);
    return { ok: true, project, zone, name: instance, action, operation: op.name, status: op.status };
  }));
  add("gcp_delete", {
    title: "Delete a Compute Engine instance",
    description: "Permanently delete one instance (and the disks set to auto-delete with it, usually the boot disk). confirmName must repeat the instance name. Instances with a protected IP are refused; Google refuses instances with deletion protection on.",
    inputSchema: { ...where, confirmName: z.string() },
    annotations: DESTRUCTIVE,
  }, adminTool("gcp_delete", async ({ project, zone, name: instance, confirmName }) => {
    const t = { project, zone, name: instance };
    const i = await getInstance(api, t);
    if (String(confirmName || "").trim() !== i.name) throw new Error(`Refusing: confirmName must be "${i.name}".`);
    assertNotProtected(i, protect);
    const op = await api.request("DELETE", target(t));
    return { ok: true, deleted: `${project}/${zone}/${instance}`, operation: op.name, status: op.status };
  }));
  add("gcp_api_request", {
    title: "Call any Compute Engine API endpoint",
    description:
      "Call any Compute Engine API v1 endpoint, e.g. GET /projects/{p}/zones (zones), GET /projects/{p}/zones/{z}/machineTypes, GET /projects/{p}/global/images/family/... or /projects/debian-cloud/global/images/family/debian-12, POST /projects/{p}/zones/{z}/instances (create; put the ssh_public_key in metadata ssh-keys as \"orrery:<key>\"), POST .../instances/{name}/setMachineType, setLabels, setMetadata, GET /projects/{p}/global/firewalls, POST /projects/{p}/global/firewalls, GET /projects/{p}/zones/{z}/operations/{op}. Paths are relative to https://compute.googleapis.com/compute/v1, start with /projects/ and must be literal (no {placeholders}). Label short-lived test instances test=true so they are easy to find and delete. Deleting an instance goes through gcp_delete; deleting disks, managed instance group calls that delete, recreate, abandon or resize members (or delete the group) and changes to an instance with a protected IP are refused. Can change or delete anything else Compute Engine offers in the configured projects.",
    inputSchema: {
      method: z.enum(METHODS),
      path: z.string().regex(/^\/projects\//, "path starts with /projects/").describe("e.g. /projects/my-project/zones/asia-east1-b/instances"),
      body: z.any().optional(),
    },
    annotations: DESTRUCTIVE,
  }, adminTool("gcp_api_request", ({ method, path: p, body }) => request(method, p, body)));
  add("gcp_query", {
    title: "Read any Compute Engine API endpoint",
    description:
      "Read-only twin of gcp_api_request: GET any Compute Engine API v1 endpoint in the configured projects, e.g. /projects/{p}/zones, /projects/{p}/zones/{z}/instances/{name}, /projects/{p}/zones/{z}/machineTypes, /projects/{p}/global/firewalls, /projects/{p}/global/snapshots, /projects/{p}/zones/{z}/disks, /projects/{p}/zones/{z}/operations/{op}, /projects/{p}/zones/{z}/instances/{name}/serialPort?port=1. Literal paths relative to https://compute.googleapis.com/compute/v1, starting with /projects/. Changes nothing.",
    inputSchema: { path: z.string().regex(/^\/projects\//, "path starts with /projects/").describe("e.g. /projects/my-project/zones/asia-east1-b/instances") },
    annotations: READ,
  }, tool(({ path: p }) => request("GET", p)));
  return { id, name, configured: true, projects: config.projects, tools };
}
