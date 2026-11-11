#!/usr/bin/env node
// Sign in to netcup's SCP once (OAuth device flow) and save the refresh token for the agent.
// Deployed connector:  cd deploy && docker compose run --rm orrery node /app/providers/netcup/login.js
//                      (writes deploy/data/netcup.json)
// Local agent:         node providers/netcup/login.js   (writes ~/.orrery/netcup.json)
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { SCP, TOKEN_URL, saveRefreshToken } from "./index.js";

const DEVICE_URL = `${SCP}/realms/scp/protocol/openid-connect/auth/device`;
const dir = process.env.ORRERY_DIR || path.join(os.homedir(), ".orrery");
const file = path.join(dir, "netcup.json");

const post = async (url, form) => {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() });
  return { ok: res.ok, body: await res.json().catch(() => ({})) };
};

const start = await post(DEVICE_URL, { client_id: "scp", scope: "offline_access openid" });
if (!start.ok || !start.body.device_code) {
  console.error("Could not start the netcup sign-in:", start.body);
  process.exit(1);
}
const { device_code, user_code, verification_uri_complete, verification_uri, interval = 5, expires_in = 600 } = start.body;
console.log(`\nOpen this address in a browser and sign in with your SCP account:\n\n  ${verification_uri_complete || verification_uri}\n\nCode: ${user_code}\n`);

const deadline = Date.now() + expires_in * 1000;
let wait = interval;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, wait * 1000));
  const { body } = await post(TOKEN_URL, { client_id: "scp", grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code });
  if (body.refresh_token) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    saveRefreshToken(file, body.refresh_token);
    console.log(`Saved the refresh token to ${file} (mode 600). Restart the agent to load it.`);
    process.exit(0);
  }
  if (body.error === "slow_down") wait += 5;
  else if (body.error !== "authorization_pending") {
    console.error("Sign-in failed:", body.error_description || body.error || body);
    process.exit(1);
  }
}
console.error("The code expired before the sign-in finished. Run this again.");
process.exit(1);
