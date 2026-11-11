// The SSH connection pool and command output, with a fake ssh2 (test/fake-ssh2.js) instead of real servers.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";

register("./fake-ssh2.js", import.meta.url);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "orrery-pool-"));
process.env.ORRERY_DIR = dataDir;

// The pool's 5-minute idle timers are captured instead of armed, so the test can fire one by hand.
const IDLE_MS = 5 * 60 * 1000;
const idle = [];
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
globalThis.setTimeout = (fn, ms, ...args) => {
  if (ms !== IDLE_MS) return realSetTimeout(fn, ms, ...args);
  const t = { fn, cleared: false, unref: () => t };
  idle.push(t);
  return t;
};
globalThis.clearTimeout = (t) => (idle.includes(t) ? (t.cleared = true) : realClearTimeout(t));

const { exec, dropConnections, closeAll } = await import("../src/ssh.js");
const { Client, clients } = await import("ssh2");

const keyPath = path.join(dataDir, "key");
fs.writeFileSync(keyPath, "never parsed by the fake ssh2");
const srv = { id: "s1", name: "web", host: "203.0.113.1", port: 22, username: "root", keyPath };
const where = async (s) => (await exec(s, "where")).stdout;

// One connection per server and address: a server moved to another IP or port gets a new one, and
// update_server / remove_server end the old ones (dropConnections).
assert.equal(await where(srv), "203.0.113.1:22");
assert.equal(await where(srv), "203.0.113.1:22");
assert.equal(clients.length, 1, "the connection is reused");
assert.equal(await where({ ...srv, host: "203.0.113.2", port: 2222 }), "203.0.113.2:2222", "a moved server is not reached through the old connection");
dropConnections("s1");
assert.ok(clients.every((c) => c.ended), "dropConnections ends every connection of that server");

// A connection that could not be set up is not kept: fixing the key file or the login is enough.
const missing = { ...srv, id: "s2", keyPath: path.join(dataDir, "missing") };
await assert.rejects(exec(missing, "where"), /Cannot read key/);
fs.writeFileSync(missing.keyPath, "now it exists");
assert.equal(await where(missing), "203.0.113.1:22");
Client.refuse.add("198.51.100.7");
const refused = { ...srv, id: "s3", host: "198.51.100.7" };
await assert.rejects(exec(refused, "where"), /authentication methods failed/);
Client.refuse.clear();
assert.equal(await where(refused), "198.51.100.7:22", "a failed login is tried again on the next call");

// A connection the server closed is forgotten with its idle timer, and a late timer or error of a
// replaced connection never ends its replacement (nor crashes the process).
await where({ ...srv, id: "s4" });
const old = clients.at(-1);
const oldTimer = idle.at(-1);
old.emit("close");
assert.ok(oldTimer.cleared, "closing clears the idle timer");
await where({ ...srv, id: "s4" });
const replacement = clients.at(-1);
assert.notEqual(replacement, old);
oldTimer.fn();
old.emit("error", new Error("late error"));
old.emit("error", new Error("a second one"));
assert.equal(replacement.ended, false, "the replacement stays open");
await where({ ...srv, id: "s4" });
assert.equal(clients.at(-1), replacement, "and is still the pooled connection");

// A connection dropped while it is still connecting (update_server during a stats poll) fails the
// waiting call instead of leaving it pending forever.
Client.stall.add("203.0.113.9");
const stalled = exec({ ...srv, id: "s5", host: "203.0.113.9" }, "where");
await new Promise((r) => setImmediate(r));
dropConnections("s5");
await assert.rejects(stalled, /closed before it was ready/);

// Output is decoded once: a character split across two packets stays whole, and the cap counts bytes.
Client.reply = () => {
  const text = Buffer.from("中文日志");
  return [text.subarray(0, 4), text.subarray(4)];
};
assert.equal(await where(srv), "中文日志");
Client.reply = () => [Buffer.alloc(400 * 1024, "a"), Buffer.alloc(400 * 1024, "b")];
const big = await exec(srv, "big");
assert.equal(Buffer.byteLength(big.stdout), 512 * 1024);
assert.equal(big.truncated, true);

closeAll();
fs.rmSync(dataDir, { recursive: true, force: true });
console.log("pool test passed");
