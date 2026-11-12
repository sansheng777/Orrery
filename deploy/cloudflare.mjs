// Cloudflare side of an Orrery deployment, done through the API: a tunnel for the host, the public
// hostname's route and DNS record, and the WAF rule that lets only the AI client's network reach it.
// install.sh runs this once, inside the Orrery image:
//   printf %s "$TOKEN" | node cloudflare.mjs <hostname> <env file>
// It touches only what is its own (see setup) and stops at anything for the hostname that it did not
// create. Running it again reuses the tunnel with a new secret. The tunnel token goes straight into the
// env file and is never printed. The API token needs: Account > Cloudflare Tunnel > Edit, and for the
// zone Zone > Read, DNS > Edit and Zone WAF > Edit.
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const API = "https://api.cloudflare.com/client/v4";
const CLAUDE_AI = "160.79.104.0/21"; // Anthropic's egress range: where claude.ai connectors call from
const SERVICE = "http://orrery:8787"; // the agent, by its compose service name
const HOSTNAME = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const PHASE = "http_request_firewall_custom";

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

// An address or a small range that may reach the hostname besides claude.ai. Wide ranges are refused:
// "0.0.0.0/0" would switch the rule off, and that is too easy to suggest as a fix for a 403.
export function allowedSource(value) {
  const [ip, prefix, ...rest] = String(value).split("/");
  const bits = prefix === undefined ? null : /^\d{1,3}$/.test(prefix) ? Number(prefix) : NaN;
  const v4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) && ip.split(".").every((n) => Number(n) <= 255);
  const v6 = !v4 && /^[0-9a-f:]{2,39}$/i.test(ip) && ip.includes(":");
  if (rest.length || (!v4 && !v6) || Number.isNaN(bits) || bits > (v4 ? 32 : 128)) throw new Error(`Not an IP address or range: "${value}"`);
  if (bits !== null && bits < (v4 ? 24 : 48)) {
    throw new Error(`${value} is too wide. Give single addresses, or ranges up to /24 (IPv4) or /48 (IPv6); a wider range can only be set by hand in Cloudflare.`);
  }
  return String(value).toLowerCase();
}

export const wafExpression = (hostname, allowIps = []) => `(http.host eq "${hostname}" and not ip.src in {${[CLAUDE_AI, ...allowIps].join(" ")}})`;
const ruleNote = (hostname) => `Orrery: only the AI client may reach ${hostname}`;
const newSecret = () => btoa(String.fromCharCode(...globalThis.crypto.getRandomValues(new Uint8Array(32))));

