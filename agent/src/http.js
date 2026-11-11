// Streamable HTTP entry for a claude.ai custom connector. Stateless: each request gets a fresh
// MCP server; SSH connections and the inventory are shared across requests.
// The endpoint runs shell commands on your servers, so it is only reachable at /mcp/<token>.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, ROLE } from "./server.js";
import { DATA_DIR } from "./inventory.js";

const MAX_BODY = 1024 * 1024;

function loadToken() {
  const fromEnv = process.env.ORRERY_TOKEN;
  if (fromEnv) {
    if (fromEnv.length < 32) throw new Error("ORRERY_TOKEN must be at least 32 characters.");
    return fromEnv;
  }
  const file = path.join(DATA_DIR, "token");
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    const token = crypto.randomBytes(24).toString("base64url");
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, token + "\n", { mode: 0o600 });
    return token;
  }
}

function sameToken(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("Request body too large"), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("Invalid JSON"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

const send = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

export async function startHttp({ port = Number(process.env.PORT) || 8787, host = process.env.HOST || "127.0.0.1" } = {}) {
  const token = loadToken();
  const handle = async (req, res) => {
    let url;
    try {
      url = new URL(req.url, "http://localhost");
    } catch {
      return send(res, 400, { error: "bad request" }); // e.g. "GET http://[x]/", which new URL rejects
    }
    if (url.pathname === "/healthz") return send(res, 200, { ok: true });
    // Two ways in: the token in the path (/mcp/<token>, for clients that only take a URL, such as a
    // claude.ai custom connector), or /mcp with "Authorization: Bearer <token>" (Codex, Cursor, Claude
    // Code and other clients that send headers). A wrong path token looks like any unknown path.
    const m = url.pathname.match(/^\/mcp\/([^/]+)\/?$/);
    if (m) {
      if (!sameToken(m[1], token)) return send(res, 404, { error: "not found" });
    } else if (/^\/mcp\/?$/.test(url.pathname)) {
      const bearer = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization || "")?.[1];
      if (!bearer || !sameToken(bearer, token)) {
        res.setHeader("WWW-Authenticate", 'Bearer realm="orrery"');
        return send(res, 401, { error: "unauthorized" });
      }
    } else return send(res, 404, { error: "not found" });
    if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });

    let body;
    try {
      body = await readJson(req);
    } catch (e) {
      return send(res, e.status || 400, { error: e.message });
    }
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      if (!res.headersSent) send(res, 500, { error: e.message });
    }
  };
  // Nothing a single request does may take the process (and every tool with it) down.
  const httpServer = http.createServer((req, res) =>
    handle(req, res).catch((e) => {
      console.error(`request failed: ${e.message}`);
      if (!res.headersSent) send(res, 500, { error: "internal error" });
      else res.destroy();
    }),
  );
  await new Promise((resolve) => httpServer.listen(port, host, resolve));
  const addr = httpServer.address();
  console.error(`orrery listening on http://${host}:${addr.port}/mcp/<token> (or /mcp with "Authorization: Bearer <token>")`);
  // The token itself is never logged: anyone who can read the logs could otherwise use every tool.
  const where = process.env.ORRERY_TOKEN ? "ORRERY_TOKEN" : path.join(DATA_DIR, "token");
  console.error(`connector URL: https://<your host>/mcp/<token>, token in ${where} (keep it secret: it unlocks every tool${ROLE === "admin" ? ", including starting, stopping and deleting cloud servers" : ""})`);
  return httpServer;
}
