// Server inventory: a local JSON file plus read-only hosts from ~/.ssh/config.
// Credentials (key paths, passwords) never leave this machine.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const HOME = os.homedir();
export const DATA_DIR = process.env.ORRERY_DIR || path.join(HOME, ".orrery");
const FILE = path.join(DATA_DIR, "servers.json");
const SSH_CONFIG = process.env.ORRERY_SSH_CONFIG || path.join(HOME, ".ssh", "config");

export function expandHome(p) {
  if (!p) return p;
  return p === "~" || p.startsWith("~/") ? path.join(HOME, p.slice(1)) : p;
}

function readStore() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return Array.isArray(data.servers) ? data : { servers: [] };
  } catch {
    return { servers: [] };
  }
}

function writeStore(store) {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const tmp = FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

// Minimal ~/.ssh/config reader: concrete Host aliases with HostName/User/Port/IdentityFile.
export function readSshConfig(file = SSH_CONFIG) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const hosts = [];
  let current = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(\S+)\s*=?\s*(.+)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].replace(/^"|"$/g, "");
    if (key === "host") {
      current = value
        .split(/\s+/)
        .filter((a) => !/[*?!]/.test(a))
        .map((alias) => ({ alias, opts: {} }));
      hosts.push(...current);
    } else if (key === "match") {
      current = [];
    } else {
      for (const h of current) if (!(key in h.opts)) h.opts[key] = value;
    }
  }
  return hosts.map(({ alias, opts }) => ({
    id: "ssh:" + alias,
    name: alias,
    host: opts.hostname || alias,
    port: Number(opts.port) || 22,
    username: opts.user || os.userInfo().username,
    keyPath: opts.identityfile ? expandHome(opts.identityfile) : undefined,
    tags: ["ssh-config"],
    source: "ssh_config",
  }));
}

// Public shape: never includes the password.
function publicView(s) {
  const { password, ...rest } = s;
  return { ...rest, source: s.source || "local", auth: password ? "password" : s.keyPath ? "key" : "agent/default keys" };
}

export function listServers() {
  const local = readStore().servers;
  const fromConfig = readSshConfig().filter((c) => !local.some((s) => s.name === c.name));
  return [...local, ...fromConfig].map(publicView);
}

export function getServer(id) {
  const s = readStore().servers.find((x) => x.id === id) || readSshConfig().find((x) => x.id === id);
  if (!s) throw new Error(`Unknown server "${id}". Call list_servers to see the ids.`);
  return s;
}

export function addServer({ name, host, port = 22, username, keyPath, password, tags = [] }) {
  const store = readStore();
  if (store.servers.some((s) => s.name === name)) throw new Error(`A server named "${name}" already exists.`);
  const server = {
    id: crypto.randomUUID().slice(0, 8),
    name,
    host,
    port,
    username,
    ...(keyPath ? { keyPath: expandHome(keyPath) } : {}),
    ...(password ? { password } : {}),
    tags,
    createdAt: new Date().toISOString(),
  };
  store.servers.push(server);
  writeStore(store);
  return publicView(server);
}

export function updateServer(id, patch) {
  const store = readStore();
  const s = store.servers.find((x) => x.id === id);
  if (!s) throw new Error(`Only servers added here can be edited; "${id}" was not found (ssh_config entries are edited in ~/.ssh/config).`);
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (v === null || v === "") delete s[k];
    else s[k] = k === "keyPath" ? expandHome(v) : v;
  }
  writeStore(store);
  return publicView(s);
}

export function removeServer(id) {
  const store = readStore();
  const before = store.servers.length;
  store.servers = store.servers.filter((s) => s.id !== id);
  if (store.servers.length === before) throw new Error(`Only servers added here can be removed; "${id}" was not found.`);
  writeStore(store);
  return { removed: id };
}
