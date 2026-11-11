// Pinned SSH host keys ($ORRERY_DIR/known_hosts.json, keyed by server id). The first connection to a
// server records the key it proved to hold (trust on first use); every later connection must present a
// pinned one. A different key means the server was reinstalled or replaced, or that something else
// answers at its address: the connection is refused until accept_host_key confirms the new key.
// Keyed by server id rather than address, so a machine keeps its pin when its IP changes and a new
// machine that inherits an IP starts fresh.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "./inventory.js";

const file = () => path.join(DATA_DIR, "known_hosts.json");

export const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;
// The fingerprint OpenSSH prints (ssh-keygen -lf): SHA-256 of the public key blob, base64 without padding.
export const fingerprint = (keyBlob) => "SHA256:" + crypto.createHash("sha256").update(keyBlob).digest("base64").replace(/=+$/, "");

// Only a missing file means "nothing pinned yet". A file that cannot be read or is not what this
// module wrote throws, and the caller refuses the connection: failing open here would accept any key
// and then overwrite every other server's pin.
function read() {
  let text;
  try {
    text = fs.readFileSync(file(), "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return {};
    throw new Error(`cannot read ${file()}: ${e.code || e.message}`);
  }
  let all = null;
  try {
    all = JSON.parse(text);
  } catch {
    // reported below
  }
  if (!all || typeof all !== "object" || Array.isArray(all)) throw new Error(`${file()} is damaged. Restore it, or delete it to pin every server afresh.`);
  return all;
}

// Reads and writes are synchronous, so two connections checking at once cannot lose each other's pin.
function write(all) {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${file()}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file());
}

export const pinned = (serverId) => {
  const list = read()[serverId]?.fingerprints;
  return Array.isArray(list) ? list.filter((f) => FINGERPRINT.test(f)) : [];
};

// Replaces the pinned keys of a server (first use, accept_host_key, or keys a provider's API vouches for).
export function pin(serverId, fingerprints) {
  const all = read();
  all[serverId] = { fingerprints: [...new Set(fingerprints)], at: new Date().toISOString() };
  write(all);
}

export function forget(serverId) {
  const all = read();
  if (!(serverId in all)) return;
  delete all[serverId];
  write(all);
}

// { ok: true } when the key is pinned for this server; { ok: true, first: true } when nothing is
// pinned yet (the caller pins it once the server has proved it holds the key); otherwise
// { ok: false, expected } with the pinned fingerprints.
export function check(serverId, fp) {
  const expected = pinned(serverId);
  if (!expected.length) return { ok: true, first: true };
  return expected.includes(fp) ? { ok: true } : { ok: false, expected };
}

// The keys Orrery refused lately, per server. accept_host_key takes only one of these, so text that
// merely looks like a refusal (in a server's output, say) cannot get another key accepted.
const REFUSED_MS = 60 * 60 * 1000;
const refused = new Map(); // serverId -> { fingerprint, at }
export const noteRefused = (serverId, fp) => refused.set(serverId, { fingerprint: fp, at: Date.now() });
export function wasRefused(serverId, fp) {
  const r = refused.get(serverId);
  return !!r && r.fingerprint === fp && Date.now() - r.at < REFUSED_MS;
}
