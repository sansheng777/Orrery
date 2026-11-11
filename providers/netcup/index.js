// netcup for Orrery: servers and their live state from the SCP REST API
// (https://www.servercontrolpanel.de/scp-core/api/v1/openapi).
// netcup has no read-only token: the refresh token can do everything the SCP account can. The dashboard
// tool here only ever sends GET requests, and only to the paths in READ_PATHS. The control tools live in
// admin.js and are registered only by the admin agent (ORRERY_ROLE=admin).
import fs from "node:fs";
import path from "node:path";
import { registerAdmin } from "./admin.js";

export const id = "netcup";
export const name = "netcup";

export const SCP = "https://www.servercontrolpanel.de";
export const TOKEN_URL = `${SCP}/realms/scp/protocol/openid-connect/token`;
export const API = `${SCP}/scp-core`;
const READ_PATHS = [/^\/api\/v1\/servers\?limit=\d+&offset=\d+$/, /^\/api\/v1\/servers\/\d+\?loadServerLiveInfo=true$/];
const TIMEOUT_MS = 15000;
const PAGE = 100;

// The refresh token comes from NETCUP_REFRESH_TOKEN or $ORRERY_DIR/netcup.json ({"refreshToken": "..."}).
// netcup's Keycloak may rotate it on use; a rotated token is written back to that file.
export function loadConfig(env = process.env, dataDir) {
  if (env.NETCUP_REFRESH_TOKEN) return { configured: true, refreshToken: env.NETCUP_REFRESH_TOKEN, file: null };
  const file = dataDir && path.join(dataDir, "netcup.json");
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (data.refreshToken) return { configured: true, refreshToken: data.refreshToken, file };
    return { configured: false, error: `${file}: refreshToken is missing` };
  } catch (e) {
    return e.code === "ENOENT" || !file ? { configured: false } : { configured: false, error: `${file}: ${e.code ? e.message : "not valid JSON"}` }; // never echo file content
  }
}

export function saveRefreshToken(file, refreshToken) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ refreshToken }, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// One session per credentials file (or NETCUP_REFRESH_TOKEN), shared by every request the agent serves.
// Callers re-read the file, so after a rotation they carry a token the session has already held; only a
// token it never held (login.js was run again) starts a new session.
const sessions = new Map(); // config.file ?? refresh token -> { refreshToken, held, accessToken, expiresAt, pending }
const HELD_MAX = 32; // rotated tokens remembered per session; the first one is always kept

export async function accessToken(config, fetchImpl, force = false) {
  const key = config.file ?? config.refreshToken;
  let s = sessions.get(key);
  if (!s || !s.held.has(config.refreshToken)) {
    sessions.set(key, (s = { refreshToken: config.refreshToken, held: new Set([config.refreshToken]), accessToken: null, expiresAt: 0, pending: null }));
  }
  if (!force && s.accessToken && Date.now() < s.expiresAt) return s.accessToken;
  s.pending ??= (async () => {
    const res = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: "scp", grant_type: "refresh_token", refresh_token: s.refreshToken }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) {
      const why = body.error ? `${body.error}${body.error_description ? ": " + body.error_description : ""}` : `HTTP ${res.status}`;
      throw new Error(`netcup rejected the refresh token (${why}). Sign in again with providers/netcup/login.js (see docs/providers.md, netcup).`);
    }
    if (body.refresh_token && body.refresh_token !== s.refreshToken) {
      s.refreshToken = body.refresh_token;
      s.held.add(body.refresh_token);
      if (s.held.size > HELD_MAX) s.held.delete([...s.held][1]);
      if (config.file) {
        try {
          saveRefreshToken(config.file, body.refresh_token);
        } catch (e) {
          console.error(`netcup: could not save the rotated refresh token to ${config.file}: ${e.message}`);
        }
      }
    }
    s.accessToken = body.access_token;
    s.expiresAt = Date.now() + Math.max(30, (Number(body.expires_in) || 300) - 30) * 1000;
    return s.accessToken;
  })().finally(() => (s.pending = null));
  return s.pending;
}

