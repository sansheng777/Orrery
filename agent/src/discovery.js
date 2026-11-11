// Auto-discovery: every netcup server, AWS EC2/Lightsail instance, Linode, Google Cloud, Alibaba Cloud and Vultr instance, DigitalOcean Droplet and Kamatera server the agent has credentials for
// shows up in list_servers without being added by hand. A saved server with the same IP wins, so its
// user, key or port can be overridden. What ssh_bootstrap learns (the login user) is kept in
// $ORRERY_DIR/discovered.json.
import fs from "node:fs";
import path from "node:path";
import { listServers, getServer, DATA_DIR } from "./inventory.js";
import { matchHosts } from "./cloud.js";
import * as aws from "../../providers/aws/index.js";
import * as netcup from "../../providers/netcup/index.js";
import * as linode from "../../providers/linode/index.js";
import * as gcp from "../../providers/gcp/index.js";
import * as aliyun from "../../providers/aliyun/index.js";
import * as vultr from "../../providers/vultr/index.js";
import * as digitalocean from "../../providers/digitalocean/index.js";
import * as kamatera from "../../providers/kamatera/index.js";

const TTL_MS = 60 * 1000;
const PROVIDER_TIMEOUT_MS = 90 * 1000; // one provider's whole listing (every region, every server)

function withTimeout(promise, ms, message) {
  let timer;
  const limit = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(message)), ms)));
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

// Lightsail blueprint -> default login user.
const LIGHTSAIL_USERS = [
  [/ubuntu/i, "ubuntu"],
  [/debian/i, "admin"],
  [/amazon/i, "ec2-user"],
  [/centos|alma|rocky/i, "centos"],
  [/freebsd/i, "ec2-user"],
];

export function fromNetcup(s, selfIp) {
  const host = s.ipv4?.[0];
  if (!host) return null;
  const generic = !s.hostname || /^v\d{10,}\b/.test(s.hostname);
  const self = !!selfIp && s.ipv4.includes(selfIp);
  return {
    id: `netcup:${s.id}`,
    name: s.nickname || (generic ? s.name : s.hostname.split(".")[0]),
    host,
    port: 22,
    username: "root",
    tags: ["netcup", s.product, s.site, ...(self ? ["orrery-host"] : [])].filter(Boolean),
    source: "netcup",
    auth: "agent key",
    state: s.state ? String(s.state).toLowerCase() : null,
    self,
    provider: { kind: "netcup", serverId: s.id, name: s.name },
  };
}

const PRIVATE_V4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

export function fromLinode(l, selfIp) {
  const host = (l.ipv4 || []).find((ip) => !PRIVATE_V4.test(ip));
  if (!host) return null;
  return {
    id: `linode:${l.id}`,
    name: l.label || String(l.id),
    host,
    port: 22,
    username: "root", // Linode images log in as root
    tags: ["linode", l.region, l.type].filter(Boolean),
    source: "linode",
    auth: "agent key",
    state: l.status || null,
    self: !!selfIp && host === selfIp,
    provider: { kind: "linode", linodeId: l.id },
  };
}

export function fromGcp(i, selfIp) {
  if (!i.externalIp) return null; // stopped, or no external address: nothing to SSH to
  return {
    id: `gcp:${i.project}:${i.zone}:${i.name}`,
    name: i.name,
    host: i.externalIp,
    port: 22,
    username: gcp.SSH_USER, // ssh_bootstrap creates it through instance metadata
    tags: ["gcp", i.zone, i.machineType].filter(Boolean),
    source: "gcp",
    auth: "agent key",
    state: i.status ? String(i.status).toLowerCase() : null,
    self: !!selfIp && i.externalIp === selfIp,
    provider: { kind: "gcp", project: i.project, zone: i.zone, name: i.name, instanceId: i.id },
  };
}

