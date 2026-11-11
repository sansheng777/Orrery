# Orrery

Orrery is a self-hosted control plane for your servers across every cloud, built for AI agents. It runs as an MCP server on a small machine you own. It finds every server in your cloud accounts, gets SSH access to them, and gives your AI assistant tools to watch, run commands on, and control them. Cloud credentials and the SSH key stay on that machine. The assistant only ever sees tool results.

## What it does

- **Auto-discovery across 8 providers.** AWS (EC2 and Lightsail), netcup, Linode, Google Cloud (Compute Engine), Alibaba Cloud (ECS), Vultr, DigitalOcean and Kamatera. Every machine with a public IPv4 shows up in `list_servers` within a minute. Deleted machines drop out on their own.
- **One-call onboarding.** `ssh_bootstrap` makes a discovered server trust Orrery's SSH key. On AWS, Google Cloud and Alibaba Cloud this is fully automatic and needs no restart. On the other providers it returns one command to paste into the provider's web console.
- **Live monitoring.** CPU, load, memory, swap, disks, network rates, Docker containers, pending updates and the last login, from one SSH round trip. `server_pulse` streams one sample a second.
- **Shell and Docker.** Run a command on any server, read container logs, start, stop or restart containers.
- **Per-provider control tools with read-only twins.** Power, delete, rebuild or reinstall, plus a generic API tool per provider (`aws_call`, `netcup_api_request`, `linode_api_request` and so on). Each generic tool has a read-only twin (`aws_query`, `netcup_query`, ...) that the code limits to reads, so you can allow it without a prompt.
- **Safety guards.**
  - Protected machines: the Orrery host and any IPs you list can be started but never stopped, rebooted, reinstalled or deleted through the cloud tools.
  - Name confirmation: every irreversible action (delete, reinstall, snapshot revert) must repeat the machine's name.
  - Refusal of secret-returning APIs: calls that would put a password, private key or token into the chat are refused (EC2 `GetPasswordData`, Lightsail default key pairs, Linode token creation, kubeconfigs, certificate private keys, and more).
  - Redaction: passwords and keys inside ordinary API answers are replaced with `[redacted]`.
  - Audit log: every change is written to an append-only JSON log on the host.

## How a request travels

```
AI assistant (claude.ai, Claude Code, Codex, Cursor, Gemini CLI, any MCP client)
   |
   |  HTTPS  https://orrery.example.com/mcp/<token>   or   POST /mcp + Authorization: Bearer <token>
   v
Cloudflare        WAF rule or Cloudflare Access: only allowed sources get through
   |
   v
Cloudflare Tunnel (outbound from the host; no inbound ports, the DNS record does not reveal the host IP)
   |
   v
Orrery host       tunnel container  ->  orrery container (checks the token, writes the audit log)
   |
   +--> provider APIs (EC2, Lightsail, netcup SCP, Linode, Compute Engine, Alibaba Cloud, Vultr, DigitalOcean, Kamatera)
   +--> SSH to every server (one key that every server trusts)
```

## Supported providers

| Provider | Discovered automatically | Onboarding (`ssh_bootstrap`) | Control tools |
| --- | --- | --- | --- |
| AWS EC2 | Yes, every enabled region | Automatic through EC2 Instance Connect, no restart | Power, terminate, any EC2 API |
| AWS Lightsail | Yes, every Lightsail region | Automatic through Lightsail's temporary SSH certificate, no restart | Power, delete, any Lightsail API |
| Google Cloud | Yes, every zone of the configured projects | Automatic through instance metadata (`ssh-keys`), no restart | Power, delete, any Compute Engine API |
| Alibaba Cloud | Yes, every region | Automatic through Cloud Assistant, no restart | Power, release, any ECS, VPC, DNS, domain, CDN or certificate API; billing read-only |
| netcup | Yes | Paste one command in the SCP web console | Power, snapshots, rescue, reinstall, rDNS, any SCP API |
| Linode | Yes | Paste one command in the Lish console | Power, delete, rebuild, any Linode API |
| Vultr | Yes | Paste one command in the web console | Power, delete, reinstall, any Vultr API |
| DigitalOcean | Yes | Paste one command in the Droplet Console | Power, delete, rebuild, any DigitalOcean API |
| Kamatera | Yes | Paste one command in the server console | Power, delete, any cloudcli API |
| Any other machine | No, add it with `add_server` | Paste the same command, or add the key yourself | SSH tools only |

