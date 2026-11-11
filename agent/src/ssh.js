// SSH connections (pooled per server) and the remote probes behind the dashboard.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "ssh2";
import { KEY_PATH } from "./keys.js";

const IDLE_MS = 5 * 60 * 1000;
const MAX_OUTPUT = 512 * 1024;
// The agent's own key first (keys.js), then the usual ~/.ssh keys.
const DEFAULT_KEYS = [KEY_PATH, ...["id_ed25519", "id_ecdsa", "id_rsa"].map((k) => path.join(os.homedir(), ".ssh", k))];

const pool = new Map(); // poolKey -> { promise, client, timer, serverId }

function connectOptions(server) {
  const opts = {
    host: server.host,
    port: server.port || 22,
    username: server.username,
    readyTimeout: 15000,
    keepaliveInterval: 15000,
  };
  // Every credential in turn: password, then the given key (or each default key that exists), then
  // ssh-agent. ssh2's plain `privateKey` option takes only one key.
  const methods = [];
  const username = server.username;
  if (server.password) methods.push({ type: "password", username, password: server.password });
  for (const keyPath of server.keyPath ? [server.keyPath] : DEFAULT_KEYS.filter((k) => fs.existsSync(k))) {
    try {
      methods.push({ type: "publickey", username, key: fs.readFileSync(keyPath) });
    } catch (e) {
      if (server.keyPath) throw new Error(`Cannot read key ${keyPath}: ${e.message}`);
    }
  }
  if (process.env.SSH_AUTH_SOCK) {
    opts.agent = process.env.SSH_AUTH_SOCK;
    methods.push({ type: "agent", username, agent: process.env.SSH_AUTH_SOCK });
  }
  if (!methods.length) throw new Error("No credentials: set keyPath or password for this server, or run an ssh-agent.");
  opts.authHandler = methods;
  return opts;
}

// (Re)starts a pooled connection's idle timer. A connection with a command still running is kept.
function touch(key) {
  const entry = pool.get(key);
  if (!entry) return;
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => (entry.busy ? touch(key) : drop(key, entry)), IDLE_MS);
  entry.timer.unref?.();
}

// Ends a connection, and forgets it only while it is still the pooled one: a late idle timer or error
// of a connection that was already replaced must not end its replacement.
function drop(key, entry) {
  clearTimeout(entry.timer);
  if (pool.get(key) === entry) pool.delete(key);
  entry.client.end();
}

// One pooled connection per server, address and login: the same machine can be reached with different
// credentials (its rescue system's password, the agent's key), and those must not share a connection;
// a server moved to another IP or port must not keep using the old one.
const poolKey = (server) =>
  `${server.id}|${server.username}@${server.host}:${server.port || 22}|${server.password ? "password" : server.keyPath || ""}`;

function getEntry(server) {
  const key = poolKey(server);
  const existing = pool.get(key);
  if (existing) {
    touch(key);
    return existing;
  }
  const client = new Client();
  const entry = { client, timer: null, serverId: server.id, busy: 0 };
  entry.promise = new Promise((resolve, reject) => {
    client
      .once("ready", () => resolve(client))
      // ssh2 can report more than one error per connection; one without a listener would crash the process.
      .on("error", (err) => {
        drop(key, entry);
        reject(new Error(`SSH to ${server.username}@${server.host}:${server.port || 22} failed: ${err.message}`));
      })
      .once("close", () => {
        clearTimeout(entry.timer);
        if (pool.get(key) === entry) pool.delete(key);
        // Closed during the handshake (dropConnections, MaxStartups, fail2ban): ssh2 emits only "close",
        // so without this the caller would wait forever. After "ready" this does nothing.
        reject(new Error(`SSH to ${server.username}@${server.host}:${server.port || 22} closed before it was ready`));
      });
    client.connect(connectOptions(server));
  });
  // A connection that never came up (unreadable key, refused login) is not kept: the next call tries again.
  entry.promise.catch(() => drop(key, entry));
  pool.set(key, entry);
  touch(key);
  return entry;
}

// Ends the pooled connections of one server, after its address or login changed or it was removed.
export function dropConnections(serverId) {
  for (const [key, entry] of [...pool]) if (entry.serverId === serverId) drop(key, entry);
}

