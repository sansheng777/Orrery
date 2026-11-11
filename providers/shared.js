// Helpers shared by the provider modules.

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ORRERY_SELF_IP (the Orrery host) plus ORRERY_PROTECTED_IPS (comma or space separated: other machines
// that must stay up). A chat may read and start these machines, never stop, reboot, delete, reinstall
// or change them. Lower-cased, without duplicates.
export const protectedIps = (env = process.env) =>
  [...new Set([env.ORRERY_SELF_IP, ...String(env.ORRERY_PROTECTED_IPS || "").split(/[\s,]+/)].map((ip) => String(ip || "").trim().toLowerCase()).filter(Boolean))];

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_RETRY_WAIT_MS = 10000;

// One JSON request with a timeout. A GET is retried once on rate limiting (429) or a 5xx, waiting for
// Retry-After when it is at most 10 s; a change is never sent twice. Resolves to { res, json, retryAfter }
// whatever the status; json is null when the body is empty or not JSON.
export async function jsonRequest(fetchImpl, url, { method = "GET", headers = {}, body, timeoutMs = 30000, retryWaitMs = 1000 } = {}) {
  const init = {
    method,
    headers: { accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
  for (let attempt = 0; ; attempt++) {
    const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    const retryAfter = Number(res.headers.get("retry-after")) || 0;
    if (res.ok || method !== "GET" || attempt > 0 || !RETRY_STATUS.has(res.status) || retryAfter * 1000 > MAX_RETRY_WAIT_MS) return { res, json, retryAfter };
    await sleep(retryAfter ? retryAfter * 1000 : retryWaitMs);
  }
}
