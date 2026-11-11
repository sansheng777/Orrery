// Cloud providers through a real MCP client: tools appear only with credentials, the hub role
// only ever gets read tools, the admin agent gets the control tools and logs every change, and provider
// resources are matched to the SSH inventory by IP. No network needed.
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "orrery-providers-"));
process.env.ORRERY_DIR = dataDir;
process.env.ORRERY_SSH_CONFIG = path.join(dataDir, "none");
for (const k of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_REGIONS", "AWS_COST_EXPLORER", "NETCUP_REFRESH_TOKEN", "LINODE_TOKEN", "GCP_PROJECTS"]) delete process.env[k];
const { createServer } = await import("../src/server.js");
const { matchHosts } = await import("../src/cloud.js");

async function connect(role = "hub") {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(role).connect(serverSide);
  const client = new Client({ name: "providers-test", version: "0" });
  await client.connect(clientSide);
  return client;
}
const PROVIDER_TOOL = /^(aws|netcup|linode|gcp|aliyun|vultr|digitalocean|kamatera|cloud)_/;

// Without credentials only cloud_providers is offered, and it says why.
let client = await connect();
// Instructions tell the model how to work with Orrery; ORRERY_INSTRUCTIONS=off leaves them out.
assert.match(client.getInstructions() || "", /Start with list_servers/);
assert.doesNotMatch(client.getInstructions(), /ssh_bootstrap, then/, "the read-only hub role does not mention onboarding");
{
  const admin = await connect("admin");
  assert.match(admin.getInstructions() || "", /orrery-host/);
  assert.match(admin.getInstructions(), /dashboard\/orrery\.html/);
  await admin.close();
  const { instructionsFor, DASHBOARD_TOOLS } = await import("../src/instructions.js");
  assert.equal(instructionsFor("admin", { ORRERY_INSTRUCTIONS: "off" }), undefined);

  // The dashboard's tool list is written in three places; they must say the same.
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const listIn = (file, from, to) => {
    const text = fs.readFileSync(path.join(root, file), "utf8");
    return text.slice(text.indexOf(from), text.indexOf(to, text.indexOf(from))).match(/\b[a-z]+_[a-z_]+\b/g);
  };
  assert.deepEqual(listIn("AGENTS.md", "`list_servers,", "\n"), DASHBOARD_TOOLS, "AGENTS.md");
  assert.deepEqual(listIn("dashboard/orrery.html", "list_servers,", "To use another connector name"), DASHBOARD_TOOLS, "dashboard header");
}
let { tools } = await client.listTools();
assert.deepEqual(tools.filter((t) => PROVIDER_TOOL.test(t.name)).map((t) => t.name), ["cloud_providers"]);
// The fleet overview: a read-only tool that answers with a Markdown board, and the same as a prompt.
// Asked here, with no credentials and no saved server, so nothing is contacted.
{
  assert.equal(tools.find((x) => x.name === "fleet_overview").annotations?.readOnlyHint, true);
  const board = await client.callTool({ name: "fleet_overview", arguments: {} });
  assert.ok(!board.isError);
  assert.match(board.content[0].text, /^Orrery overview, \d{4}-\d\d-\d\d \d\d:\d\d UTC\. 0 servers/);
  assert.ok(board.content[0].text.includes("| Server | State | CPU |"), "plain Markdown, not JSON");
  const { prompts } = await client.listPrompts();
  assert.deepEqual(prompts.map((p) => p.name), ["overview"]);
  assert.match((await client.getPrompt({ name: "overview" })).messages[0].content.text, /fleet_overview/);
}
let res = await client.callTool({ name: "cloud_providers", arguments: {} });
assert.deepEqual(res.structuredContent.providers.map((p) => [p.id, p.configured]), [["aws", false], ["netcup", false], ["linode", false], ["gcp", false], ["aliyun", false], ["vultr", false], ["digitalocean", false], ["kamatera", false]]);
await client.close();

// With credentials under the data volume, each provider registers its read tools.
fs.writeFileSync(path.join(dataDir, "aws.json"), JSON.stringify({ accessKeyId: "AKIAEXAMPLE", secretAccessKey: "x", regions: ["ap-northeast-1"], costExplorer: true }));
fs.writeFileSync(path.join(dataDir, "netcup.json"), JSON.stringify({ refreshToken: "x" }));
fs.writeFileSync(path.join(dataDir, "linode.json"), JSON.stringify({ token: "x" }));
fs.writeFileSync(path.join(dataDir, "vultr.json"), JSON.stringify({ apiKey: "x" }));
fs.writeFileSync(path.join(dataDir, "digitalocean.json"), JSON.stringify({ token: "x" }));
fs.writeFileSync(path.join(dataDir, "kamatera.json"), JSON.stringify({ clientId: "x", secret: "x" }));
const gcpKey = (await import("node:crypto")).generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });
fs.writeFileSync(path.join(dataDir, "aliyun.json"), JSON.stringify({ accessKeyId: "LTAI-x", accessKeySecret: "x", regions: ["cn-beijing"] }));
fs.writeFileSync(path.join(dataDir, "gcp.json"), JSON.stringify({ type: "service_account", project_id: "demo-proj", client_email: "hub@demo-proj.iam.gserviceaccount.com", private_key: gcpKey }));
client = await connect();
({ tools } = await client.listTools());
const cloud = tools.filter((t) => PROVIDER_TOOL.test(t.name));
assert.deepEqual(cloud.map((t) => t.name).sort(), ["aliyun_billing", "aliyun_instances", "aliyun_query", "aws_cost", "aws_instances", "cloud_providers", "digitalocean_droplets", "gcp_instances", "kamatera_servers", "linode_instances", "netcup_servers", "vultr_instances"]);
for (const t of cloud) {
  assert.equal(t.annotations?.readOnlyHint, true, `${t.name} is annotated read-only`);
  assert.doesNotMatch(t.name, /create|delete|remove|reboot|restart|start|stop|power|update|edit|put|patch|purge|rescue|reinstall/, `${t.name} only reads`);
}
res = await client.callTool({ name: "cloud_providers", arguments: {} });
assert.deepEqual(res.structuredContent.providers.find((p) => p.id === "aws"), { id: "aws", name: "AWS", configured: true, regions: ["ap-northeast-1"], tools: ["aws_instances", "aws_cost"] });
await client.close();

