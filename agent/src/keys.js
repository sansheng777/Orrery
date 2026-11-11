// The agent's own SSH identity: $ORRERY_DIR/keys/id_ed25519, created on first use. Every server the
// agent monitors trusts this one public key; the private key never leaves the machine running the agent.
import fs from "node:fs";
import path from "node:path";
import ssh2 from "ssh2";
import { DATA_DIR } from "./inventory.js";

export const KEY_DIR = path.join(DATA_DIR, "keys");
export const KEY_PATH = path.join(KEY_DIR, "id_ed25519");

export function ensureKey(file = KEY_PATH) {
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const { private: priv, public: pub } = ssh2.utils.generateKeyPairSync("ed25519", { comment: "orrery" });
    fs.writeFileSync(file, priv, { mode: 0o600, flag: "wx" });
    fs.writeFileSync(file + ".pub", pub + "\n", { mode: 0o644 });
  }
  return file;
}

export function publicKey(file = KEY_PATH) {
  ensureKey(file);
  try {
    return fs.readFileSync(file + ".pub", "utf8").trim();
  } catch {
    // Only the private key was copied in: derive the public half.
    const parsed = ssh2.utils.parseKey(fs.readFileSync(file));
    const key = Array.isArray(parsed) ? parsed[0] : parsed;
    if (key instanceof Error) throw key;
    return `${key.type} ${key.getPublicSSH().toString("base64")} orrery`;
  }
}
