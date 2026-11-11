// Append-only log of every change made through the admin connector: $ORRERY_DIR/audit.log, one
// JSON line per call with the tool, its arguments (secrets redacted), the outcome and the duration.
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./inventory.js";

const SECRET = /pass(word)?|secret|token|private|customScript/i;

const PAIR_KEY = ["key", "Key", "name", "Name"];
const PAIR_VALUE = ["value", "Value", "values", "Values"];

// Redacts by field name, and also the value of key/value pairs whose key looks secret
// (AWS tags {Key, Value}, metadata items {key, value}, environment entries {name, value}).
export function redact(value, key = "") {
  if (SECRET.test(key)) return "[redacted]";
  if (Array.isArray(value)) return value.map((v) => redact(v));
  if (value && typeof value === "object") {
    const pairKey = PAIR_KEY.map((k) => value[k]).find((k) => typeof k === "string");
    const secretPair = pairKey !== undefined && SECRET.test(pairKey);
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, secretPair && PAIR_VALUE.includes(k) ? "[redacted]" : redact(v, k)]));
  }
  return value;
}

export function auditLine(entry, file = path.join(DATA_DIR, "audit.log")) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, JSON.stringify(entry) + "\n", { mode: 0o600 });
  } catch (e) {
    console.error(`audit log not written: ${e.message}`);
  }
  // JSON keeps a newline in an argument or an error from starting a line that looks like another entry.
  console.error(`[admin] ${entry.tool} ${entry.started ? "started" : entry.ok ? "ok" : "failed"} ${JSON.stringify(entry.args)}${entry.error ? " " + JSON.stringify(entry.error) : ""}`);
}

// These can stop Orrery itself (a reboot or "docker compose down" on its own host), and then the
// line written when a call returns never comes: they are also logged when they start.
const LOGGED_AT_START = new Set(["run_command", "container_action"]);

export const audited = (name, fn, log = auditLine) => async (args) => {
  const started = Date.now();
  const base = { time: new Date(started).toISOString(), tool: name, args: redact(args ?? {}) };
  if (LOGGED_AT_START.has(name)) log({ ...base, started: true });
  try {
    const result = await fn(args ?? {});
    log({ ...base, ok: true, ms: Date.now() - started });
    return result;
  } catch (e) {
    log({ ...base, ok: false, error: e?.message || String(e), ms: Date.now() - started });
    throw e;
  }
};
