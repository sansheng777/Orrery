# Architecture

How Orrery works, its tools, discovery and onboarding, troubleshooting, configuration and code layout. Deployment is in [deploy.md](deploy.md), credentials in [providers.md](providers.md), the security model in [security.md](security.md).

## 1. Request path

```
AI client (claude.ai from Anthropic's 160.79.104.0/21; Claude Code, Codex, Cursor, Gemini CLI from your IP)
  |  https://orrery.example.com/mcp/<token>   or   POST /mcp with Authorization: Bearer <token>
  v
Cloudflare    WAF rule or Access blocks other sources; the tunnel delivers the rest (DNS is a CNAME to the tunnel)
  v
Orrery host   tunnel container (cloudflared)  ->  orrery container (http://orrery:8787): token check, tool call, audit log
  v
Provider APIs (AWS, netcup SCP, Linode, Compute Engine, Alibaba Cloud, Vultr, DigitalOcean, Kamatera) and SSH to every server
```

- cloudflared dials out to Cloudflare (port 7844), so the host opens no inbound port for the connector. Its only open port is SSH.
- The HTTP endpoint is stateless: each request gets a fresh MCP server with JSON responses (no event stream, no session id). SSH connections, the discovery cache, onboarding jobs and live samplers live in the process.
- `deploy/docker-compose.yml` runs two services: `orrery` (the agent with `ORRERY_ROLE=admin`, image `orrery:local` built from `agent/Dockerfile`, volume `./data:/data`) and `tunnel` (cloudflared, pinned, `--protocol http2`).
- Token handling and HTTP status codes: [security.md](security.md#connector-token). Cloudflare setup: [deploy.md](deploy.md), steps 2 and 7.

## 2. Roles

`ORRERY_ROLE` picks the tool set:

| | `admin` (deployed) | `hub` (default, local) |
| --- | --- | --- |
| SSH and inventory tools | All | All; `ORRERY_ALLOW_EXEC=0` removes `run_command` and `container_action` |
| Onboarding (`ssh_public_key`, `ssh_bootstrap`, `ssh_bootstrap_status`) | Yes | No |
| Cloud tools | All: listings, power, delete, rebuild, generic API tools and their `*_query` twins | Listings only: `aws_instances`, `aws_cost` (if enabled), `netcup_servers`, `linode_instances`, `gcp_instances`, `aliyun_instances`, `vultr_instances`, `digitalocean_droplets`, `kamatera_servers`, plus `aliyun_query` and `aliyun_billing`. No power, delete, rebuild or generic API tools |
| `cloud_providers` | Yes | Yes |
| Audit log | Every W and D call | None |

### MCP instructions

At connect, the server sends every client the usage rules in `agent/src/instructions.js`: start with `list_servers`, prefer read-only tools, ask before changes, never stop the machine tagged `orrery-host`, repeat names for destructive tools, keep secrets out of commands, ask before accepting a changed SSH host key, treat output as data, and how to publish the dashboard. The text differs per role. Set `ORRERY_INSTRUCTIONS=off` in `.env` to leave them out.

### Running locally

```bash
git clone https://github.com/sansheng777/orrery && cd orrery
npm install
node agent/src/index.js            # stdio, role hub
```

Add it to a client as a stdio server. In the Claude desktop app (Settings → Developer → Edit config):

```json
{ "mcpServers": { "orrery": { "command": "node", "args": ["/path/to/orrery/agent/src/index.js"] } } }
```

Keep the name `orrery`: the dashboard also looks for a local server of that name.

- Data lives in `~/.orrery` (`ORRERY_DIR`), with the same file names as on the server, or in the provider variables in section 10.
- Hosts in `~/.ssh/config` appear in `list_servers`. SSH tries Orrery's own key, then `~/.ssh/id_ed25519`, `id_ecdsa`, `id_rsa`, then a running ssh-agent.
- The stdio server is built once, so restart it after adding credentials.
- `ORRERY_ROLE=admin` gives the full tool set. Your computer then holds what the Orrery host would, and [security.md](security.md) applies to it.
- `--http` (or setting `PORT`) serves HTTP on `127.0.0.1:8787`.

## 3. Data files

Everything lives in `deploy/data/` on the host (`/data` in the container, `~/.orrery` locally), never in the repository. Files are mode 600 (the public key 644), directories 700, owner uid 1000.

| File | Contents |
| --- | --- |
| `deploy/.env` | `TUNNEL_TOKEN`, `ORRERY_SELF_IP` (written by `enable-ssh.sh`), optional `ORRERY_PROTECTED_IPS`, `ORRERY_GCP_SSH_USER`, `ORRERY_INSTRUCTIONS`, `ORRERY_TOKEN` |
| `token` | The connector token, created on first start |
| `aws.json`, `netcup.json`, `linode.json`, `gcp.json`, `aliyun.json`, `vultr.json`, `digitalocean.json`, `kamatera.json` | Cloud credentials ([providers.md](providers.md)). The agent rewrites `netcup.json` when netcup issues a new refresh token |
| `keys/id_ed25519`, `keys/id_ed25519.pub` | Orrery's SSH key (comment `orrery`), created on first start |
| `servers.json` | Servers added with `add_server`. **A password given to `add_server` is stored here in plain text.** Prefer keys |
| `discovered.json` | Per discovered server: login user found during onboarding, onboarding time, `ignore_server` flag |
| `labels.json` | Names, role tags and notes from `label_server` |
| `known_hosts.json` | Per server id: the fingerprints of its pinned SSH host keys ([security.md](security.md#ssh-host-keys)) |
| `audit.log` | One JSON line per change ([security.md](security.md#audit-log)) |

Written elsewhere: each server's `authorized_keys` (and `ssh-keys` metadata on Google Cloud); Lightsail's temporary SSH certificate in `/tmp/orrery-*/` inside the container, deleted after use; `/tmp/orrery-update.log` on the host after an update from a chat.

## 4. Tool reference

Kind: R read-only, W changes something without deleting data, D can delete data, stop machines or run commands (`destructiveHint`). A provider's tools appear only when its credentials are present. Which tools the local `hub` role has is in section 2. Name confirmation, protected machines, refusals and redaction are in [security.md](security.md).

### Servers (SSH)

| Tool | Kind | Notes |
| --- | --- | --- |
| `list_servers` | R | Every server: saved, from `~/.ssh/config`, and discovered. Includes labels, hidden machines, `exec` and `discoveryErrors`. Never returns passwords |
| `server_stats` | R | One SSH round trip: OS, kernel, CPU, load, memory, swap, disks, network totals, uptime, users, reboot required, pending updates, last login, login banner, Docker containers with CPU and memory, and the pinned SSH host key fingerprints (`hostKeys`) |
| `server_pulse` | R | Live figures, one sample a second. The first call starts a light sampler on the server; later calls answer from memory. It stops two minutes after the last call. `ids` up to 50 servers, `samples` up to 120 (default 10) |
| `container_logs` | R | Last lines of a container's log (default 200, at most 2000) |
| `run_command` | D | One shell command, no TTY. Timeout default 60 s, at most 300 s; output up to 512 KiB; command up to 8000 characters. Returns `output`, `exitCode`, `timedOut`, `truncated` and `cwd` (pass it back to continue there). A `cwd` that does not exist fails the call. A connection lost mid-command is an error |
| `container_action` | D | Start, stop or restart a container |
| `label_server` | W | Display name, role tags and a note. Changes nothing on the machine |
| `ignore_server` | W | Hide a discovered server, or bring it back |
| `add_server` | W | Save a server that is not discovered, or override a discovered one with the same IP (user, key, port). Without a password or `keyPath`, Orrery's key is used |
| `update_server` | W | Change a saved server |
| `remove_server` | D | Remove a saved server from the list. Does not touch the machine |
| `accept_host_key` | D | Pin the new SSH host key of a server that was reinstalled or replaced. `fingerprint` is the one in the refusal message |

Container names must match `^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`. Docker commands fall back to `sudo -n docker`. A refused SSH channel (sshd's `MaxSessions`, 10 by default) fails that call only, with a message that says so; the shared connection stays. A connection with a command still running is not closed as idle.

### Onboarding and overview

| Tool | Kind | Notes |
| --- | --- | --- |
| `ssh_public_key` | R | The public key every server must trust |
| `ssh_bootstrap` | D | Onboard a discovered server in the background (section 5). Returns a job |
| `ssh_bootstrap_status` | R | Progress of jobs. Jobs live in memory for 24 hours or until a restart |
| `cloud_providers` | R | The role, which providers are configured, why any failed, and their tools |

### Cloud providers

Each provider has a listing, power and delete tools, a generic API tool (D) and its read-only twin (R).

| Provider | R | D | Notes |
| --- | --- | --- | --- |
| AWS | `aws_instances`, `aws_cost`, `aws_query` | `aws_ec2_power`, `aws_ec2_terminate`, `aws_lightsail_power`, `aws_lightsail_delete`, `aws_call` | `aws_instances`: EC2 and Lightsail in every enabled region, with CloudWatch CPU for EC2. `aws_cost`: month-to-date cost by service, only with `"costExplorer": true`, cached 6 hours. `"lightsail": false` leaves out the Lightsail tools. `aws_call` takes any EC2 or Lightsail operation by API name; `aws_query` only `Describe*`, `Get*`, `List*` |
| netcup | `netcup_servers`, `netcup_get_server`, `netcup_list_snapshots`, `netcup_list_images`, `netcup_list_ssh_keys`, `netcup_list_tasks`, `netcup_get_task`, `netcup_list_endpoints`, `netcup_query` | `netcup_set_power`, `netcup_revert_snapshot`, `netcup_delete_snapshot`, `netcup_rescue_system`, `netcup_reinstall`, `netcup_api_request` | W: `netcup_update_server` (hostname, nickname), `netcup_create_snapshot` (online optional, not with UEFI), `netcup_set_rdns`, `netcup_cancel_task`. `netcup_set_power`: `ON`, `ON` + `POWERCYCLE` or `RESET`, `OFF` (ACPI), `OFF` + `POWEROFF`, `SUSPENDED`. `netcup_rescue_system` restarts the server. `netcup_reinstall` erases the disk and takes `sshKeyIds` |
| Linode | `linode_instances`, `linode_query` | `linode_power`, `linode_delete`, `linode_rebuild`, `linode_api_request` | Power: boot, shutdown, reboot. Generic tool: any API v4 endpoint, GET, POST, PUT, DELETE |
| Google Cloud | `gcp_instances`, `gcp_query` | `gcp_power`, `gcp_delete`, `gcp_api_request` | Power: start, stop, reset (hard), suspend, resume. Generic tool: any Compute Engine v1 path under `/projects/`. Google refuses deleting instances with deletion protection |
| Alibaba Cloud | `aliyun_instances`, `aliyun_billing`, `aliyun_query` | `aliyun_power`, `aliyun_delete`, `aliyun_call` | Services `ecs`, `vpc`, `alidns`, `domain`, `cdn`, `cas`, `bss` ([providers.md](providers.md#alibaba-cloud)). `aliyun_query`: `Describe*`, `Query*`, `Get*`, `List*`. `aliyun_billing`: balance and one month's bill by product. Power: `stoppedMode` `StopCharging` for pay-as-you-go. `aliyun_delete` releases pay-as-you-go instances only |
| Vultr | `vultr_instances`, `vultr_query` | `vultr_power`, `vultr_delete`, `vultr_reinstall`, `vultr_api_request` | Power: start, halt, reboot. `vultr_reinstall` keeps the IP and takes `osId`, `appId` or `imageId` to install something else |
| DigitalOcean | `digitalocean_droplets`, `digitalocean_query` | `digitalocean_power`, `digitalocean_delete`, `digitalocean_rebuild`, `digitalocean_api_request` | Power: power_on, shutdown, power_off, reboot, power_cycle |
| Kamatera | `kamatera_servers`, `kamatera_query` | `kamatera_power`, `kamatera_delete`, `kamatera_api_request` | `kamatera_servers` includes prices. Power: poweron, poweroff, reboot. `kamatera_delete` is forced, even when powered on. `kamatera_query`: any GET plus the read-only POSTs listed in [providers.md](providers.md#kamatera). Generic tool: GET or POST |

`netcup_api_request` and `netcup_query` accept only literal paths: no `?`, `%`, `#`, `.` or `..` segments (query parameters go in `query`). The only placeholder is `{userId}`, filled in automatically. Server ids are compared as numbers (`0501` is 501); firewall policy ids may not have leading zeros. The path must exist in netcup's current OpenAPI spec. The other generic tools take a query string in the path, but no percent-escapes, `{placeholders}`, dot or empty segments. DigitalOcean drops a leading `/v2`.

### Out of scope

- Other AWS services (S3, RDS, IAM), Google Cloud services other than Compute Engine, Alibaba Cloud products other than the seven listed. Account-level billing and IAM.
- Interactive programs (vim, top, less). Commands that never end (`tail -f`) run until the timeout.
- Cloudflare and GitHub: use their official MCP servers (Cloudflare's is `https://mcp.cloudflare.com/mcp`). Keeping Cloudflare separate lets you fix a broken tunnel or WAF rule from a chat. Changing Orrery's own tunnel, hostname or WAF rule through it cuts Orrery off.

## 5. Discovery and onboarding

### Discovery

`list_servers` lists every machine with a public IPv4 from every configured provider. The listing is cached for 60 seconds. Credentials are read on each listing and each onboarding, so a new credential file needs no restart.

Ids: `netcup:<server id>`, `ec2:<region>:<instance id>`, `lightsail:<region>:<name>`, `linode:<id>`, `gcp:<project>:<zone>:<name>`, `aliyun:<region>:<instance id>`, `vultr:<instance id>`, `digitalocean:<droplet id>`, `kamatera:<server id>`, `ssh:<alias>` for `~/.ssh/config`, and a random 8-character id for `add_server`.

- The Orrery host (the machine with `ORRERY_SELF_IP`) is listed first and tagged `orrery-host`, at any provider. A saved server with that IP, or one that overrides the discovered host, is tagged too.
- A saved server with the same IP as a discovered one wins. Use that to change the user, port or key.
- When a provider's API fails, or does not answer within 90 seconds, its machines from the last good answer stay listed and the other providers are not held up, and `discoveryErrors` reports the error with `usingListFrom`. netcup reads each server's details in a separate call; a failed call keeps that server's last record. These fallbacks are in memory only.
- `server_stats`, `server_pulse` and `run_command` use the last listing and refresh it in the background. A machine created a moment ago can come back as "Unknown server": call `list_servers` once.
- Stopped EC2 and Google Cloud instances have no public IP, so they leave the list until they start.
- A server that rejects Orrery's login is not tried again for 10 minutes, so polling cannot trip fail2ban. Onboarding or fixing the login clears the wait.

### Onboarding (once per server)

`ssh_bootstrap` makes a server trust Orrery's public key. It runs as a background job (follow it with `ssh_bootstrap_status`), does nothing if the key already works, and needs port 22 reachable from the Orrery host's IP. No provider needs a restart.

| Provider | How |
| --- | --- |
| EC2 | EC2 Instance Connect accepts a temporary key for 60 seconds; Orrery uses it to install its key. Tries `ubuntu`, `ec2-user`, `admin`, `debian` |
| Lightsail | Lightsail's temporary SSH certificate (`GetInstanceAccessDetails`), deleted after use. The user follows the blueprint |
| Google Cloud | Adds `orrery:<public key>` to the instance's `ssh-keys` metadata, keeping existing items. Google's guest agent creates the `orrery` user with sudo; Orrery waits up to a minute. Instances with OS Login are refused with the reason. `ORRERY_GCP_SSH_USER` changes the user |
| Alibaba Cloud | Cloud Assistant (on every public image) runs the install as root |
| netcup, Linode, Vultr, DigitalOcean, Kamatera | The job fails with one command in its `error`. Paste it as root in the provider's web console (netcup SCP, Linode Lish, Vultr View Console, DigitalOcean Droplet Console, Kamatera server console), then run `ssh_bootstrap` again to confirm. Pasting twice adds the key once. Servers created with the key need nothing ([security.md](security.md#new-server-baseline)) |
| Other machines | Paste the same command, or add the `ssh_public_key` output yourself, then `add_server` without a password or `keyPath` |
| The Orrery host | `enable-ssh.sh` |

netcup's automatic path through the rescue system is off by default (section 9). Even when enabled, it refuses the Orrery host, `ORRERY_PROTECTED_IPS`, and every server while `ORRERY_SELF_IP` is unset.

To move a hand-added server back to discovery, remove the saved entry and copy its name and note over with `label_server`.

### Asynchronous jobs at the providers

Follow progress with `netcup_get_task` or `netcup_list_tasks`, `linode_query /account/events`, `gcp_query /projects/{p}/zones/{z}/operations/{op}`, `aliyun_query` `ecs DescribeInstanceStatus` or `DescribeInvocationResults`, `digitalocean_query /actions/{id}`, and `kamatera_query /service/queue?id=<command id>`.

## 6. Dashboard

`dashboard/orrery.html` is a claude.ai Artifact. Its header comment explains how to publish it; [AGENTS.md](../AGENTS.md) lists the tools to declare. It looks for a connector named `Orrery`, then a local server named `orrery` in the Claude desktop app (`CANDIDATES` in the script).

- Servers grouped by provider with live figures, cloud views for the providers `cloud_providers` lists, a terminal (`run_command`) and container controls. The terminal and container actions are hidden when `list_servers` returns `exec: false`.
- Live figures: `server_pulse` once a second for every listed server while the page is visible, in batches of 50 servers per call.
- Full stats: a `server_stats` watch (refreshed at most every 30 seconds by the platform) for at most 40 servers, the selected one first. The rest are read with plain calls every two minutes, ten at a time.
- Stop and Restart are hidden for containers on the Orrery host.
- The terminal refuses interactive programs and follow modes (`tail -f`, `journalctl -f`, `docker logs -f`, `kubectl logs -f`, `dmesg -w`) and adds `-c 4` to a `ping` without a count. Its stop button only stops the page from waiting; the command runs on until it ends or times out.
- The page redraws every second, but leaves scrolling and copyable regions alone unless their content changes, and pauses while a pointer is pressed.

## 7. Troubleshooting

| Symptom | Fix |
| --- | --- |
| Every call returns Bad Gateway | The tunnel is down. Check it in Cloudflare and run `docker compose ps` and `docker compose logs --tail 30 tunnel`. If you just changed the host's firewall, undo it in the provider's web console |
| Bad Gateway right after an update from a chat | Expected. Wait one to two minutes |
| 403 from Cloudflare | The WAF rule or Access blocks the client. Local clients connect from your IP ([deploy.md](deploy.md), step 7) |
| 404 or 401 from the endpoint | Wrong or rotated token. Read `data/token` and update the client |
| A provider's tools are missing | `cloud_providers` shows the error. After fixing the file, open a new conversation: clients fix the tool list when a conversation starts |
| "Unknown server" for a new machine | Call `list_servers` once |
| "The SSH host key of ... changed" | The server presents another key than the pinned one. After a reinstall or replacement, accept it with `accept_host_key`; otherwise see [security.md](security.md#ssh-host-keys) |
| Lightsail onboarding: "a host key that Lightsail has not recorded" | The instance's host keys were regenerated. Clear AWS's record with `aws_call` (Lightsail `DeleteKnownHostKeys`), then onboard again |
| Login fails and will not be retried for 10 minutes | The server rejected Orrery's key. Onboard it, or fix the user, port or key with `add_server` |
| `enable-ssh.sh`: "No public IPv4 on this machine's interfaces" | 1:1 NAT cloud. Add `ORRERY_SELF_IP=<public IPv4>` to `deploy/.env` and run it again |
| `enable-ssh.sh`: "ORRERY_SELF_IP must be a plain IPv4 address" | Fix the value in `.env`. IPv6 is not accepted |
| A provider returns 401, `invalid_grant`, `InvalidAccessKeyId` or `SignatureDoesNotMatch` | The credential was revoked, expired or deleted. Replace it ([providers.md](providers.md)); for netcup, sign in again |
| Vultr or Kamatera: 401 or 403 with a valid key | The key's IP restriction does not include the Orrery host |
| AWS: `AccessDenied` or `UnauthorizedOperation`; Alibaba Cloud: `Forbidden.RAM` | Missing permission. EC2 onboarding needs `ec2-instance-connect:SendSSHPublicKey`. New Alibaba Cloud permissions take a while to apply |
| Google Cloud: 403 "has not been used" or "is disabled" | Enable the Compute Engine API in that project |
| Onboarding times out | A security group or cloud firewall blocks port 22 from the Orrery host. It looks like a key problem but is not |
| Google Cloud onboarding refused for OS Login | Set `enable-oslogin` to `FALSE` in the instance metadata, or add the key by hand |
| The client says `run_command` timed out | The client stopped waiting (about 60 s); the command may still run. Run long jobs in the background (section 9) |
| You cannot SSH into the Orrery host | Use the provider's web console |
| A secret leaked | [security.md](security.md#rotating-secrets) |

## 8. Operating from a chat

| Task | How |
| --- | --- |
| Check that all tools are there | `cloud_providers` |
| Reboot a machine (after the user agreed) | Inside it: `sudo -n setsid nohup sh -c 'sleep 2; systemctl reboot' >/dev/null 2>&1 < /dev/null &`. The call returns first. Then poll port 22 from the Orrery host (usually 30 to 60 seconds) |
| Test machines | Tag them `test` (label `test=true` on Google Cloud). Delete them when done, with any DNS records you made |
| Update Orrery | [deploy.md](deploy.md#updating-from-a-chat) |

## 9. Known pitfalls

- **netcup's firewall drops replies to outbound connections.** A policy that drops inbound traffic except some sources also drops replies to the host's own connections: tunnel, DNS, provider APIs. On the Orrery host the tunnel goes offline at once. If you must restrict inbound traffic there, also allow TCP and UDP from any source to ports 32768 to 60999. For this reason Orrery refuses to change firewall policies of protected netcup servers.
- **Changing the Orrery host's own network or firewall from a chat can lock the assistant out.** Open the provider's web console first.
- **netcup's rescue system is not safe to automate.** It can only be switched while the server is off. Switching is an asynchronous task that also powers the server on and off by itself, and a start sent before it finishes gets 409, as does the request that would undo it. A server can get stuck in rescue. Automatic onboarding through rescue needs `ORRERY_NETCUP_RESCUE=1`, which the compose file does not pass. Leave it off.
- **Pin base images.** `node:22-alpine` moved to an OpenSSH client (10.3p1) that crashes on certificate logins, which Lightsail onboarding uses. The image uses `node:22-bookworm-slim` (OpenSSH 9.2p1). cloudflared is pinned too.
- **`run_command` waits about 60 seconds at most.** Clients give up on a tool call after roughly a minute, whatever `timeoutSec` says. Run longer jobs in the background and poll their log in short calls (under 50 seconds each).
- **Detach background jobs completely.** `cd x && nohup cmd &` puts the whole chain in a background subshell that keeps the output open, so the call waits for the timeout. Write `cd x && (setsid nohup cmd > log 2>&1 < /dev/null &)`.
- **`pkill -f` kills its own shell**, whose command line contains the pattern. Use `pkill <name>` without `-f`, or look first with `pgrep -f`.
- **Alibaba Cloud images set `vm.swappiness` to 0** in `/etc/sysctl.d/99-apsara-sysctl.conf`. Use a file that sorts later, such as `99-zz-swappiness.conf`.
- **Alibaba Cloud's security center agent protects itself.** Root cannot remove it. Uninstall it from the console.
- **Hosts in mainland China may not reach GitHub release downloads.** Download on the Orrery host, check the checksum, and copy the file over: `ssh -i ~/orrery/deploy/data/keys/id_ed25519 root@203.0.113.30 'cat > /tmp/file' < file`.
- **Use HTTP/2 for cloudflared on Google Cloud VMs.** With QUIC some requests stalled for seconds. Orrery's tunnel already uses `--protocol http2`.
- **Google Cloud snapshot schedules leave orphan snapshots.** When a disk with a schedule is deleted, its last automatic snapshots stay and are billed. After deleting a machine, check `gcp_query /projects/{p}/global/snapshots`.
- **Do not hard-reset a brand-new VM.** On Google Cloud, `reset` in the first minute can leave empty SSH host keys, and sshd fails to start. Use `systemctl reboot`, or `stop` and `start`. To repair, add a `startup-script` that deletes the empty `/etc/ssh/ssh_host_*_key` files, runs `ssh-keygen -A` and restarts ssh, then `stop` and `start`. Read the serial console with `gcp_query /projects/{p}/zones/{z}/instances/{name}/serialPort?port=1&start=-6000`.
- **Kamatera key and create quirks.** The `ssh-key` field of `POST /service/server` rejects Orrery's ed25519 key with `400 General Error. (1)`. Put `echo <public key> >> /root/.ssh/authorized_keys` in `script-file` instead, **without quotes**: Kamatera keeps quotes literally and sshd then ignores the key. Pass `disk` and `network` as space-separated strings; arrays cause a 500. Some images have no `Include` line in `sshd_config` ([security.md](security.md#2-allow-keys-only-with-an-automatic-revert)).

## 10. Configuration reference

### Agent

| Variable | Default | Meaning |
| --- | --- | --- |
| `ORRERY_ROLE` | `hub` (compose sets `admin`) | Tool set (section 2) |
| `ORRERY_SELF_IP` | empty (`enable-ssh.sh` writes it) | The Orrery host's public IPv4. Protected. Trimmed and lowercased |
| `ORRERY_PROTECTED_IPS` | empty | More protected addresses, comma separated |
| `ORRERY_TOKEN` | not set | Replaces the `token` file. At least 32 characters |
| `ORRERY_INSTRUCTIONS` | `on` | `off` stops sending the MCP instructions |
| `ORRERY_GCP_SSH_USER` | `orrery` | User that onboarding creates on Google Cloud |
| `ORRERY_ALLOW_EXEC` | on | `0` removes `run_command` and `container_action` (hub role only) |
| `ORRERY_NETCUP_RESCUE` | off | `1` enables netcup onboarding through rescue. Leave it off. Not passed by compose |
| `ORRERY_DIR` | `~/.orrery` (`/data` in the image) | Data directory |
| `ORRERY_SSH_CONFIG` | `~/.ssh/config` | Extra host source for `list_servers` |
| `PORT` | 8787 | HTTP port. Setting it also switches to HTTP |
| `HOST` | `127.0.0.1` (`0.0.0.0` in the image) | HTTP listen address |
| `TUNNEL_TOKEN` | required | cloudflared's token. Every compose command fails without it |

The compose file passes the first six; other variables in `.env` have no effect until you add them to `docker-compose.yml`. `--http` serves HTTP instead of stdio.

### Provider variables (local use only)

The deployed container does not receive these. Use the files in `data/`.

| Provider | Variables |
| --- | --- |
| AWS | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` (override `aws.json`); `AWS_REGIONS` (comma separated); `AWS_LIGHTSAIL=0` leaves out Lightsail; `AWS_COST_EXPLORER=1` adds `aws_cost` |
| netcup | `NETCUP_REFRESH_TOKEN` (not written back when netcup rotates it); `NETCUP_USER_ID` if Orrery cannot find the SCP user id |
| Google Cloud | `GCP_PROJECTS` (comma separated; the key must still be in `gcp.json`) |
| Linode, Vultr, DigitalOcean, Kamatera | `LINODE_TOKEN`, `VULTR_API_KEY`, `DIGITALOCEAN_TOKEN`, `KAMATERA_API_CLIENT_ID` with `KAMATERA_API_SECRET` |
| Alibaba Cloud | None: only `aliyun.json` |

## 11. Code layout

| Path | Purpose |
| --- | --- |
| `agent/src/index.js`, `http.js` | Entry point (stdio, or HTTP with `--http` or `PORT`); token check, body limit, one MCP server per request |
| `agent/src/server.js`, `instructions.js` | Tools and MCP instructions per role |
| `agent/src/ssh.js`, `hostkeys.js`, `live.js` | SSH pool, stats script, command execution; pinned host keys; live samplers behind `server_pulse` |
| `agent/src/discovery.js`, `cloud.js` | Discovery, ids, labels, the `orrery-host` tag; provider loading and matching resources to servers by IP |
| `agent/src/bootstrap.js`, `keys.js` | `ssh_bootstrap` jobs per provider; Orrery's SSH key |
| `agent/src/inventory.js`, `audit.js` | `servers.json` and `~/.ssh/config`; audit log and redaction |
| `agent/Dockerfile` | The image, built from the repository root |
| `providers/<name>/index.js` | One module per provider: credentials, API client, discovery, tools, guards |
| `providers/shared.js` | What the modules share: protected IPs, the JSON request with one retry |
| `providers/netcup/admin.js`, `login.js` | netcup control tools; device login |
| `agent/test/`, `providers/<name>/test/` | Tests with fake SSH servers and recorded fixtures |
| `dashboard/orrery.html` | The claude.ai Artifact |
| `deploy/docker-compose.yml`, `deploy/enable-ssh.sh` | Services `orrery` and `tunnel`; one-time host setup |
| `.github/workflows/` | `test.yml` (Node 20 and 22), `release.yml` (image on version tags) |

The root `package.json` defines npm workspaces. Only `aws` has dependencies (AWS SDK v3); the others use `fetch`, and `gcp` and `aliyun` sign their own requests. `.dockerignore` lets only code into the image; `.gitignore` keeps credentials and runtime data out of the repository.

### Adding a provider

A module exports `id`, `name`, `loadConfig(env, dataDir)` and `register(server, ctx)`, which returns `{ id, name, configured, tools }`. Register listings for every role and control tools only when `ctx.admin` is true, wrapped in `ctx.adminTool` so they are audited. For discovery and onboarding, add it to `PROVIDERS` in `agent/src/cloud.js`, to the sources and id pattern in `agent/src/discovery.js`, and to `bootstrap.js`. Add its `COPY` lines to `agent/Dockerfile` and its test to the `test` script in `agent/package.json`. Follow the rules in [AGENTS.md](../AGENTS.md).

## 12. Tests and releases

```bash
npm install && npm test      # repository root; Node 20.6 or later
```

Unit tests use recorded API answers and fake SSH servers. They never touch a real account.

The SSH smoke test runs against a real machine when `SMOKE_HOST` and `SMOKE_USER` are set, and is skipped otherwise:

```bash
cd agent && SMOKE_HOST=203.0.113.30 SMOKE_USER=root SMOKE_KEY=~/.ssh/id_ed25519 npm test
```

Add `SMOKE_TRANSPORT=http` to go through the HTTP endpoint, `ORRERY_ALLOW_EXEC=0` for the read-only tool set, or `ORRERY_ROLE=admin` for the deployed role. `SMOKE_PORT` defaults to 22. The smoke test uses a fresh data directory and drops `AWS_*`, `NETCUP_*` and `LINODE_*` variables; unset `VULTR_API_KEY`, `DIGITALOCEAN_TOKEN` and the Kamatera variables yourself. Over HTTP it also checks that a wrong token gets 404 and that the token never appears in the log.

Pushing a tag `v1.2.3` runs the tests and publishes `ghcr.io/<owner>/orrery:1.2.3` and `:latest`. Pre-release tags such as `v1.2.3-rc.1` do not move `:latest`.