// A broken credentials file disables only that provider and reports the reason.
fs.writeFileSync(path.join(dataDir, "netcup.json"), "eyJhbGciOiJIUzUxMiJ9-secret-token");
client = await connect();
res = await client.callTool({ name: "cloud_providers", arguments: {} });
const netcup = res.structuredContent.providers.find((p) => p.id === "netcup");
assert.equal(netcup.configured, false);
assert.match(netcup.error, /netcup\.json: not valid JSON$/);
assert.doesNotMatch(netcup.error, /secret/, "file content never reaches the connector");
assert.equal(res.structuredContent.providers.find((p) => p.id === "aws").configured, true);
await client.close();

// The admin agent: control tools, SSH tools with commands, onboarding, every change in the audit log.
fs.writeFileSync(path.join(dataDir, "netcup.json"), JSON.stringify({ refreshToken: "admin-refresh" }));
const realFetch = globalThis.fetch;
const scpCalls = [];
const linodeCalls = [];
globalThis.fetch = async (url, init = {}) => {
  if (String(url).startsWith("https://api.linode.com/v4/")) {
    linodeCalls.push(`${init.method || "GET"} ${String(url).replace("https://api.linode.com/v4", "")}`);
    return new Response("{}", { status: 200 });
  }
  if (String(url).endsWith("/openid-connect/token")) return new Response(JSON.stringify({ access_token: "at", expires_in: 300 }), { status: 200 });
  scpCalls.push(`${init.method || "GET"} ${String(url).replace("https://www.servercontrolpanel.de/scp-core", "")}`);
  if (String(url).includes("/servers/7?loadServerLiveInfo=false")) return new Response(JSON.stringify({ id: 7, name: "v2202610000000000007", nickname: "nbg" }), { status: 200 });
  if (String(url).includes("/servers/8?loadServerLiveInfo=false")) return new Response(JSON.stringify({ id: 8, name: "v2202610000000000008", ipv4Addresses: [{ ip: "198.51.100.99" }] }), { status: 200 });
  return new Response(JSON.stringify({ uuid: "4f8a1c2e-7b3d-4e5f-9a0b-1c2d3e4f5a6b", name: "Server state change", state: "RUNNING" }), { status: 202 });
};
process.env.ORRERY_SELF_IP = "198.51.100.99"; // server 8 is the Orrery host
client = await connect("admin");
({ tools } = await client.listTools());
const names = tools.map((t) => t.name);
for (const t of ["aws_ec2_power", "aws_ec2_terminate", "aws_lightsail_power", "aws_lightsail_delete", "aws_call", "aws_query", "netcup_set_power", "netcup_reinstall", "netcup_api_request", "netcup_query", "linode_power", "linode_delete", "linode_rebuild", "linode_api_request", "linode_query", "linode_instances", "gcp_instances", "gcp_power", "gcp_delete", "gcp_api_request", "gcp_query", "aliyun_instances", "aliyun_query", "aliyun_billing", "aliyun_power", "aliyun_delete", "aliyun_call", "vultr_instances", "vultr_power", "vultr_delete", "vultr_reinstall", "vultr_api_request", "vultr_query", "digitalocean_droplets", "digitalocean_power", "digitalocean_delete", "digitalocean_rebuild", "digitalocean_api_request", "digitalocean_query", "kamatera_servers", "kamatera_power", "kamatera_delete", "kamatera_api_request", "kamatera_query", "aws_instances", "netcup_servers", "cloud_providers"]) {
  assert.ok(names.includes(t), `admin agent offers ${t}`);
}
for (const t of ["list_servers", "server_stats", "server_pulse", "run_command", "container_action", "add_server", "ignore_server", "label_server", "ssh_public_key", "ssh_bootstrap", "ssh_bootstrap_status"]) {
  assert.ok(names.includes(t), `admin agent offers ${t}`);
}
for (const t of ["run_command", "container_action", "ssh_bootstrap"]) assert.equal(tools.find((x) => x.name === t).annotations?.destructiveHint, true, `${t} is marked destructive`);
for (const t of tools.filter((x) => /_query$/.test(x.name))) {
  assert.equal(t.annotations?.readOnlyHint, true, `${t.name} is marked read-only`);
  assert.ok(!("method" in (t.inputSchema?.properties || {})), `${t.name} takes no method`);
  // Kamatera reads some things by POST (server info, images, reports); kamatera_query sends a body only there.
  if (t.name !== "kamatera_query") assert.ok(!("body" in (t.inputSchema?.properties || {})), `${t.name} takes no body`);
}
res = await client.callTool({ name: "ssh_public_key", arguments: {} });
assert.match(res.structuredContent.publicKey, /^ssh-ed25519 \S+ orrery$/);
assert.equal((fs.statSync(path.join(dataDir, "keys", "id_ed25519")).mode & 0o777).toString(8), "600", "the private key is private");
for (const t of tools) {
  if (/_(power|terminate|delete|reinstall|call|api_request|revert_snapshot|rescue_system)/.test(t.name) && !/^netcup_list/.test(t.name)) {
    assert.equal(t.annotations?.destructiveHint, true, `${t.name} is marked destructive`);
  }
}
res = await client.callTool({ name: "netcup_set_power", arguments: { serverId: 7, state: "ON", option: "RESET" } });
assert.ok(!res.isError, res.content?.[0]?.text);
assert.equal(res.structuredContent.task.state, "RUNNING");
assert.deepEqual(scpCalls, ["GET /api/v1/servers/7?loadServerLiveInfo=false", "PATCH /api/v1/servers/7?stateOption=RESET"], "looks the server up first: is it the Orrery host?");
res = await client.callTool({ name: "netcup_reinstall", arguments: { serverId: 7, imageFlavourId: 3, confirmServerName: "web-01", customScript: "echo secret-value" } });
assert.ok(res.isError && /Refusing/.test(res.content[0].text), "reinstall needs the server's name");
res = await client.callTool({ name: "netcup_api_request", arguments: { method: "POST", path: "/api/v1/servers/7/image", body: {} } });
assert.ok(res.isError && /netcup_reinstall/.test(res.content[0].text), "the generic tool cannot reinstall");
assert.ok(!scpCalls.some((c) => c.startsWith("POST")), "nothing was reinstalled");
res = await client.callTool({ name: "linode_power", arguments: { linodeId: 42, action: "reboot" } });
assert.ok(!res.isError, res.content?.[0]?.text);
res = await client.callTool({ name: "linode_api_request", arguments: { method: "DELETE", path: "/linode/instances/42" } });
assert.ok(res.isError && /linode_delete/.test(res.content[0].text), "the generic tool cannot delete a Linode");
assert.deepEqual(linodeCalls, ["GET /linode/instances/42", "POST /linode/instances/42/reboot"], "the protected-IP check reads the Linode first");
res = await client.callTool({ name: "linode_query", arguments: { path: "/linode/instances/42" } });
assert.ok(!res.isError, res.content?.[0]?.text);
assert.equal(linodeCalls.at(-1), "GET /linode/instances/42", "linode_query reads");
const audit = fs.readFileSync(path.join(dataDir, "audit.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
assert.deepEqual(audit.map((a) => [a.tool, a.ok]), [["netcup_set_power", true], ["netcup_reinstall", false], ["netcup_api_request", false], ["linode_power", true], ["linode_api_request", false]]);
assert.equal(audit[1].args.customScript, "[redacted]", "secrets in arguments are not logged");
assert.equal((fs.statSync(path.join(dataDir, "audit.log")).mode & 0o777).toString(8), "600");
for (const [name, args] of [
  ["netcup_set_power", { serverId: 8, state: "ON", option: "RESET" }],
  ["netcup_set_power", { serverId: 8, state: "OFF" }],
  ["netcup_rescue_system", { serverId: 8, active: true }],
  ["netcup_api_request", { method: "PATCH", path: "/api/v1/servers/8", body: { state: "OFF" } }],
]) {
  res = await client.callTool({ name, arguments: args });
  assert.ok(res.isError && /Orrery host/.test(res.content[0].text), `${name} refuses the Orrery host`);
}
assert.ok(!scpCalls.some((c) => /servers\/8(\?stateOption|\/rescuesystem|$)/.test(c) && !c.startsWith("GET")), "nothing was sent to the Orrery host");
await client.close();
delete process.env.ORRERY_SELF_IP;
globalThis.fetch = realFetch;

// The dashboard's agent never offers a control tool, whatever credentials it has.
client = await connect("hub");
({ tools } = await client.listTools());
assert.ok(tools.filter((t) => PROVIDER_TOOL.test(t.name)).every((t) => t.annotations?.readOnlyHint === true));
await client.close();

// Matching by IP: literal addresses, resolved hostnames, IPv6 case and IPv4-mapped forms.
const lookup = async (host) => (host === "web.example.com" ? [{ address: "2001:DB8::10", family: 6 }] : Promise.reject(new Error("ENOTFOUND")));
const match = await matchHosts({
  servers: [
    { id: "a1", name: "aws-tokyo", host: "203.0.113.10" },
    { id: "w1", name: "web", host: "web.example.com" },
    { id: "x1", name: "unknown", host: "nowhere.invalid" },
  ],
  lookup,
});
assert.deepEqual(match(["::ffff:203.0.113.10"]), { id: "a1", name: "aws-tokyo" });
assert.deepEqual(match([null, "2001:db8::10"].filter(Boolean)), { id: "w1", name: "web" });
assert.equal(match(["198.51.100.99"]), null);

// The HTTP entry: a request target that new URL rejects gets a 400, and the agent keeps serving.
{
  const { startHttp } = await import("../src/http.js");
  const httpServer = await startHttp({ port: 0 });
  const { port } = httpServer.address();
  const reply = await new Promise((resolve, reject) => {
    let out = "";
    const sock = net.connect(port, "127.0.0.1", () => sock.write("GET http://[x]/ HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n"));
    sock.on("data", (d) => (out += d)).on("end", () => resolve(out)).on("error", reject);
  });
  assert.match(reply, /^HTTP\/1\.1 400 /);
  assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200, "still running");

  // Authentication: the token in the path, or as a Bearer header on /mcp.
  const token = fs.readFileSync(path.join(dataDir, "token"), "utf8").trim();
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } };
  const post = (p, headers = {}) =>
    fetch(`http://127.0.0.1:${port}${p}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(init) });
  assert.equal((await post(`/mcp/${token}`)).status, 200, "token in the path");
  assert.equal((await post("/mcp", { authorization: `Bearer ${token}` })).status, 200, "Bearer token on /mcp");
  assert.equal((await post("/mcp/", { authorization: `bearer ${token}` })).status, 200, "the scheme is case-insensitive, a trailing slash is fine");
  const wrong = await post("/mcp", { authorization: "Bearer not-the-token" });
  assert.equal(wrong.status, 401, "a wrong Bearer token is refused");
  assert.match(wrong.headers.get("www-authenticate") || "", /^Bearer /);
  assert.equal((await post("/mcp")).status, 401, "no token at all is refused");
  assert.equal((await post("/mcp/not-the-token")).status, 404, "a wrong path token looks like an unknown path");
  assert.equal((await post("/mcp/not-the-token", { authorization: `Bearer ${token}` })).status, 404, "a Bearer header does not rescue a wrong path token");
  assert.equal((await post("/elsewhere", { authorization: `Bearer ${token}` })).status, 404, "other paths stay closed");
  assert.equal((await fetch(`http://127.0.0.1:${port}/mcp`, { headers: { authorization: `Bearer ${token}` } })).status, 405, "only POST");
  const big = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "x".repeat(1024 * 1024 + 10) });
  assert.equal(big.status, 413, "an oversized body gets a 413 the client can read");
  httpServer.closeAllConnections();
  await new Promise((resolve) => httpServer.close(resolve));
}

