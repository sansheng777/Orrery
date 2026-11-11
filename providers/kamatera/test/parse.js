// The Kamatera module against a fake cloudcli API: credentials, headers, the server listing (list + info),
// IP matching, errors, the name confirmation, the requests the generic tool refuses, redaction, protected
// IPs and the read-only query tool. No Kamatera account needed.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { API, loadConfig, createApi, servers, toServer, getServer, assertName, guardRequest, normalizePath, protectedIps, redactSecrets, register as kamRegister } from "../index.js";

const json = (status, body) => new Response(JSON.stringify(body), { status });
const PROXY = "4ef1a2b3c4d5e6f7a8b9c0d1e2f3a4b5"; // hk-proxy, 203.0.113.50
const TEST = "9abc0000def10000aaaa0000bbbb0000"; // hk-test, 198.51.100.60
const info = {
  [PROXY]: {
    id: PROXY, name: "hk-proxy", datacenter: "AS", power: "on", cpu: "1A", ram: 1024, diskSizes: [20], billing: "hourly", traffic: "t5000", managed: "no", backup: "no",
    priceMonthlyOn: "4.00", priceHourlyOn: "0.0055", priceHourlyOff: "0.0010",
    networks: [{ network: "wan-as", ips: ["203.0.113.50", "2001:db8::50"] }, { network: "lan-as-1", ips: ["10.0.0.5"] }],
  },
  [TEST]: { id: TEST, name: "hk-test", datacenter: "AS", power: "off", cpu: "2B", ram: 2048, diskSizes: ["30", "10"], billing: "monthly", networks: [{ network: "wan-as", ips: ["198.51.100.60"] }] },
};

function fakeKamatera() {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method || "GET";
    const u = new URL(url);
    assert.equal(u.origin, API);
    assert.equal(init.headers.AuthClientId, "cid");
    assert.equal(init.headers.AuthSecret, "sec");
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: u.pathname + u.search, body });
    const p = u.pathname.toLowerCase(); // routes as if the API ignored letter case
    if (p === "/service/servers" && method === "GET") return json(200, [
      { id: PROXY, name: "hk-proxy", datacenter: "AS", power: "on" },
      { id: TEST, name: "hk-test", datacenter: "AS", power: "off" },
      { id: "gone00000000", name: "gone", datacenter: "EU", power: "off" },
    ]);
    if (p === "/service/server/info" && method === "POST") return info[body?.id] ? json(200, [info[body.id]]) : json(500, { message: "Server not found" });
    if (/^\/service\/server\/(poweron|poweroff|reboot|terminate)$/.test(p)) return json(200, ["1234567"]);
    if (p === "/service/server" && method === "POST") return json(200, { password: "Gen3rated!", commandIds: ["7654321"] });
    if (p === "/service/server" && method === "GET") return json(200, { cpu: ["1A", "2B"] });
    if (p === "/service/queue") return json(200, [{ id: u.searchParams.get("id"), status: "complete", log: "Name: hk-new" }]);
    if (p === "/server/configure") return json(200, ["1234568"]);
    return json(404, { message: "Not found" });
  };
  return { calls, fetchImpl };
}
const config = { configured: true, clientId: "cid", secret: "sec" };

// ---------- credentials ----------
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kamatera-test-"));
assert.deepEqual(loadConfig({}, dataDir), { configured: false });
assert.deepEqual(loadConfig({ KAMATERA_API_CLIENT_ID: "a", KAMATERA_API_SECRET: "b" }, dataDir), { configured: true, clientId: "a", secret: "b" });
assert.deepEqual(loadConfig({ KAMATERA_API_CLIENT_ID: "a" }, dataDir), { configured: false }, "both halves of the key are needed");
fs.writeFileSync(path.join(dataDir, "kamatera.json"), JSON.stringify({ clientId: "fc", secret: "fs" }));
assert.deepEqual(loadConfig({}, dataDir), { configured: true, clientId: "fc", secret: "fs" });
fs.writeFileSync(path.join(dataDir, "kamatera.json"), JSON.stringify({ clientId: "x" }));
assert.match(loadConfig({}, dataDir).error, /clientId or secret is missing$/);
fs.writeFileSync(path.join(dataDir, "kamatera.json"), "secret-key-not-json");
const bad = loadConfig({}, dataDir);
assert.equal(bad.configured, false);
assert.match(bad.error, /not valid JSON$/);
assert.doesNotMatch(bad.error, /secret-key/, "file content never reaches the connector");
fs.rmSync(dataDir, { recursive: true, force: true });