// Command output as raw bytes up to MAX_OUTPUT, decoded once at the end, so a multi-byte character
// split across two SSH packets stays whole.
function collector() {
  const chunks = [];
  let size = 0;
  const c = {
    truncated: false,
    add(chunk) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const room = MAX_OUTPUT - size;
      if (buf.length > room) c.truncated = true;
      if (room <= 0) return;
      chunks.push(buf.subarray(0, room));
      size += Math.min(buf.length, room);
    },
    text: () => Buffer.concat(chunks).toString("utf8"),
  };
  return c;
}

// A long-running command on the pooled connection (the live sampler): output goes to onData as it
// arrives and onEnd(err) is called once, never synchronously, when it stops (it exits, the connection is
// lost, or the returned stop() is called).
export function stream(server, command, { onData, onEnd }) {
  const key = poolKey(server);
  let channel = null;
  let stopped = false;
  let ended = false;
  const end = (err) => queueMicrotask(() => {
    if (ended) return;
    ended = true;
    onEnd(err || null);
  });
  let entry;
  try {
    entry = getEntry(server);
  } catch (e) {
    end(e);
    return () => {};
  }
  entry.promise.then(
    (client) => {
      if (stopped) return end();
      try {
        client.exec(command, (err, ch) => {
          // A refused channel (e.g. sshd's MaxSessions) fails this call only; the shared connection stays.
          if (err) return end(channelError(err, server));
          channel = ch;
          ch.on("data", (d) => {
            touch(key);
            onData(d);
          });
          ch.stderr.on("data", () => {});
          ch.on("close", () => end());
          if (stopped) ch.close();
        });
      } catch (e) {
        drop(key, entry); // "Not connected": the pooled connection went away in between
        end(e);
      }
    },
    (e) => end(e),
  );
  return () => {
    stopped = true;
    if (channel) channel.close();
    else end();
  };
}

// sshd allows a limited number of sessions per connection (MaxSessions, 10 by default).
const channelError = (err, server) =>
  /channel open failure/i.test(err.message)
    ? new Error(`${server.host} refused another session on this connection (sshd MaxSessions): too many commands are running there at once. Try again when some have finished.`)
    : err;

export async function exec(server, command, { timeoutSec = 30, closeGraceMs = 5000 } = {}) {
  const key = poolKey(server);
  const entry = getEntry(server);
  const client = await entry.promise;
  const started = Date.now();
  entry.busy++;
  return new Promise((resolve, reject) => {
    const onChannel = (err, stream) => {
      // A refused channel (e.g. sshd's MaxSessions) fails this call only; the shared connection stays.
      if (err) return reject(channelError(err, server));
      const stdout = collector();
      const stderr = collector();
      let timedOut = false;
      let grace = null;
      const timer = setTimeout(() => {
        timedOut = true;
        stream.close();
        grace = setTimeout(finish, closeGraceMs); // a server that never confirms the close must not hang the call
      }, timeoutSec * 1000);
      function finish(code, signal) {
        clearTimeout(timer);
        clearTimeout(grace);
        // No exit code, no signal and no timeout of ours: the connection went away under the command.
        if (code == null && !signal && !timedOut) return reject(new Error(`The SSH connection to ${server.host} closed before the command finished`));
        const truncated = stdout.truncated || stderr.truncated;
        resolve({ stdout: stdout.text(), stderr: stderr.text(), code: code ?? null, signal: signal ?? null, truncated, timedOut, ms: Date.now() - started });
      }
      stream.on("data", (d) => stdout.add(d));
      stream.stderr.on("data", (d) => stderr.add(d));
      stream.on("close", finish);
    };
    try {
      client.exec(command, onChannel);
    } catch (err) {
      drop(key, entry); // "Not connected": the pooled connection went away in between
      reject(err);
    }
  }).finally(() => entry.busy--);
}

