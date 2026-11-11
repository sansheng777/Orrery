// Append-only log of every change made through the admin connector: $ORRERY_DIR/audit.log, one
// JSON line per call with the tool, its arguments (secrets redacted), the outcome and the duration.
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./inventory.js";

const SECRET = /pass(word)?|secret|token|private|customScript/i;

export function redact(value, key = "") {
  if (SECRET.test(key)) return "[redacted]";
  if (Array.isArray(value)) return value.map((v) => redact(v));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]));
  return value;
}

export function auditLine(entry, file = path.join(DATA_DIR, "audit.log")) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, JSON.stringify(entry) + "\n", { mode: 0o600 });
  } catch (e) {
    console.error(`audit log not written: ${e.message}`);
  }
  console.error(`[admin] ${entry.tool} ${entry.ok ? "ok" : "failed"} ${JSON.stringify(entry.args)}${entry.error ? " " + entry.error : ""}`);
}

export const audited = (name, fn, log = auditLine) => async (args) => {
  const started = Date.now();
  const base = { time: new Date(started).toISOString(), tool: name, args: redact(args ?? {}) };
  try {
    const result = await fn(args ?? {});
    log({ ...base, ok: true, ms: Date.now() - started });
    return result;
  } catch (e) {
    log({ ...base, ok: false, error: e?.message || String(e), ms: Date.now() - started });
    throw e;
  }
};
