// The Google Cloud module against a fake token endpoint and Compute Engine API: the signed JWT, token
// caching, pagination across projects, the instance shape, protected instances, name confirmation, the
// requests the generic tool refuses and ssh-keys metadata. No Google account needed.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { API, SCOPE, loadConfig, createApi, signedJwt, instances, toInstance, target, guardRequest, normalizePath, addSshKey, register as gcpRegister } from "../index.js";

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" });
const KEY = { type: "service_account", project_id: "demo-proj", client_email: "hub@demo-proj.iam.gserviceaccount.com", private_key: pem, token_uri: "https://oauth2.googleapis.com/token" };
const json = (status, body) => new Response(JSON.stringify(body), { status });

// ---------- credentials ----------
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gcp-test-"));
assert.deepEqual(loadConfig({}, dataDir), { configured: false });
fs.writeFileSync(path.join(dataDir, "gcp.json"), JSON.stringify(KEY));
let config = loadConfig({}, dataDir);
assert.equal(config.configured, true);
assert.deepEqual(config.projects, ["demo-proj"]);
assert.deepEqual(loadConfig({ GCP_PROJECTS: "demo-proj, other-proj" }, dataDir).projects, ["demo-proj", "other-proj"]);
fs.writeFileSync(path.join(dataDir, "gcp.json"), JSON.stringify({ ...KEY, projects: ["demo-proj", "other-proj"] }));
config = loadConfig({}, dataDir);
assert.deepEqual(config.projects, ["demo-proj", "other-proj"]);
fs.writeFileSync(path.join(dataDir, "gcp.json"), JSON.stringify({ ...KEY, type: "authorized_user" }));
assert.match(loadConfig({}, dataDir).error, /not a service account key/);
fs.writeFileSync(path.join(dataDir, "gcp.json"), "-----BEGIN PRIVATE KEY----- secret");
const bad = loadConfig({}, dataDir);
assert.match(bad.error, /not valid JSON$/);
assert.doesNotMatch(bad.error, /secret|PRIVATE/, "file content never reaches the connector");
fs.writeFileSync(path.join(dataDir, "gcp.json"), JSON.stringify({ ...KEY, projects: ["../x"] }));
assert.match(loadConfig({}, dataDir).error, /invalid or missing project id \.\.\/x/);

// ---------- the signed JWT ----------
{
  const jwt = signedJwt(config, 1_800_000_000);
  const [h, c, s] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(h, "base64url")), { alg: "RS256", typ: "JWT" });
  assert.deepEqual(JSON.parse(Buffer.from(c, "base64url")), { iss: KEY.client_email, scope: SCOPE, aud: KEY.token_uri, iat: 1_800_000_000, exp: 1_800_003_600 });
  assert.ok(crypto.verify("RSA-SHA256", Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s, "base64url")), "signed with the service account key");
}

