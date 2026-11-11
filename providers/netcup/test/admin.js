// The netcup control helpers against a fake SCP: request shapes, the server-name confirmation, the
// user id lookup and spec matching. No netcup account needed.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TOKEN_URL, loadConfig } from "../index.js";
import { createScp, endpointsOf, matchEndpoint, serverStateRequest, assertServerName, assertNotSelf, summarize, protectedIps, redactPasswords, registerAdmin } from "../admin.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status });

function fakeScp({ userinfo = { sub: "f1e2d3c4-0000-4000-8000-000000000001", id: 50123 }, expireOnce = false } = {}) {
  const calls = [];
  let expired = expireOnce;
  const fetchImpl = async (url, init = {}) => {
    const method = init.method || "GET";
    if (url === TOKEN_URL) return json(200, { ...fixture("token.json"), refresh_token: "admin-test-token" });
    if (url.endsWith("/userinfo")) return json(200, userinfo);
    const u = new URL(url);
    calls.push({ method, path: u.pathname.replace("/scp-core", "") + u.search, type: init.headers["content-type"] || null, body: init.body ? JSON.parse(init.body) : undefined });
    if (expired) {
      expired = false;
      return json(401, { message: "expired" });
    }
    const p = u.pathname.replace("/scp-core", "");
    if (p === "/api/v1/openapi") return json(200, fixture("openapi-excerpt.json"));
    if (p === "/api/v1/tasks") return json(200, [fixture("task-accepted.json")]);
    if (p === "/api/v1/servers/412345" && method === "GET") return json(200, fixture("server-412345.json"));
    if (p === "/api/v1/servers/412345" && method === "PATCH") return json(202, fixture("task-accepted.json"));
    if (p.endsWith("/snapshots") && method === "POST") return json(422, fixture("validation-error.json"));
    if (p.endsWith("/rescuesystem") && method === "DELETE") return new Response(null, { status: 204 });
    return json(404, fixture("not-found.json"));
  };
  return { calls, fetchImpl };
}
const config = () => ({ configured: true, refreshToken: "admin-test-token", file: null });

// ---------- power: merge-patch body and stateOption ----------
assert.deepEqual(serverStateRequest("ON", "POWERCYCLE"), { query: "?stateOption=POWERCYCLE", body: { state: "ON" } });
assert.deepEqual(serverStateRequest("OFF"), { query: "", body: { state: "OFF" } });
assert.throws(() => serverStateRequest("OFF", "RESET"), /not valid with state OFF/);
assert.throws(() => serverStateRequest("REBOOT"), /ON, OFF or SUSPENDED/);

let f = fakeScp({ expireOnce: true });
let scp = createScp(config, f.fetchImpl, {});
const r = serverStateRequest("ON", "RESET");
const res = summarize(await scp.request("PATCH", `/api/v1/servers/412345${r.query}`, { body: r.body, contentType: "application/merge-patch+json" }));
assert.deepEqual(res, { accepted: true, task: { uuid: "4f8a1c2e-7b3d-4e5f-9a0b-1c2d3e4f5a6b", name: "Server state change", state: "RUNNING", message: null, progress: 0 } });
assert.equal(f.calls.length, 2, "an expired access token is refreshed once and the call repeated");
assert.deepEqual(f.calls[1], { method: "PATCH", path: "/api/v1/servers/412345?stateOption=RESET", type: "application/merge-patch+json", body: { state: "ON" } });

// ---------- errors and empty responses ----------
await assert.rejects(scp.request("POST", "/api/v1/servers/412345/snapshots", { body: { name: "" } }), /failed with 422: Validation failed\. \(name: must not be blank\)/);
assert.deepEqual(summarize(await scp.request("DELETE", "/api/v1/servers/412345/rescuesystem")), { ok: true, status: 204 });
await assert.rejects(scp.request("GET", "/api/v1/../realms"), /Invalid SCP path/);
await assert.rejects(scp.request("TRACE", "/api/v1/servers"), /Unsupported method/);

// ---------- confirmation by server name ----------
await assert.rejects(assertServerName(scp, 412345, "netcup"), /Refusing: confirmServerName must be one of "v2202610123456789012", "netcup-nbg", "v2202610123456789012.bestsrv.de"/);
assert.equal((await assertServerName(scp, 412345, " netcup-nbg ")).id, 412345);