// ---------- servers: list + info, shape, matching ----------
let f = fakeKamatera();
let api = createApi(config, f.fetchImpl, { retryWaitMs: 0 });
const res = await servers(api, { matchHosts: async () => (ips) => (ips.includes("10.0.0.5") ? { id: "lan", name: "wrong" } : ips.includes("203.0.113.50") ? { id: "s1", name: "hk" } : null) });
assert.deepEqual(f.calls.map((c) => `${c.method} ${c.path} ${c.body?.id ?? ""}`.trim()), [
  "GET /service/servers",
  `POST /service/server/info ${PROXY}`,
  `POST /service/server/info ${TEST}`,
  "POST /service/server/info gone00000000",
  "POST /service/server/info gone00000000",
], "info for each server; a failed info is read once more");
assert.equal(res.servers.length, 3);
assert.deepEqual(res.servers[0], {
  id: PROXY, name: "hk-proxy", datacenter: "AS", power: "on", cpu: "1A", ramMB: 1024, diskSizesGB: [20], billing: "hourly", traffic: "t5000", managed: "no", backup: "no",
  priceMonthlyOn: 4, priceHourlyOn: 0.0055, priceHourlyOff: 0.001,
  ipv4: "203.0.113.50", publicIps: ["203.0.113.50", "2001:db8::50"], privateIps: ["10.0.0.5"], server: { id: "s1", name: "hk" },
});
assert.deepEqual(res.servers[1].diskSizesGB, [30, 10]);
assert.equal(res.servers[1].server, null);
assert.equal(res.servers[2].name, "gone");
assert.equal(res.servers[2].ipv4, null);
assert.match(res.servers[2].error, /failed with 500: Server not found/, "a server whose info fails is still listed");
assert.match(res.collectedAt, /^\d{4}-\d\d-\d\dT/);
assert.deepEqual(toServer({ id: "x" }).publicIps, []);
await assert.rejects(getServer(api, "../x"), /Invalid Kamatera server id/);

