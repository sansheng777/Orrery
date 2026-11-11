// Pinned SSH host keys ($ORRERY_DIR/known_hosts.json, keyed by server id). The first connection to a
// server records the key it presents (trust on first use); every later connection must present a
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

function read() {
  try {
    return JSON.parse(fs.readFileSync(file(), "utf8"));
  } catch {
    return {};
  }
}

// Reads and writes are synchronous, so two connections checking at once cannot lose each other's pin.
function write(all) {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file() + ".tmp", JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(file() + ".tmp", file());
}

export const pinned = (serverId) => read()[serverId]?.fingerprints || [];

// Replaces the pinned keys of a server (accept_host_key, or keys a provider's API vouches for).
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

// { ok: true } when the key is pinned for this server, or is the first one seen (and is pinned now);
// otherwise { ok: false, expected } with the pinned fingerprints.
export function check(serverId, fp) {
  const expected = pinned(serverId);
  if (!expected.length) pin(serverId, [fp]);
  return expected.length && !expected.includes(fp) ? { ok: false, expected } : { ok: true };
}