// One round trip gathers everything the dashboard shows. Sections are split by "@@name" markers.
const STATS_SCRIPT = String.raw`
export LC_ALL=C
echo "@@host"; hostname
echo "@@os"; (. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME") || uname -s
echo "@@kernel"; uname -srm
echo "@@cpuinfo"; nproc 2>/dev/null; grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2-
echo "@@stat1"; head -1 /proc/stat
sleep 0.5
echo "@@stat2"; head -1 /proc/stat
echo "@@loadavg"; cat /proc/loadavg
echo "@@uptime"; cat /proc/uptime
echo "@@meminfo"; grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree|Buffers|Cached):' /proc/meminfo
echo "@@disk"; df -P -k -x tmpfs -x devtmpfs -x overlay -x squashfs 2>/dev/null | tail -n +2
echo "@@net"; tail -n +3 /proc/net/dev
echo "@@ips"; hostname -I 2>/dev/null
echo "@@ipaddr"; ip -o addr show scope global 2>/dev/null
echo "@@users"; who 2>/dev/null | wc -l
echo "@@procs"; ls -d /proc/[0-9]* 2>/dev/null | wc -l
echo "@@reboot"; [ -f /var/run/reboot-required ] && echo yes || echo no
echo "@@updates"; cat /var/lib/update-notifier/updates-available 2>/dev/null | grep -m1 -oE '^[0-9]+ (updates|update)' | cut -d' ' -f1
echo "@@motd"; cat /run/motd.dynamic 2>/dev/null | head -60
echo "@@lastlog"; last -n 1 -w -F "$(whoami)" 2>/dev/null | head -1
D=docker; command -v docker >/dev/null 2>&1 || D=""
if [ -n "$D" ] && ! docker info >/dev/null 2>&1; then
  if sudo -n docker info >/dev/null 2>&1; then D="sudo -n docker"
  elif docker info 2>&1 | grep -qi 'permission denied'; then D=denied
  else D=down; fi
fi
echo "@@docker"; echo "$D"
if [ "$D" = docker ] || [ "$D" = "sudo -n docker" ]; then
  echo "@@dockerps"; $D ps -a --no-trunc --format '{{json .}}' 2>/dev/null
  echo "@@dockerstats"; timeout 8 $D stats --no-stream --format '{{json .}}' 2>/dev/null
fi
echo "@@end"
`;

// The live sampler's loop (live.js): /proc figures once a second, each sample closed by "@@end". It stops
// by itself after ten minutes (or when the channel closes), so nothing is left running on the server; the
// agent starts a new one while the dashboard is still watching.
export const SAMPLE_SCRIPT = String.raw`
export LC_ALL=C
i=0
while [ $i -lt 600 ]; do
  echo "@@t"; cut -d' ' -f1 /proc/uptime
  echo "@@stat"; head -1 /proc/stat
  echo "@@net"; tail -n +3 /proc/net/dev
  echo "@@loadavg"; cat /proc/loadavg
  echo "@@meminfo"; grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo
  echo "@@end"
  i=$((i+1))
  sleep 1
done
`;

function sections(text) {
  const out = {};
  let name = null;
  for (const line of text.split("\n")) {
    const m = line.match(/^@@(\w+)$/);
    if (m) {
      name = m[1];
      out[name] = [];
    } else if (name) out[name].push(line);
  }
  for (const k of Object.keys(out)) out[k] = out[k].join("\n").replace(/\n+$/, "");
  return out;
}

const kb = (n) => Number(n) * 1024;
const pct = (used, total) => (total > 0 ? Math.round((used / total) * 1000) / 10 : 0);

function parseCpu(a, b) {
  const nums = (l) => l.trim().split(/\s+/).slice(1).map(Number);
  const x = nums(a);
  const y = nums(b);
  const idle = (v) => v[3] + (v[4] || 0);
  const total = (v) => v.reduce((s, n) => s + n, 0);
  const dt = total(y) - total(x);
  return dt > 0 ? Math.round((1 - (idle(y) - idle(x)) / dt) * 1000) / 10 : 0;
}

function parseSize(s) {
  const m = String(s).trim().match(/^([\d.]+)\s*([kKMGTP]?i?B)?$/);
  if (!m) return 0;
  const unit = (m[2] || "B").replace("i", "").toUpperCase();
  const pow = { B: 0, KB: 1, MB: 2, GB: 3, TB: 4, PB: 5 }[unit] ?? 0;
  return Math.round(parseFloat(m[1]) * (/i/.test(m[2] || "") ? 1024 : 1000) ** pow);
}

function jsonLines(text) {
  return (text || "")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// "ubuntu pts/0 198.51.100.20 Tue May  5 13:45:21 2026 - ..." -> the sshd banner wording.
function formatLastLogin(line) {
  const m = String(line || "").match(/^\S+\s+\S+\s+(\S+)\s+(\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4})/);
  return m ? `Last login: ${m[2]} from ${m[1]}` : "";
}

