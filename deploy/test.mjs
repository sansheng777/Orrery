// Tests for deploy/cloudflare.mjs against an in-memory Cloudflare. Fake data only.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setup, apiClient, wafExpression, writeTunnelToken } from "./cloudflare.mjs";

const fail = (status, message) => Object.assign(new Error(message), { status });

// A zone with nothing in it. `calls` records every change as "METHOD path".
function fakeCloudflare({ zones = [{ id: "z1", name: "example.com", account: { id: "acc" } }], entrypoint = null, records = [], tunnels = [] } = {}) {
  const state = { zones, entrypoint, records, tunnels, calls: [], ingress: null };
  const request = async ({ method = "GET", path: p, query = {}, body }) => {
    if (method !== "GET") state.calls.push(`${method} ${p}`);
    if (p === "/zones") return query.page === 1 ? state.zones : [];
    if (p === "/accounts/acc/cfd_tunnel" && method === "GET") return state.tunnels.filter((t) => t.name.startsWith(query.name));
    if (p === "/accounts/acc/cfd_tunnel" && method === "POST") {
      const t = { id: `tun${state.tunnels.length + 1}`, name: body.name, config_src: body.config_src };
      state.tunnels.push(t);
      return t;
    }
    let m;
    if ((m = p.match(/^\/accounts\/acc\/cfd_tunnel\/(\w+)\/configurations$/)) && method === "PUT") return (state.ingress = body.config.ingress);
    if ((m = p.match(/^\/accounts\/acc\/cfd_tunnel\/(\w+)\/token$/))) return `secret-token-of-${m[1]}`;
    if (p === "/zones/z1/dns_records" && method === "GET") return state.records.filter((r) => r.name === query.name);
    if (p === "/zones/z1/dns_records" && method === "POST") return state.records.push(body), body;
    if (p === "/zones/z1/rulesets/phases/http_request_firewall_custom/entrypoint") {
      if (!state.entrypoint) throw fail(404, "could not find entrypoint ruleset");
      return state.entrypoint;
    }
    if (p === "/zones/z1/rulesets" && method === "POST") return (state.entrypoint = { id: "rs1", ...body });
    if (p === "/zones/z1/rulesets/rs1/rules" && method === "POST") return state.entrypoint.rules.push(body), state.entrypoint;
    throw fail(400, `unexpected ${method} ${p}`);
  };
  return { state, request };
}

const HOST = "orrery.example.com";
const RULE = '(http.host eq "orrery.example.com" and not ip.src in {160.79.104.0/21})';

// A fresh zone: tunnel, route, the zone's first custom rule, DNS record, in that order.
{
  const { state, request } = fakeCloudflare();
  const lines = [];
  const done = await setup({ request, hostname: HOST, log: (l) => lines.push(l) });
  assert.deepEqual(done, { zone: "example.com", tunnelId: "tun1", tunnelToken: "secret-token-of-tun1" });
  assert.deepEqual(state.calls, ["POST /accounts/acc/cfd_tunnel", "PUT /accounts/acc/cfd_tunnel/tun1/configurations", "POST /zones/z1/rulesets", "POST /zones/z1/dns_records"], "the WAF rule exists before the DNS record");
  assert.deepEqual(state.tunnels[0], { id: "tun1", name: HOST, config_src: "cloudflare" });
  assert.deepEqual(state.ingress, [{ hostname: HOST, service: "http://orrery:8787" }, { service: "http_status:404" }]);
  assert.deepEqual(state.records, [{ type: "CNAME", name: HOST, content: "tun1.cfargotunnel.com", proxied: true, comment: "Orrery" }]);
  assert.equal(state.entrypoint.rules.length, 1);
  assert.deepEqual([state.entrypoint.rules[0].action, state.entrypoint.rules[0].expression], ["block", RULE]);
  assert.ok(!lines.join("\n").includes("secret-token"), "the tunnel token is never logged");

  // Running it again changes nothing but the route (set to the same value).
  state.calls.length = 0;
  await setup({ request, hostname: HOST });
  assert.deepEqual(state.calls, ["PUT /accounts/acc/cfd_tunnel/tun1/configurations"]);
  assert.equal(state.records.length, 1);
  assert.equal(state.entrypoint.rules.length, 1);
}

