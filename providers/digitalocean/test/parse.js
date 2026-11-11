// The DigitalOcean module against a fake API v2: pagination, the Droplet shape, IP matching, errors, the
// name confirmation, the requests the generic tool refuses, protected IPs and secret redaction. No
// DigitalOcean account needed.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { API, loadConfig, createApi, droplets, toDroplet, assertName, guardRequest, normalizePath, protectedIps, redactSecrets, register as doRegister } from "../index.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
const json = (status, body) => new Response(JSON.stringify(body), { status });
const PROXY = 412345678; // sgp-proxy, 203.0.113.30, tag proxy
const TEST = 412349999; // fra-test, 198.51.100.40, tag test

function fakeDo() {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method || "GET";
    const u = new URL(url);
    assert.equal(u.origin + "/v2", API);
    assert.equal(init.headers.authorization, "Bearer test-token");
    const p = u.pathname.replace("/v2", "");
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: p + u.search, body });
    const page1 = fixture("droplets-page1.json").droplets[0];
    const page2 = fixture("droplets-page2.json").droplets[0];
    if (p === "/droplets" && method === "GET") {
      const tag = u.searchParams.get("tag_name");
      if (tag) return json(200, { droplets: [page1, page2].filter((d) => d.tags.includes(tag)), links: {}, meta: { total: 1 } });
      return json(200, fixture(`droplets-page${u.searchParams.get("page")}.json`));
    }
    if (p === `/droplets/${PROXY}` && method === "GET") return json(200, { droplet: page1 });
    if (p === `/droplets/${TEST}` && method === "GET") return json(200, { droplet: page2 });
    if (p === `/droplets/${TEST}` && method === "DELETE") return new Response(null, { status: 204 });
    if (/^\/droplets\/(\d+\/)?actions$/.test(p) && method === "POST") {
      if (body?.image === "nope") return json(422, fixture("error-422.json"));
      return json(201, { action: { id: 2900000001, status: "in-progress", type: body?.type, resource_id: Number(p.split("/")[2]) || null } });
    }
    if (p === "/databases/9cc10173" && method === "GET") return json(200, fixture("database.json"));
    if (p === "/firewalls/fw-proxy" && method === "GET") return json(200, { firewall: { id: "fw-proxy", droplet_ids: [PROXY], tags: [] } });
    if (p === "/firewalls/fw-proxytag" && method === "GET") return json(200, { firewall: { id: "fw-proxytag", droplet_ids: [], tags: ["proxy"] } });
    if (p === "/firewalls/fw-test" && method === "GET") return json(200, { firewall: { id: "fw-test", droplet_ids: [TEST], tags: [] } });
    if (method !== "GET") return json(200, {});
    return json(404, { id: "not_found", message: "The resource you were accessing could not be found." });
  };
  return { calls, fetchImpl };
}
const config = { configured: true, token: "test-token" };

// ---------- credentials ----------
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "digitalocean-test-"));
assert.deepEqual(loadConfig({}, dataDir), { configured: false });
assert.deepEqual(loadConfig({}), { configured: false });
assert.deepEqual(loadConfig({ DIGITALOCEAN_TOKEN: "env-token" }, dataDir), { configured: true, token: "env-token" });
fs.writeFileSync(path.join(dataDir, "digitalocean.json"), JSON.stringify({ token: "file-token" }));
assert.deepEqual(loadConfig({}, dataDir), { configured: true, token: "file-token" });
fs.writeFileSync(path.join(dataDir, "digitalocean.json"), JSON.stringify({}));
assert.match(loadConfig({}, dataDir).error, /token is missing$/);
fs.writeFileSync(path.join(dataDir, "digitalocean.json"), "dop_v1_secret-token-not-json");
const bad = loadConfig({}, dataDir);
assert.equal(bad.configured, false);
assert.match(bad.error, /not valid JSON$/);
assert.doesNotMatch(bad.error, /secret|dop_v1/, "file content never reaches the connector");

