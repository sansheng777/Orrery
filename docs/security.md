# Security model

Orrery gives an AI assistant control over every server you own. This document explains what protects that power, what does not, and what to do when something leaks. Report vulnerabilities as described in [SECURITY.md](../SECURITY.md).

## What is at stake

The Orrery host holds:

- Credentials for every configured cloud account (full control of EC2 and Lightsail, netcup, Linode, Vultr, DigitalOcean and Kamatera; Compute Engine in the configured Google Cloud projects; ECS, VPC, DNS, domains, CDN and certificates on Alibaba Cloud, plus read-only billing).
- The connector token.
- One SSH private key that every monitored server trusts, usually as root.

Whoever controls the host controls all of that. Most of this document is about keeping the host safe and limiting what a chat can do through it.

## Layers of protection

| Layer | What it stops |
| --- | --- |
| Network rule at Cloudflare (WAF or Access) | Requests that do not come from your AI client's network |
| Connector token | Anyone who does not know the URL or header, including other users of the same AI service (they share its IP range) |
| Tool approval in the client | Changes you did not agree to |
| Name confirmation | Irreversible actions on the wrong machine |
| Protected machines | Stopping, reinstalling or deleting the Orrery host and other machines you mark |
| Refusals and redaction | Secrets landing in the chat |
| Audit log | Changes nobody can account for afterwards |
| One SSH key, only on the host | Logins from anywhere else |

### Network rule

The tunnel means the host has no open port for the connector, and the DNS record points at Cloudflare, not at the host. A WAF custom rule or Cloudflare Access then decides who may reach the hostname at all. For claude.ai, allow only Anthropic's published egress range `160.79.104.0/21`. For clients on your own machines, use Cloudflare Access service tokens or an allowlist of your IPs. Setup is in [deploy.md](deploy.md), step 7.

### Connector token

The token is a 24-byte random string, stored in `deploy/data/token` (or taken from `ORRERY_TOKEN`, which must be at least 32 characters). The agent compares it in constant time and never writes it to a log.

The endpoint accepts the token in the path (`/mcp/<token>`) or as `Authorization: Bearer <token>` on `POST /mcp`. A wrong token in the path returns 404, like any unknown path; a missing or wrong Bearer token on `/mcp` returns 401 with a `WWW-Authenticate: Bearer` header. A request that is not POST returns 405, and a body over 1 MiB returns 413. Only `/healthz` answers without a token.

The token in the path appears wherever full URLs are logged, for example in Cloudflare's request logs if you turn those on. Prefer the header form for every client that supports it.

### Tool approval in the client

Every tool carries MCP annotations: read-only tools have `readOnlyHint`, tools that delete data, stop machines or run arbitrary commands have `destructiveHint`. The tool reference in [architecture.md](architecture.md) marks them R, W and D.

Set your client to allow R tools without asking and to ask every time for W and D tools. In claude.ai this is per tool in the connector's settings. In Claude Code, add only R tools to the `permissions.allow` list (for example `mcp__orrery__list_servers`). Each generic API tool has a read-only twin (`aws_query`, `netcup_query`, `linode_query`, `gcp_query`, `aliyun_query`, `vultr_query`, `digitalocean_query`, `kamatera_query`) that the code limits to reads, so you can allow those safely.

Always ask for `run_command`, even for a harmless-looking `cat`. Nothing in the tool name tells you whether a command changes something.

### Name confirmation

Irreversible actions must repeat the target's name in an argument. A mismatch is refused before any API call.

| Tool | Argument | Accepted value |
| --- | --- | --- |
| `netcup_reinstall`, `netcup_revert_snapshot` | `confirmServerName` | The server's name, nickname or hostname |
| `aws_ec2_terminate` | `confirmName` | The instance id or its `Name` tag |
| `aws_lightsail_delete` | `confirmName` | The exact instance name |
| `linode_delete`, `linode_rebuild` | `confirmLabel` | The exact label |
| `gcp_delete` | `confirmName` | The exact instance name |
| `aliyun_delete` | `confirmName` | The instance name or id |
| `vultr_delete`, `vultr_reinstall` | `confirmLabel` | The exact label |
| `digitalocean_delete`, `digitalocean_rebuild` | `confirmName` | The exact Droplet name |
| `kamatera_delete` | `confirmName` | The exact server name |

