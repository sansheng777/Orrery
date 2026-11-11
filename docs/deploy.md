# Deploying Orrery

This guide sets up Orrery from scratch on a fresh VPS and connects your AI client to it. Replace values in `<angle brackets>` with your own. The examples use `orrery.example.com` as the public hostname and `198.51.100.20` as the Orrery host's IP.

```
AI client -> orrery.example.com (Cloudflare) -> tunnel -> Orrery host -> cloud APIs and SSH to your servers
```

Read [security.md](security.md) first. The Orrery host ends up holding credentials to all your clouds.

## What you need

- A small, dedicated VPS running Debian or Ubuntu, with a public IPv4 address, and root SSH access with a key. Do not run anything else on it.
- A domain whose DNS is on Cloudflare (the free plan is enough).
- Credentials for each cloud you want to manage. [providers.md](providers.md) explains how to create least-privilege ones.

`enable-ssh.sh` reads the host's public IPv4 from its network interfaces. Clouds that use 1:1 NAT (AWS EC2 and Lightsail, Google Cloud, Alibaba Cloud) do not put the public address on an interface; on those, add `ORRERY_SELF_IP=<public IPv4>` to `deploy/.env` before running the script, and it uses that value.

All commands below run as root on the Orrery host.

## 1. Install Docker and get the code

```bash
apt update && apt install -y git curl
curl -fsSL https://get.docker.com | sh
git clone https://github.com/sansheng777/orrery ~/orrery
cd ~/orrery/deploy
mkdir -p data && chown 1000:1000 data && chmod 700 data
```

The container runs as uid 1000 (`node`), so `data/` must belong to that uid. Everything secret lives in `deploy/data/` and `deploy/.env`. Both are in `.gitignore` and `.dockerignore`.

## 2. Create a Cloudflare Tunnel

The tunnel is an outbound connection from the host to Cloudflare, so the host opens no inbound port for it and the DNS record does not reveal the host's IP.

1. In the Cloudflare dashboard, open Zero Trust → Networks → Tunnels and create a tunnel of type **Cloudflared**. Name it `orrery`.
2. Choose **Docker** as the environment. Copy the token that follows `--token` in the command shown (it starts with `eyJ`). Do not run that command: the compose file already runs cloudflared, and a container started by hand is not on the compose network, so it cannot reach `orrery`.
3. Save the token on the host:

   ```bash
   cd ~/orrery/deploy
   echo "TUNNEL_TOKEN=<tunnel token>" > .env && chmod 600 .env
   ```

   Every `docker compose` command fails until `TUNNEL_TOKEN` is set.

4. Add a public hostname (also called a published application route) to the tunnel: subdomain `orrery`, your domain, service type `HTTP`, URL `orrery:8787`. The full target is `http://orrery:8787`.

## 3. Put cloud credentials in `data/`

Follow [providers.md](providers.md) for each provider you use. Each one ends up as one JSON file:

| Provider | File |
| --- | --- |
| AWS | `data/aws.json` |
| netcup | `data/netcup.json` (written by the device login) |
| Linode | `data/linode.json` |
| Google Cloud | `data/gcp.json` |
| Alibaba Cloud | `data/aliyun.json` |
| Vultr | `data/vultr.json` |
| DigitalOcean | `data/digitalocean.json` |
| Kamatera | `data/kamatera.json` |

Every file must be mode 600 and owned by uid 1000. Skip the providers you do not use. You can add more later and restart the container.

netcup has no API key. Sign in once with its device login (this builds the image first):

```bash
docker compose build orrery
docker compose run --rm orrery node /app/providers/netcup/login.js
```

Open the address it prints, sign in with your SCP account, and the refresh token lands in `data/netcup.json`.

Use files, not environment variables. The code also reads variables such as `AWS_ACCESS_KEY_ID` or `LINODE_TOKEN`, but the container only receives the variables listed in `docker-compose.yml`, so putting them in `.env` has no effect.

