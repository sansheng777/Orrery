// The Linode module against a fake API v4: pagination, the instance shape, IP matching, errors, the
// label confirmation and the requests the generic tool refuses. No Linode account needed.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { API, loadConfig, createApi, instances, toInstance, assertLabel, guardRequest, normalizePath, protectedIps, register as linodeRegister } from "../index.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
const json = (status, body) => new Response(JSON.stringify(body), { status });

function fakeLinode() {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method || "GET";
    const u = new URL(url);
    assert.equal(u.origin + "/v4", API);
    assert.equal(init.headers.authorization, "Bearer test-token");
    const p = u.pathname.replace("/v4", "");
    calls.push({ method, path: p + u.search, body: init.body ? JSON.parse(init.body) : undefined });
    if (p === "/linode/instances" && method === "GET") return json(200, fixture(`instances-page${u.searchParams.get("page")}.json`));
    if (p === "/linode/instances/61234567" && method === "GET") return json(200, fixture("instances-page1.json").data[0]);
    if (p.endsWith("/rebuild")) return json(400, fixture("error-400.json"));
    if (/^\/linode\/instances\/61234567\/(reboot|boot)$/.test(p)) return json(200, {});
    return json(404, { errors: [{ reason: "Not found" }] });
  };
  return { calls, fetchImpl };
}
const config = { configured: true, token: "test-token" };

// ---------- credentials ----------
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "linode-test-"));
assert.deepEqual(loadConfig({}, dataDir), { configured: false });
assert.deepEqual(loadConfig({ LINODE_TOKEN: "env-token" }, dataDir), { configured: true, token: "env-token" });
fs.writeFileSync(path.join(dataDir, "linode.json"), JSON.stringify({ token: "file-token" }));
assert.deepEqual(loadConfig({}, dataDir), { configured: true, token: "file-token" });
fs.writeFileSync(path.join(dataDir, "linode.json"), "secret-token-not-json");
const bad = loadConfig({}, dataDir);
assert.equal(bad.configured, false);
assert.match(bad.error, /not valid JSON$/);
assert.doesNotMatch(bad.error, /secret/, "file content never reaches the connector");

// ---------- instances: every page, shape, matching ----------
let f = fakeLinode();
let api = createApi(config, f.fetchImpl);
const res = await instances(api, { matchHosts: async () => (ips) => (ips.includes("192.168.130.5") ? { id: "lan", name: "wrong" } : ips.includes("203.0.113.10") ? { id: "s1", name: "tokyo" } : null) });
assert.deepEqual(f.calls.map((c) => c.path), ["/linode/instances?page=1&page_size=500", "/linode/instances?page=2&page_size=500"]);
assert.equal(res.instances.length, 2);
assert.deepEqual(res.instances[0], {
  id: 61234567,
  label: "tokyo-proxy",
  status: "running",
  region: "ap-northeast",
  type: "g6-nanode-1",
  image: "linode/debian12",
  vcpus: 1,
  memoryMB: 1024,
  diskMB: 25600,
  transferGB: 1000,
  ipv4: ["203.0.113.10", "192.168.130.5"],
  ipv6: "2600:3c18::f03c:94ff:fe12:3456/128",
  tags: ["proxy"],
  backups: false,
  created: "2026-03-02T08:12:44",
  server: { id: "s1", name: "tokyo" },
});
assert.equal(res.instances[1].status, "offline");
assert.equal(res.instances[1].backups, true);
assert.equal(res.instances[1].server, null);
assert.equal(toInstance({ id: 1, label: "x", status: "provisioning" }).ipv6, null, "missing fields come back empty, not undefined");

// ---------- errors and paths ----------
await assert.rejects(api.request("POST", "/linode/instances/61234567/rebuild", { body: { image: "nope" } }), /failed with 400: image: image is not valid; root_pass: Password does not meet/);
await assert.rejects(api.request("GET", "/linode/../account"), /Invalid Linode API path/);
await assert.rejects(api.request("PATCH", "/linode/instances"), /Unsupported method/);
assert.deepEqual(await api.request("POST", "/linode/instances/61234567/reboot"), {});

// ---------- label confirmation ----------
await assert.rejects(assertLabel(api, 61234567, "fra-db"), /Refusing: confirmLabel must be "tokyo-proxy"/);
assert.equal((await assertLabel(api, 61234567, " tokyo-proxy ")).id, 61234567);

// ---------- what the generic tool refuses ----------
assert.throws(() => guardRequest("DELETE", "/linode/instances/61234567"), /linode_delete/);
assert.throws(() => guardRequest("DELETE", "/linode/instances/61234567/"), /linode_delete/);
assert.throws(() => guardRequest("POST", "/linode/instances/61234567/rebuild?x=1"), /linode_rebuild/);
assert.throws(() => guardRequest("POST", "/account/cancel"), /not offered/);
assert.throws(() => guardRequest("DELETE", "/linode/instances/61234567/disks/9"), /disk erases its data/);
assert.throws(() => guardRequest("POST", "/linode/instances/61234567/backups/77/restore", { linode_id: 61234568, overwrite: true }), /overwrite erases every disk/);
assert.doesNotThrow(() => guardRequest("POST", "/linode/instances/61234567/backups/77/restore", { linode_id: 61234568, overwrite: false }));
for (const [method, p] of [["POST", "/profile/tokens"], ["POST", "/object-storage/keys"], ["GET", "/databases/mysql/instances/9/credentials"], ["GET", "/databases/postgresql/instances/9/credentials/"], ["GET", "/lke/clusters/5/kubeconfig"], ["POST", "/account/oauth-clients"], ["POST", "/profile/tfa-enable"]]) {
  assert.throws(() => guardRequest(method, p), /must not end up in the chat/, `${method} ${p}`);
}
assert.doesNotThrow(() => guardRequest("GET", "/profile/tokens"), "listing tokens shows no secrets");
assert.doesNotThrow(() => guardRequest("GET", "/linode/instances/61234567"));

