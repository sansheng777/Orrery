// End-to-end check through a real MCP client: add a server, read stats, run commands.
// Usage: SMOKE_HOST=127.0.0.1 SMOKE_PORT=22 SMOKE_USER=ubuntu SMOKE_KEY=~/.ssh/id_ed25519 npm test
// Add SMOKE_TRANSPORT=http to go through the HTTP connector endpoint instead of stdio,
// and ORRERY_ALLOW_EXEC=0 to check the read-only tool set.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawn } from "node:child_process";

const { SMOKE_HOST, SMOKE_PORT = "22", SMOKE_USER, SMOKE_KEY } = process.env;
if (!SMOKE_HOST || !SMOKE_USER) {
  console.log("Set SMOKE_HOST and SMOKE_USER (and SMOKE_KEY / SMOKE_PORT) to run the smoke test.");
  process.exit(0);
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "orrery-"));
const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "index.js");
// No cloud credentials: discovery stays empty and the test never touches a real account.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(AWS_|NETCUP_|LINODE_|GCP_|VULTR_|DIGITALOCEAN_|KAMATERA_)/.test(k)));
Object.assign(env, { ORRERY_DIR: dataDir, ORRERY_SSH_CONFIG: path.join(dataDir, "none") });
let transport;
let child;
if (process.env.SMOKE_TRANSPORT === "http") {
  child = spawn(process.execPath, [entry, "--http"], { env: { ...env, PORT: "18787" }, stdio: ["ignore", "ignore", "pipe"] });
  const token = await new Promise((resolve, reject) => {
    let log = "";
    child.stderr.on("data", (d) => {
      log += d;
      if (/connector URL/.test(log)) {
        assert.doesNotMatch(log, /\/mcp\/[A-Za-z0-9_-]{20,}/, "the token is never logged");
        resolve(fs.readFileSync(path.join(dataDir, "token"), "utf8").trim());
      }
    });
    child.on("exit", (code) => reject(new Error(`agent exited ${code}: ${log}`)));
  });
  const wrong = await fetch("http://127.0.0.1:18787/mcp/not-the-token", { method: "POST", body: "{}" });
  assert.equal(wrong.status, 404, "wrong token is rejected");
  transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:18787/mcp/${token}`));
} else {
  transport = new StdioClientTransport({ command: process.execPath, args: [entry], env });
}
const client = new Client({ name: "smoke", version: "0" });
await client.connect(transport);

async function call(name, args) {
  const res = await client.callTool({ name, arguments: args });
  if (res.isError) throw new Error(`${name}: ${res.content[0].text}`);
  return res.structuredContent;
}

const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));

const added = await call("add_server", {
  name: "smoke",
  host: SMOKE_HOST,
  port: Number(SMOKE_PORT),
  username: SMOKE_USER,
  keyPath: SMOKE_KEY,
  tags: ["test"],
});
assert.equal((await call("list_servers")).servers.length, 1);

const s = await call("server_stats", { id: added.id });
assert.ok(s.memory.total > 0, "memory total");
assert.ok(s.cpu.percent >= 0 && s.cpu.percent <= 100, "cpu percent");
console.log(`stats: ${s.hostname} | ${s.os} | cpu ${s.cpu.percent}% x${s.cpu.cores} | mem ${s.memory.percent}% | disk ${s.disk?.percent}% | docker ${s.docker.status} | ${s.latencyMs}ms`);
// The overview shows the same server as one row of a Markdown table.
const board = (await client.callTool({ name: "fleet_overview", arguments: {} })).content[0].text;
assert.match(board, /1 server: 1 up\./);
assert.ok(board.split("\n").some((l) => l.startsWith(`| smoke (${SMOKE_HOST}) | up | `)), "overview row");
console.log(board.split("\n").filter((l) => l.startsWith("| smoke")).join("\n"));
// The live sampler answers from memory once it has run for a couple of seconds.
let pz = await call("server_pulse", { id: added.id });
for (let i = 0; i < 8 && !pz.latest; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  pz = await call("server_pulse", { id: added.id });
}
assert.ok(pz.latest?.memory.total > 0 && pz.latest.cpu.percent >= 0 && pz.latest.net.rxRate >= 0, "pulse");
console.log(`pulse: cpu ${pz.cpu.percent}% | mem ${pz.memory.percent}% | rx ${pz.net.rxRate} B/s | tx ${pz.net.txRate} B/s | ${pz.samples.length} samples`);

const readOnly = process.env.ORRERY_ALLOW_EXEC === "0";
assert.equal((await call("list_servers")).exec, !readOnly);
assert.equal(tools.some((t) => t.name === "run_command" || t.name === "container_action"), !readOnly);
if (readOnly) console.log("read-only: command tools are not offered");
else {
  const r1 = await call("run_command", { id: added.id, command: "cd /tmp && echo hi && echo err >&2" });
  assert.equal(r1.cwd, "/tmp");
  assert.match(r1.output, /hi\nerr/);
  const r2 = await call("run_command", { id: added.id, command: "pwd; exit 3", cwd: r1.cwd });
  assert.equal(r2.output.trim(), "/tmp");
  assert.equal(r2.exitCode, 3);
  console.log("run_command: cwd tracking and exit codes ok");
}

const bad = await client.callTool({ name: "container_logs", arguments: { id: added.id, container: "x; rm -rf /" } });
assert.ok(bad.isError, "container names are validated");

await call("remove_server", { id: added.id });
assert.equal((await call("list_servers")).servers.length, 0);

await client.close();
child?.kill();
fs.rmSync(dataDir, { recursive: true, force: true });
console.log(`smoke test passed (${process.env.SMOKE_TRANSPORT || "stdio"})`);