// ---------- a fake Google ----------
const inst = (n, extra = {}) => ({
  id: String(n.id),
  name: n.name,
  zone: `${API}/projects/${n.project}/zones/${n.zone}`,
  status: n.status || "RUNNING",
  machineType: `${API}/projects/${n.project}/zones/${n.zone}/machineTypes/e2-micro`,
  networkInterfaces: [{ networkIP: "10.140.0.2", accessConfigs: n.ip ? [{ natIP: n.ip }] : [{}] }],
  metadata: { fingerprint: "fp-1", items: n.items || [] },
  creationTimestamp: "2026-05-01T08:00:00.000-07:00",
  ...extra,
});
function fakeGoogle({ failProject } = {}) {
  const calls = [];
  let tokens = 0;
  const state = {
    "demo-proj/asia-east1-b/web-1": inst({ id: 11, name: "web-1", project: "demo-proj", zone: "asia-east1-b", ip: "203.0.113.30", items: [{ key: "ssh-keys", value: "alice:ssh-ed25519 AAAA alice" }, { key: "startup-script", value: "echo hi" }] }),
    "demo-proj/us-central1-a/batch": inst({ id: 12, name: "batch", project: "demo-proj", zone: "us-central1-a", status: "TERMINATED" }, { scheduling: { provisioningModel: "SPOT" }, deletionProtection: true }),
    "other-proj/europe-west1-b/proxy": inst({ id: 21, name: "proxy", project: "other-proj", zone: "europe-west1-b", ip: "198.51.100.40", items: [{ key: "enable-oslogin", value: "TRUE" }] }),
  };
  const fetchImpl = async (url, init = {}) => {
    const method = init.method || "GET";
    if (url === KEY.token_uri) {
      const form = new URLSearchParams(init.body);
      assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
      const [h, c, s] = form.get("assertion").split(".");
      if (!crypto.verify("RSA-SHA256", Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s, "base64url"))) return json(400, { error: "invalid_grant", error_description: "Invalid JWT Signature." });
      tokens++;
      return json(200, { access_token: `tok-${tokens}`, expires_in: 3599 });
    }
    assert.ok(url.startsWith(API), url);
    assert.match(init.headers.authorization, /^Bearer tok-\d+$/);
    const u = new URL(url);
    const p = u.pathname.replace("/compute/v1", "");
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: p + u.search, body });
    let m;
    if ((m = p.match(/^\/projects\/([^/]+)\/aggregated\/instances$/)) && method === "GET") {
      if (m[1] === failProject) return json(403, { error: { code: 403, message: "Compute Engine API has not been used in project other-proj before or it is disabled." } });
      const mine = Object.entries(state).filter(([k]) => k.startsWith(m[1] + "/"));
      // Two pages for demo-proj, the second asked for by a token with characters a literal path may not carry.
      if (m[1] === "demo-proj" && !u.searchParams.get("pageToken")) return json(200, { items: { "zones/asia-east1-b": { instances: [mine[0][1]] }, "zones/asia-east2-a": { warning: { code: "NO_RESULTS_ON_PAGE" } } }, nextPageToken: "Cg/a+b==" });
      if (m[1] === "demo-proj") {
        assert.equal(u.searchParams.get("pageToken"), "Cg/a+b==");
        return json(200, { items: { "zones/us-central1-a": { instances: [mine[1][1]] } } });
      }
      return json(200, { items: Object.fromEntries(mine.map(([k, v]) => [`zones/${k.split("/")[1]}`, { instances: [v] }])) });
    }
    if ((m = p.match(/^\/projects\/([^/]+)$/)) && method === "GET") return json(200, { name: m[1], commonInstanceMetadata: { items: m[1] === "other-proj" ? [{ key: "enable-oslogin", value: "TRUE" }] : [] } });
    if ((m = p.match(/^\/projects\/([^/]+)\/zones\/([^/]+)\/operations\/([^/]+)$/))) return json(200, { name: m[3], status: "DONE" });
    if (/^\/projects\/[^/]+\/zones\/[^/]+\/instances\/bulkInsert$/.test(p) && method === "POST") return json(200, { name: "op-bulk", status: "RUNNING" });
    if ((m = p.match(/^\/projects\/([^/]+)\/zones\/([^/]+)\/instances\/([^/]+)(\/[^/]+)?$/))) {
      const key = `${m[1]}/${m[2]}/${m[3]}`;
      if (!state[key]) return json(404, { error: { code: 404, message: `The resource 'projects/${key}' was not found` } });
      if (method === "GET" && !m[4]) return json(200, state[key]);
      if (m[4] === "/setMetadata") {
        if (body.fingerprint !== state[key].metadata.fingerprint) return json(412, { error: { code: 412, message: "Supplied fingerprint does not match current metadata fingerprint." } });
        state[key].metadata = { fingerprint: "fp-2", items: body.items };
      }
      return json(200, { name: `op-${calls.length}`, status: "RUNNING" });
    }
    return json(404, { error: { code: 404, message: "Not found" } });
  };
  return { calls, fetchImpl, state, tokens: () => tokens };
}

