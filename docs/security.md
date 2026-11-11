# Security model

Orrery gives an AI assistant control over every server you own. This page covers what protects that power, what does not, and what to do when something leaks. To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## What is at stake

The Orrery host holds credentials for every configured cloud account, the connector token, and one SSH private key that every monitored server trusts, usually as root. Whoever controls the host controls all of that. Run it on a dedicated VPS with key-only SSH and nothing else on it.

## Layers of protection

| Layer | Stops |
| --- | --- |
| Network rule at Cloudflare (WAF or Access) | Requests from outside your AI client's network ([deploy.md](deploy.md), step 7) |
| Connector token | Anyone without the URL or header, including other users of the same AI service (they share its IP range) |
| Tool approval in the client | Changes you did not agree to |
| Name confirmation | Irreversible actions on the wrong machine |
| Protected machines | Stopping, reinstalling or deleting the Orrery host and other machines you list |
| Refusals and redaction | Secrets landing in the chat |
| Audit log | Changes nobody can account for |
| One SSH key, only on the host | Logins from anywhere else |

## Connector token

The token is 24 random bytes in `deploy/data/token`, created on first start. `ORRERY_TOKEN` (at least 32 characters) replaces it. The agent compares it in constant time and never logs it.

| Request | Answer |
| --- | --- |
| `POST /mcp/<token>` | Served |
| `/mcp/<wrong token>` or any unknown path | 404 |
| `POST /mcp` with `Authorization: Bearer <token>` | Served |
| `/mcp` with a missing or wrong Bearer token | 401 with `WWW-Authenticate: Bearer realm="orrery"` |
| A valid token but not POST | 405 |
| A body over 1 MiB | 413, then the connection closes |
| `/healthz` | 200, no token needed |

A token in the path shows up wherever full URLs are logged, such as Cloudflare request logs. Use the header form in every client that supports it.

## Tool approval in the client

