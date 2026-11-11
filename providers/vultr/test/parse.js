// The Vultr module against a fake API v2: cursor pagination, the instance shape, IP matching, errors, the
// label confirmation, the requests the generic tool refuses, redaction and protected IPs. No Vultr account needed.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { API, loadConfig, createApi, instances, toInstance, assertLabel, guardRequest, normalizePath, protectedIps, redactSecrets, instanceIdsIn, register as vultrRegister } from "../index.js";

const json = (status, body) => new Response(JSON.stringify(body), { status });
const A = "cb676a46-66fd-4dfb-b839-443f2e6c0b60"; // tokyo-proxy, 203.0.113.10
const B = "1b2c3d4e-0000-4000-8000-00000000000b"; // fresh instance, no address yet
const raw = {
  [A]: {
    id: A, os: "Debian 12 x64 (bookworm)", ram: 1024, disk: 25, plan: "vc2-1c-1gb", main_ip: "203.0.113.10", vcpu_count: 1, region: "nrt",
    date_created: "2026-11-04T08:00:00+00:00", status: "active", allowed_bandwidth: 1000, power_status: "running", server_status: "ok",
    v6_main_ip: "2001:db8::10", label: "tokyo-proxy", internal_ip: "10.1.96.3", hostname: "tokyo-proxy", firewall_group_id: "", tags: ["proxy"], features: ["ipv6"],
  },
  [B]: { id: B, label: "", hostname: "new-1", main_ip: "0.0.0.0", v6_main_ip: "", status: "pending", power_status: "stopped", server_status: "none", tags: [] },
};

function fakeVultr() {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method || "GET";
    const u = new URL(url);
    assert.equal(u.origin + "/v2", API);
    assert.equal(init.headers.authorization, "Bearer test-key");
    const p = u.pathname.replace("/v2", "");
    calls.push({ method, path: p + u.search, body: init.body ? JSON.parse(init.body) : undefined });
    if (p === "/instances" && method === "GET") {
      return u.searchParams.get("cursor") === "page2"
        ? json(200, { instances: [raw[B]], meta: { total: 2, links: { next: "", prev: "page1" } } })
        : json(200, { instances: [raw[A]], meta: { total: 2, links: { next: "page2", prev: "" } } });
    }
    const one = p.match(/^\/instances\/([^/]+)$/);
    if (one && method === "GET" && raw[one[1]]) return json(200, { instance: raw[one[1]] });
    if (/^\/instances(\/[^/]+)?\/(start|halt|reboot)$/.test(p)) return new Response(null, { status: 204 });
    if (p === "/instances" && method === "POST") return json(202, { instance: { ...raw[B], default_password: "Hunter2!" } });
    if (p === "/databases/db1") return json(200, { database: { id: "db1", user: "vultradmin", password: "dbsecret", read_replicas: [{ password: "x" }] } });
    if (p === "/inference") return json(200, { subscriptions: [{ id: "inf1", label: "glm", api_key: "INFKEY" }] });
    if (p === "/plans") return json(400, { error: "Invalid plan type", status: 400 });
    return json(404, { error: "Not found", status: 404 });
  };
  return { calls, fetchImpl };
}
const config = { configured: true, apiKey: "test-key" };

// ---------- credentials ----------
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vultr-test-"));
assert.deepEqual(loadConfig({}, dataDir), { configured: false });
assert.deepEqual(loadConfig({ VULTR_API_KEY: "env-key" }, dataDir), { configured: true, apiKey: "env-key" });
fs.writeFileSync(path.join(dataDir, "vultr.json"), JSON.stringify({ apiKey: "file-key" }));
assert.deepEqual(loadConfig({}, dataDir), { configured: true, apiKey: "file-key" });
fs.writeFileSync(path.join(dataDir, "vultr.json"), JSON.stringify({ token: "x" }));
assert.match(loadConfig({}, dataDir).error, /apiKey is missing/);
fs.writeFileSync(path.join(dataDir, "vultr.json"), "secret-key-not-json");
const bad = loadConfig({}, dataDir);
assert.equal(bad.configured, false);
assert.match(bad.error, /not valid JSON$/);
assert.doesNotMatch(bad.error, /secret/, "file content never reaches the connector");