// ---------- droplets: every page, shape, matching ----------
let f = fakeDo();
let api = createApi(config, f.fetchImpl);
const res = await droplets(api, { matchHosts: async () => (ips) => (ips.includes("10.104.0.2") ? { id: "lan", name: "wrong" } : ips.includes("203.0.113.30") ? { id: "s1", name: "singapore" } : null) });
assert.deepEqual(f.calls.map((c) => c.path), ["/droplets?page=1&per_page=200", "/droplets?page=2&per_page=200"]);
assert.equal(res.droplets.length, 2);
assert.deepEqual(res.droplets[0], {
  id: PROXY,
  name: "sgp-proxy",
  status: "active",
  region: "sgp1",
  size: "s-1vcpu-512mb-10gb",
  image: "debian-12-x64",
  vcpus: 1,
  memoryMB: 512,
  diskGB: 10,
  ipv4: ["203.0.113.30"],
  privateIpv4: ["10.104.0.2"],
  ipv6: "2400:6180:0:d2::1a2b:3001",
  tags: ["proxy"],
  created: "2026-05-12T03:10:22Z",
  locked: false,
  server: { id: "s1", name: "singapore" },
});
assert.equal(res.droplets[1].status, "off");
assert.equal(res.droplets[1].image, "Ubuntu 24.04 (LTS) x64", "an image without a slug shows distribution and name");
assert.equal(res.droplets[1].ipv6, null);
assert.equal(res.droplets[1].locked, true);
assert.equal(res.droplets[1].server, null);
assert.match(res.collectedAt, /^\d{4}-\d\d-\d\dT/);
{
  const m = [];
  await droplets(api, { matchHosts: async () => (ips) => (m.push(ips), null) });
  assert.deepEqual(m[0], ["203.0.113.30", "2400:6180:0:d2::1a2b:3001"], "private IPs are never matched");
}
assert.deepEqual(toDroplet({ id: 1, name: "x", status: "new" }), { id: 1, name: "x", status: "new", region: null, size: null, image: null, vcpus: null, memoryMB: null, diskGB: null, ipv4: [], privateIpv4: [], ipv6: null, tags: [], created: null, locked: false });

// The page walk stops at maxPages even if DigitalOcean keeps saying there is a next page.
{
  let n = 0;
  const endless = createApi(config, async () => (n++, json(200, { droplets: [{ id: n }], links: { pages: { next: "x" } } })));
  assert.equal((await endless.all("/droplets", "droplets")).length, 20);
  n = 0;
  assert.equal((await endless.all("/droplets?tag_name=test", "droplets", 3)).length, 3);
}

// ---------- errors and paths ----------
await assert.rejects(api.request("POST", `/droplets/${TEST}/actions`, { body: { type: "rebuild", image: "nope" } }), /DigitalOcean POST \/droplets\/412349999\/actions failed with 422: You specified an invalid image/);
await assert.rejects(api.request("GET", "/droplets/../account"), /Invalid DigitalOcean API path/);
await assert.rejects(api.request("OPTIONS", "/droplets"), /Unsupported method/);
assert.deepEqual(await api.request("DELETE", `/droplets/${TEST}`), {}, "a 204 comes back as {}");
assert.equal((await api.request("GET", `/v2/droplets/${TEST}`)).droplet.name, "fra-test", "a leading /v2 is dropped");

// ---------- name confirmation ----------
await assert.rejects(assertName(api, PROXY, "fra-test"), /Refusing: confirmName must be "sgp-proxy"/);
assert.equal((await assertName(api, PROXY, " sgp-proxy ")).id, PROXY);
await assert.rejects(assertName(api, "abc", "x"), /Invalid Droplet id/);