Every tool carries MCP annotations: `readOnlyHint` on reads, `destructiveHint` on tools that delete data, stop machines or run commands. The [tool reference](architecture.md#4-tool-reference) marks them R, W and D.

- Allow R tools without asking. Ask every time for W and D tools.
- Each generic API tool has a read-only `*_query` twin that the code limits to reads. You can allow those safely.
- Always ask for `run_command`, even for `cat`. The tool name does not tell you whether a command changes something.

In claude.ai, set this per tool in the connector's settings. In Claude Code, add only R tools to `permissions.allow` (for example `mcp__orrery__list_servers`).

## Name confirmation

Irreversible actions must repeat the target's name. A mismatch is refused before any change.

| Tool | Argument | Must equal |
| --- | --- | --- |
| `netcup_reinstall`, `netcup_revert_snapshot` | `confirmServerName` | The server's name, nickname or hostname |
| `aws_ec2_terminate` | `confirmName` | The `Name` tag; the instance id only when it has no `Name` tag |
| `aws_lightsail_delete` | `confirmName` | The instance name as Lightsail returns it |
| `linode_delete`, `linode_rebuild` | `confirmLabel` | The label |
| `gcp_delete` | `confirmName` | The instance name |
| `aliyun_delete` | `confirmName` | The instance name or id |
| `vultr_delete`, `vultr_reinstall` | `confirmLabel` | The label |
| `digitalocean_delete`, `digitalocean_rebuild` | `confirmName` | The Droplet name |
| `kamatera_delete` | `confirmName` | The server name |

The generic API tools refuse these operations and point to the dedicated tool, so the confirmation cannot be skipped.

## Protected machines

The protected set is `ORRERY_SELF_IP` (the Orrery host, written to `.env` by `enable-ssh.sh`) plus every address in `ORRERY_PROTECTED_IPS` (comma separated, empty by default). Both are trimmed and lowercased. A machine is protected when one of its public addresses is in the set. Protected machines can be started and read. The cloud tools refuse to stop, reboot, reinstall, delete or reconfigure them.

Without `ORRERY_SELF_IP`, only netcup fails closed: it refuses everything in its row below on every server, because it cannot tell which server runs Orrery. A value that is not an IPv4 address counts as unset for netcup. The other providers protect nothing when the set is empty. Check that `.env` contains `ORRERY_SELF_IP`.

### Refused by the code

| Provider | Refused on a protected machine | Matched by |
| --- | --- | --- |
| netcup | `netcup_set_power` except a plain start (`ON` without an option); `netcup_rescue_system`, `netcup_reinstall`, `netcup_revert_snapshot`; any non-GET `netcup_api_request` under `/api/v1/servers/<id>`; changing a firewall policy attached to one of its interfaces (every policy change is refused if the interfaces or MACs cannot be read); onboarding through the rescue system | `ORRERY_SELF_IP` as IPv4; `ORRERY_PROTECTED_IPS` as IPv4 exactly, or IPv6 when the address or prefix lies in one of the server's IPv6 prefixes |
| AWS | Stop and reboot in `aws_ec2_power`, `aws_lightsail_power`; `aws_ec2_terminate`, `aws_lightsail_delete`; every `aws_call` that is not a read, `StartInstance(s)` or `CreateInstanceSnapshot` and names the instance (`InstanceId(s)`, Lightsail `instanceName(s)`, or the `resourceName` of an instance), one of its network interfaces (`NetworkInterfaceId(s)`), an Elastic IP that is protected or attached to it (`AllocationId(s)`, `AssociationId(s)`, `PublicIp(s)`, `Address`), or a Lightsail static IP it holds (`AttachStaticIp`, `DetachStaticIp`, `ReleaseStaticIp`) | Public IPv4 and IPv6 of the instance and its interfaces |
| Linode | Shutdown and reboot in `linode_power`; `linode_delete`, `linode_rebuild`; any non-GET `linode_api_request` under `/linode/instances/<id>` except `/boot`; any request whose body `linode_id` (or `assignments[].linode_id`) names it, such as a clone or restore target; `POST /networking/ips/assign`, `/networking/ipv4/assign` and their `share` twins that move or share a protected address | IPv4 and IPv6 |
| Google Cloud | Every `gcp_power` action except start and resume; `gcp_delete`; any non-GET `gcp_api_request` under `/projects/.../zones/.../instances/<name>` except start and resume | External IPv4 and IPv6 |
| Alibaba Cloud | Stop and reboot in `aliyun_power`; `aliyun_delete`; every `aliyun_call` that is not a read or `StartInstance(s)`, in any service, and names the instance (`InstanceId`, `InstanceId.N`, `InstanceIds`; outside ECS only `i-...` ids), `RunCommand` included; every `vpc` call whose `AllocationId` is a protected elastic IP or one bound to a protected instance. The check runs in the region the request goes to (`RegionId`, else `region`): an id not found there, or a missing region, is refused | Public IPv4 or elastic IP |
| Vultr | Halt and reboot in `vultr_power`; `vultr_delete`, `vultr_reinstall`; every non-GET `vultr_api_request` that names the instance in the path (`/instances/<id>/...`, except `/start`) or in the body (`instance_id`, `instance_ids`), except bulk `POST /instances/start` and `POST /snapshots`; detaching or deleting block storage or a reserved IP attached to it, or a reserved IP that is itself protected | Main IPv4 and IPv6 |
| DigitalOcean | Every `digitalocean_power` action except `power_on`; `digitalocean_delete`, `digitalocean_rebuild`; `digitalocean_api_request` changes to the Droplet (except `power_on`), bulk actions on a tag it carries, paths that contain its IP (reserved IPs), bodies that name it (`droplet_id`, `droplet_ids`, tag `resources`), firewalls that cover it, deleting a tag it carries | IPv4 and IPv6 |
| Kamatera | Poweroff and reboot in `kamatera_power`; `kamatera_delete`; `kamatera_api_request` on a server action path (rename, configure, network, disk, snapshot, tags, description, suspend, hdlib and the other per-server actions) except poweron and resume. Action paths are matched case-insensitively and whatever the method, must name the server by `id` (never `name`, which Kamatera treats as a regular expression), and are refused by `kamatera_query` | Public IPs |

### Allowed on protected machines

- Starting them, and every read.
- Snapshots: `netcup_create_snapshot`, Lightsail `CreateInstanceSnapshot`, Vultr `POST /snapshots`.

### Not refused

- **`run_command` and `container_action`.** On the Orrery host, `reboot`, a firewall change, `docker compose down` or stopping the `orrery` or `tunnel` container run as asked and cut the assistant off mid-call. Keep approval on for both. The dashboard hides Stop and Restart for the Orrery host's containers, but the tool does not refuse them.
- netcup: `netcup_update_server` (hostname, nickname), `netcup_delete_snapshot`, `netcup_set_rdns`, `netcup_cancel_task`.
- Resources addressed by their own id rather than by an instance: AWS security groups and EBS volumes, Linode `/networking/firewalls`, Vultr firewall groups, Google Cloud firewall rules and project metadata, Alibaba Cloud security groups.
- Machines without a public IP: stopped EC2 and Google Cloud instances cannot be matched.

## Refusals and redaction

Tool results go back to the model and into the conversation history. The generic API tools refuse calls that would return a secret or erase data without a name confirmation, and redact secrets in ordinary answers. The `*_query` twins apply the same rules.

| Provider | Refused | Redacted in answers |
| --- | --- | --- |
| AWS | `TerminateInstances`, Lightsail `DeleteInstance` (dedicated tools); `GetPasswordData`, `CreateKeyPair`, `ExportVerifiedAccessInstanceClientConfiguration`, `GetVpnConnectionDeviceSampleConfiguration`, `GetConsoleOutput`, `GetConsoleScreenshot`, `CreateReplaceRootVolumeTask`; Lightsail `GetInstanceAccessDetails`, `DownloadDefaultKeyPair`, `CreateKeyPair`, `GetRelationalDatabaseMasterUserPassword`, `CreateBucketAccessKey`, `CreateContainerServiceRegistryLogin`; unknown operations | `password`, `passwordData`, `masterUserPassword`, `secretAccessKey`, `privateKey`, `privateKeyBase64`, `certKey`, `KeyMaterial`, `PreSharedKey`, `CustomerGatewayConfiguration`, `ClientSecret`, `UserData` |
| netcup | Reinstall, `user-image` install, disk format and snapshot revert (dedicated tools); paths that are not literal or not in netcup's current OpenAPI spec | Every field whose name ends in `password`, in server details, tasks and every generic tool answer |
| Linode | Deleting or rebuilding a Linode (dedicated tools); deleting a disk; restoring a backup with `overwrite`; cancelling the account; enabling two-factor authentication; new personal tokens, Object Storage keys, OAuth client secrets, child-account tokens, database credentials, LKE kubeconfigs | Nothing. Keep the token's scope narrow |
| Google Cloud | Deleting an instance (`gcp_delete`); deleting a disk; every change to an existing managed instance group (resize, delete or recreate members, patch, delete: they reach members without naming them); reading a group and creating one work, and so does `bulkInsert` | Nothing (Compute Engine answers carry no secrets) |
| Alibaba Cloud | `DeleteInstance(s)` (`aliyun_delete`); `ModifyInstanceAutoReleaseTime`, `ReplaceSystemDisk`, `ResetDisk(s)`, `ReInitDisk`, `DeleteDisk`; `CreateKeyPair`, `DescribeInstanceVncUrl`, `StartTerminalSession`; domain transfer-out, transfer lock changes and transfer codes; certificate private keys; every billing (`bss`) change | CDN URL-signing keys (`auth_key*`), any string holding a private key |
| Vultr | Deleting or reinstalling an instance, also by `PATCH /instances/<id>` with `os_id`, `app_id` or `image_id` (use `vultr_reinstall` with `osId`, `appId` or `imageId`); restoring over an instance or bare-metal server; deleting or reinstalling bare metal (also by `PATCH` with a new image); creating API keys; regenerating Object Storage keys; Kubernetes configs; inference API keys; the OPTIONS method | `kvm` console URL, `default_password`, `password`, `api_key`, `access_key`, S3 keys, `secret`, `secret_key`, `private_key`, kubeconfigs, `token`, any string holding a private key |
| DigitalOcean | Deleting or rebuilding a Droplet (dedicated tools); deleting by tag; destroying with associated resources; restoring a backup; kubeconfigs, registry credentials, Spaces keys, secrets, Functions keys, inference and AI API keys, database metrics credentials, and other credential endpoints | Passwords, tokens, secrets, private keys, kubeconfigs, access keys, passwords inside connection URIs, the Functions namespace `key` |
| Kamatera | Terminating (`kamatera_delete`); reverting a snapshot; `/service/server/password`, `/ssh`, `/sshkey` | `password`, `passwordValidate`, `generated_password`, `secret`, `token`, `private_key`, including the password Kamatera generates for `"password": "__generate__"` |

`run_command` output is never redacted: whatever a command prints reaches the chat.

Onboarding uses some secrets internally (the Lightsail temporary key, the netcup rescue password). They stay inside the Orrery process and never reach a tool result or the audit log.

## Audit log

Every W and D call on the deployed connector (role `admin`) is appended to `deploy/data/audit.log`: one JSON line with time, tool, arguments, success or error, and duration. Results are not logged. A short line also goes to the container log. Reads and the local `hub` role are not logged.

These are replaced with `[redacted]`:

- every argument whose name contains `pass`, `secret`, `token`, `private` or `customScript`,
- the value of a key/value pair whose key contains one of those words: `{Key, Value}` (AWS tags), `{key, value}` (metadata items), `{name, value}` (environment entries).

Everything else is logged as given, including the full `command` of `run_command` and request bodies such as AWS `UserData` or Kamatera `script-file`. **Never put a secret in a command or a request body.** Read it from a file on the target instead.

## If a machine is compromised

**A monitored server.** It cannot reach the Orrery host or a cloud credential. SSH goes one way, from Orrery to the server; the server holds only Orrery's public key; Orrery forwards no SSH agent; Lightsail instances get no AWS credentials. An attacker there can feed Orrery false data, or write text into output, logs, file names or the hostname that tries to instruct the assistant. Remove Orrery's key from the server, or delete the server.

**The Orrery host.** Everything is lost: every cloud account, the connector token, and root on every server that trusts the key. Rotate everything (below), starting with the cloud credentials.

## Known gap: SSH host keys

Orrery does not verify SSH host keys yet. It trusts whatever key a server presents. Someone who can intercept traffic to a server's IP, or who takes over a released IP, could impersonate that server and see the commands Orrery sends it, and the password of a server saved with password login. Prefer key login for saved servers and watch IPs you release. Pinning host keys on first use is planned.

## Prompt injection

Command output, container logs, file contents, server names, tags and API answers can contain text written by someone else. Orrery tells assistants to treat them as data, but you are the last line of defence: keep approval on for W and D tools and read what you approve.

## New server baseline

Apply this to every new server, and to the Orrery host.

### 1. Install Orrery's key at creation

Get the key with `ssh_public_key`. A server created with it needs no onboarding.

| Provider | How |
| --- | --- |
| EC2 | `ImportKeyPair`, then `KeyName` in `RunInstances`, or an `authorized_keys` line in cloud-init `UserData` |
| Lightsail | `keyPairName` in `CreateInstances` (after `ImportKeyPair`), or `userData` |
| Linode | `authorized_keys` in `POST /linode/instances`. Set a random `root_pass` and run `passwd -l root` after the first login |
| Google Cloud | Metadata `ssh-keys` with `orrery:<public key>`. Google's images already refuse passwords |
| Alibaba Cloud | Import the key and pass `KeyPairName` in `RunInstances`, or onboard afterwards (automatic) |
| Vultr | `sshkey_id` in `POST /instances` (register the key with `POST /ssh-keys` first) |
| DigitalOcean | `ssh_keys` in `POST /droplets` (register the key with `POST /account/keys` first) |
| Kamatera | `script-file` in `POST /service/server` with `echo <public key> >> /root/.ssh/authorized_keys`, unquoted, and `"password": "__generate__"` (see [pitfalls](architecture.md#9-known-pitfalls)) |
| netcup | Servers are bought on the website. On a new, empty server, `netcup_reinstall` with `sshKeyIds`. Register the key in the SCP account first (`netcup_list_ssh_keys`; the endpoint is in `netcup_list_endpoints`) |

### 2. Allow keys only, with an automatic revert

1. Set up a revert that undoes the change after two minutes. Redirect all output, or `run_command` waits for the background job:

   ```bash
   nohup sh -c 'sleep 120; [ -f /run/orrery-keys-only-keep ] || { rm -f /etc/ssh/sshd_config.d/00-orrery-keys-only.conf; systemctl reload ssh; }' >/dev/null 2>&1 </dev/null &
   ```

2. Write the drop-in, check it and reload:

   ```bash
   cat > /etc/ssh/sshd_config.d/00-orrery-keys-only.conf <<'EOF'
   PasswordAuthentication no
   KbdInteractiveAuthentication no
   PermitRootLogin prohibit-password
   EOF
   sshd -t && systemctl reload ssh
   ```

   sshd uses the first value it reads, so `Include /etc/ssh/sshd_config.d/*.conf` must come before these options in `/etc/ssh/sshd_config`. Debian and Ubuntu put it at the top. If an image has no `Include` line, back up `sshd_config`, add the line at the top, and make the revert restore the backup. The service is `ssh` on Debian and Ubuntu, `sshd` on most other distributions.

3. From the Orrery host, open a **new** connection with Orrery's key, then check that passwords are refused:

   ```bash
   ssh -i ~/orrery/deploy/data/keys/id_ed25519 root@203.0.113.30 true
   ssh -o PubkeyAuthentication=no -o PreferredAuthentications=password root@203.0.113.30   # expect: Permission denied (publickey)
   ```

4. If both are right, keep the change: `touch /run/orrery-keys-only-keep`.

### 3. Open only the ports you need

In the cloud firewall, allow 22 and your services' ports. Orrery needs 22 from the Orrery host's IP. With key-only logins an open port 22 is low risk, and some providers' browser SSH consoles need it. Ports published by Docker bypass host firewalls such as ufw.

### 4. Know your way back in

Note how to reach each server without SSH: the provider's web console, rescue system or recovery mode.

The baseline does not cover the cloud accounts themselves (turn on two-factor authentication at every provider, Cloudflare, GitHub and your AI client), other exposed services, or OS updates (keep `unattended-upgrades` or similar on).

## Rotating secrets

### Connector token

```bash
cd ~/orrery/deploy
rm data/token && docker compose restart orrery
cat data/token
```

The old token stops working at once. Update every client. If you use `ORRERY_TOKEN` in `deploy/.env`, change it there and run `docker compose up -d`.

**Cloud credentials:** follow the provider's "Rotate or revoke" step in [providers.md](providers.md). Revoke at the provider first.

### Orrery's SSH key

1. Note the old public key: `cat data/keys/id_ed25519.pub`.
2. Delete the key and restart, which creates a new one: `rm -r data/keys && docker compose restart orrery`.
3. Run `bash enable-ssh.sh` again, so the host trusts the new key.
4. Onboard every server again with `ssh_bootstrap`.
5. Remove the old key line from every server. Match the whole line: old and new keys both end in `orrery`.
6. On Google Cloud, also remove `orrery:<old key>` from each instance's (or the project's) `ssh-keys` metadata. The guest agent reinstalls keys from metadata.

If the key leaked, do steps 5 and 6 first wherever you can: the old key works until it is removed.
