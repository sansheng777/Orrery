// The SSH connection pool and command output, with a fake ssh2 (test/fake-ssh2.js) instead of real servers.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";
import { spawnSync } from "node:child_process";

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

const { exec, runInDir, dropConnections, closeAll } = await import("../src/ssh.js");
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

// A refused channel (sshd MaxSessions) fails that call with a clear message and keeps the connection.
{
  const busy = { ...srv, id: "s6", host: "203.0.113.6" };
  Client.reply = (client) => [Buffer.from(client.opts.host)];
  await where(busy);
  const conn = clients.at(-1);
  Client.noChannel.add(busy.host);
  await assert.rejects(exec(busy, "where"), /refused another session .*MaxSessions/);
  assert.equal(conn.ended, false, "the shared connection is kept");
  Client.noChannel.clear();
  assert.equal(await where(busy), busy.host);
  assert.equal(clients.at(-1), conn, "and used again");
}

// A channel that closes without an exit code (the connection went away) is an error, not a result.
Client.reply = () => ({ chunks: [Buffer.from("partial")], code: undefined });
await assert.rejects(exec(srv, "long"), /closed before the command finished/);

// A command that outlives its timeout on a server that never confirms the close still returns (timedOut).
Client.reply = () => ({ chunks: [Buffer.from("so far")], hang: true });
assert.deepEqual(await exec(srv, "hang", { timeoutSec: 0.03, closeGraceMs: 20 }).then((r) => [r.stdout, r.timedOut, r.code]), ["so far", true, null]);

// runInDir with a real bash behind the fake connection: the working directory and what happens when it is gone.
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "orrery-cwd-"));
  fs.mkdirSync(path.join(home, "it's here"));
  Client.reply = (client, command) => {
    const r = spawnSync("bash", ["-c", command], { env: { ...process.env, HOME: home }, cwd: home });
    return { chunks: [r.stdout], code: r.status };
  };
  const real = fs.realpathSync(home);
  assert.deepEqual(await runInDir(srv, "pwd", null, 10).then((r) => [r.output.trim(), r.cwd, r.exitCode]), [real, real, 0], "no cwd: the home directory");
  assert.equal((await runInDir(srv, "cd /tmp && true", "~", 10)).cwd, fs.realpathSync("/tmp"), "the directory the command ended in comes back");
  assert.equal((await runInDir(srv, "pwd", "~/it's here", 10)).cwd, path.join(real, "it's here"), "~/ and quotes in the path");
  assert.equal((await runInDir(srv, "pwd", path.join(real, "it's here"), 10)).cwd, path.join(real, "it's here"));
  const gone = await runInDir(srv, "echo SHOULD-NOT-RUN", "/no/such/dir'; echo INJECTED; '", 10);
  assert.equal(gone.exitCode, 1, "a cwd that does not exist fails the call");
  assert.match(gone.output, /orrery: cannot cd to/);
  assert.doesNotMatch(gone.output, /SHOULD-NOT-RUN|^INJECTED/m, "the command does not run elsewhere, and the path is not executed");
  assert.equal(gone.cwd, real, "and the reported directory is where the shell really is");
  fs.rmSync(home, { recursive: true, force: true });
}

closeAll();
fs.rmSync(dataDir, { recursive: true, force: true });
console.log("pool test passed");