// accept_host_key: offered in both roles, takes only a well-formed fingerprint, and replaces the pin;
// changing a saved server's address or removing it forgets the pin.
{
  const hostKeys = await import("../src/hostkeys.js");
  const { addServer } = await import("../src/inventory.js");
  const fp = hostKeys.fingerprint(Buffer.from("a new key"));
  for (const role of ["hub", "admin"]) {
    const c = await connect(role);
    assert.ok((await c.listTools()).tools.some((t) => t.name === "accept_host_key" && t.annotations.destructiveHint), `${role}: asks for confirmation`);
    const saved = addServer({ name: `pin-${role}`, host: "203.0.113.77", username: "root" });
    hostKeys.pin(saved.id, [hostKeys.fingerprint(Buffer.from("the old key"))]);
    assert.ok((await c.callTool({ name: "accept_host_key", arguments: { id: saved.id, fingerprint: "SHA256:tooshort" } })).isError, "a malformed fingerprint is refused");
    assert.ok((await c.callTool({ name: "accept_host_key", arguments: { id: "no-such-server", fingerprint: fp } })).isError, "the server must exist");
    const r = await c.callTool({ name: "accept_host_key", arguments: { id: saved.id, fingerprint: fp } });
    assert.equal(r.structuredContent.fingerprint, fp);
    assert.deepEqual(hostKeys.pinned(saved.id), [fp]);
    await c.callTool({ name: "update_server", arguments: { id: saved.id, name: "renamed" } });
    assert.deepEqual(hostKeys.pinned(saved.id), [fp], "a rename keeps the pin");
    await c.callTool({ name: "update_server", arguments: { id: saved.id, host: "203.0.113.78" } });
    assert.deepEqual(hostKeys.pinned(saved.id), [], "another address is pinned afresh");
    hostKeys.pin(saved.id, [fp]);
    await c.callTool({ name: "remove_server", arguments: { id: saved.id } });
    assert.deepEqual(hostKeys.pinned(saved.id), []);
    await c.close();
  }
}

// Audit redaction: by field name, and the value of key/value pairs whose key looks secret.
{
  const { redact } = await import("../src/audit.js");
  assert.deepEqual(redact({ root_pass: "p", nested: { apiToken: "t" }, keep: 1 }), { root_pass: "[redacted]", nested: { apiToken: "[redacted]" }, keep: 1 });
  assert.deepEqual(redact({ Tags: [{ Key: "db_password", Value: "p" }, { Key: "Name", Value: "web" }] }), { Tags: [{ Key: "db_password", Value: "[redacted]" }, { Key: "Name", Value: "web" }] });
  assert.deepEqual(redact({ items: [{ key: "api-token", value: "t" }] }), { items: [{ key: "api-token", value: "[redacted]" }] });
}

fs.rmSync(dataDir, { recursive: true, force: true });
console.log("providers test passed");