The generic API tools refuse these operations and point to the dedicated tool, so the confirmation cannot be skipped.

## Protected machines

The protected set is the Orrery host (`ORRERY_SELF_IP`, written to `.env` by `enable-ssh.sh`) plus every IP in `ORRERY_PROTECTED_IPS` (comma separated, empty by default). Machines are matched by public IP. Protected machines can be started and read, never stopped, rebooted, reinstalled or deleted through the cloud tools.

If `ORRERY_SELF_IP` is not set, netcup refuses every stop, restart, rescue, reinstall and revert on every server, and every `netcup_api_request` change to a server or a firewall policy, because it cannot tell which server runs Orrery. The other providers have no such fallback: with an empty protected set, nothing is protected. Run `enable-ssh.sh`, and check that `.env` contains `ORRERY_SELF_IP`.

### Refused by the code

- **netcup:** `netcup_set_power` for anything except a plain start (`ON` without an option); `netcup_rescue_system`, `netcup_reinstall`, `netcup_revert_snapshot`; `netcup_api_request` with any non-GET request under `/api/v1/servers/<protected id>`; changing or deleting a firewall policy attached to an interface of a protected server (if the interfaces cannot be read, every policy change is refused).
- **AWS:** stop and reboot in `aws_ec2_power` and `aws_lightsail_power`; `aws_ec2_terminate`, `aws_lightsail_delete`; `aws_call` operations that are not reads and name the instance through `InstanceId`, `InstanceIds`, `instanceName`, `instanceNames` or an instance `resourceName` (starting and `CreateInstanceSnapshot` are allowed; `PutInstancePublicPorts`, `SetIpAddressType` and the like are refused); attaching, detaching or releasing a Lightsail static IP held by the instance.
- **Linode:** shutdown and reboot in `linode_power`; `linode_delete`, `linode_rebuild`; `linode_api_request` with any non-GET request under `/linode/instances/<protected id>` except `/boot`.
- **Google Cloud:** every `gcp_power` action except start and resume; `gcp_delete`; `gcp_api_request` with any non-GET request under `/projects/.../zones/.../instances/<protected>` except start and resume.
- **Alibaba Cloud:** stop and reboot in `aliyun_power`; `aliyun_delete`; `aliyun_call` ECS actions that are not reads and name the instance through `InstanceId`, `InstanceId.N` or `InstanceIds` (except `StartInstance` and `StartInstances`; `RunCommand` is refused too).
- **Vultr:** halt and reboot in `vultr_power`; `vultr_delete`, `vultr_reinstall`; `vultr_api_request` with any non-GET request under `/instances/<protected id>` except start, and bulk `POST /instances/halt` or `/instances/reboot` that list it in `instance_ids`.
- **DigitalOcean:** every `digitalocean_power` action except `power_on`; `digitalocean_delete`, `digitalocean_rebuild`; `digitalocean_api_request` changes to the Droplet itself (except `power_on`), bulk actions by a tag it carries, requests whose path contains its IP (reserved IPs), requests that name it in `droplet_id`, `droplet_ids` or tag `resources`, firewalls that cover it, and deleting a tag it carries.
- **Kamatera:** poweroff and reboot in `kamatera_power`; `kamatera_delete`; `kamatera_api_request` changes to it (rename, configure, network, disk, snapshot, tags, description, suspend, and the other per-server actions).

### Allowed on protected machines

Starting them, every read, and snapshots (`netcup_create_snapshot`, Lightsail `CreateInstanceSnapshot`).

### Not refused

- **`run_command` and `container_action` are never blocked.** On the Orrery host, `reboot`, a firewall change, `docker compose down` or stopping the `orrery` or `tunnel` container all run as asked, and cut off the assistant mid-call. Treat commands on the Orrery host with care, and keep approval on for both tools.
- netcup: `netcup_update_server` (hostname and nickname), `netcup_delete_snapshot`, `netcup_set_rdns`.
- Resources that are not addressed by an instance: AWS security groups, elastic IPs addressed by `AllocationId` or `AssociationId`, volumes; Linode `/networking/firewalls`; Vultr firewall groups and reserved IPs; Google Cloud firewall rules and project-wide metadata; Alibaba Cloud security groups.
- Stopped EC2 and Google Cloud instances have no public IP, so they cannot be matched to a protected IP.

## Refusals and redaction