// Paths are checked as fetch will send them: dot segments, empty segments and escapes are refused.
for (const p of ["/linode/instances/61234567/.", "/linode/./instances/61234567", "//linode/instances/61234567", "/linode/instances/61234567%2F", "/linode/instances/61234567#x", "/linode/instances/{id}"]) {
  assert.throws(() => guardRequest("DELETE", p), /Invalid Linode API path/, p);
}
assert.equal(normalizePath("/linode/instances/61234567/"), "/linode/instances/61234567");
assert.equal(normalizePath("/account/events?page=2&page_size=25"), "/account/events?page=2&page_size=25");
assert.throws(() => normalizePath("/linode/instances?x=a/../b#c"), /Invalid Linode API query/);

// ---------- rate limits and token errors ----------
function flaky(statuses, headers = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push(init.method || "GET");
    const status = statuses.shift() ?? 200;
    return new Response(JSON.stringify(status === 200 ? { data: [], page: 1, pages: 1 } : { errors: [{ reason: status === 401 ? "Invalid Token" : "Too Many Requests" }] }), { status, headers });
  };
  return { calls, fetchImpl };
}
f = flaky([429]);
api = createApi(config, f.fetchImpl, { retryWaitMs: 1 });
assert.deepEqual(await api.request("GET", "/linode/instances"), { data: [], page: 1, pages: 1 });
assert.deepEqual(f.calls, ["GET", "GET"], "a rate-limited GET is retried once");
f = flaky([429, 429], { "retry-after": "0" });
api = createApi(config, f.fetchImpl, { retryWaitMs: 1 });
await assert.rejects(api.request("GET", "/linode/instances"), /failed with 429: Too Many Requests \(rate limited\)/);
f = flaky([429], { "retry-after": "7" });
api = createApi(config, f.fetchImpl, { retryWaitMs: 1 });
await assert.rejects(api.request("POST", "/linode/instances", { body: {} }), /rate limited, retry after 7s/);
assert.deepEqual(f.calls, ["POST"], "a change is never sent twice");
f = flaky([401]);
api = createApi(config, f.fetchImpl, { retryWaitMs: 1 });
await assert.rejects(api.request("GET", "/linode/instances"), /Invalid Token \(the Linode token is invalid, expired or revoked/);
assert.deepEqual(f.calls, ["GET"]);

// ---------- protected IPs: a Linode that must keep running is only booted or read ----------
{
  assert.deepEqual(protectedIps({ ORRERY_SELF_IP: "198.51.100.10", ORRERY_PROTECTED_IPS: "198.51.100.20,203.0.113.10" }), ["198.51.100.10", "198.51.100.20", "203.0.113.10"]);
  const chain = new Proxy(function () {}, { get: () => chain, apply: () => chain }); // stands in for zod
  const register = (env) => {
    const g = fakeLinode();
    const handlers = {};
    const fake = { registerTool: (name, spec, handler) => (handlers[name] = handler) };
    linodeRegister(fake, { z: chain, tool: (fn) => fn, adminTool: (name, fn) => fn, admin: true, env: { LINODE_TOKEN: "test-token", ...env } }, g.fetchImpl);
    return { ...handlers, calls: g.calls };
  };
  const t = register({ ORRERY_PROTECTED_IPS: "203.0.113.10" }); // tokyo-proxy, 61234567
  for (const action of ["shutdown", "reboot"]) await assert.rejects(t.linode_power({ linodeId: 61234567, action }), /Linode 61234567 \(tokyo-proxy\) has the protected IP 203\.0\.113\.10/);
  await assert.rejects(t.linode_delete({ linodeId: 61234567, confirmLabel: "tokyo-proxy" }), /protected IP/);
  await assert.rejects(t.linode_rebuild({ linodeId: 61234567, confirmLabel: "tokyo-proxy", body: { image: "linode/debian12" } }), /protected IP/);
  await assert.rejects(t.linode_api_request({ method: "POST", path: "/linode/instances/61234567/shutdown" }), /protected IP/);
  await assert.rejects(t.linode_api_request({ method: "PUT", path: "/linode/instances/61234567", body: { label: "x" } }), /protected IP/);
  assert.deepEqual(t.calls.filter((c) => c.method !== "GET"), [], "nothing was sent to the protected Linode");
  await t.linode_power({ linodeId: 61234567, action: "boot" });
  await t.linode_api_request({ method: "POST", path: "/linode/instances/61234567/boot" });
  assert.deepEqual(t.calls.filter((c) => c.method !== "GET").map((c) => c.path), ["/linode/instances/61234567/boot", "/linode/instances/61234567/boot"], "booting stays allowed");
  const other = register({ ORRERY_PROTECTED_IPS: "198.51.100.1" });
  assert.deepEqual(await other.linode_power({ linodeId: 61234567, action: "reboot" }), { ok: true, linodeId: 61234567, action: "reboot" });
  const none = register({});
  await none.linode_power({ linodeId: 61234567, action: "reboot" });
  assert.deepEqual(none.calls.map((c) => c.method), ["POST"], "no lookup when nothing is protected");
}

console.log("linode test passed");