// Returns { zone, tunnelId, tunnelToken }. allowIps: more addresses or small ranges that may reach the hostname.
// What it touches in Cloudflare is its own: the tunnel named after the hostname, that hostname's DNS
// record, and the one firewall rule it describes as Orrery's. A DNS record or a rule for the hostname
// that it did not create stops the run before anything is changed.
export async function setup({ request, hostname, allowIps = [], log = () => {} }) {
  if (!HOSTNAME.test(hostname)) throw new Error(`Not a hostname: "${hostname}". Use lowercase, such as orrery.example.com.`);
  const sources = allowIps.map(allowedSource);

  // First everything is read, so that a conflict stops the run with nothing changed.
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
  const reused = !!tunnel;
  const target = (id) => `${id}.cfargotunnel.com`;
  const records = (await request({ path: `/zones/${zone.id}/dns_records`, query: { name: hostname } })).filter((r) => r.name === hostname);
  const ours = tunnel && records.find((r) => r.type === "CNAME" && r.content === target(tunnel.id));
  const foreign = records.find((r) => r !== ours && ["A", "AAAA", "CNAME"].includes(r.type));
  if (foreign) throw new Error(`${hostname} already has a DNS record (${foreign.type} ${foreign.content}). Remove it in Cloudflare or choose another hostname; nothing was changed.`);

  const want = { action: "block", expression: wafExpression(hostname, sources), description: ruleNote(hostname), enabled: true };
  const entry = await request({ path: `/zones/${zone.id}/rulesets/phases/${PHASE}/entrypoint` }).catch((e) => (e.status === 404 ? null : Promise.reject(e)));
  const naming = (entry?.rules || []).filter((r) => String(r.expression || "").includes(`"${hostname}"`));
  const mine = naming.find((r) => r.description === want.description);
  const theirs = naming.find((r) => r !== mine);
  if (theirs) {
    throw new Error(
      `Cloudflare already has a custom rule for ${hostname} that this installer did not create (${theirs.action}, ${theirs.enabled === false ? "disabled" : "enabled"}: ${theirs.expression}). ` +
        `It could let requests past Orrery's rule. Remove it or choose another hostname; nothing was changed.`,
    );
  }

  // From here on things change. A failure leaves what was made so far; the same command picks it up.
  if (reused) {
    // A token from an earlier run (an old host, a copied .env) must not connect to this tunnel again.
    await request({ method: "PATCH", path: `/accounts/${account}/cfd_tunnel/${tunnel.id}`, body: { tunnel_secret: newSecret() } });
    await request({ method: "DELETE", path: `/accounts/${account}/cfd_tunnel/${tunnel.id}/connections` }).catch(() => {});
    log(`Tunnel "${hostname}" exists: reusing it with a new secret, so earlier tunnel tokens stop working`);
  } else {
    tunnel = await request({ method: "POST", path: `/accounts/${account}/cfd_tunnel`, body: { name: hostname, config_src: "cloudflare" } });
    log(`Tunnel "${hostname}" created`);
  }
  // The route to the agent comes first; other hostnames someone added to this tunnel are kept.
  const current = reused ? (await request({ path: `/accounts/${account}/cfd_tunnel/${tunnel.id}/configurations` }))?.config || {} : {};
  const routes = Array.isArray(current.ingress) ? current.ingress : [];
  if (!routes.some((r) => r.hostname === hostname && r.service === SERVICE)) {
    const ingress = [{ hostname, service: SERVICE }, ...routes.filter((r) => r.hostname && r.hostname !== hostname), routes.find((r) => !r.hostname) || { service: "http_status:404" }];
    await request({ method: "PUT", path: `/accounts/${account}/cfd_tunnel/${tunnel.id}/configurations`, body: { config: { ...current, ingress } } });
  }
  log(`Route ${hostname} -> ${SERVICE}`);

  // The firewall rule comes before the DNS record, so the hostname is never reachable without it, and
  // it goes first in the zone's list, so no earlier "skip" rule can let a request past it.
  const first = { position: { index: 1 } };
  if (!entry) {
    await request({ method: "POST", path: `/zones/${zone.id}/rulesets`, body: { name: "default", kind: "zone", phase: PHASE, rules: [want] } });
  } else if (!mine) {
    await request({ method: "POST", path: `/zones/${zone.id}/rulesets/${entry.id}/rules`, body: { ...want, ...first } });
  } else if (mine.action !== want.action || mine.enabled === false || mine.expression !== want.expression || entry.rules[0] !== mine) {
    // Cloudflare refuses a position the rule already has, so it is only given when the rule must move.
    await request({ method: "PATCH", path: `/zones/${zone.id}/rulesets/${entry.id}/rules/${mine.id}`, body: entry.rules[0] === mine ? want : { ...want, ...first } });
  }
  log(`Firewall rule in place: ${hostname} can be reached only from ${[CLAUDE_AI, ...sources].join(", ")}`);

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
  // The API token comes on stdin, so it is in no command line, environment or container description.
  const token = (process.env.CLOUDFLARE_API_TOKEN || (process.stdin.isTTY ? "" : fs.readFileSync(0, "utf8"))).trim();
  try {
    if (!hostname || !envFile || !token) throw new Error("Usage: printf %s \"$TOKEN\" | node cloudflare.mjs <hostname> <env file>");
    const allowIps = (process.env.ORRERY_ALLOW_IPS || "").split(/[\s,]+/).filter(Boolean);
    const done = await setup({ request: apiClient(token), hostname, allowIps, log: (line) => console.error(`   ${line}`) });
    writeTunnelToken(envFile, done.tunnelToken);
    console.error("   Tunnel token saved");
  } catch (e) {
    console.error(`Cloudflare setup failed: ${e.message}`);
    process.exit(1);
  }
}
