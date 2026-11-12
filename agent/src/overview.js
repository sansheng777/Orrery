// The fleet overview: one status board of every server, as a Markdown table that any MCP client can
// show as it is. It is the dashboard for clients that cannot publish the claude.ai Artifact, and a
// one-call answer to "how are my servers doing?" for every client.

const MAX_SERVERS = 50; // as many as server_pulse takes in one call
const TIMEOUT_MS = 20000; // per server; all are asked at once, so the probes together take no longer
const MAX_ATTENTION = 4; // items per server; the rest are counted

// Names, mount points, container names and error texts come from providers and servers, so they are
// shown literally: one line, no control or direction characters, and inside a code span, where a
// client renders no link, image or HTML. A host is cut down to the characters an address can have.
const literal = (v, max) =>
  String(v ?? "")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/[|`\\]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
const code = (v, max = 60) => {
  const text = literal(v, max);
  return text ? `\`${text}\`` : "";
};
const address = (v) => String(v ?? "").replace(/[^A-Za-z0-9.:_-]/g, "").slice(0, 45);
const pct = (v) => (Number.isFinite(v) ? `${Math.round(v)}%` : "");
const size = (bytes) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const gb = bytes / 1024 ** 3;
  return gb >= 10 ? `${Math.round(gb)} GB` : gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
};
const of = (percent, total) => [pct(percent), size(total)].filter(Boolean).join(" of ");
const uptime = (sec) => {
  if (!Number.isFinite(sec)) return "";
  return sec >= 172800 ? `${Math.floor(sec / 86400)} d` : sec >= 7200 ? `${Math.floor(sec / 3600)} h` : `${Math.max(1, Math.floor(sec / 60))} min`;
};

// One row from a server_stats answer, or from the error that kept us from getting one.
export function overviewRow(server, stats, error) {
  const row = { server: `${code(server.name || server.id, 40)} (${address(server.host)})`, id: server.id, state: "up", attention: [] };
  if (server.state === "stopped") return { ...row, state: "stopped" };
  if (!stats) {
    const why = error?.code === "HOST_KEY_CHANGED"
      ? "SSH host key changed: server_stats says what to do"
      : /authentication methods failed/i.test(error?.message || "")
        ? "login refused: onboard it with ssh_bootstrap"
        : code(error?.message || "no answer", 110);
    return { ...row, state: "unreachable", attention: [why] };
  }
  const disks = stats.disks?.length ? stats.disks : stats.disk ? [stats.disk] : [];
  const root = stats.disk || disks[0];
  const containers = stats.docker?.containers || [];
  const stopped = containers.filter((c) => c.state !== "running");
  const cores = stats.cpu?.cores || 1;
  for (const d of disks.filter((x) => x.percent >= 90)) row.attention.push(`disk ${code(d.mount, 30)} ${pct(d.percent)}`);
  if (stats.memory?.percent >= 90) row.attention.push(`memory ${pct(stats.memory.percent)}`);
  if (stats.load?.m5 >= cores * 2) row.attention.push(`load ${stats.load.m5} on ${cores} ${cores === 1 ? "core" : "cores"}`);
  if (stopped.length) row.attention.push(`not running: ${stopped.slice(0, 3).map((c) => code(c.name, 30)).join(", ")}${stopped.length > 3 ? ` and ${stopped.length - 3} more` : ""}`);
  if (stats.rebootRequired) row.attention.push("reboot required");
  if (row.attention.length > MAX_ATTENTION) row.attention.splice(MAX_ATTENTION - 1, Infinity, `and ${row.attention.length - MAX_ATTENTION + 1} more`);
  return {
    ...row,
    cpu: pct(stats.cpu?.percent),
    memory: of(stats.memory?.percent, stats.memory?.total),
    disk: root ? of(root.percent, root.total) : "",
    load: Number.isFinite(stats.load?.m1) ? stats.load.m1 : "",
    containers: containers.length ? `${containers.length - stopped.length}/${containers.length}` : "",
    uptime: uptime(stats.uptimeSec),
  };
}

export function overviewText(rows, { now = new Date(), more = 0, errors = [], version = "" } = {}) {
  const count = (state) => rows.filter((r) => r.state === state).length;
  const flagged = rows.filter((r) => r.attention.length).length;
  const parts = [`${count("up")} up`, count("unreachable") && `${count("unreachable")} unreachable`, count("stopped") && `${count("stopped")} stopped`].filter(Boolean);
  const lines = [
    `Orrery${version ? ` ${version}` : ""} overview, ${now.toISOString().slice(0, 16).replace("T", " ")} UTC. ${rows.length} ${rows.length === 1 ? "server" : "servers"}: ${parts.join(", ")}. ${flagged ? `${flagged} ${flagged === 1 ? "needs" : "need"} attention.` : "Nothing needs attention."}`,
    "",
    "| Server | State | CPU | Memory | Disk / | Load | Containers | Uptime | Attention |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map((r) => `| ${[r.server, r.state, r.cpu, r.memory, r.disk, r.load, r.containers, r.uptime, r.attention.join("; ")].map((v) => v ?? "").join(" | ")} |`),
  ];
  if (!rows.length) lines.push("", "No servers yet. Add cloud credentials (docs/providers.md) or a server with add_server.");
  if (more) lines.push("", `${more} more ${more === 1 ? "server is" : "servers are"} not shown. Ask for them with server_stats.`);
  for (const e of errors.slice(0, 10)) lines.push("", `Provider ${address(e.provider || "?")} did not answer: ${code(e.error || e.message, 110)}`);
  lines.push("", "Details of one server: server_stats with its id. Ids: list_servers.");
  return lines.join("\n");
}

// servers: what list_servers returns. probe(server) resolves to its server_stats or rejects.
export async function buildOverview({ servers, errors = [], probe, timeoutMs = TIMEOUT_MS, now, version }) {
  const shown = servers.slice(0, MAX_SERVERS);
  const rows = await Promise.all(
    shown.map(async (s) => {
      if (s.state === "stopped") return overviewRow(s);
      let timer;
      const late = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`no answer within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs)));
      try {
        return overviewRow(s, await Promise.race([probe(s), late]));
      } catch (e) {
        return overviewRow(s, null, e);
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  return overviewText(rows, { now, more: servers.length - shown.length, errors, version });
}
