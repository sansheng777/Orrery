# Changelog

All notable changes to Orrery are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Until 1.0.0, a minor version can change tools, their arguments or the configuration; such changes are listed under **Changed** with what to do when updating.

## [Unreleased]

## [0.1.0] - 2026-11-12

First public release.

### Added

- An MCP server for the user's servers across AWS (EC2, Lightsail), Google Cloud, Alibaba Cloud, netcup, Linode, Vultr, DigitalOcean and Kamatera, plus any machine reachable over SSH. 78 tools: discovery, monitoring, shell and Docker, and each provider's power, delete, rebuild and API controls with read-only twins.
- Discovery of every machine with a public IPv4 in the configured accounts, and one-call onboarding (`ssh_bootstrap`): automatic on AWS, Google Cloud and Alibaba Cloud, one pasted command elsewhere.
- `fleet_overview`: a status board of every server as one Markdown table, also offered as the MCP prompt `overview`. It is the dashboard outside claude.ai.
- A live dashboard for claude.ai and the Claude apps (`dashboard/orrery.html`), published as an Artifact.
- A one-command installer (`deploy/install.sh`): Docker, swap, the Cloudflare tunnel, its DNS record and a firewall rule that lets only the AI client reach the hostname, then Orrery itself.
- Guards: protected machines, name confirmation for irreversible actions, refusal of secret-returning APIs, redaction of results, an audit log, and pinned SSH host keys with `accept_host_key`.
- Operating rules sent to every client at connect (MCP instructions), and step-by-step setup instructions for AI agents in `AGENTS.md`.
- Access with the token in the URL (claude.ai) or as a Bearer header (Claude Code, Codex, Cursor and other MCP clients), and a local stdio mode.

[Unreleased]: https://github.com/sansheng777/Orrery/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/sansheng777/Orrery/releases/tag/v0.1.0