export function fromAliyun(i, selfIp) {
  if (!i.publicIp) return null;
  return {
    id: `aliyun:${i.region}:${i.id}`,
    name: i.name,
    host: i.publicIp,
    port: 22,
    username: "root", // Aliyun's public images log in as root; ssh_bootstrap installs the key there
    tags: ["aliyun", i.region, i.type].filter(Boolean),
    source: "aliyun",
    auth: "agent key",
    state: i.status ? String(i.status).toLowerCase() : null,
    self: !!selfIp && i.publicIp === selfIp,
    provider: { kind: "aliyun", region: i.region, instanceId: i.id, name: i.name },
  };
}

export function fromAws(i, selfIp) {
  if (!i.publicIp) return null;
  const isEc2 = i.service === "ec2";
  const lightsailUser = LIGHTSAIL_USERS.find(([re]) => re.test(i.platform || ""))?.[1] || "admin";
  return {
    id: isEc2 ? `ec2:${i.region}:${i.id}` : `lightsail:${i.region}:${i.name}`,
    name: i.name || i.id,
    host: i.publicIp,
    port: 22,
    username: isEc2 ? "ubuntu" : lightsailUser, // EC2 does not say which distribution; ssh_bootstrap finds the real user
    tags: ["aws", isEc2 ? "ec2" : "lightsail", i.region],
    source: "aws",
    auth: "agent key",
    state: i.state || null,
    self: !!selfIp && i.publicIp === selfIp,
    provider: isEc2
      ? { kind: "ec2", region: i.region, instanceId: i.id, zone: i.zone }
      : { kind: "lightsail", region: i.region, instanceName: i.name },
  };
}

export function fromVultr(i, selfIp) {
  if (!i.ipv4) return null; // a new instance has 0.0.0.0 until its address is assigned
  return {
    id: `vultr:${i.id}`,
    name: i.label || i.id,
    host: i.ipv4,
    port: 22,
    username: "root", // Vultr images log in as root
    tags: ["vultr", i.region, i.plan].filter(Boolean),
    source: "vultr",
    auth: "agent key",
    state: i.powerStatus === "stopped" ? "stopped" : i.status === "active" ? "running" : i.status || null,
    self: !!selfIp && i.ipv4 === selfIp,
    provider: { kind: "vultr", instanceId: i.id, label: i.label },
  };
}

export function fromDigitalocean(d, selfIp) {
  const host = (d.ipv4 || [])[0];
  if (!host) return null;
  return {
    id: `digitalocean:${d.id}`,
    name: d.name || String(d.id),
    host,
    port: 22,
    username: "root", // DigitalOcean images log in as root
    tags: ["digitalocean", d.region, d.size].filter(Boolean),
    source: "digitalocean",
    auth: "agent key",
    state: d.status === "active" ? "running" : d.status === "off" ? "stopped" : d.status || null,
    self: !!selfIp && (d.ipv4 || []).includes(selfIp),
    provider: { kind: "digitalocean", dropletId: d.id, name: d.name },
  };
}

export function fromKamatera(k, selfIp) {
  if (!k.ipv4) return null;
  return {
    id: `kamatera:${k.id}`,
    name: k.name || k.id,
    host: k.ipv4,
    port: 22,
    username: "root", // Kamatera images log in as root
    tags: ["kamatera", k.datacenter, k.cpu].filter(Boolean),
    source: "kamatera",
    auth: "agent key",
    state: k.power === "on" ? "running" : k.power === "off" ? "stopped" : k.power || null,
    self: !!selfIp && (k.publicIps || []).includes(selfIp),
    provider: { kind: "kamatera", serverId: k.id, name: k.name },
  };
}

// Labels the user gives servers ($ORRERY_DIR/labels.json, keyed by server id): a display name that
// replaces the provider's (the original stays as originalName), role tags such as "prod", and a note.
export function applyLabel(s, labels = {}) {
  const l = labels[s.id];
  if (!l) return s;
  const tags = [...(l.tags || []), ...(s.tags || []).filter((t) => !(l.tags || []).includes(t))];
  return { ...s, ...(l.label ? { name: l.label, originalName: s.name } : {}), tags, roleTags: l.tags || [], ...(l.note ? { note: l.note } : {}) };
}

// The Orrery host first, so it is always the first thing you see.
const selfFirst = (a, b) => Number(!!b.self) - Number(!!a.self);

