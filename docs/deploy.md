# Deploying Orrery

Set up Orrery on a fresh VPS and connect your AI client. Replace `<angle brackets>` with your values. The examples use `orrery.example.com` as the public hostname and `198.51.100.20` as the Orrery host's IP.

Read [security.md](security.md) first: the Orrery host ends up holding credentials to all your clouds.

## What you need

- A small, dedicated VPS with Debian or Ubuntu, a public IPv4 address and root SSH access with a key. Run nothing else on it.
- A domain whose DNS is on Cloudflare (the free plan is enough).
- Credentials for each cloud you want to manage ([providers.md](providers.md)).

All commands run as root on the Orrery host.

## 1. Install Docker and get the code

```bash
apt update && apt install -y git curl
curl -fsSL https://get.docker.com | sh
git clone https://github.com/sansheng777/orrery ~/orrery
cd ~/orrery/deploy
mkdir -p data && chown 1000:1000 data && chmod 700 data
```

The container runs as uid 1000 (`node`), so `data/` must belong to it. All secrets live in `deploy/data/` and `deploy/.env`, which git and Docker ignore.

## 2. Create a Cloudflare Tunnel

The tunnel connects outbound from the host, so the host opens no inbound port and the DNS record does not reveal its IP.

1. In Cloudflare, open Zero Trust → Networks → Tunnels and create a **Cloudflared** tunnel named `orrery`.
2. Choose **Docker**. Copy the token after `--token` in the command shown (it starts with `eyJ`). Do not run that command: the compose file already runs cloudflared, and a container started by hand is not on the compose network, so it cannot reach `orrery`.
3. Save the token. Every `docker compose` command fails until it is set.

   ```bash
   echo "TUNNEL_TOKEN=<tunnel token>" > .env && chmod 600 .env
   ```

4. Add a public hostname (published application route) to the tunnel: subdomain `orrery`, your domain, type `HTTP`, URL `orrery:8787`.

On a cloud with 1:1 NAT (AWS EC2 and Lightsail, Google Cloud, Alibaba Cloud), the public address is not on a network interface. Add it now:

```bash
echo "ORRERY_SELF_IP=<public IPv4>" >> .env
```

## 3. Add cloud credentials

Follow [providers.md](providers.md) for each provider you use. Each one ends up as a JSON file in `data/`, mode 600, owner 1000. Skip the ones you do not use; you can add more later.

netcup has no API key. Sign in once with its device login:

```bash
docker compose build orrery
docker compose run --rm orrery node /app/providers/netcup/login.js
```

Open the address it prints and sign in with your SCP account. The refresh token lands in `data/netcup.json`.

## 4. Start Orrery and enable SSH monitoring

```bash
bash enable-ssh.sh
```

The script:

1. Takes `ORRERY_SELF_IP` from `.env` if set (an inline `# comment` is dropped). Otherwise it uses the first public IPv4 on the host's interfaces, skipping private, loopback and carrier-grade NAT (`100.64.0.0/10`) addresses. It stops if it finds none, or if the value is not a plain IPv4 address, and writes the result back to `.env`.
2. Builds and starts both containers (`docker compose up -d --build`).
3. Waits for the agent's SSH key (`data/keys/id_ed25519`) and adds its public half to `/root/.ssh/authorized_keys`, so Orrery can monitor its own host.
4. Warns if sshd has `PermitRootLogin no` or `forced-commands-only`. Set `PermitRootLogin prohibit-password` and restart sshd.