Tool results go back to the model and into the conversation history. Orrery refuses calls that would return a secret, and redacts secrets inside ordinary answers.

| Provider | Refused | Redacted in answers |
| --- | --- | --- |
| AWS | `GetPasswordData`, `CreateKeyPair`, `ExportVerifiedAccessInstanceClientConfiguration`, `GetVpnConnectionDeviceSampleConfiguration`; Lightsail `GetInstanceAccessDetails`, `DownloadDefaultKeyPair`, `CreateKeyPair`, `GetRelationalDatabaseMasterUserPassword`, `CreateBucketAccessKey`, `CreateContainerServiceRegistryLogin`; `CreateReplaceRootVolumeTask` | `password`, `secretAccessKey`, `privateKey`, `certKey`, `KeyMaterial`, `PreSharedKey`, `ClientSecret` and similar fields |
| netcup | Reinstall, disk format and snapshot revert outside the dedicated tools | Every field whose name ends in `password` |
| Linode | New personal tokens, two-factor setup, Object Storage keys, OAuth client secrets, database credentials, LKE kubeconfigs, account cancellation | Nothing |
| Google Cloud | Instance and disk deletion through the generic tool | Nothing (Compute Engine answers carry no secrets) |
| Alibaba Cloud | `CreateKeyPair`, `DescribeInstanceVncUrl`, domain transfer-out and transfer codes, certificate private keys, billing changes | Nothing |
| Vultr | API key creation, Object Storage key regeneration, Kubernetes configs, inference API keys, OPTIONS requests | Passwords, keys, tokens, the `kvm` console URL |
| DigitalOcean | Kubeconfigs, registry credentials, Spaces keys, function keys, AI API keys, database metrics credentials, and more | Passwords, tokens, secrets, private keys, passwords in connection URIs |
| Kamatera | Setting the root password, console sessions | Passwords, including generated root passwords |

The `*_query` twins apply the same refusals and redaction. `run_command` output is never redacted: whatever a command prints reaches the chat.

Onboarding uses some secrets internally (the Lightsail temporary key, the netcup rescue password). They stay inside the Orrery process and never appear in a tool result or the audit log.

## Audit log

Every W and D call on the deployed connector (role `admin`) is appended to `deploy/data/audit.log`, one JSON line per call: time, tool, arguments, success or error, duration. Results are not logged. A short line also goes to the container log. Read-only tools are not logged.

Arguments whose name matches `pass`, `password`, `secret`, `token`, `private` or `customScript` are replaced with `[redacted]`. Everything else is logged as given, which includes:

- the full `command` of `run_command`,
- request bodies of the generic API tools, such as AWS `UserData` or Kamatera `script-file`.

**Never put a secret in a command or a request body.** Read it from a file on the target instead.

The local `hub` role writes no audit log.

## If a machine is compromised

**A monitored server.** It cannot reach the Orrery host or any cloud credential. SSH goes one way, from Orrery to the server; the server only holds Orrery's public key; Orrery does not forward an SSH agent; Lightsail instances get no AWS credentials. What an attacker on that server can do is feed Orrery false data, and write text into command output, logs, file names or the hostname that tries to instruct the assistant (prompt injection). Remove the server's key line or delete the server.

**The Orrery host.** Everything is lost: every cloud account Orrery has credentials for, the connector token, and root on every server that trusts the key. Rotate everything (below), starting with the cloud credentials. This is why the host must be a dedicated machine with key-only SSH and no other services.

## Prompt injection

Tool output is data, not instructions. Command output, container logs, file contents, server names, cloud resource tags and API answers can all contain text written by someone else. A good assistant treats them as data, but you are the last line of defence: keep approval on for every W and D tool and read what you approve.

## New server baseline

Apply this to every new server, and to the Orrery host itself.

### 1. Install Orrery's key at creation

Get the key with `ssh_public_key`. Then no onboarding is needed.