export function createDiscovery({ env = process.env, dataDir = DATA_DIR, providers = { aws, netcup, linode, gcp, aliyun, vultr, digitalocean, kamatera }, now = () => Date.now(), providerTimeoutMs = PROVIDER_TIMEOUT_MS } = {}) {
  const overridesFile = path.join(dataDir, "discovered.json");
  const labelsFile = path.join(dataDir, "labels.json");
  const selfIp = String(env.ORRERY_SELF_IP || "").trim().toLowerCase() || null;
  // Only the providers' listings are cached; saved servers, labels and what onboarding learned are read
  // from their files on every call, so a change to those shows at once.
  let cache = null; // { at, value } of the last finished listing
  let pending = null; // the listing being fetched

  function readOverrides() {
    try {
      return JSON.parse(fs.readFileSync(overridesFile, "utf8"));
    } catch {
      return {};
    }
  }

  function readLabels() {
    try {
      return JSON.parse(fs.readFileSync(labelsFile, "utf8"));
    } catch {
      return {};
    }
  }

  // patch: { label?, tags?, note? }; an empty string or empty list removes that field.
  function setLabel(id, patch) {
    const all = readLabels();
    const next = { ...all[id] };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      if (v === "" || (Array.isArray(v) && !v.length)) delete next[k];
      else next[k] = v;
    }
    if (Object.keys(next).length) all[id] = next;
    else delete all[id];
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(labelsFile + ".tmp", JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(labelsFile + ".tmp", labelsFile);
    return all[id] || {};
  }

  function remember(id, patch) {
    const all = readOverrides();
    all[id] = { ...all[id], ...patch };
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(overridesFile + ".tmp", JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(overridesFile + ".tmp", overridesFile);
  }

  // Each provider's last successful listing ({ at, servers }). When a refresh fails (API down, expired
  // token), its machines stay listed and addressable from that list instead of becoming "Unknown server";
  // the error is still reported, with the time of the list in use.
  const lastGood = new Map();
  // Each netcup server's last record with an IP ({ at, server }). netcup lists servers without their IPs and
  // each one's details come from a call of its own; when that call fails, the server keeps this record
  // instead of silently dropping out of the list, and the error is reported.
  const lastNetcup = new Map();

  // One Google Cloud client per key, so its access token is reused across listings (it lasts an hour).
  let gcpClient = null;
  const gcpApi = (c) => (gcpClient?.email === c.clientEmail ? gcpClient.api : (gcpClient = { email: c.clientEmail, api: providers.gcp.createApi(c) }).api);

  async function fetchProviders() {
    const errors = [];
    const netcupServers = async (c) =>
      (await providers.netcup.servers(c)).servers.map((s) => {
        const id = `netcup:${s.id}`;
        const found = fromNetcup(s, selfIp);
        if (found) lastNetcup.set(id, { at: now(), server: found });
        if (found || !s.error) return found;
        const last = lastNetcup.get(id);
        errors.push({ provider: "netcup", server: id, error: s.error, ...(last ? { usingListFrom: new Date(last.at).toISOString() } : {}) });
        return last ? last.server : null;
      });
    // [provider, list its machines as server records]. Each uses the client its module builds from the config.
    const P = providers;
    const sources = [
      ["aws", async (c) => (await P.aws.instances(c)).instances.map((i) => fromAws(i, selfIp))],
      ["netcup", netcupServers],
      ["linode", async (c) => (await P.linode.instances(P.linode.createApi(c))).instances.map((l) => fromLinode(l, selfIp))],
      ["gcp", async (c) => (await P.gcp.instances(gcpApi(c), c)).instances.map((i) => fromGcp(i, selfIp))],
      ["aliyun", async (c) => (await P.aliyun.instances(P.aliyun.createApi(c), c)).instances.map((i) => fromAliyun(i, selfIp))],
      ["vultr", async (c) => (await P.vultr.instances(P.vultr.createApi(c))).instances.map((i) => fromVultr(i, selfIp))],
      ["digitalocean", async (c) => (await P.digitalocean.droplets(P.digitalocean.createApi(c))).droplets.map((d) => fromDigitalocean(d, selfIp))],
      ["kamatera", async (c) => (await P.kamatera.servers(P.kamatera.createApi(c))).servers.map((k) => fromKamatera(k, selfIp))],
    ]
      .filter(([provider]) => P[provider])
      .map(([provider, load]) => [provider, P[provider].loadConfig(env, dataDir), load])
      .filter(([, config]) => config.configured);
    // A provider that fails or does not answer in time keeps its last list; the others are not held up.
    const lists = await Promise.all(
      sources.map(([provider, config, load]) =>
        withTimeout(load(config), providerTimeoutMs, `${provider} did not answer within ${providerTimeoutMs / 1000} s`).then(
          (servers) => (lastGood.set(provider, { at: now(), servers }), servers),
          (e) => {
            const last = lastGood.get(provider);
            errors.push({ provider, error: e.message, ...(last ? { usingListFrom: new Date(last.at).toISOString() } : {}) });
            return last ? last.servers : [];
          },
        ),
      ),
    );
    return { found: lists.flat().filter(Boolean), errors };
  }

  function refresh() {
    pending ||= fetchProviders()
      .then((value) => ((cache = { at: now(), value }), value))
      .finally(() => (pending = null));
    return pending;
  }
  // Past the 60 s TTL, list() waits for a fresh listing. With `stale`, resolve() answers from the last one at
  // once and refreshes behind it: the live figures call it every second, and a fresh listing (every AWS
  // region, every netcup server) takes seconds.
  async function discovered({ stale = false } = {}) {
    if (cache && now() - cache.at <= TTL_MS) return cache.value;
    if (stale && cache) {
      refresh().catch(() => {});
      return cache.value;
    }
    return refresh();
  }

  // Saved and ~/.ssh/config servers, then every discovered machine that none of them already covers.
  // Machines marked ignored (ignore_server) are left out and listed separately.
  async function list() {
    const saved = listServers();
    const match = await matchHosts({ servers: saved });
    const { found, errors } = await discovered();
    const overrides = readOverrides();
    const extra = found.filter((d) => !match([d.host])).map((d) => ({ ...d, ...pick(overrides[d.id]) }));
    const labels = readLabels();
    const ignored = extra.filter((d) => overrides[d.id]?.ignored).map(({ id, name, host, source }) => ({ id, name, host, source }));
    // The machine Orrery runs on carries the orrery-host tag, whichever provider it was found at.
    const hostTag = (s) => (s.self && !(s.tags || []).includes("orrery-host") ? { ...s, tags: [...(s.tags || []), "orrery-host"] } : s);
    // A saved server that covers the Orrery host (same IP, e.g. to override its user or port) is still the host.
    const hostIds = new Set(found.filter((d) => d.self).map((d) => match([d.host])?.id).filter(Boolean));
    const isHost = (s) => hostIds.has(s.id) || (!!selfIp && String(s.host).toLowerCase() === selfIp);
    const savedMarked = saved.map((s) => (isHost(s) ? { ...s, self: true } : s));
    const servers = [...savedMarked, ...extra.filter((d) => !overrides[d.id]?.ignored)].map((s) => applyLabel(hostTag(s), labels)).sort(selfFirst);
    return { servers, ignored, errors };
  }

  // The full record (with provider details) for any id list() returns, ignored ones included.
  async function resolve(id) {
    if (!/^(netcup|ec2|lightsail|linode|gcp|aliyun|vultr|digitalocean|kamatera):/.test(id)) return applyLabel(getServer(id), readLabels());
    const saved = listServers();
    const match = await matchHosts({ servers: saved });
    const overrides = readOverrides();
    const servers = (await discovered({ stale: true })).found.filter((d) => !match([d.host])).map((d) => ({ ...d, ...pick(overrides[d.id]) }));
    const s = servers.find((x) => x.id === id);
    if (!s) throw new Error(`Unknown server "${id}". Call list_servers to see the ids.`);
    return applyLabel(s, readLabels());
  }

  return { list, resolve, remember, setLabel, selfIp };
}

const pick = (o = {}) => Object.fromEntries(Object.entries(o).filter(([k]) => ["username", "port", "keyPath", "bootstrappedAt"].includes(k)));
