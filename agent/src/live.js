// Live figures for the dashboard. While someone watches a server, one long-running SSH command on it
// (SAMPLE_SCRIPT) prints /proc figures every second; the agent keeps the last two minutes in memory and
// server_pulse answers from there at once, without a round trip to the server. A sampler nobody has
// asked about for two minutes is stopped, and the remote loop ends by itself after ten minutes (it is
// started again while still wanted), so nothing is left running on a server.
import { stream, quote, SAMPLE_SCRIPT, parseSample, sampleFrom } from "./ssh.js";

const KEEP = 120; // samples, one a second
const IDLE_MS = 2 * 60 * 1000;
const RETRY_MS = 15 * 1000;
const MAX_BUFFER = 64 * 1024;

const samplers = new Map(); // server id -> { where, samples, prev, error, stop, wantedAt, retryAt }

// The last `count` samples of a server, starting (or restarting) its sampler when needed.
export function read(server, { count = 10, onAuthFailure } = {}) {
  let s = samplers.get(server.id);
  if (!s) samplers.set(server.id, (s = { where: null, samples: [], prev: null, error: null, stop: null, wantedAt: 0, retryAt: 0 }));
  s.wantedAt = Date.now();
  const where = `${server.username}@${server.host}:${server.port || 22}`;
  if (s.where !== where) {
    halt(s); // moved to another address or login: start over there
    s.samples = [];
    s.retryAt = 0;
    s.where = where;
  }
  if (!s.stop && Date.now() >= s.retryAt) start(server, s, onAuthFailure);
  const samples = s.samples.slice(-count);
  return { latest: samples.at(-1) || null, samples, error: s.error, running: !!s.stop };
}

function start(server, s, onAuthFailure) {
  let buf = "";
  s.prev = null;
  const stop = stream(server, `sh -c ${quote(SAMPLE_SCRIPT)}`, {
    onData(chunk) {
      buf += chunk.toString("utf8");
      for (let i; (i = buf.indexOf("@@end\n")) >= 0; ) {
        const cur = parseSample(buf.slice(0, i));
        buf = buf.slice(i + 6);
        if (s.prev) {
          s.samples.push(sampleFrom(s.prev, cur));
          if (s.samples.length > KEEP) s.samples.shift();
        }
        s.prev = cur;
        s.error = null;
      }
      if (buf.length > MAX_BUFFER) buf = ""; // never grow on output that is not ours
    },
    onEnd(err) {
      if (s.stop !== stop) return; // stopped on purpose or replaced
      s.stop = null;
      if (!err) return; // the remote loop's own time limit: the next read starts a new one
      s.error = err.message;
      s.retryAt = Date.now() + RETRY_MS;
      if (/authentication methods failed/i.test(err.message)) onAuthFailure?.(err);
    },
  });
  s.stop = stop;
}

function halt(s) {
  const stop = s.stop;
  s.stop = null;
  stop?.();
}

// Stops the samplers nobody watches any more (also called by the timer below).
export function sweep(now = Date.now()) {
  for (const [id, s] of samplers) {
    if (now - s.wantedAt > IDLE_MS) {
      halt(s);
      samplers.delete(id);
    }
  }
}
setInterval(() => sweep(), 30 * 1000).unref?.();

// A server that was changed or removed starts afresh.
export function forget(serverId) {
  const s = samplers.get(serverId);
  if (s) halt(s);
  samplers.delete(serverId);
}

export function stopAll() {
  for (const id of [...samplers.keys()]) forget(id);
}
