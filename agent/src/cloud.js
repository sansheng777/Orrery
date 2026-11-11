// Cloud providers (aws/, netcup/, linode/, gcp/, aliyun/, vultr/, digitalocean/, kamatera/ at the repo root), served by this agent. A provider
// registers its tools only when its credentials are present; control tools only on the admin agent.
import dns from "node:dns/promises";
import net from "node:net";
import { listServers, DATA_DIR } from "./inventory.js";
import * as aws from "../../providers/aws/index.js";
import * as netcup from "../../providers/netcup/index.js";
import * as linode from "../../providers/linode/index.js";
import * as gcp from "../../providers/gcp/index.js";
import * as aliyun from "../../providers/aliyun/index.js";
import * as vultr from "../../providers/vultr/index.js";
import * as digitalocean from "../../providers/digitalocean/index.js";
import * as kamatera from "../../providers/kamatera/index.js";

export const PROVIDERS = [aws, netcup, linode, gcp, aliyun, vultr, digitalocean, kamatera];

const RESOLVE_TTL_MS = 5 * 60 * 1000;
const resolved = new Map(); // hostname -> { at, ips }

export const normalizeIp = (ip) => String(ip).trim().toLowerCase().replace(/^::ffff:(?=\d+\.)/, "");

async function addressesOf(host, lookup) {
  if (net.isIP(host)) return [host];
  const hit = resolved.get(host);
  if (hit && Date.now() - hit.at < RESOLVE_TTL_MS) return hit.ips;
  let ips = [];
  try {
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 2000).unref?.());
    ips = (await Promise.race([lookup(host, { all: true }), timeout])).map((a) => a.address);
  } catch {}
  resolved.set(host, { at: Date.now(), ips });
  return ips;
}

// Builds ip -> {id, name} from the SSH inventory (hostnames are resolved) and returns a matcher that
// takes a provider resource's addresses and gives back the Orrery server they belong to, or null.
export async function matchHosts({ servers = listServers(), lookup = dns.lookup } = {}) {
  const byIp = new Map();
  await Promise.all(
    servers.map(async (s) => {
      for (const ip of await addressesOf(s.host, lookup)) {
        const key = normalizeIp(ip);
        if (!byIp.has(key)) byIp.set(key, { id: s.id, name: s.name });
      }
    }),
  );
  return (ips) => {
    for (const ip of ips || []) {
      const hit = byIp.get(normalizeIp(ip));
      if (hit) return hit;
    }
    return null;
  };
}

// ctx: { z, tool, READ, and for the admin agent admin: true, adminTool, WRITE, DESTRUCTIVE }.
export function registerProviders(server, { env = process.env, dataDir = DATA_DIR, ...rest }) {
  const ctx = { admin: false, ...rest, env, dataDir, matchHosts: () => matchHosts() };
  return PROVIDERS.map((p) => {
    try {
      return p.register(server, ctx);
    } catch (e) {
      return { id: p.id, name: p.name, configured: false, error: e.message, tools: [] };
    }
  });
}