## 4. Start Orrery and enable SSH monitoring

```bash
cd ~/orrery/deploy
bash enable-ssh.sh
```

The script, run once as root:

1. Detects the host's public IPv4 and records it as `ORRERY_SELF_IP` in `.env`. Orrery never stops, reboots, reinstalls or deletes the machine with this IP through its cloud tools.
2. Builds and starts both containers (`docker compose up -d --build`).
3. Waits for the agent to create its SSH key (`data/keys/id_ed25519`, comment `orrery`) and adds the public half to `/root/.ssh/authorized_keys`, so Orrery can monitor its own host.

If sshd on the host has `PermitRootLogin no`, the script warns you. Set `PermitRootLogin prohibit-password` and reload sshd.

Check that both containers are up:

```bash
docker compose ps
docker compose logs --tail 20 orrery
```

## 5. Read the connector token

```bash
cat data/token
```

The agent creates a random token on first start. It is never written to the logs. Anyone with the token can use every tool, so treat it like a root password.

## 6. Connect your AI client

The endpoint accepts the token in two ways:

| Form | Use it for |
| --- | --- |
| `https://orrery.example.com/mcp/<token>` | claude.ai custom connectors, which cannot send custom headers |
| `POST https://orrery.example.com/mcp` with `Authorization: Bearer <token>` | Every other client that supports remote Streamable HTTP MCP servers with headers |

### claude.ai (web, desktop app, mobile)

1. claude.ai → Settings → Connectors → Add custom connector.
2. Name: `Orrery`. The dashboard finds the connector by this name, so keep it.
3. URL: `https://orrery.example.com/mcp/<token>`.
4. Open the connector's settings and set the permission for each tool. A good default: allow the read-only tools (listed as R in [architecture.md](architecture.md)), and ask every time for everything else.

Requests from claude.ai come from Anthropic's servers, not from your device.

### Claude Code

```bash
claude mcp add --transport http orrery https://orrery.example.com/mcp --header "Authorization: Bearer <token>"
```

### Codex CLI

In `~/.codex/config.toml`:

```toml
[mcp_servers.orrery]
url = "https://orrery.example.com/mcp"
bearer_token_env_var = "ORRERY_CONNECTOR_TOKEN"
```

Then export `ORRERY_CONNECTOR_TOKEN=<token>` in the shell that runs Codex.

### Cursor

