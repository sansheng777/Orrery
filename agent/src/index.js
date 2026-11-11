#!/usr/bin/env node
// Orrery agent. Default: stdio MCP for the Claude desktop app.
// With --http (or PORT set): Streamable HTTP MCP for a claude.ai custom connector.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { closeAll } from "./ssh.js";
import { stopAll } from "./live.js";
import { ensureKey } from "./keys.js";

const shutdown = () => {
  stopAll();
  closeAll();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Create the agent's SSH key up front, so deploy/enable-ssh.sh can read its public half.
try {
  ensureKey();
} catch (e) {
  console.error(`orrery: could not create the SSH key: ${e.message}`);
}

if (process.argv.includes("--http") || process.env.PORT) {
  const { startHttp } = await import("./http.js");
  await startHttp();
} else {
  process.stdin.on("close", shutdown);
  await createServer().connect(new StdioServerTransport());
}