Orrery never stops, reboots, reinstalls or deletes the machine with `ORRERY_SELF_IP` through its cloud tools ([security.md](security.md#protected-machines)).

Check both containers:

```bash
docker compose ps
docker compose logs --tail 20 orrery
```

## 5. Read the connector token

```bash
cat data/token
```

The agent creates it on first start and never logs it. Anyone with the token can use every tool: treat it like a root password.

## 6. Connect your AI client

| Client | Setting |
| --- | --- |
| claude.ai (web, desktop, mobile) | Settings → Connectors → Add custom connector. Name `Orrery` (the dashboard looks for it). URL `https://orrery.example.com/mcp/<token>` |
| Claude Code | `claude mcp add --transport http orrery https://orrery.example.com/mcp --header "Authorization: Bearer <token>"` |
| Codex CLI | `~/.codex/config.toml`: `[mcp_servers.orrery]` with `url = "https://orrery.example.com/mcp"` and `bearer_token_env_var = "ORRERY_CONNECTOR_TOKEN"`, then export `ORRERY_CONNECTOR_TOKEN=<token>` |
| Cursor | `~/.cursor/mcp.json`: `{"mcpServers": {"orrery": {"url": "https://orrery.example.com/mcp", "headers": {"Authorization": "Bearer <token>"}}}}` |
| Gemini CLI | `~/.gemini/settings.json`: `{"mcpServers": {"orrery": {"httpUrl": "https://orrery.example.com/mcp", "headers": {"Authorization": "Bearer <token>"}}}}` |
| Other clients | A remote Streamable HTTP server at `https://orrery.example.com/mcp` with the header `Authorization: Bearer <token>` |

claude.ai connectors cannot send headers, so they use the token in the path. Prefer the header form everywhere else. Client config formats change often: if a key does not work, look for "remote MCP server", "Streamable HTTP" and "headers" in your client's docs.

Then set each tool's permission in the client: allow the read-only tools (R in the [tool reference](architecture.md#4-tool-reference)) and ask every time for the rest ([security.md](security.md#tool-approval-in-the-client)).

## 7. Restrict who can reach the hostname

The token alone is not enough for a tool set this powerful. Add a network rule at Cloudflare.

**Option A: claude.ai only.** claude.ai requests come from Anthropic's egress range `160.79.104.0/21`, not from your device. Open your domain → Security → WAF → Custom rules → Create rule → Edit expression, paste this and set the action to **Block**:

```
(http.host eq "orrery.example.com" and not ip.src in {160.79.104.0/21})
```

Every Claude user shares this range, which is why the token still matters. The rule also blocks Claude Code, Codex and Cursor on your computer.

**Option B: other clients too.** Local clients connect from your IPs. Either:

- add your static IPs to the rule, such as `{160.79.104.0/21 203.0.113.30}`, or
- create a self-hosted Cloudflare Access application for the hostname with a Service Auth policy and a service token. Clients then also send `CF-Access-Client-Id` and `CF-Access-Client-Secret`. claude.ai cannot send them, so add a Bypass policy for `160.79.104.0/21` if you use it too.

To debug from your computer with Option A, add your IP to the rule for a while.

## 8. Check that it works

In a new conversation, ask the assistant to list your servers. It calls `list_servers`. If the Orrery host runs at a configured provider, it is listed first and tagged `orrery-host`. Otherwise add it with `add_server` (its public IP, user `root`, no password or key path). Ask for `cloud_providers` to see which providers are configured and why any failed.

Orrery reads credential files on every request, so adding one needs no restart. Clients fix their tool list when a conversation starts: open a new conversation to see a new provider's tools.

## 9. Harden SSH on the host

Orrery logs in with its key, so password logins can go. Follow [New server baseline](security.md#new-server-baseline). It reverts itself if you lock yourself out. Keep the provider's web console at hand.

## 10. Onboard your servers

Ask the assistant to onboard a server (`ssh_bootstrap <id>`) or all of them.

- AWS, Google Cloud and Alibaba Cloud are automatic.
- netcup, Linode, Vultr, DigitalOcean and Kamatera jobs end in `failed` with one command in `error`. Paste it as root into the provider's web console, then run `ssh_bootstrap` again. This is expected.
- Each target must accept SSH on port 22 from the Orrery host's IP.

Details: [Discovery and onboarding](architecture.md#5-discovery-and-onboarding).

## 11. Publish the dashboard (optional)

`dashboard/orrery.html` is a claude.ai Artifact and works only inside claude.ai and the Claude apps. In a conversation that has the `Orrery` connector, ask Claude to publish the file unchanged as an Artifact with the connector's tools; the list is in [AGENTS.md](../AGENTS.md#publish-the-dashboard-claudeai-only) and in the file's header comment. Allow the page to use the connector when it asks. To update it, publish the new file to the same Artifact.

## Daily operations

Run these as root in `~/orrery/deploy`.

| Task | Command |
| --- | --- |
| Update Orrery | `cd ~/orrery && git pull && cd deploy && docker compose up -d --build` (connector down for one to two minutes) |
| Status | `docker compose ps` |
| Agent or tunnel logs | `docker compose logs -f orrery`, `docker compose logs -f tunnel` |
| Audit log | `tail -n 50 data/audit.log` |
| Restart the agent | `docker compose restart orrery` |
| After editing `.env` | `docker compose up -d` (`restart` does not re-read `.env`) |
| Rotate a secret | [security.md](security.md#rotating-secrets) |
| Upgrade cloudflared | Bump the pinned `cloudflare/cloudflared` tag in `docker-compose.yml`, then `docker compose up -d`. Cloudflare supports a release for about a year |

### Updating from a chat

Run this with `run_command` on the Orrery host:

```bash
cd ~/orrery && git pull -q && cd deploy && (setsid nohup docker compose up -d --build > /tmp/orrery-update.log 2>&1 < /dev/null &)
```

The call often returns Bad Gateway because the rebuild cuts the connection carrying the reply. Wait one to two minutes, call `list_servers`, then check `git -C ~/orrery log --oneline -1` and `/tmp/orrery-update.log`. The command is fully detached on purpose ([pitfalls](architecture.md#9-known-pitfalls)).