// ---------- user id: userinfo first, then the newest task ----------
assert.equal(await scp.getUserId(), "50123");
f = fakeScp({ userinfo: { sub: "f1e2d3c4-0000-4000-8000-000000000001" } });
scp = createScp(config, f.fetchImpl, {});
assert.equal(await scp.getUserId(), "50123", "falls back to the executing user of the newest task");
assert.equal(await createScp(config, f.fetchImpl, { NETCUP_USER_ID: "777" }).getUserId(), "777");

// ---------- spec matching for the generic tool ----------
const spec = await scp.getSpec();
assert.equal(spec.version, "2026.0728.082537");
const eps = endpointsOf(fixture("openapi-excerpt.json"));
assert.equal(matchEndpoint(eps, "PATCH", "/api/v1/servers/42?stateOption=RESET").merge, true, "PATCH /servers/{id} takes merge-patch JSON");
assert.equal(matchEndpoint(eps, "POST", "/api/v1/users/50123/firewall-policies").merge, false);
assert.equal(matchEndpoint(eps, "DELETE", "/api/v1/servers/42/snapshots"), null, "undocumented method");
assert.equal(matchEndpoint(eps, "GET", "/api/v1/servers/42/snapshots/x/y"), null, "placeholders do not span segments");

// ---------- actions without input still carry a Content-Type (netcup answers 400 otherwise) ----------
{
  const g = fakeScp();
  const plain = createScp(config, g.fetchImpl, {});
  await plain.request("POST", "/api/v1/servers/412345/rescuesystem").catch(() => {});
  await plain.request("DELETE", "/api/v1/servers/412345/rescuesystem");
  await plain.request("GET", "/api/v1/servers/412345?loadServerLiveInfo=false");
  const [post, del, get] = g.calls;
  assert.equal(post.type, "application/json");
  assert.deepEqual(post.body, {});
  assert.equal(del.type, null, "DELETE without input sends no body");
  assert.equal(get.type, null);
}

// ---------- the middle server and the other protected machines are never taken down from a chat ----------
{
  const g = fakeScp();
  const guarded = createScp(config, g.fetchImpl, {});
  await assert.rejects(assertNotSelf(guarded, 412345, "198.51.100.20"), /middle server/);
  await assertNotSelf(guarded, 412345, "203.0.113.9"); // another machine: allowed
  await assert.rejects(assertNotSelf(guarded, 412345, "203.0.113.9", ["198.51.100.21"]), /protected IP 198\.51\.100\.21/);
  const before = g.calls.length;
  await assert.rejects(assertNotSelf(guarded, 412345, null), /Set ORRERY_SELF_IP \(deploy\/enable-ssh\.sh\)/, "unknown middle server: nothing is taken down");
  assert.equal(g.calls.length, before, "refused before any request");
  assert.deepEqual(protectedIps({ ORRERY_SELF_IP: " 198.51.100.10 ", ORRERY_PROTECTED_IPS: "198.51.100.20, 198.51.100.10,2001:DB8::1" }), ["198.51.100.10", "198.51.100.20", "2001:db8::1"]);
  assert.deepEqual(protectedIps({}), []);
}

// ---------- results: passwords never reach the chat ----------
assert.deepEqual(redactPasswords({ ok: true, result: { active: true, password: "x", nested: [{ rootPassword: "y", sshPasswordAuthentication: true, Password: null }] } }), {
  ok: true,
  result: { active: true, password: "[redacted]", nested: [{ rootPassword: "[redacted]", sshPasswordAuthentication: true, Password: null }] },
});

