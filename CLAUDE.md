# Orrery

A self-hosted MCP server that lets AI assistants (claude.ai, Claude Code, Codex, Cursor, ...) monitor and control servers across cloud providers over provider APIs and SSH. Everything in this repository is public: English only, no personal data (real IPs, hostnames, domains, account names, ids, emails) anywhere, including tests and fixtures. Use documentation values: 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24, 2001:db8::/32, example.com.

## Layout

| Path | What |
| --- | --- |
| `agent/` | The MCP server (Node 22, ES modules): `src/server.js` registers tools, `src/http.js` the HTTP entry, `src/bootstrap.js` onboarding, `src/discovery.js` auto-discovery and labels, `src/ssh.js` / `src/live.js` SSH and live sampling |
| `providers/<name>/` | One module per cloud provider, each with its own `test/`; no dependencies except the AWS SDK |
| `dashboard/orrery.html` | The claude.ai Artifact dashboard |
| `deploy/` | `docker-compose.yml` (services `orrery` and `tunnel`) and `enable-ssh.sh` |
| `docs/` | Deployment, providers, security model, architecture |

## Working rules

- Run `npm test` at the repository root before every commit. Tests use fake data only and never reach a real account.
- Safety guards are part of the product: protected machines (`ORRERY_SELF_IP`, `ORRERY_PROTECTED_IPS`), name confirmation for destructive actions, refusal of operations that would return secrets, redaction, and the audit log. A new tool or provider follows the same pattern, with tests for the refusals.
- Every tool that only reads gets `readOnlyHint`; every tool that can stop, delete or run arbitrary commands gets `destructiveHint`. Each provider's generic API tool has a read-only `*_query` twin.
- Environment variables use the `ORRERY_` prefix and must be listed in `deploy/docker-compose.yml` to reach the container, and in `docs/architecture.md`.
- Keep docs in step with the code: new tools go into the tool reference in `docs/architecture.md`, new credentials into `docs/providers.md`.