// ---------- errors and paths ----------
await assert.rejects(api.request("GET", "/nope"), /Kamatera GET \/nope failed with 404: Not found/);
await assert.rejects(api.request("GET", "/service/../x"), /Invalid Kamatera API path/);
await assert.rejects(api.request("DELETE", "/service/servers"), /Unsupported method/);
assert.equal(normalizePath("/service/queue?id=123"), "/service/queue?id=123");
assert.throws(() => normalizePath("/service/queue?id=1;x"), /Invalid Kamatera API query/);
{
  let n = 0;
  const flaky = createApi(config, async () => (n++ ? json(200, []) : json(503, {})), { retryWaitMs: 0 });
  assert.deepEqual(await flaky.request("GET", "/service/servers"), []);
  n = 0;
  await assert.rejects(flaky.request("POST", "/service/server/poweroff", { body: { id: TEST } }), /503/, "a change is never sent twice");
  const denied = createApi(config, async () => json(401, { message: "Unauthorized" }));
  await assert.rejects(denied.request("GET", "/service/servers"), /401: Unauthorized \(the API key is wrong/);
}

// ---------- name confirmation ----------
await assert.rejects(assertName(api, PROXY, "hk-test"), /Refusing: confirmName must be "hk-proxy"/);
assert.equal((await assertName(api, PROXY, " hk-proxy ")).id, PROXY);

// ---------- what the generic tool refuses ----------
assert.throws(() => guardRequest("POST", "/service/server/terminate", { id: TEST, force: true }), /kamatera_delete/);
assert.throws(() => guardRequest("POST", "/service/server/terminate/", { name: ".*" }), /kamatera_delete/);
assert.throws(() => guardRequest("POST", "/service/server/password", { id: TEST, password: "x" }), /credential/);
assert.throws(() => guardRequest("POST", "/service/server/ssh", { id: TEST }), /credential/);
assert.throws(() => guardRequest("POST", "/server/snapshot", { id: TEST, revert: "snap1" }), /overwrites the server's disk/);
assert.throws(() => guardRequest("POST", "/service/server/poweroff", { name: "hk-.*" }), /by "id", not "name"/);
assert.throws(() => guardRequest("POST", "/server/configure", { id: TEST, name: "hk-test", ram: 2048 }), /by "id", not "name"/);
assert.throws(() => guardRequest("POST", "/service/server/reboot", {}), /needs the server's "id"/);
assert.deepEqual(guardRequest("POST", "/service/server/reboot", { id: TEST }), { serverId: TEST, powerOn: false });
assert.deepEqual(guardRequest("POST", "/service/server/poweron", { id: TEST }), { serverId: TEST, powerOn: true });
assert.deepEqual(guardRequest("POST", "/service/server", { name: "hk-new" }), { serverId: null }, "creating names the new server");
assert.deepEqual(guardRequest("POST", "/service/server/info", { name: "hk" }), { serverId: null });
assert.deepEqual(guardRequest("POST", "/server/snapshot", { id: TEST, create: "snap1" }), { serverId: TEST, powerOn: false });
assert.deepEqual(guardRequest("GET", "/service/servers"), { serverId: null });
// Paths are compared case-insensitively, and the checks hold whatever the method.
assert.throws(() => guardRequest("POST", "/Service/Server/Terminate", { id: TEST }), /kamatera_delete/);
assert.throws(() => guardRequest("POST", "/SERVICE/SERVER/PASSWORD", { id: TEST }), /credential/);
assert.throws(() => guardRequest("POST", "/Server/Snapshot", { id: TEST, revert: "snap1" }), /overwrites/);
assert.deepEqual(guardRequest("POST", "/Service/Server/PowerOff", { id: TEST }), { serverId: TEST, powerOn: false });
assert.deepEqual(guardRequest("POST", "/Service/Server/PowerOn", { id: TEST }), { serverId: TEST, powerOn: true });
assert.throws(() => guardRequest("GET", "/service/server/terminate?id=x"), /kamatera_delete/);
assert.throws(() => guardRequest("GET", "/service/server/poweroff?id=x"), /needs the server's "id"/);

// ---------- redaction and protected IPs ----------
assert.deepEqual(redactSecrets({ password: "p", commandIds: ["1"], nested: [{ secret: "s", passwordValidate: "p", name: "x" }], empty: "" }), {
  password: "[redacted]", commandIds: ["1"], nested: [{ secret: "[redacted]", passwordValidate: "[redacted]", name: "x" }], empty: "",
});
assert.deepEqual(protectedIps({ ORRERY_SELF_IP: "192.0.2.1", ORRERY_PROTECTED_IPS: "203.0.113.50, 192.0.2.1" }), ["192.0.2.1", "203.0.113.50"]);

// ---------- the tools ----------
{
  const chain = new Proxy(function () {}, { get: () => chain, apply: () => chain }); // stands in for zod
  const register = (env, admin = true) => {
    const g = fakeKamatera();
    const handlers = {};
    const fake = { registerTool: (name, spec, handler) => (handlers[name] = handler) };
    const reg = kamRegister(fake, { z: chain, tool: (fn) => fn, adminTool: (name, fn) => fn, admin, env: { KAMATERA_API_CLIENT_ID: "cid", KAMATERA_API_SECRET: "sec", ...env } }, g.fetchImpl);
    return { ...handlers, info: reg, calls: g.calls };
  };
  assert.deepEqual(register({}, false).info, { id: "kamatera", name: "Kamatera", configured: true, tools: ["kamatera_servers"] });
  assert.deepEqual(register({}).info.tools, ["kamatera_servers", "kamatera_power", "kamatera_delete", "kamatera_api_request", "kamatera_query"]);
  assert.deepEqual(kamRegister({ registerTool: () => assert.fail("no tools without a key") }, { z: chain, env: {} }), { id: "kamatera", name: "Kamatera", configured: false, error: null, tools: [] });
  assert.equal((await register({}).kamatera_servers()).servers.length, 3);

  // kamatera_query reads: GETs, and POSTs only to the read-only endpoints.
  {
    const r = register({});
    await r.kamatera_query({ path: "/service/queue?id=1234567" });
    await r.kamatera_query({ path: "/service/server/info", body: { id: TEST } });
    await r.kamatera_query({ path: "/Service/Server/Info", body: { id: TEST } });
    await assert.rejects(r.kamatera_query({ path: "/service/server/poweroff", body: { id: TEST } }), /changes a server; kamatera_query only reads/);
    // No GET to an action path either, in any letter case.
    for (const p of ["/service/server/poweroff", "/service/server/terminate?id=x", "/service/server/password", "/service/server/ssh", "/Service/Server/Reboot", "/server/configure", "/SERVER/NETWORK", "/service/cloneServer"]) {
      await assert.rejects(r.kamatera_query({ path: p }), /changes a server; kamatera_query only reads/, p);
    }
    await assert.rejects(r.kamatera_query({ path: "/service/servers", body: {} }), /sends a body only to/);
    assert.deepEqual(r.calls.map((c) => `${c.method} ${c.path}`), ["GET /service/queue?id=1234567", "POST /service/server/info", "POST /Service/Server/Info"]);
  }

  const t = register({ ORRERY_PROTECTED_IPS: "203.0.113.50" }); // hk-proxy
  const refused = new RegExp(`Kamatera server ${PROXY} \\(hk-proxy\\) has the protected IP 203\\.0\\.113\\.50`);
  for (const action of ["poweroff", "reboot"]) await assert.rejects(t.kamatera_power({ serverId: PROXY, action }), refused, action);
  await assert.rejects(t.kamatera_delete({ serverId: PROXY, confirmName: "hk-proxy" }), refused);
  for (const [p, body] of [
    ["/service/server/poweroff", { id: PROXY }],
    ["/service/server/rename", { id: PROXY, "new-name": "x" }],
    ["/server/configure", { id: PROXY, ram: 512 }],
    ["/server/network", { id: PROXY, disconnect: "eth0" }],
    ["/service/server/suspend", { id: PROXY }],
    ["/Service/Server/PowerOff", { id: PROXY }],
    ["/SERVER/configure", { id: PROXY, ram: 512 }],
  ]) {
    await assert.rejects(t.kamatera_api_request({ method: "POST", path: p, body }), refused, p);
  }
  assert.deepEqual(t.calls.filter((c) => c.path !== "/service/server/info"), [], "nothing but lookups reached the protected server");

  // Powering on, reading and the other servers stay allowed.
  assert.deepEqual(await t.kamatera_power({ serverId: PROXY, action: "poweron" }), { ok: true, serverId: PROXY, action: "poweron", commandIds: ["1234567"] });
  await t.kamatera_power({ serverId: TEST, action: "reboot" });
  await t.kamatera_api_request({ method: "POST", path: "/server/configure", body: { id: TEST, ram: 4096 } });
  const created = await t.kamatera_api_request({ method: "POST", path: "/service/server", body: { name: "hk-new", password: "__generate__", passwordValidate: "__generate__", datacenter: "AS" } });
  assert.deepEqual(created, { password: "[redacted]", commandIds: ["7654321"] }, "a generated root password never reaches the chat");
  await assert.rejects(t.kamatera_delete({ serverId: TEST, confirmName: "hk-proxy" }), /confirmName must be "hk-test"/);
  assert.deepEqual(await t.kamatera_delete({ serverId: TEST, confirmName: "hk-test" }), { ok: true, deleted: TEST, commandIds: ["1234567"] });
  assert.deepEqual(
    t.calls.filter((c) => c.path !== "/service/server/info").map((c) => `${c.method} ${c.path} ${JSON.stringify(c.body)}`),
    [
      `POST /service/server/poweron {"id":"${PROXY}"}`,
      `POST /service/server/reboot {"id":"${TEST}"}`,
      `POST /server/configure {"id":"${TEST}","ram":4096}`,
      `POST /service/server {"name":"hk-new","password":"__generate__","passwordValidate":"__generate__","datacenter":"AS"}`,
      `POST /service/server/terminate {"id":"${TEST}","force":true}`,
    ],
  );
  await assert.rejects(t.kamatera_api_request({ method: "POST", path: "/service/server/terminate", body: { id: TEST } }), /kamatera_delete/, "guardRequest runs in the tool");

  const none = register({});
  await none.kamatera_power({ serverId: PROXY, action: "reboot" });
  assert.deepEqual(none.calls.map((c) => c.path), ["/service/server/reboot"], "no lookup when nothing is protected");
}

console.log("kamatera test passed");
