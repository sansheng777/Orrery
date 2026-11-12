# Orrery

[![test](https://github.com/sansheng777/Orrery/actions/workflows/test.yml/badge.svg)](https://github.com/sansheng777/Orrery/actions/workflows/test.yml)
[![release](https://img.shields.io/github/v/release/sansheng777/Orrery?sort=semver)](https://github.com/sansheng777/Orrery/releases/latest)
[![license](https://img.shields.io/github/license/sansheng777/Orrery)](LICENSE)

Orrery is a self-hosted MCP server for your servers across many clouds. It runs on a small machine you own, finds every server in your cloud accounts, gets SSH access to them, and gives your AI assistant tools to watch, run commands on, and control them. Cloud credentials and the SSH key stay on that machine. The assistant only sees tool results.

AI agents: start with [AGENTS.md](AGENTS.md). It has the deploy commands, client setup, dashboard publishing and operating rules.

## What you need

- **One dedicated, always-on VPS: the Orrery host.** This is the one thing Orrery cannot do without. It runs there, your AI client connects to it, and every credential and the SSH key stay on it. Use a machine that runs nothing else: Debian or Ubuntu, a public IPv4, root SSH access. Minimum: 2 vCPU, 2 GB of memory, 2 GB of swap and 20 GB of disk.
- A domain on Cloudflare (the free plan is enough), for the tunnel that makes the host reachable without opening a port.
- API credentials for the clouds you use.

## What it does

- **Discovery across 8 providers.** Every machine with a public IPv4 shows up in `list_servers` within a minute. Deleted machines drop out.
- **One-call onboarding.** `ssh_bootstrap` makes a discovered server trust Orrery's key: automatic on AWS, Google Cloud and Alibaba Cloud, one pasted command elsewhere.
- **Monitoring.** CPU, load, memory, swap, disks, network, Docker containers, pending updates and last login in one SSH round trip. `server_pulse` gives one sample a second; `fleet_overview` gives a status board of every server in one call.
- **Shell and Docker.** Run commands, read container logs, start, stop or restart containers.
- **Cloud control.** Power, delete, rebuild or reinstall, plus a generic API tool per provider with a read-only `*_query` twin you can allow without a prompt.
- **Guards.** The Orrery host and IPs you list cannot be stopped or deleted through the cloud tools. Irreversible actions must repeat the machine's name. Secret-returning APIs are refused and secrets in answers are redacted. SSH host keys are pinned, so a changed key stops the connection. Every change goes to an audit log. Details: [docs/security.md](docs/security.md).
- **Usage rules built in.** At connect, Orrery sends each client its operating rules as MCP instructions (`agent/src/instructions.js`).

## Built for Claude, open to every MCP client

Orrery is developed and tested with Claude first, and speaks plain MCP, so any client that can add a remote MCP server with a header can use it, whatever model it runs.

| | claude.ai and the Claude apps | Claude Code | Other MCP clients (Codex, Cursor, Gemini CLI, tools built on other models) |
| --- | --- | --- | --- |
| Every tool, with the same guards | Yes | Yes | Yes |
| Operating rules sent at connect | Yes | Yes | If the client passes MCP instructions to its model |
| Dashboard | Live page (a claude.ai Artifact): figures every second, terminal, container controls, cloud views | Status board as text: `fleet_overview` | Status board as text: `fleet_overview` |
| Reaching Orrery | Allowed by the installer's firewall rule | Your IP allowed at install | Your IP allowed at install |
| Setup guided by the assistant | Yes ([AGENTS.md](AGENTS.md)) | Yes | Yes: the steps are written for any model to follow |

`fleet_overview` returns one Markdown table of every server (state, CPU, memory, disk, load, containers, uptime, what needs attention) in a single call, so even a small model can answer "how are my servers doing?" correctly.

## Supported providers

| Provider | Discovered | Onboarding (`ssh_bootstrap`) | Control tools |
| --- | --- | --- | --- |
| AWS EC2 | Every enabled region | Automatic (EC2 Instance Connect) | Power, terminate, any EC2 API |
| AWS Lightsail | Every region | Automatic (temporary SSH certificate) | Power, delete, any Lightsail API |
| Google Cloud | Every zone of the configured projects | Automatic (instance metadata) | Power, delete, any Compute Engine API |
| Alibaba Cloud | Every region | Automatic (Cloud Assistant) | Power, release, any ECS, VPC, DNS, domain, CDN or certificate API; billing read-only |
| netcup | Yes | Paste one command in the SCP console | Power, snapshots, rescue, reinstall, rDNS, any SCP API |
| Linode | Yes | Paste one command in Lish | Power, delete, rebuild, any Linode API |
| Vultr | Yes | Paste one command in the web console | Power, delete, reinstall, any Vultr API |
| DigitalOcean | Yes | Paste one command in the Droplet Console | Power, delete, rebuild, any DigitalOcean API |
| Kamatera | Yes | Paste one command in the server console | Power, delete, any cloudcli API |
| Any other machine | Add it with `add_server` | Paste the same command | SSH tools only |

New machines need no onboarding if they get Orrery's public key at creation ([New server baseline](docs/security.md#new-server-baseline)).

## Quick start

On the Orrery host, as root, with the hostname you want Orrery to have:

```bash
curl -fsSL https://github.com/sansheng777/Orrery/releases/latest/download/install.sh | bash -s -- orrery.example.com
```

It asks once for a Cloudflare API token, typed hidden and used for that run only, and does the rest: Docker, swap, the Cloudflare tunnel with its DNS record and firewall rule, and Orrery itself. At the end it shows the URL to add to your AI client. What it does, step by step, and how to do it by hand: [docs/deploy.md](docs/deploy.md).

It installs the latest release. To update later, run the same line without the hostname. What changed in each release: [CHANGELOG.md](CHANGELOG.md).

To try it without a server, run `npm install && node agent/src/index.js` on your computer. This local `hub` role offers the SSH tools and read-only cloud listings ([Running locally](docs/architecture.md#running-locally)).

## Security warning

The Orrery host holds credentials to all your cloud accounts and an SSH key every server trusts. Whoever controls it can delete every machine and run any command as root anywhere.

- Run Orrery on a dedicated small VPS with key-only SSH and no other open ports.
- Keep the connector token secret, restrict the hostname at Cloudflare, and require approval for every tool that changes something.
- Turn on two-factor authentication for every cloud account, Cloudflare and your AI client.

Read [docs/security.md](docs/security.md) before you deploy.

## Documentation

| Document | Contents |
| --- | --- |
| [AGENTS.md](AGENTS.md) | Entry point for AI agents: deploy, connect, dashboard, operating rules, code rules |
| [docs/deploy.md](docs/deploy.md) | Deployment from scratch, connecting clients, daily operations |
| [docs/providers.md](docs/providers.md) | Credentials and permissions for each provider |
| [docs/security.md](docs/security.md) | Security model, protected machines, refusals, audit log, key rotation |
| [docs/architecture.md](docs/architecture.md) | Request path, roles, tool reference, discovery and onboarding, dashboard, troubleshooting, pitfalls, configuration, code layout, tests |
| [CHANGELOG.md](CHANGELOG.md) | What changed in each release |
| [SECURITY.md](SECURITY.md) | Reporting a vulnerability, supported versions |

## License

[MIT](LICENSE).