New machines need no onboarding at all if you install Orrery's public key when you create them (`ssh_public_key`). See [docs/security.md](docs/security.md), "New server baseline".

## Quick start

You need a small dedicated VPS with Docker, a domain on Cloudflare, and credentials for the clouds you use. The full walkthrough is in [docs/deploy.md](docs/deploy.md).

```bash
git clone https://github.com/sansheng777/orrery ~/orrery && cd ~/orrery/deploy
mkdir -p data && chown 1000:1000 data && chmod 700 data
echo "TUNNEL_TOKEN=<your Cloudflare tunnel token>" > .env && chmod 600 .env
# put cloud credentials into data/ (docs/providers.md)
bash enable-ssh.sh
cat data/token
```

Point the tunnel's public hostname at `http://orrery:8787`, add the connector to your AI client, and restrict who can reach the hostname.

## Using it

### From claude.ai

Settings → Connectors → Add custom connector. Name it `Orrery` (the dashboard looks for this name) and use the URL `https://orrery.example.com/mcp/<token>`. The connector then works in claude.ai on the web, in the desktop app and on your phone. Set each tool's permission there: allow the read-only tools, and ask every time for the rest.

### From Codex, Cursor, Claude Code, Gemini CLI and other MCP clients

Use the header form. Point the client at `https://orrery.example.com/mcp` as a remote (Streamable HTTP) MCP server and send the header `Authorization: Bearer <token>`. For example, in Claude Code:

```bash
claude mcp add --transport http orrery https://orrery.example.com/mcp --header "Authorization: Bearer <token>"
```

These clients connect from your own machine, not from Anthropic, so the claude.ai network rule will block them. Use Cloudflare Access or an allowlist of your own IPs instead. [docs/deploy.md](docs/deploy.md) has examples for each client and both network options.

### Locally, without a server

Run the agent on your own computer over stdio:

```bash
npm install
node agent/src/index.js
```

This is the `hub` role (the default). It offers the SSH tools and read-only cloud views, with no power, delete or generic API tools and no onboarding. Credentials go in `~/.orrery/`. See [docs/architecture.md](docs/architecture.md), "Running locally".

## Dashboard

`dashboard/orrery.html` is a page for claude.ai's Artifact feature. It shows every server with live figures, the cloud providers' views, a terminal and container controls, and it calls the same `Orrery` connector. It only works inside claude.ai (and the Claude apps). Publishing it is described in [docs/deploy.md](docs/deploy.md).

## Security warning

The Orrery host holds credentials to all your cloud accounts and an SSH private key that every one of your servers trusts. Whoever controls that host controls everything: they can delete every machine, read every disk, and run any command as root anywhere.

- Run Orrery on a dedicated small VPS. Do not run anything else on it.
- Allow SSH logins with keys only. Open no other inbound ports (the tunnel is outbound).
- Keep the connector token secret, restrict the hostname at Cloudflare, and require approval for every tool that changes something.
- Turn on two-factor authentication for every cloud account, Cloudflare and your AI client account.

Read [docs/security.md](docs/security.md) before you deploy.

## Documentation

| Document | Contents |
| --- | --- |
| [docs/deploy.md](docs/deploy.md) | Deploying from scratch, connecting clients, daily operations |
| [docs/providers.md](docs/providers.md) | Credentials and permissions for each cloud provider |
| [docs/security.md](docs/security.md) | Security model, threat model, protected machines, key rotation |
| [docs/architecture.md](docs/architecture.md) | How it works, tool reference, discovery and onboarding, troubleshooting, known pitfalls, configuration, code layout, tests |
| [SECURITY.md](SECURITY.md) | Reporting a vulnerability |

## License

[MIT](LICENSE).