// ---------- instances: every page (cursor), shape, matching ----------
let f = fakeVultr();
let api = createApi(config, f.fetchImpl);
const res = await instances(api, { matchHosts: async () => (ips) => (ips.includes("10.1.96.3") ? { id: "lan", name: "wrong" } : ips.includes("203.0.113.10") ? { id: "s1", name: "tokyo" } : null) });
assert.deepEqual(f.calls.map((c) => c.path), ["/instances?per_page=500", "/instances?per_page=500&cursor=page2"]);
assert.equal(res.instances.length, 2);
{
  const g = fakeVultr();
  await createApi(config, g.fetchImpl).all("/instances?label=x", "instances", 1);
  assert.equal(g.calls[0].path, "/instances?label=x&per_page=500", "a base path with its own query gets & before per_page");
}
assert.deepEqual(res.instances[0], {
  id: A, label: "tokyo-proxy", hostname: "tokyo-proxy", status: "active", powerStatus: "running", serverStatus: "ok", region: "nrt", plan: "vc2-1c-1gb",
  os: "Debian 12 x64 (bookworm)", vcpus: 1, memoryMB: 1024, diskGB: 25, bandwidthGB: 1000, ipv4: "203.0.113.10", ipv6: "2001:db8::10", internalIp: "10.1.96.3",
  firewallGroupId: null, tags: ["proxy"], features: ["ipv6"], created: "2026-11-04T08:00:00+00:00", server: { id: "s1", name: "tokyo" },
});
assert.equal(res.instances[1].ipv4, null, "0.0.0.0 of a new instance is no address");
assert.equal(res.instances[1].label, "new-1", "an empty label falls back to the hostname");
assert.equal(res.instances[1].server, null);
assert.equal(toInstance({ id: "x" }).tags.length, 0);

// ---------- errors and paths ----------
await assert.rejects(api.request("GET", "/plans"), /Vultr GET \/plans failed with 400: Invalid plan type/);
await assert.rejects(api.request("GET", "/instances/../account"), /Invalid Vultr API path/);
await assert.rejects(api.request("OPTIONS", "/registry/r1/docker-credentials"), /Unsupported method/, "registry credentials stay out of reach");
assert.deepEqual(await api.request("POST", `/instances/${A}/reboot`), {}, "204 No Content");

// ---------- label confirmation ----------
await assert.rejects(assertLabel(api, A, "fra-db"), /Refusing: confirmLabel must be "tokyo-proxy"/);
assert.equal((await assertLabel(api, A, " tokyo-proxy ")).id, A);
await assert.rejects(assertLabel(api, "not-a-uuid", "x"), /Invalid Vultr instance id/);