| Provider | How |
| --- | --- |
| EC2 | `ImportKeyPair`, then `KeyName` in `RunInstances` (or a cloud-init `authorized_keys` line in `UserData`) |
| Lightsail | `keyPairName` in `CreateInstances` (after `ImportKeyPair`), or `userData` |
| Linode | `authorized_keys` in `POST /linode/instances`. Set `root_pass` to a random value and run `passwd -l root` after the first login |
| Google Cloud | Metadata `ssh-keys` with `orrery:<public key>` in the create request. Google's images already refuse passwords |
| Alibaba Cloud | Import the key and pass `KeyPairName` in `RunInstances`, or onboard afterwards (automatic) |
| Vultr | `sshkey_id` in `POST /instances` (register the key with `POST /ssh-keys` first) |
| DigitalOcean | `ssh_keys` in `POST /droplets` (register the key with `POST /account/keys` first) |
| Kamatera | `script-file` in `POST /service/server` with `echo <public key> >> /root/.ssh/authorized_keys`, unquoted. Use `"password": "__generate__"`; the generated password is redacted |
| netcup | Servers are bought on the website. On a new, empty server, `netcup_reinstall` with `sshKeyIds` (register the key in the SCP account first: check `netcup_list_ssh_keys`, and add it through the ssh-keys endpoint found with `netcup_list_endpoints`) |

### 2. Allow keys only, with an automatic revert

First set up a revert, so a mistake undoes itself after two minutes. Redirect all output, or `run_command` waits for the background job:

```bash
nohup sh -c 'sleep 120; [ -f /run/orrery-keys-only-keep ] || { rm -f /etc/ssh/sshd_config.d/00-orrery-keys-only.conf; systemctl reload ssh; }' >/dev/null 2>&1 </dev/null &
```

Then write the drop-in, check the configuration and reload:

```bash
cat > /etc/ssh/sshd_config.d/00-orrery-keys-only.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
sshd -t && systemctl reload ssh
```

- sshd uses the first value it reads for each option, so the `Include /etc/ssh/sshd_config.d/*.conf` line must come before these options in `/etc/ssh/sshd_config`. Debian and Ubuntu put it at the top. Some provider images have no `Include` line at all: add it as the first line, back up `sshd_config` first, and make the revert restore the backup too.
- The service is `ssh` on Debian and Ubuntu and `sshd` on most other distributions.

From the Orrery host, open a **new** connection with Orrery's key and check that it works. Then check that passwords are refused:

```bash
ssh -i ~/orrery/deploy/data/keys/id_ed25519 root@203.0.113.30 true
ssh -o PubkeyAuthentication=no -o PreferredAuthentications=password root@203.0.113.30   # expect: Permission denied (publickey)
```

If both are right, keep the change:

```bash
touch /run/orrery-keys-only-keep
```

### 3. Open only the ports you need

In the cloud firewall, allow 22 and the ports your services use. Orrery needs 22 from the Orrery host's IP. You do not have to limit 22 to that IP: with key-only logins, an open port 22 is low risk, and some providers' browser-based SSH consoles connect over it from their own addresses. Note that ports published by Docker bypass a host firewall such as ufw.

### 4. Know your way back in

Write down how to reach each server without SSH: the provider's web console, rescue system or recovery mode.

### What the baseline does not cover

- The cloud accounts themselves. Turn on two-factor authentication everywhere: every provider, Cloudflare, GitHub and your AI client account.
- Other services a server exposes to the internet.
- The Orrery host's own security.
- Operating system vulnerabilities. Keep automatic security updates on (for example `unattended-upgrades`).

## Rotating secrets

### Connector token

```bash
cd ~/orrery/deploy
rm data/token && docker compose restart orrery
cat data/token
```

Update the token in every client. The old one stops working at once. If you set `ORRERY_TOKEN` in `deploy/.env` instead, change it there and run `docker compose up -d`.

### Cloud credentials

Each provider's section in [providers.md](providers.md) has a "Rotate or revoke" step. Revoke at the provider first, then install the new credential.

### Orrery's SSH key

1. Note the old public key: `cat data/keys/id_ed25519.pub`.
2. Delete the key and restart, which creates a new one: `rm -r data/keys && docker compose restart orrery`.
3. Run `bash enable-ssh.sh` again on the host, so it trusts the new key.
4. Onboard every server again with `ssh_bootstrap` (automatic on AWS, Google Cloud and Alibaba Cloud; paste the command on the others).
5. Remove the old key from every server. Match the whole key line, not the comment: old and new keys both end in `orrery`.
6. On Google Cloud, also remove the old `orrery:<old key>` line from each instance's `ssh-keys` metadata (or the project metadata, if you put it there). The guest agent installs keys from metadata, so a key removed only from `authorized_keys` comes back.

If the key leaked, do steps 5 and 6 first wherever you still can, because the old key works until it is removed.