In `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "orrery": {
      "url": "https://orrery.example.com/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

### Gemini CLI

In `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "orrery": {
      "httpUrl": "https://orrery.example.com/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

Client configuration formats change often. If a key above does not work, check your client's documentation for "remote MCP server", "Streamable HTTP" and "headers".

## 7. Restrict who can reach the hostname

The token alone is not enough protection for a tool set this powerful. Add a network rule at Cloudflare as well.

### Option A: claude.ai only (one WAF rule)

Anthropic publishes the range its servers use for outbound requests: `160.79.104.0/21`. In Cloudflare, open your domain → Security → WAF → Custom rules → Create rule, choose "Edit expression", paste this and set the action to **Block**:

```
(http.host eq "orrery.example.com" and not ip.src in {160.79.104.0/21})
```

This range is shared by every Claude user, which is why the token still matters. The rule blocks every other client, including Claude Code, Codex and Cursor on your own computer.

### Option B: other clients too

Clients on your own machines connect from your IPs, not Anthropic's. Use one of these:

- **Allowlist your own IPs.** Extend the WAF rule with your addresses, for example `(http.host eq "orrery.example.com" and not ip.src in {160.79.104.0/21 203.0.113.30})`. This works well with a static IP and badly with a changing one.
- **Cloudflare Access with service tokens.** Create a self-hosted Access application for `orrery.example.com` with a Service Auth policy, and create a service token. The client then sends two more headers, `CF-Access-Client-Id` and `CF-Access-Client-Secret`, next to `Authorization`. claude.ai cannot send these headers; if you also use claude.ai, add a Bypass policy for `160.79.104.0/21` to the same application.

To debug from your own computer with Option A, add your IP to the rule for a while and remove it afterwards.

## 8. Check that it works

Open a new conversation and ask your assistant to list your servers. It should call `list_servers` and show every discovered machine. If the Orrery host runs at a provider you configured, it is listed first and tagged `orrery-host`. Otherwise add it with `add_server` (its public IP, user `root`, no password or key path) so you can monitor it too. Ask it to call `cloud_providers` to see which providers are configured and why any of them failed.

Clients fix their tool list when a conversation starts. After you add credentials for another provider, restart the container and open a new conversation to see its tools.

## 9. Harden SSH on the host to key-only

Orrery logs in with its key, so password logins can go. Follow "New server baseline" in [security.md](security.md): it adds a small sshd drop-in, with an automatic revert in case you lock yourself out. Keep the provider's web console at hand while you do it.

## 10. Onboard your servers

Ask the assistant to onboard a server (`ssh_bootstrap <id>`), or all of them.

- AWS, Google Cloud and Alibaba Cloud machines are done automatically.
- For netcup, Linode, Vultr, DigitalOcean and Kamatera the job ends in `failed` with one command in its `error`. Paste that command as root into the provider's web console, then run `ssh_bootstrap` again to confirm. This is expected.
- Each target must accept SSH on port 22 from the Orrery host's IP. A cloud firewall that only allows other addresses makes onboarding time out.

Details per provider are in [architecture.md](architecture.md), "Discovery and onboarding".

## 11. Publish the dashboard (optional)

`dashboard/orrery.html` is a claude.ai Artifact page. It only works inside claude.ai and the Claude apps.

1. In a claude.ai conversation that has the `Orrery` connector, give Claude the file and ask it to publish it as an artifact with access to the Orrery connector.
2. The page needs permission to call these tools: `list_servers`, `server_stats`, `server_pulse`, `cloud_providers`, `aws_instances`, `aws_cost`, `netcup_servers`, `linode_instances`, `gcp_instances`, `aliyun_instances`, `vultr_instances`, `digitalocean_droplets`, `kamatera_servers`, `run_command`, `container_logs`, `container_action`, `add_server`, `update_server`, `remove_server`.
3. Open the page and allow it to use the connector when it asks.

To update the page later, publish the new file to the same artifact.

## Daily operations

Run these as root in `~/orrery/deploy`.

| Task | Command |
| --- | --- |
| Update Orrery | `cd ~/orrery && git pull && cd deploy && docker compose up -d --build` (the connector is down for one to two minutes) |
| Status | `docker compose ps` |
| Agent logs | `docker compose logs -f orrery` |
| Tunnel logs | `docker compose logs -f tunnel` |
| Audit log | `tail -n 50 data/audit.log` |
| Restart the agent | `docker compose restart orrery` (enough after changing files in `data/`) |
| After editing `.env` | `docker compose up -d` (`restart` does not re-read `.env`) |
| Rotate the connector token | See [security.md](security.md), "Rotating secrets" |
| Upgrade cloudflared | Bump the pinned `cloudflare/cloudflared` tag in `docker-compose.yml`, then `docker compose up -d`. Cloudflare supports a release for about a year |

### Updating from a chat

You can update Orrery through Orrery. Run this with `run_command` on the Orrery host:

```bash
cd ~/orrery && git pull -q && cd deploy && (setsid nohup docker compose up -d --build > /tmp/orrery-update.log 2>&1 < /dev/null &)
```

The call often returns Bad Gateway, because the rebuild cuts the connection that carries the reply. That is normal. Wait one to two minutes, call `list_servers` to confirm Orrery is back, then check `git -C ~/orrery log --oneline -1` and `/tmp/orrery-update.log`.

The command is detached from the shell on purpose. See "Known pitfalls" in [architecture.md](architecture.md) for why.