// ---------- what the generic tool refuses ----------
assert.throws(() => guardRequest("DELETE", `/instances/${A}`), /vultr_delete/);
assert.throws(() => guardRequest("DELETE", `/instances/${A}/`), /vultr_delete/);
assert.throws(() => guardRequest("POST", `/instances/${A}/reinstall`), /vultr_reinstall/);
assert.throws(() => guardRequest("POST", `/instances/${A}/restore`), /overwrites the server's disk/);
assert.throws(() => guardRequest("POST", "/bare-metals/bm1/restore"), /overwrites/);
assert.throws(() => guardRequest("DELETE", "/bare-metals/bm1"), /bare-metal server erases it/);
assert.throws(() => guardRequest("POST", "/bare-metals/bm1/reinstall"), /bare-metal server erases it/);
for (const [method, p] of [["POST", "/users/u1/apikeys"], ["POST", "/object-storage/o1/regenerate-keys"], ["GET", "/kubernetes/clusters/k1/config"], ["POST", "/inference/inf1/apikey"]]) {
  assert.throws(() => guardRequest(method, p), /must not end up in the chat/, `${method} ${p}`);
}
for (const [method, p] of [["GET", `/instances/${A}`], ["DELETE", `/instances/${A}/ipv4/203.0.113.11`], ["DELETE", "/snapshots/s1"], ["POST", "/instances"], ["GET", "/users/u1/apikeys"], ["DELETE", "/firewalls/fw1"]]) {
  assert.doesNotThrow(() => guardRequest(method, p), `${method} ${p}`);
}
for (const p of [`/instances/${A}/.`, "/instances/./x", "//instances", `/instances/${A}%2F`, `/instances/${A}#x`, "/instances/{id}"]) {
  assert.throws(() => guardRequest("DELETE", p), /Invalid Vultr API path/, p);
}
assert.equal(normalizePath("/instances?per_page=100&cursor=bmV4dA=="), "/instances?per_page=100&cursor=bmV4dA==");

// ---------- redaction ----------
assert.deepEqual(redactSecrets({ instance: { id: "i", default_password: "Hunter2!", label: "x" } }), { instance: { id: "i", default_password: "[redacted]", label: "x" } });
assert.deepEqual(redactSecrets({ instance: { id: "i", kvm: "https://console.vultr.com/subs/vps/novnc/api.php?data=abc", hostname: "x" } }), { instance: { id: "i", kvm: "[redacted]", hostname: "x" } }, "the web console URL carries a token");
assert.deepEqual(redactSecrets({ a: [{ s3_secret_key: "k", s3_access_key: "a", s3_hostname: "h" }], password: "" }), { a: [{ s3_secret_key: "[redacted]", s3_access_key: "[redacted]", s3_hostname: "h" }], password: "" });

// ---------- ids a request names ----------
assert.deepEqual(instanceIdsIn("POST", `/instances/${A}/halt`), { ids: [A], rest: "/halt" });
assert.deepEqual(instanceIdsIn("POST", "/instances/halt", { instance_ids: [A, B] }), { ids: [A, B], rest: "" });
assert.deepEqual(instanceIdsIn("POST", "/instances/start", { instance_ids: [A] }), { ids: [], rest: "" }, "starting is never blocked");
assert.deepEqual(instanceIdsIn("POST", "/instances"), { ids: [], rest: "" });

// ---------- rate limits and key errors ----------
function flaky(statuses, headers = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push(init.method || "GET");
    const status = statuses.shift() ?? 200;
    return new Response(JSON.stringify(status === 200 ? { instances: [], meta: { links: { next: "" } } } : { error: status === 401 ? "Invalid API token." : "Rate limit reached" }), { status, headers });
  };
  return { calls, fetchImpl };
}
f = flaky([429]);
api = createApi(config, f.fetchImpl, { retryWaitMs: 1 });
assert.deepEqual((await api.request("GET", "/instances")).instances, []);
assert.deepEqual(f.calls, ["GET", "GET"], "a rate-limited GET is retried once");
f = flaky([503], { "retry-after": "30" });
api = createApi(config, f.fetchImpl, { retryWaitMs: 1 });
await assert.rejects(api.request("GET", "/instances"), /failed with 503/, "a long retry-after is not waited for");
f = flaky([429]);
api = createApi(config, f.fetchImpl, { retryWaitMs: 1 });
await assert.rejects(api.request("POST", "/instances", { body: {} }), /rate limited/);
assert.deepEqual(f.calls, ["POST"], "a change is never sent twice");
f = flaky([401]);
api = createApi(config, f.fetchImpl, { retryWaitMs: 1 });
await assert.rejects(api.request("GET", "/instances"), /Invalid API token\. \(the API key is wrong or disabled, or this IP is not in the key's access control list/);

// ---------- register: read-only for the hub, everything for admin; protected IPs ----------
{
  assert.deepEqual(protectedIps({ ORRERY_SELF_IP: "198.51.100.10", ORRERY_PROTECTED_IPS: "198.51.100.20,203.0.113.10" }), ["198.51.100.10", "198.51.100.20", "203.0.113.10"]);
  const chain = new Proxy(function () {}, { get: () => chain, apply: () => chain }); // stands in for zod
  const setup = (env, admin = true) => {
    const g = fakeVultr();
    const handlers = {};
    const fake = { registerTool: (n, spec, handler) => (handlers[n] = handler) };
    const r = vultrRegister(fake, { z: chain, tool: (fn) => fn, adminTool: (n, fn) => fn, admin, env: { VULTR_API_KEY: "test-key", ...env } }, g.fetchImpl);
    return { ...handlers, calls: g.calls, registered: r };
  };
  assert.deepEqual(setup({}, false).registered.tools, ["vultr_instances"]);
  assert.deepEqual(setup({}).registered.tools, ["vultr_instances", "vultr_power", "vultr_delete", "vultr_reinstall", "vultr_api_request", "vultr_query"]);
  assert.deepEqual(vultrRegister({ registerTool() {} }, { z: chain, tool: (fn) => fn, admin: true, env: {}, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "vultr-none-")) }), { id: "vultr", name: "Vultr", configured: false, error: null, tools: [] });

  const t = setup({ ORRERY_PROTECTED_IPS: "203.0.113.10" });
  for (const action of ["halt", "reboot"]) await assert.rejects(t.vultr_power({ instanceId: A, action }), /instance cb676a46-.* \(tokyo-proxy\) has the protected IP 203\.0\.113\.10/);
  await assert.rejects(t.vultr_delete({ instanceId: A, confirmLabel: "tokyo-proxy" }), /protected IP/);
  await assert.rejects(t.vultr_reinstall({ instanceId: A, confirmLabel: "tokyo-proxy" }), /protected IP/);
  await assert.rejects(t.vultr_api_request({ method: "POST", path: `/instances/${A}/halt` }), /protected IP/);
  await assert.rejects(t.vultr_api_request({ method: "PATCH", path: `/instances/${A}`, body: { plan: "vc2-2c-4gb" } }), /protected IP/);
  await assert.rejects(t.vultr_api_request({ method: "POST", path: "/instances/reboot", body: { instance_ids: [B, A] } }), /protected IP/);
  await assert.rejects(t.vultr_api_request({ method: "POST", path: "/instances/halt/extra" }), /Invalid Vultr instance id/, "an id that is not a UUID is not let through unchecked");
  assert.deepEqual(t.calls.filter((c) => c.method !== "GET"), [], "nothing was sent to the protected instance");
  await t.vultr_power({ instanceId: A, action: "start" });
  await t.vultr_api_request({ method: "POST", path: `/instances/${A}/start` });
  await t.vultr_api_request({ method: "POST", path: "/instances/start", body: { instance_ids: [A] } });
  assert.deepEqual(t.calls.filter((c) => c.method !== "GET").map((c) => c.path), [`/instances/${A}/start`, `/instances/${A}/start`, "/instances/start"], "starting stays allowed");

  const other = setup({ ORRERY_PROTECTED_IPS: "198.51.100.1" });
  assert.deepEqual(await other.vultr_power({ instanceId: A, action: "reboot" }), { ok: true, instanceId: A, action: "reboot" });
  await assert.rejects(other.vultr_delete({ instanceId: A, confirmLabel: "wrong" }), /confirmLabel must be "tokyo-proxy"/);
  const created = await other.vultr_api_request({ method: "POST", path: "/instances", body: { region: "nrt" } });
  assert.equal(created.instance.default_password, "[redacted]", "a new instance's root password never reaches the chat");
  assert.equal((await other.vultr_api_request({ method: "GET", path: "/databases/db1" })).database.password, "[redacted]");
  assert.equal((await other.vultr_api_request({ method: "GET", path: "/inference" })).subscriptions[0].api_key, "[redacted]");
  // vultr_query: GET only, with the same refusals and redaction.
  assert.equal((await other.vultr_query({ path: "/inference" })).subscriptions[0].api_key, "[redacted]");
  assert.equal((await other.vultr_query({ path: "/databases/db1" })).database.password, "[redacted]");
  await assert.rejects(other.vultr_query({ path: "/kubernetes/clusters/k1/config" }), /must not end up in the chat/);
  const before = other.calls.length;
  await other.vultr_query({ path: `/instances/${A}`, method: "DELETE", body: { x: 1 } });
  assert.deepEqual(other.calls.slice(before).map((c) => c.method), ["GET"], "vultr_query ignores any method or body it is handed");
  const none = setup({});
  await none.vultr_power({ instanceId: A, action: "reboot" });
  assert.deepEqual(none.calls.map((c) => c.method), ["POST"], "no lookup when nothing is protected");
}

console.log("vultr test passed");