// Addresses on the machine's own interfaces, apart from the gateways of Docker and other virtual
// bridges (docker0, br-…, veth…), which only exist inside the machine. Without `ip`, every
// address from `hostname -I` is listed as before.
const VIRTUAL_IF = /^(docker\d*|br-[0-9a-f]+|veth|virbr|cni|flannel|cali|vxlan|tun|wg|lxc|lxd)/;
export function splitIps(ipaddr, hostnameI) {
  const lines = (ipaddr || "").split("\n").filter((l) => / inet6? /.test(l));
  if (!lines.length) return { ips: (hostnameI || "").trim().split(/\s+/).filter(Boolean), bridgeNetworks: 0 };
  const ips = [];
  const bridges = new Set();
  for (const l of lines) {
    const m = l.match(/^\d+:\s+(\S+?)(?:@\S+)?\s+inet6?\s+([0-9a-fA-F.:]+)\//);
    if (!m) continue;
    if (VIRTUAL_IF.test(m[1])) bridges.add(m[1]);
    else if (!ips.includes(m[2])) ips.push(m[2]);
  }
  return { ips, bridgeNetworks: bridges.size };
}

// Bytes received and sent on the real interfaces (/proc/net/dev lines); loopback and Docker's are left out.
function netTotals(text) {
  let rx = 0;
  let tx = 0;
  for (const l of (text || "").split("\n")) {
    const [iface, rest] = l.split(":");
    if (!rest || iface.trim() === "lo" || /^(docker|veth|br-)/.test(iface.trim())) continue;
    const f = rest.trim().split(/\s+/).map(Number);
    rx += f[0] || 0;
    tx += f[8] || 0;
  }
  return { rx, tx };
}

function memoryOf(meminfo) {
  const mem = Object.fromEntries(
    (meminfo || "").split("\n").map((l) => {
      const [k, v] = l.split(":");
      return [k, kb(parseInt(v, 10) || 0)];
    }),
  );
  const total = mem.MemTotal || 0;
  const available = mem.MemAvailable ?? 0;
  const swapTotal = mem.SwapTotal || 0;
  const swapUsed = swapTotal - (mem.SwapFree || 0);
  return {
    memory: { total, used: total - available, available, percent: pct(total - available, total) },
    swap: { total: swapTotal, used: swapUsed, percent: pct(swapUsed, swapTotal) },
  };
}

// One block of SAMPLE_SCRIPT output -> raw counters; sampleFrom turns two of them into rates.
export function parseSample(text) {
  const s = sections(text);
  const [l1, l5, l15] = (s.loadavg || "").split(/\s+/);
  return { up: parseFloat(s.t) || 0, stat: s.stat || "", net: netTotals(s.net), load: { m1: Number(l1), m5: Number(l5), m15: Number(l15) }, ...memoryOf(s.meminfo) };
}

export function sampleFrom(prev, cur, at = new Date().toISOString()) {
  const seconds = Math.max(0.2, cur.up - prev.up || 1);
  const rate = (x, y) => Math.max(0, Math.round((y - x) / seconds));
  return {
    t: at,
    cpu: { percent: parseCpu(prev.stat, cur.stat) },
    load: cur.load,
    memory: cur.memory,
    swap: cur.swap,
    net: { rxRate: rate(prev.net.rx, cur.net.rx), txRate: rate(prev.net.tx, cur.net.tx) },
  };
}

export async function stats(server) {
  const res = await exec(server, `sh -c ${quote(STATS_SCRIPT)}`, { timeoutSec: 25 });
  if (!res.stdout.includes("@@end")) throw new Error(`Stats probe failed: ${res.stderr || "no output"}`);
  return { serverId: server.id, latencyMs: res.ms, ...parseStats(res.stdout) };
}

export function parseStats(text) {
  const s = sections(text);

  const mem = Object.fromEntries(
    (s.meminfo || "").split("\n").map((l) => {
      const [k, v] = l.split(":");
      return [k, kb(parseInt(v, 10) || 0)];
    }),
  );
  const [cores, model] = (s.cpuinfo || "").split("\n");
  const [l1, l5, l15, procRun] = (s.loadavg || "").split(/\s+/);

  const disks = (s.disk || "")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const p = l.trim().split(/\s+/);
      return { fs: p[0], mount: p[5], total: kb(p[1]), used: kb(p[2]), avail: kb(p[3]), percent: parseInt(p[4], 10) || 0 };
    })
    .filter((d) => d.total > 0 && !/^\/(snap|boot\/efi)/.test(d.mount));

  const { rx, tx } = netTotals(s.net);

  const dockerMode = (s.docker || "").trim();
  const statsByName = Object.fromEntries(jsonLines(s.dockerstats).map((d) => [d.Name, d]));
  const containers = jsonLines(s.dockerps).map((c) => {
    const st = statsByName[c.Names] || {};
    const [memUsed, memLimit] = String(st.MemUsage || "").split("/");
    return {
      id: String(c.ID).slice(0, 12),
      name: c.Names,
      image: c.Image,
      state: c.State,
      status: c.Status,
      ports: c.Ports,
      created: c.CreatedAt,
      cpuPercent: st.CPUPerc ? parseFloat(st.CPUPerc) : null,
      memUsed: memUsed ? parseSize(memUsed) : null,
      memLimit: memLimit ? parseSize(memLimit) : null,
      memPercent: st.MemPerc ? parseFloat(st.MemPerc) : null,
    };
  });

  const memTotal = mem.MemTotal || 0;
  const memAvail = mem.MemAvailable ?? 0;
  const rootDisk = disks.find((d) => d.mount === "/") || disks[0] || null;

  return {
    collectedAt: new Date().toISOString(),
    hostname: s.host,
    os: s.os,
    kernel: s.kernel,
    cpu: { cores: Number(cores) || null, model: (model || "").trim(), percent: parseCpu(s.stat1 || "", s.stat2 || "") },
    load: { m1: Number(l1), m5: Number(l5), m15: Number(l15), running: procRun },
    uptimeSec: Math.round(parseFloat(s.uptime) || 0),
    memory: { total: memTotal, used: memTotal - memAvail, available: memAvail, percent: pct(memTotal - memAvail, memTotal) },
    swap: {
      total: mem.SwapTotal || 0,
      used: (mem.SwapTotal || 0) - (mem.SwapFree || 0),
      percent: pct((mem.SwapTotal || 0) - (mem.SwapFree || 0), mem.SwapTotal || 0),
    },
    disk: rootDisk,
    disks,
    network: { rxBytes: rx, txBytes: tx },
    ...splitIps(s.ipaddr, s.ips),
    usersLoggedIn: Number(s.users) || 0,
    processes: Number(s.procs) || 0,
    rebootRequired: (s.reboot || "").trim() === "yes",
    updatesAvailable: s.updates ? Number(s.updates) : null,
    motd: s.motd || "",
    lastLogin: formatLastLogin(s.lastlog),
    docker: {
      status: { "": "not_installed", denied: "permission_denied", down: "daemon_down" }[dockerMode] ?? "ok",
      sudo: dockerMode.startsWith("sudo"),
      running: containers.filter((c) => c.state === "running").length,
      containers,
    },
  };
}