async function scpGet(config, pathAndQuery, fetchImpl) {
  if (!READ_PATHS.some((re) => re.test(pathAndQuery))) throw new Error(`${pathAndQuery} is not an allowed read-only path`);
  for (let attempt = 0; ; attempt++) {
    const token = await accessToken(config, fetchImpl, attempt > 0);
    const res = await fetchImpl(API + pathAndQuery, {
      method: "GET",
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401 && attempt === 0) continue;
    const text = await res.text();
    if (!res.ok) {
      let msg = text.slice(0, 300);
      try {
        const j = JSON.parse(text);
        msg = j.message || j.code || msg;
      } catch {}
      throw new Error(`netcup SCP ${res.status}: ${msg || res.statusText}`);
    }
    return JSON.parse(text);
  }
}

// Server (GET /api/v1/servers/{id}?loadServerLiveInfo=true) -> the shape the dashboard shows.
export function toServer(s) {
  const live = s.serverLiveInfo || null;
  const ipv4 = new Set((s.ipv4Addresses || []).map((a) => a.ip).filter(Boolean));
  const ipv6 = new Set((s.ipv6Addresses || []).map((a) => (a.networkPrefix ? `${a.networkPrefix}/${a.networkPrefixLength ?? 64}` : null)).filter(Boolean));
  for (const nic of live?.interfaces || []) for (const ip of nic.ipv4Addresses || []) ipv4.add(ip);
  const diskMiB = (live?.disks || []).reduce((n, d) => n + (d.capacityInMiB || 0), 0);
  return {
    id: s.id,
    name: s.name,
    nickname: s.nickname || null,
    hostname: s.hostname || null,
    state: live?.state || null, // RUNNING, SHUTOFF, PAUSED, ... (null when live info is unavailable)
    disabled: !!s.disabled,
    site: s.site?.city || null,
    architecture: s.architecture || null,
    product: s.template?.name || null,
    cpuCount: live?.cpuCount ?? null,
    memoryMiB: live?.currentServerMemoryInMiB || live?.maxServerMemoryInMiB || null, // a stopped server reports 0 current memory
    diskMiB: diskMiB || null,
    uptimeSec: live?.uptimeInSeconds ?? null,
    configChanged: !!live?.configChanged,
    rescueSystemActive: !!s.rescueSystemActive,
    snapshotCount: s.snapshotCount ?? null,
    ipv4: [...ipv4],
    ipv6: [...ipv6],
  };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

export async function servers(config, { matchHosts, fetchImpl = fetch } = {}) {
  const minimal = [];
  for (let offset = 0; offset < 2000; offset += PAGE) {
    const page = await scpGet(config, `/api/v1/servers?limit=${PAGE}&offset=${offset}`, fetchImpl);
    if (!Array.isArray(page)) throw new Error("Unexpected response from GET /api/v1/servers");
    minimal.push(...page);
    if (page.length < PAGE) break;
  }
  const match = matchHosts ? await matchHosts() : () => null;
  const list = await mapLimit(minimal, 4, async (m) => {
    let s;
    try {
      s = { ...toServer(await scpGet(config, `/api/v1/servers/${Number(m.id)}?loadServerLiveInfo=true`, fetchImpl)), error: null };
    } catch (e) {
      s = { ...toServer(m), error: e.message };
    }
    s.server = match([...s.ipv4, ...s.ipv6.map((p) => p.split("/")[0])]);
    return s;
  });
  return { servers: list, collectedAt: new Date().toISOString() };
}

export function register(server, ctx) {
  const { tool, READ, admin, env, dataDir, matchHosts } = ctx;
  const config = loadConfig(env, dataDir);
  if (!config.configured) return { id, name, configured: false, error: config.error || null, tools: [] };
  // Re-read on every call, so each request carries the refresh token the file holds now.
  const current = () => {
    const c = loadConfig(env, dataDir);
    if (!c.configured) throw new Error(c.error || "netcup credentials are missing. Sign in again with providers/netcup/login.js.");
    return c;
  };
  server.registerTool(
    "netcup_servers",
    {
      title: "netcup servers",
      description:
        "netcup servers from the SCP REST API with live state (RUNNING, SHUTOFF, ...), location, CPU, memory, uptime and IPs. Each carries the matching Orrery server (by public IP), if any.",
      annotations: READ,
    },
    tool(() => servers(current(), { matchHosts })),
  );
  const tools = ["netcup_servers"];
  if (admin) tools.push(...registerAdmin(server, ctx, current));
  return { id, name, configured: true, tools };
}
