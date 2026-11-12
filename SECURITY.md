# Security policy

## Reporting a vulnerability

Do not report security problems in public issues, pull requests or discussions. Use GitHub's private vulnerability reporting: open this repository's **Security** tab and choose **Report a vulnerability**. Only the maintainers can see the report.

Include:

- what an attacker can do, and what they need first (for example a connector token, a compromised monitored server, or a malicious API answer),
- the affected component (agent, a provider module, the dashboard, the deployment files),
- steps to reproduce, and the release or commit you tested.

Never include real credentials, tokens, private keys or IP addresses of machines you do not own. Use placeholders.

We will acknowledge the report, keep you informed while we fix it, and credit you in the release unless you prefer otherwise.

## Scope

Security fixes ship in a new release and are listed under **Security** in [CHANGELOG.md](CHANGELOG.md). Only the latest release is supported: update with the installer (`curl -fsSL https://github.com/sansheng777/Orrery/releases/latest/download/install.sh | bash` on the Orrery host). How to check that a release is genuine: [docs/security.md](docs/security.md#verifying-a-release).

We want to hear about:

- a way around the token check, protected machines, name confirmation, the refusal of secret-returning APIs or the redaction of results,
- a secret that reaches a tool result, a log or the audit log,
- a way for a monitored server to reach the Orrery host or its credentials.

Weaknesses that need full control of the Orrery host are out of scope: that host holds every credential by design. The security model is in [docs/security.md](docs/security.md).
