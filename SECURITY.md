# Security policy

## Reporting a vulnerability

Please do not report security problems in public issues, pull requests or discussions.

Use GitHub's private vulnerability reporting instead: open this repository's **Security** tab and choose **Report a vulnerability**. Only the maintainers can see the report.

Please include:

- what an attacker can do, and what they need first (for example a connector token, a compromised monitored server, or a malicious API answer),
- the affected component (agent, a provider module, the dashboard, the deployment files),
- steps to reproduce, and the commit you tested.

Never include real credentials, tokens, private keys or IP addresses of machines you do not own. Use placeholders.

We will acknowledge the report, keep you informed while we work on a fix, and credit you when it is released, unless you prefer otherwise.

## Scope

Fixes go to the latest version on the default branch. Examples of issues we want to hear about:

- a way around the token check, protected machines, name confirmation, the refusal of secret-returning APIs or the redaction of results,
- a secret that reaches a tool result, a log or the audit log,
- a way for a monitored server to reach the Orrery host or its credentials.

Weaknesses that need full control of the Orrery host are out of scope: that host holds every credential by design. See [docs/security.md](docs/security.md) for the security model.
