// Cloudflare side of an Orrery deployment, done through the API: a tunnel for the host, the public
// hostname's route and DNS record, and the WAF rule that lets only the AI client's network reach it.
// install.sh runs this once, inside the Orrery image:
//   CLOUDFLARE_API_TOKEN=... node cloudflare.mjs <hostname> <env file>
// It only adds things: an existing DNS record or WAF rule is never changed or replaced, and running it
// again for the same hostname reuses what is there. The tunnel token goes straight into the env file
// and is never printed. The API token needs: Account > Cloudflare Tunnel > Edit, and for the zone
// Zone > Read, DNS > Edit and Zone WAF > Edit.
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const API = "https://api.cloudflare.com/client/v4";
const CLAUDE_AI = "160.79.104.0/21"; // Anthropic's egress range: where claude.ai connectors call from
const SERVICE = "http://orrery:8787"; // the agent, by its compose service name
const HOSTNAME = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const IP_OR_CIDR = /^(\d{1,3}(\.\d{1,3}){3}|[0-9a-f:]*:[0-9a-f:]*)(\/\d{1,3})?$/i;

// request({ method, path, query, body }) -> the API's `result`. A failure throws an Error with `status`.
export function apiClient(token, fetchImpl = fetch) {
  return async ({ method = "GET", path, query, body }) => {
    const url = new URL(API + path);
    for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
    const res = await fetchImpl(url, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
    const data = await res.json().catch(() => null);
    if (res.ok && data?.success) return data.result;
    const why = (data?.errors || []).map((e) => e.message).join("; ") || res.statusText || "no details";
    throw Object.assign(new Error(`Cloudflare ${method} ${path}: HTTP ${res.status}: ${why}`), { status: res.status });
  };
}

export const wafExpression = (hostname, allowIps = []) => `(http.host eq "${hostname}" and not ip.src in {${[CLAUDE_AI, ...allowIps].join(" ")}})`;

// Returns { zone, tunnelId, tunnelToken }. allowIps: more addresses or CIDRs that may reach the hostname.
export async function setup({ request, hostname, allowIps = [], log = () => {} }) {
  if (!HOSTNAME.test(hostname)) throw new Error(`Not a hostname: "${hostname}". Use lowercase, such as orrery.example.com.`);
  const badIp = allowIps.find((ip) => !IP_OR_CIDR.test(ip));
  if (badIp) throw new Error(`Not an IP address or CIDR: "${badIp}"`);

  // Everything is read before anything is changed, so a conflict stops the run with nothing half done.
  const zones = [];
  for (let page = 1; ; page++) {
    const batch = await request({ path: "/zones", query: { per_page: 50, page } });
    zones.push(...batch);
    if (batch.length < 50) break;
  }
  const zone = zones.filter((z) => hostname === z.name || hostname.endsWith(`.${z.name}`)).sort((a, b) => b.name.length - a.name.length)[0];
  if (!zone) throw new Error(`The API token sees no zone for ${hostname}. Its domain must be on Cloudflare and inside the token's zone resources.`);
  const account = zone.account.id;
  log(`Zone ${zone.name}`);

  const tunnels = await request({ path: `/accounts/${account}/cfd_tunnel`, query: { name: hostname, is_deleted: false } });
  let tunnel = tunnels.find((t) => t.name === hostname);
  const target = (id) => `${id}.cfargotunnel.com`;
  const records = (await request({ path: `/zones/${zone.id}/dns_records`, query: { name: hostname } })).filter((r) => r.name === hostname);
  const ours = tunnel && records.find((r) => r.type === "CNAME" && r.content === target(tunnel.id));
  const foreign = records.find((r) => r !== ours && ["A", "AAAA", "CNAME"].includes(r.type));
  if (foreign) throw new Error(`${hostname} already has a DNS record (${foreign.type} ${foreign.content}). Remove it in Cloudflare or choose another hostname; nothing was changed.`);

  if (tunnel) log(`Tunnel "${hostname}" exists, reusing it`);
  else {
    tunnel = await request({ method: "POST", path: `/accounts/${account}/cfd_tunnel`, body: { name: hostname, config_src: "cloudflare" } });
    log(`Tunnel "${hostname}" created`);
  }
  await request({
    method: "PUT",
    path: `/accounts/${account}/cfd_tunnel/${tunnel.id}/configurations`,
    body: { config: { ingress: [{ hostname, service: SERVICE }, { service: "http_status:404" }] } },
  });
  log(`Route ${hostname} -> ${SERVICE}`);

  // The WAF rule comes before the DNS record, so the hostname is never reachable without it.
  const rule = { action: "block", expression: wafExpression(hostname, allowIps), description: `Orrery: only the AI client may reach ${hostname}`, enabled: true };
  const phase = "http_request_firewall_custom";
  const entry = await request({ path: `/zones/${zone.id}/rulesets/phases/${phase}/entrypoint` }).catch((e) => (e.status === 404 ? null : Promise.reject(e)));
  if (!entry) {
    await request({ method: "POST", path: `/zones/${zone.id}/rulesets`, body: { name: "default", kind: "zone", phase, rules: [rule] } });
    log("WAF rule added (the zone's first custom rule)");
  } else if ((entry.rules || []).some((r) => r.expression?.includes(`http.host eq "${hostname}"`))) {
    log("A WAF rule for this hostname exists, leaving it as it is");
  } else {
    await request({ method: "POST", path: `/zones/${zone.id}/rulesets/${entry.id}/rules`, body: rule });
    log("WAF rule added");
  }

  if (ours) log("DNS record exists");
  else {
    await request({ method: "POST", path: `/zones/${zone.id}/dns_records`, body: { type: "CNAME", name: hostname, content: target(tunnel.id), proxied: true, comment: "Orrery" } });
    log("DNS record created");
  }

  const tunnelToken = await request({ path: `/accounts/${account}/cfd_tunnel/${tunnel.id}/token` });
  return { zone: zone.name, tunnelId: tunnel.id, tunnelToken };
}

// Sets TUNNEL_TOKEN in the env file and keeps its other lines. The file stays private (mode 600).
export function writeTunnelToken(file, token) {
  const kept = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter((l) => l && !l.startsWith("TUNNEL_TOKEN=")) : [];
  fs.writeFileSync(file, [...kept, `TUNNEL_TOKEN=${token}`].join("\n") + "\n", { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const [hostname, envFile] = process.argv.slice(2);
  const token = process.env.CLOUDFLARE_API_TOKEN;
  try {
    if (!hostname || !envFile || !token) throw new Error("Usage: CLOUDFLARE_API_TOKEN=... node cloudflare.mjs <hostname> <env file>");
    const allowIps = (process.env.ORRERY_ALLOW_IPS || "").split(/[\s,]+/).filter(Boolean);
    const done = await setup({ request: apiClient(token), hostname, allowIps, log: (line) => console.error(`   ${line}`) });
    writeTunnelToken(envFile, done.tunnelToken);
    console.error("   Tunnel token saved");
  } catch (e) {
    console.error(`Cloudflare setup failed: ${e.message}`);
    process.exit(1);
  }
}