export const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// Runs a command in a working directory and reports the directory it ended in,
// so the dashboard's console can keep `cd` between commands.
export async function runInDir(server, command, cwd, timeoutSec) {
  const marker = "__ORRERY_CWD__";
  // A cwd that does not exist fails the call instead of running the command somewhere else.
  const dir = !cwd ? "~" : cwd === "~" ? '"$HOME"' : cwd.startsWith("~/") ? `"$HOME"/${quote(cwd.slice(2))}` : quote(cwd);
  const shown = String(cwd || "~").replace(/[^\w./~ -]/g, "?");
  const script = `cd -- ${dir} || { echo "orrery: cannot cd to ${shown}" >&2; printf '\\n${marker}%s\\n' "$(pwd)"; exit 1; }
${command}
__rc=$?
printf '\\n${marker}%s\\n' "$(pwd)"
exit $__rc`;
  // stderr is merged into stdout so the console shows output in the order it was written.
  const res = await exec(server, `bash -c ${quote(script)} 2>&1`, { timeoutSec });
  const idx = res.stdout.lastIndexOf("\n" + marker);
  let output = res.stdout;
  let newCwd = cwd || null;
  if (idx !== -1) {
    newCwd = res.stdout.slice(idx + marker.length + 1).trim() || newCwd;
    output = res.stdout.slice(0, idx);
  }
  return { output, stderr: res.stderr, exitCode: res.code, cwd: newCwd, truncated: res.truncated, timedOut: res.timedOut, ms: res.ms };
}

export function closeAll() {
  for (const [key, entry] of [...pool]) drop(key, entry);
}
