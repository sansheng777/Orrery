# Orrery

Orrery is a self-hosted MCP server for your servers across many clouds. It runs on a small machine you own, finds every server in your cloud accounts, gets SSH access to them, and gives your AI assistant tools to watch, run commands on, and control them. Cloud credentials and the SSH key stay on that machine. The assistant only sees tool results.

AI agents: start with [AGENTS.md](AGENTS.md). It has the deploy commands, client setup, dashboard publishing and operating rules.

## What it does

- **Discovery across 8 providers.** Every machine with a public IPv4 shows up in `list_servers` within a minute. Deleted machines drop out.
- **One-call onboarding.** `ssh_bootstrap` makes a discovered server trust Orrery's key: automatic on AWS, Google Cloud and Alibaba Cloud, one pasted command elsewhere.
- **Monitoring.** CPU, load, memory, swap, disks, network, Docker containers, pending updates and last login in one SSH round trip. `server_pulse` gives one sample a second.
- **Shell and Docker.** Run commands, read container logs, start, stop or restart containers.
- **Cloud control.** Power, delete, rebuild or reinstall, plus a generic API tool per provider with a read-only `*_query` twin you can allow without a prompt.
- **Guards.** The Orrery host and IPs you list cannot be stopped or deleted through the cloud tools. Irreversible actions must repeat the machine's name. Secret-returning APIs are refused and secrets in answers are redacted. SSH host keys are pinned, so a changed key stops the connection. Every change goes to an audit log. Details: [docs/security.md](docs/security.md).
- **Usage rules built in.** At connect, Orrery sends each client its operating rules as MCP instructions (`agent/src/instructions.js`).

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

You need a small dedicated VPS with Docker, a domain on Cloudflare, and credentials for your clouds. The commands are in [AGENTS.md](AGENTS.md#deploy-on-the-users-vps-as-root); the full walkthrough with client setup and network restrictions is in [docs/deploy.md](docs/deploy.md).

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
| [SECURITY.md](SECURITY.md) | Reporting a vulnerability |

## License

[MIT](LICENSE).