// ---------- token caching ----------
{
  let t = 0;
  const g = fakeGoogle();
  const api = createApi(config, g.fetchImpl, { now: () => t });
  await api.request("GET", "/projects/demo-proj/zones/asia-east1-b/instances/web-1");
  await api.request("GET", "/projects/demo-proj/zones/asia-east1-b/instances/web-1");
  assert.equal(g.tokens(), 1, "one token for many calls");
  t += 3600 * 1000;
  await api.request("GET", "/projects/demo-proj/zones/asia-east1-b/instances/web-1");
  assert.equal(g.tokens(), 2, "a new token after it expires");
  const wrong = { ...config, privateKey: crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey };
  await assert.rejects(createApi(wrong, g.fetchImpl).request("GET", "/projects/demo-proj"), /token failed with 400: invalid_grant: Invalid JWT Signature\. \(the service account key is invalid/);
}

// ---------- instances: every project and page, shape, matching, one project failing ----------
{
  const g = fakeGoogle();
  const api = createApi(config, g.fetchImpl);
  const res = await instances(api, config, { matchHosts: async () => (ips) => (ips.includes("203.0.113.30") ? { id: "s1", name: "taipei" } : null) });
  assert.deepEqual(res.instances.map((i) => `${i.project}/${i.zone}/${i.name}`), ["demo-proj/asia-east1-b/web-1", "demo-proj/us-central1-a/batch", "other-proj/europe-west1-b/proxy"]);
  assert.deepEqual(res.instances[0], {
    id: "11", name: "web-1", project: "demo-proj", zone: "asia-east1-b", status: "RUNNING", machineType: "e2-micro",
    externalIp: "203.0.113.30", internalIp: "10.140.0.2", ipv6: null, spot: false, deletionProtection: false, osLogin: null,
    labels: {}, created: "2026-05-01T08:00:00.000-07:00", server: { id: "s1", name: "taipei" },
  });
  assert.equal(res.instances[1].externalIp, null, "a stopped instance has no external IP");
  assert.equal(res.instances[1].spot, true);
  assert.equal(res.instances[1].deletionProtection, true);
  assert.equal(res.instances[2].osLogin, true);
  assert.deepEqual(res.projects, [{ project: "demo-proj", count: 2, error: null }, { project: "other-proj", count: 1, error: null }]);

  const half = await instances(createApi(config, fakeGoogle({ failProject: "other-proj" }).fetchImpl), config);
  assert.equal(half.instances.length, 2, "one project failing does not hide the other");
  assert.match(half.projects[1].error, /failed with 403: Compute Engine API has not been used .* \(enable the Compute Engine API in that project\)/);
  const only = { ...config, projects: ["other-proj"] };
  await assert.rejects(instances(createApi(only, fakeGoogle({ failProject: "other-proj" }).fetchImpl), only), /other-proj: .*403/, "every project failing is an error");
  assert.equal(toInstance({ name: "x" }, "p").externalIp, null);
}

// ---------- paths and what the generic tool refuses ----------
assert.equal(target({ project: "demo-proj", zone: "asia-east1-b", name: "web-1" }), "/projects/demo-proj/zones/asia-east1-b/instances/web-1");
for (const t of [{ project: "../x", zone: "asia-east1-b", name: "a" }, { project: "demo-proj", zone: "asia-east1-b/..", name: "a" }, { project: "demo-proj", zone: "asia-east1-b", name: "A_b" }]) {
  assert.throws(() => target(t), /Invalid/, JSON.stringify(t));
}
assert.throws(() => guardRequest("DELETE", "/projects/demo-proj/zones/asia-east1-b/instances/web-1"), /gcp_delete/);
assert.throws(() => guardRequest("DELETE", "/projects/demo-proj/zones/asia-east1-b/instances/web-1/"), /gcp_delete/);
assert.throws(() => guardRequest("DELETE", "/projects/demo-proj/zones/asia-east1-b/disks/web-1"), /disk erases its data/);
assert.throws(() => guardRequest("DELETE", "/projects/demo-proj/regions/asia-east1/disks/d"), /disk erases its data/);
assert.doesNotThrow(() => guardRequest("DELETE", "/projects/demo-proj/global/snapshots/s1"));
for (const [method, p] of [
  ["POST", "/projects/demo-proj/zones/asia-east1-b/instanceGroupManagers/web-mig/deleteInstances"],
  ["POST", "/projects/demo-proj/zones/asia-east1-b/instanceGroupManagers/web-mig/recreateInstances"],
  ["POST", "/projects/demo-proj/zones/asia-east1-b/instanceGroupManagers/web-mig/abandonInstances"],
  ["POST", "/projects/demo-proj/zones/asia-east1-b/instanceGroupManagers/web-mig/resize?size=0"],
  ["DELETE", "/projects/demo-proj/zones/asia-east1-b/instanceGroupManagers/web-mig"],
  ["POST", "/projects/demo-proj/regions/asia-east1/instanceGroupManagers/web-mig/deleteInstances"],
  ["POST", "/projects/demo-proj/regions/asia-east1/instanceGroupManagers/web-mig/recreateInstances"],
  ["POST", "/projects/demo-proj/regions/asia-east1/instanceGroupManagers/web-mig/abandonInstances"],
  ["POST", "/projects/demo-proj/regions/asia-east1/instanceGroupManagers/web-mig/resize?size=1"],
  ["DELETE", "/projects/demo-proj/regions/asia-east1/instanceGroupManagers/web-mig/"],
  ["PATCH", "/projects/demo-proj/zones/asia-east1-b/instanceGroupManagers/web-mig"],
  ["PUT", "/projects/demo-proj/zones/asia-east1-b/instanceGroupManagers/web-mig"],
  ["POST", "/projects/demo-proj/zones/asia-east1-b/instanceGroupManagers/web-mig/applyUpdatesToInstances"],
  ["POST", "/projects/demo-proj/zones/asia-east1-b/instanceGroupManagers/web-mig/setInstanceTemplate"],
]) {
  assert.throws(() => guardRequest(method, p), /managed instance group.*protected instance could be among them/, `${method} ${p}`);
}
assert.doesNotThrow(() => guardRequest("GET", "/projects/demo-proj/zones/asia-east1-b/instanceGroupManagers/web-mig"));
assert.doesNotThrow(() => guardRequest("POST", "/projects/demo-proj/zones/asia-east1-b/instanceGroupManagers/web-mig/listManagedInstances"));
assert.doesNotThrow(() => guardRequest("POST", "/projects/demo-proj/zones/asia-east1-b/instanceGroupManagers"), "creating a group names no existing instance");
for (const p of ["/projects/demo-proj/zones/./instances/web-1", "//projects/demo-proj", "/projects/demo-proj/zones/a%2Fb", "/projects/{p}/zones", "/compute/v1/projects/x", "/v1/projects"]) {
  assert.throws(() => guardRequest("DELETE", p), /Invalid Compute Engine API path|start with \/projects/, p);
}
assert.equal(normalizePath("/projects/demo-proj/zones/"), "/projects/demo-proj/zones");

// ---------- the tools: protected instances, name confirmation ----------
{
  const chain = new Proxy(function () {}, { get: () => chain, apply: () => chain }); // stands in for zod
  const register = (env) => {
    const g = fakeGoogle();
    const handlers = {};
    const fake = { registerTool: (n, spec, handler) => (handlers[n] = handler) };
    const info = gcpRegister(fake, { z: chain, tool: (fn) => fn, adminTool: (n, fn) => fn, admin: true, env, dataDir }, g.fetchImpl);
    return { ...handlers, info, calls: g.calls };
  };
  fs.writeFileSync(path.join(dataDir, "gcp.json"), JSON.stringify(KEY));
  const t = register({ ORRERY_PROTECTED_IPS: "203.0.113.30" }); // web-1
  assert.deepEqual(t.info.tools, ["gcp_instances", "gcp_power", "gcp_delete", "gcp_api_request", "gcp_query"]);
  const web = { project: "demo-proj", zone: "asia-east1-b", name: "web-1" };
  for (const action of ["stop", "reset", "suspend"]) await assert.rejects(t.gcp_power({ ...web, action }), /instance web-1 \(demo-proj\/asia-east1-b\) has the protected IP 203\.0\.113\.30/);
  await assert.rejects(t.gcp_delete({ ...web, confirmName: "web-1" }), /protected IP/);
  await assert.rejects(t.gcp_api_request({ method: "POST", path: "/projects/demo-proj/zones/asia-east1-b/instances/web-1/setMachineType", body: {} }), /protected IP/);
  assert.deepEqual(t.calls.filter((c) => c.method !== "GET"), [], "nothing was sent to the protected instance");
  await t.gcp_power({ ...web, action: "start" });
  await t.gcp_api_request({ method: "POST", path: "/projects/demo-proj/zones/asia-east1-b/instances/web-1/resume" });
  assert.deepEqual(t.calls.filter((c) => c.method !== "GET").map((c) => c.path), ["/projects/demo-proj/zones/asia-east1-b/instances/web-1/start", "/projects/demo-proj/zones/asia-east1-b/instances/web-1/resume"], "starting stays allowed");

  const q = t.calls.length;
  await t.gcp_query({ path: "/projects/demo-proj/zones/asia-east1-b/instances/web-1", method: "DELETE" });
  assert.deepEqual(t.calls.slice(q).map((c) => c.method), ["GET"], "gcp_query only reads, even on a protected instance");
  const b = t.calls.length;
  await t.gcp_api_request({ method: "POST", path: "/projects/demo-proj/zones/asia-east1-b/instances/bulkInsert", body: { count: 2, namePattern: "test-##" } });
  assert.deepEqual(t.calls.slice(b).map((c) => `${c.method} ${c.path}`), ["POST /projects/demo-proj/zones/asia-east1-b/instances/bulkInsert"], "bulkInsert is a collection verb, not an instance to look up");
  await assert.rejects(t.gcp_query({ path: "/projects/demo-proj/zones/./instances/web-1" }), /Invalid Compute Engine API path/);

  const o = register({});
  const batch = { project: "demo-proj", zone: "us-central1-a", name: "batch" };
  await assert.rejects(o.gcp_delete({ ...batch, confirmName: "web-1" }), /confirmName must be "batch"/);
  assert.equal((await o.gcp_delete({ ...batch, confirmName: " batch " })).deleted, "demo-proj/us-central1-a/batch");
  assert.deepEqual((await o.gcp_power({ ...web, action: "reset" })).action, "reset");
  assert.deepEqual(o.calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path}`), ["DELETE /projects/demo-proj/zones/us-central1-a/instances/batch", "POST /projects/demo-proj/zones/asia-east1-b/instances/web-1/reset"]);
  await assert.rejects(o.gcp_power({ ...web, zone: "asia-east1-b/../x", action: "stop" }), /Invalid zone/);
  const ro = gcpRegister({ registerTool: () => {} }, { z: chain, tool: (fn) => fn, READ: {}, admin: false, env: {}, dataDir }, fakeGoogle().fetchImpl);
  assert.deepEqual(ro.tools, ["gcp_instances"], "the hub role only reads");
}

// ---------- ssh_bootstrap through metadata ----------
{
  const g = fakeGoogle();
  const api = createApi({ ...config, projects: ["demo-proj", "other-proj"] }, g.fetchImpl);
  const PUB = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample orrery";
  const fast = { pollMs: 1 };
  const r = await addSshKey(api, { project: "demo-proj", zone: "asia-east1-b", name: "web-1", publicKey: PUB }, fast);
  assert.deepEqual(r, { changed: true, user: "orrery" });
  const meta = g.state["demo-proj/asia-east1-b/web-1"].metadata;
  assert.equal(meta.items.find((m) => m.key === "ssh-keys").value, `alice:ssh-ed25519 AAAA alice\norrery:${PUB}`, "existing keys are kept");
  assert.equal(meta.items.find((m) => m.key === "startup-script").value, "echo hi", "other metadata is kept");
  assert.equal(g.calls.find((c) => c.path.endsWith("/setMetadata")).body.fingerprint, "fp-1", "sent with the current fingerprint");
  assert.deepEqual(await addSshKey(api, { project: "demo-proj", zone: "asia-east1-b", name: "web-1", publicKey: PUB }, fast), { changed: false, user: "orrery" }, "added once");
  const batchMeta = await addSshKey(api, { project: "demo-proj", zone: "us-central1-a", name: "batch", publicKey: PUB }, fast);
  assert.equal(batchMeta.changed, true);
  assert.equal(g.state["demo-proj/us-central1-a/batch"].metadata.items.find((m) => m.key === "ssh-keys").value, `orrery:${PUB}`);
  await assert.rejects(addSshKey(api, { project: "other-proj", zone: "europe-west1-b", name: "proxy", publicKey: PUB }, fast), /OS Login/);
}

console.log("gcp test passed");
