// Tests for deploy/cloudflare.mjs against an in-memory Cloudflare. Fake data only.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setup, apiClient, wafExpression, writeTunnelToken } from "./cloudflare.mjs";

const fail = (status, message) => Object.assign(new Error(message), { status });

// An in-memory Cloudflare with one zone. `calls` records every change as "METHOD path".
function fakeCloudflare({ zones = [{ id: "z1", name: "example.com", account: { id: "acc" } }], entrypoint = null, records = [], tunnels = [], config = null } = {}) {
  const state = { zones, entrypoint, records, tunnels, config, calls: [], secrets: [], dropped: 0 };
  const request = async ({ method = "GET", path: p, query = {}, body }) => {
    if (method !== "GET") state.calls.push(`${method} ${p}`);
    if (p === "/zones") return query.page === 1 ? state.zones : [];
    if (p === "/accounts/acc/cfd_tunnel" && method === "GET") return state.tunnels.filter((t) => t.name === query.name);
    if (p === "/accounts/acc/cfd_tunnel" && method === "POST") {
      const t = { id: `tun${state.tunnels.length + 1}`, name: body.name, config_src: body.config_src };
      state.tunnels.push(t);
      return t;
    }
    let m;
    if ((m = p.match(/^\/accounts\/acc\/cfd_tunnel\/(\w+)$/)) && method === "PATCH") return state.secrets.push(body.tunnel_secret), {};
    if ((m = p.match(/^\/accounts\/acc\/cfd_tunnel\/(\w+)\/connections$/)) && method === "DELETE") return (state.dropped += 1), {};
    if ((m = p.match(/^\/accounts\/acc\/cfd_tunnel\/(\w+)\/configurations$/))) {
      if (method === "PUT") state.config = body.config;
      return { config: state.config };
    }
    if ((m = p.match(/^\/accounts\/acc\/cfd_tunnel\/(\w+)\/token$/))) return `secret-token-of-${m[1]}-${state.secrets.length}`;
    if (p === "/zones/z1/dns_records" && method === "GET") return state.records.filter((r) => r.name === query.name);
    if (p === "/zones/z1/dns_records" && method === "POST") return state.records.push(body), body;
    if (p === "/zones/z1/rulesets/phases/http_request_firewall_custom/entrypoint") {
      if (!state.entrypoint) throw fail(404, "could not find entrypoint ruleset");
      return state.entrypoint;
    }
    const place = (rule, position) => {
      const rules = state.entrypoint.rules.filter((r) => r.id !== rule.id);
      rules.splice(position ? position.index - 1 : rules.length, 0, rule);
      state.entrypoint.rules = rules;
    };
    if (p === "/zones/z1/rulesets" && method === "POST") return (state.entrypoint = { id: "rs1", ...body, rules: body.rules.map((r, i) => ({ id: `r${i + 1}`, ...r })) });
    if (p === "/zones/z1/rulesets/rs1/rules" && method === "POST") {
      const { position, ...rule } = body;
      place({ id: `r${state.entrypoint.rules.length + 1}`, ...rule }, position);
      return state.entrypoint;
    }
    if ((m = p.match(/^\/zones\/z1\/rulesets\/rs1\/rules\/(\w+)$/)) && method === "PATCH") {
      const { position, ...rule } = body;
      // As the real API does (seen on a live zone): a position the rule already has is an error.
      if (position && state.entrypoint.rules[position.index - 1]?.id === m[1]) throw fail(400, `'${position.index}' is not a valid value for index because the rule is already in that position`);
      place({ id: m[1], ...rule }, position);
      return state.entrypoint;
    }
    throw fail(400, `unexpected ${method} ${p}`);
  };
  return { state, request };
}

const HOST = "orrery.example.com";
const NOTE = "Orrery: only the AI client may reach orrery.example.com";
const RULE = '(http.host eq "orrery.example.com" and not ip.src in {160.79.104.0/21})';
const changes = (state) => state.calls.splice(0);

// A fresh zone: tunnel, route, the zone's first custom rule, DNS record, in that order.
{
  const { state, request } = fakeCloudflare();
  const lines = [];
  const done = await setup({ request, hostname: HOST, log: (l) => lines.push(l) });
  assert.deepEqual(done, { zone: "example.com", tunnelId: "tun1", tunnelToken: "secret-token-of-tun1-0" });
  assert.deepEqual(changes(state), ["POST /accounts/acc/cfd_tunnel", "PUT /accounts/acc/cfd_tunnel/tun1/configurations", "POST /zones/z1/rulesets", "POST /zones/z1/dns_records"], "the firewall rule exists before the DNS record");
  assert.deepEqual(state.tunnels[0], { id: "tun1", name: HOST, config_src: "cloudflare" });
  assert.deepEqual(state.config.ingress, [{ hostname: HOST, service: "http://orrery:8787" }, { service: "http_status:404" }]);
  assert.deepEqual(state.records, [{ type: "CNAME", name: HOST, content: "tun1.cfargotunnel.com", proxied: true, comment: "Orrery" }]);
  assert.deepEqual(state.entrypoint.rules.map((r) => [r.action, r.enabled, r.expression, r.description]), [["block", true, RULE, NOTE]]);
  assert.ok(!lines.join("\n").includes("secret-token"), "the tunnel token is never logged");
  assert.ok(lines.some((l) => l.includes("can be reached only from 160.79.104.0/21")), "the log says who may reach it");

  // Running it again reuses everything, and gives the tunnel a new secret: a token from an earlier
  // run (an old host, a copied .env) can no longer connect.
  const again = await setup({ request, hostname: HOST, log: (l) => lines.push(l) });
  assert.deepEqual(changes(state), ["PATCH /accounts/acc/cfd_tunnel/tun1", "DELETE /accounts/acc/cfd_tunnel/tun1/connections"]);
  assert.ok(Buffer.from(state.secrets[0], "base64").length >= 32 && !lines.join("\n").includes(state.secrets[0]));
  assert.notEqual(again.tunnelToken, done.tunnelToken);
  assert.equal(state.records.length, 1);
  assert.equal(state.entrypoint.rules.length, 1);

  // ORRERY_ALLOW_IPS on a later run takes effect: the installer's own rule is brought up to date.
  await setup({ request, hostname: HOST, allowIps: ["203.0.113.30", "2001:DB8::/48"] });
  assert.ok(changes(state).includes("PATCH /zones/z1/rulesets/rs1/rules/r1"));
  assert.equal(state.entrypoint.rules[0].expression, '(http.host eq "orrery.example.com" and not ip.src in {160.79.104.0/21 203.0.113.30 2001:db8::/48})');

  // So is a rule someone switched off, weakened or moved behind another rule.
  for (const damage of [(r) => (r.enabled = false), (r) => (r.action = "log"), (r) => (r.expression = `(http.host eq "${HOST}")`), () => state.entrypoint.rules.unshift({ id: "skip", action: "skip", expression: "(cf.client.bot)" })]) {
    damage(state.entrypoint.rules.find((r) => r.description === NOTE));
    await setup({ request, hostname: HOST });
    assert.ok(changes(state).includes("PATCH /zones/z1/rulesets/rs1/rules/r1"));
    const first = state.entrypoint.rules[0];
    assert.deepEqual([first.description, first.action, first.enabled, first.expression], [NOTE, "block", true, RULE], "first in the list, blocking, enabled");
  }
}

