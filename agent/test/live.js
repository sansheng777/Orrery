// The live sampler (live.js) against the fake ssh2 of test/fake-ssh2.js: samples from a streamed loop,
// output split anywhere, restart after the remote loop ends, login failures and idle sweeping.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";

register("./fake-ssh2.js", import.meta.url);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "orrery-live-"));
process.env.ORRERY_DIR = dataDir;

const live = await import("../src/live.js");
const { closeAll } = await import("../src/ssh.js");
const { Client, clients } = await import("ssh2");

const keyPath = path.join(dataDir, "key");
fs.writeFileSync(keyPath, "never parsed by the fake ssh2");
const srv = { id: "s1", name: "web", host: "203.0.113.1", port: 22, username: "root", keyPath };
const tick = () => new Promise((r) => setTimeout(r, 30));

const block = (up, busy, rx) => `@@t\n${up}\n@@stat\ncpu  ${busy} 0 0 ${1000 - busy} 0 0 0 0 0 0\n@@net\n  eth0: ${rx} 1 0 0 0 0 0 0 ${rx / 2} 1 0 0 0 0 0 0\n@@loadavg\n0.1 0.2 0.3 1/90 7\n@@meminfo\nMemTotal: 1000 kB\nMemAvailable: 600 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n@@end\n`;
let run = 0;
Client.reply = () => {
  run++;
  const text = [block(10, 100, 0), block(11, 300, 2000), block(12, 400, 6000)].join("");
  return [Buffer.from(text.slice(0, 37)), Buffer.from(text.slice(37, 170)), Buffer.from(text.slice(170))]; // split mid-line
};

// First read starts the sampler and has nothing yet; once the loop has printed, samples are there.
let r = live.read(srv);
assert.deepEqual([r.samples.length, r.running], [0, true]);
await tick();
r = live.read(srv);
assert.equal(r.samples.length, 2, "three blocks give two samples (rates need a previous one)");
assert.deepEqual(r.latest.net, { rxRate: 4000, txRate: 2000 });
assert.equal(r.latest.memory.percent, 40);
assert.equal(clients.at(-1).opts.host, "203.0.113.1");

// The remote loop ended on its own (the fake closes after its output): the next read starts another one.
assert.equal(r.running, true, "this read already restarted it");
await tick();
assert.equal(run, 2);
r = live.read(srv, { count: 3 });
assert.equal(r.samples.length, 3, "samples keep accumulating across restarts, newest last");

// A refused login is reported, waits before retrying, and tells the caller (for the shared backoff).
Client.refuse.add("203.0.113.2");
let authFailed = null;
const bad = { ...srv, id: "s2", host: "203.0.113.2" };
live.read(bad, { onAuthFailure: (e) => (authFailed = e.message) });
await tick();
r = live.read(bad);
assert.match(r.error, /authentication methods failed/);
assert.equal(r.running, false, "no retry right away");
assert.match(authFailed, /authentication methods failed/);

// Moving a server to another address starts over there.
live.read({ ...srv, host: "203.0.113.3" });
await tick();
assert.equal(clients.at(-1).opts.host, "203.0.113.3");

// Nobody watching for two minutes: the sampler is stopped and forgotten.
live.sweep(Date.now() + 3 * 60 * 1000);
r = live.read(srv);
assert.equal(r.samples.length, 0, "a swept sampler starts from scratch");

live.stopAll();
closeAll();
fs.rmSync(dataDir, { recursive: true, force: true });
console.log("live test passed");