// A zone that already has custom rules: ours is appended, the others are untouched, nothing is replaced.
{
  const others = [{ description: "theirs", action: "block", expression: '(http.host eq "admin.example.com" and not ip.src in {160.79.104.0/21})' }];
  const { state, request } = fakeCloudflare({ entrypoint: { id: "rs1", rules: structuredClone(others) } });
  await setup({ request, hostname: HOST, allowIps: ["203.0.113.30", "2001:db8::/32"] });
  assert.ok(state.calls.includes("POST /zones/z1/rulesets/rs1/rules"));
  assert.ok(!state.calls.some((c) => c.startsWith("PUT /zones") || c === "POST /zones/z1/rulesets"), "the existing ruleset is never rewritten");
  assert.deepEqual(state.entrypoint.rules[0], others[0]);
  assert.equal(state.entrypoint.rules[1].expression, '(http.host eq "orrery.example.com" and not ip.src in {160.79.104.0/21 203.0.113.30 2001:db8::/32})');
}

// A hostname that already points somewhere else is refused before anything is created.
{
  const { state, request } = fakeCloudflare({ records: [{ type: "A", name: HOST, content: "198.51.100.7" }] });
  await assert.rejects(setup({ request, hostname: HOST }), /already has a DNS record \(A 198\.51\.100\.7\).*nothing was changed/);
  assert.deepEqual(state.calls, []);
}

// Bad input never reaches the API; the deepest matching zone wins; API errors pass through.
{
  const { state, request } = fakeCloudflare({ zones: [{ id: "z0", name: "com.example", account: { id: "acc" } }, { id: "z1", name: "example.com", account: { id: "acc" } }] });
  for (const bad of ["", "Orrery.Example.com", "example", 'a.example.com" or true', "a b.example.com"]) await assert.rejects(setup({ request, hostname: bad }), /Not a hostname/);
  await assert.rejects(setup({ request, hostname: HOST, allowIps: ["1.2.3.4} or true"] }), /Not an IP address or CIDR/);
  await assert.rejects(setup({ request, hostname: "orrery.example.org" }), /sees no zone for orrery\.example\.org/);
  assert.deepEqual(state.calls, []);
  assert.equal((await setup({ request, hostname: HOST })).zone, "example.com");
  await assert.rejects(setup({ request: async () => Promise.reject(fail(403, "Cloudflare GET /zones: HTTP 403: Authentication error")), hostname: HOST }), /HTTP 403: Authentication error/);
}
assert.equal(wafExpression("a.example.com"), '(http.host eq "a.example.com" and not ip.src in {160.79.104.0/21})');

// apiClient: bearer token, JSON body, the result unwrapped, Cloudflare's error text and status kept.
{
  const seen = [];
  const fakeFetch = async (url, init) => {
    seen.push({ url: String(url), ...init });
    const bad = String(url).includes("/missing");
    return { ok: !bad, status: bad ? 404 : 200, statusText: "", json: async () => (bad ? { success: false, errors: [{ message: "not found" }] } : { success: true, result: [1] }) };
  };
  const request = apiClient("api-token", fakeFetch);
  assert.deepEqual(await request({ path: "/zones", query: { per_page: 50, page: 1 } }), [1]);
  assert.equal(seen[0].url, "https://api.cloudflare.com/client/v4/zones?per_page=50&page=1");
  assert.equal(seen[0].headers.authorization, "Bearer api-token");
  await request({ method: "POST", path: "/x", body: { a: 1 } });
  assert.deepEqual([seen[1].method, seen[1].body, seen[1].headers["content-type"]], ["POST", '{"a":1}', "application/json"]);
  const err = await request({ path: "/missing" }).catch((e) => e);
  assert.equal(err.status, 404);
  assert.match(err.message, /GET \/missing: HTTP 404: not found/);
  assert.ok(!err.message.includes("api-token"));
}

// The env file keeps its other lines, gets exactly one TUNNEL_TOKEN line, and stays private.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orrery-deploy-"));
  const file = path.join(dir, ".env");
  writeTunnelToken(file, "first");
  assert.equal(fs.readFileSync(file, "utf8"), "TUNNEL_TOKEN=first\n");
  fs.writeFileSync(file, "ORRERY_SELF_IP=198.51.100.20\nTUNNEL_TOKEN=first\n# a comment\n", { mode: 0o644 });
  fs.chmodSync(file, 0o644);
  writeTunnelToken(file, "second");
  assert.equal(fs.readFileSync(file, "utf8"), "ORRERY_SELF_IP=198.51.100.20\n# a comment\nTUNNEL_TOKEN=second\n");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("deploy test passed");