// A zone that already has custom rules: ours goes first, the others are untouched, nothing is replaced.
{
  const others = [{ id: "a1", description: "theirs", action: "skip", expression: '(http.request.uri.path contains "/health")' }, { id: "a2", description: "also theirs", action: "block", expression: '(http.host eq "admin.example.com" and not ip.src in {160.79.104.0/21})' }];
  const { state, request } = fakeCloudflare({ entrypoint: { id: "rs1", rules: structuredClone(others) } });
  await setup({ request, hostname: HOST });
  assert.ok(state.calls.includes("POST /zones/z1/rulesets/rs1/rules"));
  assert.ok(!state.calls.some((c) => c.startsWith("PUT /zones") || c === "POST /zones/z1/rulesets"), "the existing ruleset is never rewritten");
  assert.equal(state.entrypoint.rules[0].description, NOTE, "before a skip rule that could let requests past it");
  assert.deepEqual(state.entrypoint.rules.slice(1), others);
}

// A rule for this hostname that the installer did not create could let requests past its own. Whatever
// it does (skip, disabled, a weaker condition), the run stops before anything is changed.
for (const theirs of [
  { action: "skip", enabled: true, expression: `(http.host eq "${HOST}")` },
  { action: "block", enabled: false, expression: RULE },
  { action: "block", enabled: true, expression: `(http.host eq "${HOST}" and ip.src.country eq "XX")`, description: "geo" },
  { action: "block", enabled: true, expression: `(not http.host eq "${HOST}")`, description: NOTE + " (edited)" },
]) {
  const { state, request } = fakeCloudflare({ entrypoint: { id: "rs1", rules: [{ id: "x", ...theirs }] } });
  await assert.rejects(setup({ request, hostname: HOST }), /already has a custom rule for orrery\.example\.com that this installer did not create.*nothing was changed/);
  assert.deepEqual(state.calls, []);
  assert.equal(state.records.length, 0, "no DNS record: the hostname does not exist");
}

// A hostname that already points somewhere else is refused before anything is created.
{
  const { state, request } = fakeCloudflare({ records: [{ type: "A", name: HOST, content: "198.51.100.7" }] });
  await assert.rejects(setup({ request, hostname: HOST }), /already has a DNS record \(A 198\.51\.100\.7\).*nothing was changed/);
  assert.deepEqual(state.calls, []);
}

// Reusing a tunnel that carries more than Orrery's route keeps the rest of its configuration.
{
  const config = { ingress: [{ hostname: "other.example.com", service: "http://other:80" }, { service: "http://fallback:80" }], "warp-routing": { enabled: false } };
  const { state, request } = fakeCloudflare({ tunnels: [{ id: "tun1", name: HOST }], config: structuredClone(config) });
  await setup({ request, hostname: HOST });
  assert.deepEqual(state.config, { ...config, ingress: [{ hostname: HOST, service: "http://orrery:8787" }, ...config.ingress] });
  changes(state);
  await setup({ request, hostname: HOST });
  assert.ok(!changes(state).some((c) => c.includes("/configurations")), "a route that is there is not written again");
}

// Bad input never reaches the API; the deepest matching zone wins; API errors pass through.
{
  const { state, request } = fakeCloudflare({ zones: [{ id: "z0", name: "com.example", account: { id: "acc" } }, { id: "z1", name: "example.com", account: { id: "acc" } }] });
  for (const bad of ["", "Orrery.Example.com", "example", 'a.example.com" or true', "a b.example.com"]) await assert.rejects(setup({ request, hostname: bad }), /Not a hostname/);
  for (const bad of ["1.2.3.4} or true", "999.1.1.1", "1.2.3.4/33", "1.2.3.4/24/1", "abc"]) await assert.rejects(setup({ request, hostname: HOST, allowIps: [bad] }), /Not an IP address or range/);
  // A range that would open the hostname to the world, or to a large part of it, is refused.
  for (const wide of ["0.0.0.0/0", "::/0", "203.0.113.30/3", "10.0.0.0/8", "2001:db8::/32"]) await assert.rejects(setup({ request, hostname: HOST, allowIps: [wide] }), /too wide/);
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