// ---------- what the generic tool refuses ----------
assert.throws(() => guardRequest("DELETE", `/droplets/${PROXY}`), /digitalocean_delete/);
assert.throws(() => guardRequest("DELETE", `/v2/droplets/${PROXY}/`), /digitalocean_delete/);
assert.throws(() => guardRequest("DELETE", "/droplets?tag_name=test"), /by tag is not offered|with a tag is not offered/);
assert.throws(() => guardRequest("DELETE", "/droplets"), /not offered/);
for (const [m, p] of [["GET", `/droplets/${PROXY}/destroy_with_associated_resources`], ["DELETE", `/droplets/${PROXY}/destroy_with_associated_resources/dangerous`], ["DELETE", `/droplets/${PROXY}/destroy_with_associated_resources/selective`], ["POST", `/droplets/${PROXY}/destroy_with_associated_resources/retry`]]) {
  assert.throws(() => guardRequest(m, p, {}), /associated resources|volumes, snapshots and IPs/, `${m} ${p}`);
}
assert.throws(() => guardRequest("POST", `/droplets/${PROXY}/actions`, { type: "rebuild", image: "debian-12-x64" }), /digitalocean_rebuild/);
assert.throws(() => guardRequest("POST", `/droplets/${PROXY}/actions`, { type: "REBUILD", image: 1 }), /digitalocean_rebuild/);
assert.throws(() => guardRequest("POST", `/droplets/${PROXY}/actions`, { type: "restore", image: 12389723 }), /overwrites the Droplet's disk/);
assert.throws(() => guardRequest("POST", "/droplets/actions?tag_name=test", { type: "rebuild", image: "debian-12-x64" }), /by tag is not offered/);
assert.throws(() => guardRequest("POST", "/droplets/actions?tag_name=test", { type: "restore", image: 1 }), /overwrites/);
for (const [method, p] of [
  ["GET", "/kubernetes/clusters/bd5f5959-5e1e-4205-a714-a914373942af/kubeconfig"],
  ["GET", "/kubernetes/clusters/bd5f5959-5e1e-4205-a714-a914373942af/credentials?expiry_seconds=300"],
  ["GET", "/registry/docker-credentials?read_write=true"],
  ["GET", "/registries/example/docker-credentials"],
  ["POST", "/spaces/keys"],
  ["GET", "/security/secrets/db-password?region=sgp1"],
  ["POST", "/functions/namespaces/fn-1/keys"],
  ["POST", "/dedicated-inferences/di-1/tokens"],
  ["POST", "/gen-ai/agents/a-1/api_keys"],
  ["PUT", "/gen-ai/agents/a-1/api_keys/k-1/regenerate"],
  ["POST", "/gen-ai/models/api_keys"],
  ["PUT", "/gen-ai/models/api_keys/k-1/regenerate"],
  ["POST", "/gen-ai/oauth2/dropbox/tokens"],
  ["GET", "/vector-databases/v-1/credentials"],
  ["GET", "/databases/metrics/credentials"],
]) {
  assert.throws(() => guardRequest(method, p), /must not end up in the chat/, `${method} ${p}`);
}
for (const [method, p, body] of [
  ["GET", `/droplets/${PROXY}`],
  ["GET", "/droplets/actions"],
  ["POST", "/droplets", { name: "test-1", region: "sgp1", size: "s-1vcpu-512mb-10gb", image: "debian-12-x64", tags: ["test"] }],
  ["POST", `/droplets/${PROXY}/actions`, { type: "resize", size: "s-1vcpu-1gb" }],
  ["POST", "/droplets/actions?tag_name=test", { type: "power_off" }],
  ["GET", "/spaces/keys"],
  ["DELETE", "/spaces/keys/DO00QWERTYUIOPASDFGH"],
  ["GET", "/security/secrets?region=sgp1"],
  ["GET", "/gen-ai/agents/a-1/api_keys"],
  ["GET", "/customers/my/invoices?per_page=20"],
]) {
  assert.doesNotThrow(() => guardRequest(method, p, body), `${method} ${p}`);
}

// Paths are checked as fetch will send them: dot segments, empty segments and escapes are refused.
for (const p of [`/droplets/${PROXY}/.`, `/droplets/./${PROXY}`, `//droplets/${PROXY}`, `/droplets/${PROXY}%2F`, `/droplets/${PROXY}#x`, "/droplets/{id}"]) {
  assert.throws(() => guardRequest("DELETE", p), /Invalid DigitalOcean API path/, p);
}
assert.equal(normalizePath(`/droplets/${PROXY}/`), `/droplets/${PROXY}`);
assert.equal(normalizePath("/v2/account"), "/account");
assert.equal(normalizePath("/actions?page=2&per_page=25"), "/actions?page=2&per_page=25");
assert.throws(() => normalizePath("/droplets?x=a/../b#c"), /Invalid DigitalOcean API query/);

// ---------- rate limits and token errors ----------
function flaky(statuses, headers = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push(init.method || "GET");
    const status = statuses.shift() ?? 200;
    return new Response(JSON.stringify(status === 200 ? { droplets: [], links: {}, meta: { total: 0 } } : status === 401 ? { id: "Unauthorized", message: "Unable to authenticate you" } : { id: "too_many_requests", message: "API Rate limit exceeded." }), { status, headers });
  };
  return { calls, fetchImpl };
}
f = flaky([429]);
api = createApi(config, f.fetchImpl, { retryWaitMs: 1 });
assert.deepEqual(await api.request("GET", "/droplets"), { droplets: [], links: {}, meta: { total: 0 } });
assert.deepEqual(f.calls, ["GET", "GET"], "a rate-limited GET is retried once");
f = flaky([503]);
api = createApi(config, f.fetchImpl, { retryWaitMs: 1 });
await api.request("GET", "/droplets");
assert.deepEqual(f.calls, ["GET", "GET"], "a 5xx GET is retried once");
f = flaky([429, 429], { "retry-after": "0" });
api = createApi(config, f.fetchImpl, { retryWaitMs: 1 });
await assert.rejects(api.request("GET", "/droplets"), /failed with 429: API Rate limit exceeded\. \(rate limited\)/);
f = flaky([429], { "retry-after": "60" });
api = createApi(config, f.fetchImpl, { retryWaitMs: 1 });
await assert.rejects(api.request("GET", "/droplets"), /retry after 60s/);
assert.deepEqual(f.calls, ["GET"], "no retry when DigitalOcean asks for a long wait");
f = flaky([429], { "retry-after": "7" });
api = createApi(config, f.fetchImpl, { retryWaitMs: 1 });
await assert.rejects(api.request("POST", "/droplets", { body: {} }), /rate limited, retry after 7s/);
assert.deepEqual(f.calls, ["POST"], "a change is never sent twice");
f = flaky([401]);
api = createApi(config, f.fetchImpl, { retryWaitMs: 1 });
await assert.rejects(api.request("GET", "/droplets"), /failed with 401: Unable to authenticate you \(the DigitalOcean token is invalid, expired or revoked; .*docs\/providers\.md, DigitalOcean/);
assert.deepEqual(f.calls, ["GET"]);

// ---------- secrets in answers are redacted ----------
{
  const db = redactSecrets(fixture("database.json")).database;
  assert.equal(db.connection.password, "[redacted]");
  assert.equal(db.connection.uri, "postgresql://doadmin:[redacted]@backend-do-user-1.db.ondigitalocean.com:25060/defaultdb?sslmode=require");
  assert.equal(db.private_connection.password, "[redacted]");
  assert.match(db.private_connection.uri, /^postgresql:\/\/doadmin:\[redacted\]@private-backend/);
  assert.deepEqual(db.users.map((u) => u.password), ["[redacted]", "[redacted]"]);
  assert.equal(db.users[1].access_key, "[redacted]", "a Kafka user's private key");
  assert.match(db.users[1].access_cert, /BEGIN CERTIFICATE/, "a certificate is not a secret");
  assert.equal(db.connection.user, "doadmin");
  assert.equal(db.connection.port, 25060);
  assert.deepEqual(db.tags, ["prod"]);
  assert.doesNotMatch(JSON.stringify(db), /AVNS_|PRIVATE KEY/);
  const other = redactSecrets({
    key: { name: "k", access_key: "DO00QWERTYUIOPASDFGH", secret_key: "s3cr3t", grants: [] },
    credentials: { basic_auth_username: "u", basic_auth_password: "p" },
    kubeconfig: "apiVersion: v1",
    api_key_info: { uuid: "x", secret_key: "sk" },
    auths: { "registry.digitalocean.com": { auth: "dXNlcjp0b2tlbg==" } },
    client_key_data: "LS0t",
    access_token: "dop_v1_x",
    has_password: true,
    max_tokens: 100,
    token_id: "tok-1",
    password: "",
  });
  assert.deepEqual(other, {
    key: { name: "k", access_key: "DO00QWERTYUIOPASDFGH", secret_key: "[redacted]", grants: [] },
    credentials: { basic_auth_username: "u", basic_auth_password: "[redacted]" },
    kubeconfig: "[redacted]",
    api_key_info: { uuid: "x", secret_key: "[redacted]" },
    auths: { "registry.digitalocean.com": { auth: "[redacted]" } },
    client_key_data: "[redacted]",
    access_token: "[redacted]",
    has_password: true,
    max_tokens: 100,
    token_id: "tok-1",
    password: "",
  });
}

// ---------- register: tools per role, protected IPs, redaction in the generic tool ----------
{
  assert.deepEqual(protectedIps({ ORRERY_SELF_IP: "198.51.100.10", ORRERY_PROTECTED_IPS: "198.51.100.20, 203.0.113.30" }), ["198.51.100.10", "198.51.100.20", "203.0.113.30"]);
  const chain = new Proxy(function () {}, { get: () => chain, apply: () => chain }); // stands in for zod
  const register = (env, admin = true) => {
    const g = fakeDo();
    const handlers = {};
    const fake = { registerTool: (name, spec, handler) => (handlers[name] = handler) };
    const info = doRegister(fake, { z: chain, tool: (fn) => fn, adminTool: (name, fn) => fn, admin, env: { DIGITALOCEAN_TOKEN: "test-token", ...env } }, g.fetchImpl);
    return { ...handlers, info, calls: g.calls };
  };
  assert.deepEqual(register({}, false).info, { id: "digitalocean", name: "DigitalOcean", configured: true, tools: ["digitalocean_droplets"] });
  assert.deepEqual(register({}).info.tools, ["digitalocean_droplets", "digitalocean_power", "digitalocean_delete", "digitalocean_rebuild", "digitalocean_api_request", "digitalocean_query"]);
  assert.deepEqual(doRegister({ registerTool: () => assert.fail("no tools without a token") }, { z: chain, env: {} }), { id: "digitalocean", name: "DigitalOcean", configured: false, error: null, tools: [] });
  assert.equal((await register({}).digitalocean_droplets()).droplets.length, 2);
  {
    const r = register({});
    await assert.rejects(r.digitalocean_query({ path: "/kubernetes/clusters/k1/kubeconfig" }), /must not end up in the chat|returns/);
    await r.digitalocean_query({ path: "/droplets/412345678", method: "DELETE" });
    assert.deepEqual(r.calls.map((c) => c.method), ["GET"], "digitalocean_query only reads");
  }

  const t = register({ ORRERY_PROTECTED_IPS: "203.0.113.30" }); // sgp-proxy
  const refused = /Droplet 412345678 \(sgp-proxy\) has the protected IP 203\.0\.113\.30/;
  for (const action of ["shutdown", "power_off", "reboot", "power_cycle"]) await assert.rejects(t.digitalocean_power({ dropletId: PROXY, action }), refused, action);
  await assert.rejects(t.digitalocean_delete({ dropletId: PROXY, confirmName: "sgp-proxy" }), refused);
  await assert.rejects(t.digitalocean_rebuild({ dropletId: PROXY, confirmName: "sgp-proxy", image: "debian-12-x64" }), refused);
  for (const [method, p, body] of [
    ["POST", `/droplets/${PROXY}/actions`, { type: "shutdown" }],
    ["POST", `/droplets/${PROXY}/actions`, { type: "rename", name: "x" }],
    ["POST", `/droplets/${PROXY}/actions`, { type: "password_reset" }],
    ["DELETE", `/droplets/${PROXY}/backups/policy`],
    ["POST", "/droplets/actions?tag_name=proxy", { type: "power_off" }],
    ["PUT", "/firewalls/fw-proxy", { name: "x", inbound_rules: [] }],
    ["DELETE", "/firewalls/fw-proxytag"],
    ["POST", "/firewalls/fw-test/droplets", { droplet_ids: [PROXY] }],
    ["POST", "/firewalls", { name: "new", tags: ["proxy"], inbound_rules: [] }],
    ["POST", "/volumes/vol-1/actions", { type: "detach", droplet_id: PROXY }],
    ["DELETE", "/tags/proxy/resources", { resources: [{ resource_id: String(PROXY), resource_type: "droplet" }] }],
    ["DELETE", "/tags/proxy"],
    ["POST", "/reserved_ips", { droplet_id: PROXY }],
  ]) {
    await assert.rejects(t.digitalocean_api_request({ method, path: p, body }), refused, `${method} ${p}`);
  }
  await assert.rejects(t.digitalocean_api_request({ method: "POST", path: "/reserved_ips/203.0.113.30/actions", body: { type: "unassign" } }), /touches the protected IP 203\.0\.113\.30/);
  await assert.rejects(t.digitalocean_api_request({ method: "DELETE", path: "/reserved_ips/203.0.113.30" }), /protected IP/);
  assert.deepEqual(t.calls.filter((c) => c.method !== "GET"), [], "nothing was sent that touches the protected Droplet");

  // Powering on and reading stay allowed; other Droplets are untouched by the protection.
  assert.deepEqual(await t.digitalocean_power({ dropletId: PROXY, action: "power_on" }), { ok: true, dropletId: PROXY, action: "power_on", actionId: 2900000001, status: "in-progress" });
  await t.digitalocean_api_request({ method: "POST", path: `/droplets/${PROXY}/actions`, body: { type: "power_on" } });
  await t.digitalocean_api_request({ method: "POST", path: "/droplets/actions?tag_name=proxy", body: { type: "power_on" } });
  await t.digitalocean_api_request({ method: "GET", path: `/droplets/${PROXY}` });
  await t.digitalocean_power({ dropletId: TEST, action: "power_cycle" });
  await t.digitalocean_api_request({ method: "POST", path: "/droplets/actions?tag_name=test", body: { type: "shutdown" } });
  await t.digitalocean_api_request({ method: "PUT", path: "/firewalls/fw-test", body: { name: "x", droplet_ids: [TEST] } });
  await t.digitalocean_api_request({ method: "POST", path: "/droplets", body: { name: "test-1", region: "sgp1", size: "s-1vcpu-512mb-10gb", image: "debian-12-x64", tags: ["test"] } });
  assert.deepEqual(await t.digitalocean_rebuild({ dropletId: TEST, confirmName: "fra-test", image: "debian-12-x64" }), { ok: true, dropletId: TEST, image: "debian-12-x64", actionId: 2900000001, status: "in-progress" });
  await assert.rejects(t.digitalocean_delete({ dropletId: TEST, confirmName: "sgp-proxy" }), /confirmName must be "fra-test"/);
  assert.deepEqual(await t.digitalocean_delete({ dropletId: TEST, confirmName: "fra-test" }), { ok: true, deleted: TEST });
  assert.deepEqual(
    t.calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path} ${c.body?.type ?? ""}`.trim()),
    [
      `POST /droplets/${PROXY}/actions power_on`,
      `POST /droplets/${PROXY}/actions power_on`,
      "POST /droplets/actions?tag_name=proxy power_on",
      `POST /droplets/${TEST}/actions power_cycle`,
      "POST /droplets/actions?tag_name=test shutdown",
      "PUT /firewalls/fw-test",
      "POST /droplets",
      `POST /droplets/${TEST}/actions rebuild`,
      `DELETE /droplets/${TEST}`,
    ],
  );
  await assert.rejects(t.digitalocean_api_request({ method: "DELETE", path: `/droplets/${TEST}` }), /digitalocean_delete/, "guardRequest runs in the tool");

  const db = await t.digitalocean_api_request({ method: "GET", path: "/databases/9cc10173" });
  assert.equal(db.database.connection.password, "[redacted]", "the generic tool redacts its answers");
  assert.doesNotMatch(JSON.stringify(db), /AVNS_/);

  const other = register({ ORRERY_PROTECTED_IPS: "198.51.100.1" });
  assert.equal((await other.digitalocean_power({ dropletId: PROXY, action: "reboot" })).action, "reboot");
  const none = register({});
  await none.digitalocean_power({ dropletId: PROXY, action: "reboot" });
  await none.digitalocean_api_request({ method: "PUT", path: "/firewalls/fw-proxy", body: { name: "x" } });
  assert.deepEqual(none.calls.map((c) => c.method), ["POST", "PUT"], "no lookup when nothing is protected");
}

console.log("digitalocean test passed");