// ---------- netcup_api_request, as registered for the admin agent ----------
{
  // Server 412345 (198.51.100.20) is the middle server; policy 501 is attached to its interface.
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method || "GET";
    if (url === TOKEN_URL) return json(200, { ...fixture("token.json"), refresh_token: "admin-test-token" });
    if (url.endsWith("/userinfo")) return json(200, { id: 50123 });
    const u = new URL(url);
    const p = u.pathname.replace("/scp-core", "");
    calls.push(`${method} ${p}${u.search}`);
    if (p === "/api/v1/openapi") return json(200, fixture("openapi-excerpt.json"));
    if (p === "/api/v1/servers" && method === "GET") return json(200, fixture("servers.json"));
    if (/^\/api\/v1\/servers\/41234[56]$/.test(p) && method === "GET") return json(200, fixture(`server-${p.split("/").pop()}.json`));
    if (p === "/api/v1/servers/412347" && method === "GET") return json(200, fixture("servers.json")[2]);
    if (p === "/api/v1/servers/412345/interfaces/aa:bb:cc:00:00:01/firewall") return json(200, fixture("interface-firewall.json"));
    if (p.endsWith("/rescuesystem") && method === "GET") return json(200, fixture("rescuesystem-active.json"));
    if (p === "/api/v1/tasks") return json(200, [fixture("task-accepted.json")]);
    if (method !== "GET") return json(202, fixture("task-accepted.json"));
    return json(404, fixture("not-found.json"));
  };
  const chain = new Proxy(function () {}, { get: () => chain, apply: () => chain }); // stands in for zod
  const handlers = {};
  const fakeServer = { registerTool: (name, spec, handler) => (handlers[name] = handler) };
  const register = (env) => {
    for (const k of Object.keys(handlers)) delete handlers[k];
    registerAdmin(fakeServer, { z: chain, tool: (fn) => fn, adminTool: (name, fn) => fn, env }, config, fetchImpl);
    return handlers.netcup_api_request;
  };
  const api = register({ ORRERY_SELF_IP: "198.51.100.20" });
  const changes = () => calls.filter((c) => !c.startsWith("GET"));

  // Only literal paths: a query, escape, fragment or dot segment could hide the real target.
  for (const p of ["/api/v1/servers/412346/image?", "/api/v1/servers/412346/image?x=1", "/api/v1/servers/412346/%69mage", "/api/v1/servers/412346/image#x", "/api/v1/servers/412346/./image", "/api/v1/servers/412345/%2e%2e/412346", "/api/v1/servers//412346"]) {
    await assert.rejects(api({ method: "POST", path: p, body: {} }), /literal API path/, p);
  }
  await assert.rejects(api({ method: "POST", path: "/api/v1/servers/412346/image", body: {} }), /netcup_reinstall/);
  assert.deepEqual(calls, [], "refused before any request");

  // Nothing but reading on the middle server; other servers can be changed.
  for (const [method, p, body] of [["PATCH", "/api/v1/servers/412345", { hostname: "web" }], ["PATCH", "/api/v1/servers/412345", { State: "OFF" }], ["PUT", "/api/v1/servers/412345/interfaces/aa:bb:cc:00:00:01/firewall", { userPolicies: [] }], ["DELETE", "/api/v1/servers/412345/rescuesystem"]]) {
    await assert.rejects(api({ method, path: p, body }), /middle server/, `${method} ${p}`);
  }
  await assert.rejects(api({ method: "PATCH", path: "/api/v1/servers/v2202610123456789012", body: { state: "OFF" } }), /numeric server id/);
  assert.deepEqual(changes(), [], "nothing was sent to the middle server");
  assert.equal((await api({ method: "PATCH", path: "/api/v1/servers/412346", body: { nickname: "db" } })).accepted, true);
  assert.deepEqual(changes(), ["PATCH /api/v1/servers/412346"]);

  // Firewall policies: one attached to the middle server's interface stays as it is.
  calls.length = 0;
  await assert.rejects(api({ method: "PUT", path: "/api/v1/users/{userId}/firewall-policies/501", body: { rules: [] } }), /policy 501 is attached to server 412345/);
  await assert.rejects(api({ method: "DELETE", path: "/api/v1/users/50123/firewall-policies/501" }), /attached/);
  for (const id of ["0501", "501.", "5e2"]) await assert.rejects(api({ method: "PUT", path: `/api/v1/users/{userId}/firewall-policies/${id}`, body: {} }), /numeric firewall policy id/, id);
  assert.equal((await api({ method: "PUT", path: "/api/v1/users/{userId}/firewall-policies/502", body: { rules: [] } })).accepted, true);
  assert.deepEqual(changes(), ["PUT /api/v1/users/50123/firewall-policies/502"]);
  assert.equal(calls.filter((c) => c.startsWith("GET /api/v1/servers?")).length, 1, "the protected server's id is looked up once");

  // The rescue system's password is not returned.
  const rescue = await api({ method: "GET", path: "/api/v1/servers/412346/rescuesystem" });
  assert.deepEqual(rescue.result, { active: true, password: "[redacted]" });
  await api({ method: "GET", path: "/api/v1/tasks", query: { limit: 1 } });
  assert.equal(calls.at(-1), "GET /api/v1/tasks?limit=1", "query parameters go through query");

  // netcup_query: the same request, GET only, even on the middle server, without method or body.
  const query = handlers.netcup_query;
  assert.deepEqual((await query({ path: "/api/v1/servers/412346/rescuesystem" })).result, { active: true, password: "[redacted]" });
  calls.length = 0;
  await query({ path: "/api/v1/servers/412345/interfaces/aa:bb:cc:00:00:01/firewall", method: "PUT", body: { userPolicies: [] } });
  await query({ path: "/api/v1/tasks", query: { limit: 1 } });
  assert.deepEqual(calls.filter((c) => !c.startsWith("GET /api/v1/openapi")), ["GET /api/v1/servers/412345/interfaces/aa:bb:cc:00:00:01/firewall", "GET /api/v1/tasks?limit=1"], "netcup_query only reads");
  await assert.rejects(query({ path: "/api/v1/servers/412346/./image" }), /literal API path/);

  // Without ORRERY_SELF_IP nothing is changed on any server and no firewall policy is touched.
  calls.length = 0;
  const blind = register({});
  await assert.rejects(blind({ method: "PATCH", path: "/api/v1/servers/412346", body: { nickname: "db" } }), /Set ORRERY_SELF_IP/);
  await assert.rejects(blind({ method: "PUT", path: "/api/v1/users/50123/firewall-policies/502", body: {} }), /Set ORRERY_SELF_IP/);
  assert.deepEqual(changes(), []);
  await assert.rejects(handlers.netcup_set_power({ serverId: 412346, state: "OFF" }), /Set ORRERY_SELF_IP/);
  assert.equal((await handlers.netcup_set_power({ serverId: 412346, state: "ON" })).accepted, true, "starting a server stays allowed");

  // ORRERY_PROTECTED_IPS: another machine that must keep running.
  const guardedApi = register({ ORRERY_SELF_IP: "203.0.113.250", ORRERY_PROTECTED_IPS: "198.51.100.30" });
  await assert.rejects(guardedApi({ method: "POST", path: "/api/v1/servers/412346/rescuesystem" }), /protected IP 198\.51\.100\.30/);
  await assert.rejects(handlers.netcup_rescue_system({ serverId: 412346, active: true }), /protected IP/);
}

