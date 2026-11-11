// Parses fixture responses shaped like the netcup SCP REST API and drives netcup_servers against a
// fake fetch: token refresh, rotation written back to the file, GET-only requests. No netcup account needed.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, toServer, servers, TOKEN_URL } from "../index.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));

// ---------- parsing ----------
const running = toServer(fixture("server-412345.json"));
assert.deepEqual(running, {
  id: 412345,
  name: "v2202610123456789012",
  nickname: "netcup-nbg",
  hostname: "v2202610123456789012.bestsrv.de",
  state: "RUNNING",
  disabled: false,
  site: "Nuremberg",
  architecture: "AMD64",
  product: "VPS 1000 G12",
  cpuCount: 4,
  memoryMiB: 8192,
  diskMiB: 262144,
  uptimeSec: 1036800,
  configChanged: false,
  rescueSystemActive: false,
  snapshotCount: 1,
  ipv4: ["198.51.100.20", "198.51.100.21"],
  ipv6: ["2001:db8:1a2b::/64"],
});
const off = toServer(fixture("server-412346.json"));
assert.equal(off.state, "SHUTOFF");
assert.equal(off.memoryMiB, 16384, "a stopped server shows its configured memory");
assert.equal(off.configChanged, true);
const minimal = toServer(fixture("servers.json")[2]);
assert.equal(minimal.state, null, "list entries carry no live info");
assert.equal(minimal.disabled, true);

// ---------- config ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hub-netcup-"));
assert.equal(loadConfig({}, tmp).configured, false);
assert.equal(loadConfig({ NETCUP_REFRESH_TOKEN: "env-token" }, tmp).refreshToken, "env-token");
const file = path.join(tmp, "netcup.json");
fs.writeFileSync(file, JSON.stringify({ refreshToken: "file-token" }));
const config = loadConfig({}, tmp);
assert.deepEqual(config, { configured: true, refreshToken: "file-token", file });

// ---------- netcup_servers against a fake fetch ----------
const calls = [];
let tokenRequests = 0;
const fetchImpl = async (url, init = {}) => {
  calls.push({ url, method: init.method || "GET" });
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (url === TOKEN_URL) {
    tokenRequests++;
    const form = new URLSearchParams(init.body);
    assert.equal(form.get("client_id"), "scp");
    assert.equal(form.get("grant_type"), "refresh_token");
    assert.equal(form.get("refresh_token"), "file-token");
    return json(200, fixture("token.json"));
  }
  assert.equal(init.method, "GET", "the SCP API is only read");
  assert.equal(init.headers.authorization, `Bearer ${fixture("token.json").access_token}`);
  const u = new URL(url);
  assert.equal(u.origin + u.pathname.replace(/\/api\/.*/, ""), "https://www.servercontrolpanel.de/scp-core");
  if (u.pathname === "/scp-core/api/v1/servers") return json(200, Number(u.searchParams.get("offset")) === 0 ? fixture("servers.json") : []);
  const m = u.pathname.match(/\/servers\/(\d+)$/);
  assert.equal(u.searchParams.get("loadServerLiveInfo"), "true");
  if (m[1] === "412347") return json(404, fixture("not-found.json"));
  return json(200, fixture(`server-${m[1]}.json`));
};
const matchHosts = async () => (ips) => (ips.includes("198.51.100.21") ? { id: "n1", name: "netcup-nbg" } : null);

const res = await servers(config, { matchHosts, fetchImpl });
assert.deepEqual(res.servers.map((s) => [s.id, s.state, s.server?.id ?? null]), [
  [412345, "RUNNING", "n1"],
  [412346, "SHUTOFF", null],
  [412347, null, null],
]);
assert.match(res.servers[2].error, /404: Entity Server with id 412347 not found/, "one failing server keeps its list entry");
assert.equal(res.servers[2].nickname, "old-mail");
assert.equal(tokenRequests, 1, "one token for the whole call");
assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { refreshToken: fixture("token.json").refresh_token }, "the rotated refresh token is saved");
assert.equal((fs.statSync(file).mode & 0o777).toString(8), "600");

await servers(config, { fetchImpl });
assert.equal(tokenRequests, 1, "the access token is reused until it expires");

// A revoked refresh token gives a message that says how to fix it.
const revoked = async (url) =>
  url === TOKEN_URL ? new Response(JSON.stringify(fixture("token-invalid-grant.json")), { status: 400 }) : assert.fail("no API call without a token");
await assert.rejects(servers({ configured: true, refreshToken: "revoked", file: null }, { fetchImpl: revoked }), /invalid_grant: Offline user session not found.*login\.js/);

fs.rmSync(tmp, { recursive: true, force: true });
console.log("netcup parse test passed");