// ---------- refresh token rotation: callers re-read the file, the session survives ----------
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hub-netcup-rotate-"));
  const file = path.join(tmp, "netcup.json");
  fs.writeFileSync(file, JSON.stringify({ refreshToken: "R0" }));
  const used = [];
  let n = 0;
  const fetchImpl = async (url, init = {}) => {
    if (url === TOKEN_URL) {
      used.push(new URLSearchParams(init.body).get("refresh_token"));
      n++;
      return json(200, { access_token: `A${n}`, expires_in: 300, refresh_token: `R${n}` }); // a new refresh token every time, as Keycloak does
    }
    return json(200, []);
  };
  const rotating = createScp(() => loadConfig({}, tmp), fetchImpl, {});
  for (let i = 0; i < 5; i++) await rotating.request("GET", "/api/v1/tasks?limit=1&offset=0");
  assert.deepEqual(used, ["R0"], "several calls after a rotation refresh once, not every time");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { refreshToken: "R1" });
  fs.writeFileSync(file, JSON.stringify({ refreshToken: "signed-in-again" })); // login.js was run again
  await rotating.request("GET", "/api/v1/tasks?limit=1&offset=0");
  await rotating.request("GET", "/api/v1/tasks?limit=1&offset=0");
  assert.deepEqual(used, ["R0", "signed-in-again"], "a token from a new sign-in starts a new session");
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("netcup admin test passed");
