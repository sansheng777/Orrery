# Architecture

How Orrery works, what every tool does, how discovery and onboarding work per provider, what goes wrong and how to fix it, and how the code is laid out. Deployment is in [deploy.md](deploy.md), credentials in [providers.md](providers.md), the security model in [security.md](security.md).

## 1. Request path

```
You (claude.ai web, desktop or mobile app; or Claude Code, Codex, Cursor, Gemini CLI on your machine)
  |
  v
AI client  (claude.ai requests leave Anthropic from 160.79.104.0/21; local clients from your own IP)
  |   https://orrery.example.com/mcp/<token>   or   POST /mcp with Authorization: Bearer <token>
  v
Cloudflare   1. WAF rule or Access: everything else is blocked
             2. Tunnel: delivered to the Orrery host (DNS only has a CNAME to the tunnel)
  v
Orrery host  tunnel container (cloudflared)  ->  orrery container (http://orrery:8787)
             3. Token check: a wrong token gets 404
             4. Tool call: cloud API request or SSH command; changes go to the audit log
  v
AWS (every region)   netcup SCP API   Linode API v4   Compute Engine API v1
Alibaba Cloud OpenAPI (ECS, VPC, DNS, domains, CDN, certificates, billing)
Vultr API v2   DigitalOcean API v2   Kamatera cloudcli API   SSH to every server
```

cloudflared dials out to Cloudflare (port 7844), so the host opens no inbound port for the connector. Its only open port is SSH.

The HTTP endpoint is stateless. Each request gets a fresh MCP server instance with JSON responses (no server-sent event stream, no session id). What must outlive a request lives in the process: SSH connections, the discovery cache, onboarding jobs and the live samplers.

## 2. Components

| Component | Where | Notes |
| --- | --- | --- |
| Connector | Your AI client's settings | Named `Orrery` in claude.ai, URL `https://orrery.example.com/mcp/<token>` |
| WAF rule or Access app, tunnel, DNS record | Cloudflare | See [deploy.md](deploy.md), steps 2 and 7 |
| Orrery host | A dedicated small VPS | Code in `~/orrery`, deployment in `~/orrery/deploy` |
| `orrery` container | Orrery host | The agent with `ORRERY_ROLE=admin`. Image `orrery:local`, built from `agent/Dockerfile`, data volume `./data:/data` |
| `tunnel` container | Orrery host | cloudflared, pinned version, with `TUNNEL_TOKEN` from `.env` and `--protocol http2` |
| Dashboard | A claude.ai Artifact | `dashboard/orrery.html`, calls the same connector |

### Roles

The agent has two roles, chosen with `ORRERY_ROLE`.

| | `admin` | `hub` (default) |
| --- | --- | --- |
| Intended use | The deployed connector | A local agent on your computer, over stdio |
| SSH tools | All, including `run_command` and `container_action` | All; `run_command` and `container_action` can be turned off with `ORRERY_ALLOW_EXEC=0` |
| Onboarding (`ssh_public_key`, `ssh_bootstrap`) | Yes | No |
| Cloud tools | Everything: lists, control tools, generic API tools and their read-only twins | Lists only: the `*_instances` style tools, plus `aws_cost`, `aliyun_query` and `aliyun_billing` |
| Audit log | Every W and D call | None |

### Running locally

```bash
git clone https://github.com/sansheng777/orrery orrery && cd orrery
npm install
node agent/src/index.js            # stdio, role hub
```

Add it to an MCP client as a stdio server. For the Claude desktop app, in Settings → Developer → Edit config:

```json
{ "mcpServers": { "orrery": { "command": "node", "args": ["/path/to/orrery/agent/src/index.js"] } } }
```

The dashboard also looks for a local server named `orrery` in the Claude desktop app, so keep that name.

Locally, the data directory is `~/.orrery` (`ORRERY_DIR`). Credential files go there with the same names as on the server, or you can use the provider environment variables listed in section 10. Hosts in `~/.ssh/config` appear in `list_servers` too, and SSH tries Orrery's own key, then `~/.ssh/id_ed25519`, `id_ecdsa`, `id_rsa`, then a running ssh-agent.

`ORRERY_ROLE=admin node agent/src/index.js` gives the full tool set over stdio. Your computer then holds everything the Orrery host would, so the warnings in [security.md](security.md) apply to it.

`node agent/src/index.js --http` (or setting `PORT`) serves HTTP instead, on `127.0.0.1:8787` by default.

## 3. Data files

Everything lives in `deploy/data/` on the host (`/data` in the container, `~/.orrery` locally). None of it is in the repository. Files are mode 600 (the public key 644), directories 700, owner uid 1000.

| File | Contents |
| --- | --- |
| `deploy/.env` | `TUNNEL_TOKEN`, `ORRERY_SELF_IP` (written by `enable-ssh.sh`), optional `ORRERY_PROTECTED_IPS` and `ORRERY_GCP_SSH_USER` |
| `token` | The connector token, created on first start. `ORRERY_TOKEN` (at least 32 characters) replaces it if set |
| `aws.json`, `netcup.json`, `linode.json`, `gcp.json`, `aliyun.json`, `vultr.json`, `digitalocean.json`, `kamatera.json` | Cloud credentials, see [providers.md](providers.md). The agent rewrites `netcup.json` when netcup issues a new refresh token |
| `keys/id_ed25519`, `keys/id_ed25519.pub` | Orrery's SSH key (comment `orrery`), created on first start. Every monitored server trusts it |
| `servers.json` | Servers added with `add_server`. **A password given to `add_server` is stored here in plain text.** Prefer keys |
| `discovered.json` | Per discovered server: the login user found during onboarding, when it was onboarded, and the `ignore_server` flag |
| `labels.json` | Display names, role tags and notes from `label_server` |
| `audit.log` | One JSON line per change, see [security.md](security.md) |

Written elsewhere:

- Each server's `authorized_keys` (onboarding appends Orrery's public key). On Google Cloud, the instance's `ssh-keys` metadata gets `orrery:<public key>`.
- `/tmp/orrery-*/` inside the container: Lightsail's temporary SSH certificate during onboarding, deleted right after.
- `/tmp/orrery-update.log` on the host, if you update from a chat (see [deploy.md](deploy.md)).

## 4. Tool reference

R is read-only, W changes something without deleting data, D can delete data, stop machines or run arbitrary commands (it carries `destructiveHint`). "Hub" marks the tools the local `hub` role also offers. A provider's tools only appear when its credentials are present.

### Servers (SSH)

| Tool | Kind | Hub | Notes |
| --- | --- | --- | --- |
| `list_servers` | R | Yes | Every server: added by hand, from `~/.ssh/config`, and discovered. Includes labels, hidden machines and discovery errors. Never returns passwords |
| `server_stats` | R | Yes | One SSH round trip: OS, kernel, CPU, load, memory, swap, disks, network totals, uptime, logged-in users, reboot required, pending updates, last login, login banner, Docker containers with CPU and memory |
| `server_pulse` | R | Yes | Live figures, one sample a second. The first call on a server starts a light sampler there; later calls answer from memory. Stops two minutes after the last call. `ids` reads up to 50 servers at once; `samples` up to 120 |
| `container_logs` | R | Yes | Last lines of a container's log (default 200, at most 2000) |
| `run_command` | D | Yes* | Runs one shell command, no TTY. Default timeout 60 s, at most 300 s, output up to 512 KiB, command up to 8000 characters. Returns output, exit code (`null` on timeout) and the directory it ended in; pass that back as `cwd` to continue there |
| `container_action` | D | Yes* | Start, stop or restart a container |
| `label_server` | W | Yes | Display name, role tags and a note, for any server. Changes nothing on the machine |
| `ignore_server` | W | Yes | Hide a discovered server, or bring it back |
| `add_server` | W | Yes | Save a server that is not discovered, or override a discovered one with the same IP (other user, key or port). Without a password or `keyPath`, Orrery's own key is used |
| `update_server` | W | Yes | Change a saved server (not discovered ones) |
| `remove_server` | D | Yes | Remove a saved server from the list. Does not touch the machine |

\* Left out when `ORRERY_ALLOW_EXEC=0` (hub role only).

Container names must match `^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`. Docker commands fall back to `sudo -n docker` when the login user cannot reach Docker directly.

### Onboarding and overview

| Tool | Kind | Hub | Notes |
| --- | --- | --- | --- |
| `ssh_public_key` | R | No | The public key every server must trust. Install it when you create a server and onboarding is not needed |
| `ssh_bootstrap` | D | No | Onboard a discovered server in the background (section 5). Returns a job |
| `ssh_bootstrap_status` | R | No | Progress of onboarding jobs. Jobs live in memory and are gone after 24 hours or a restart |
| `cloud_providers` | R | Yes | Which providers are configured, why any failed, and their tools |

### AWS

| Tool | Kind | Hub | Notes |
| --- | --- | --- | --- |
| `aws_instances` | R | Yes | EC2 and Lightsail instances in every enabled region, with recent CloudWatch CPU for EC2 |
| `aws_cost` | R | Yes | Month-to-date cost by service. Only with `"costExplorer": true`; cached 6 hours |
| `aws_ec2_power` | D | | start, stop (optionally forced) or reboot |
| `aws_ec2_terminate` | D | | Needs `confirmName` (instance id or Name tag) |
| `aws_lightsail_power` | D | | start, stop or reboot. Not registered with `"lightsail": false` |
| `aws_lightsail_delete` | D | | Needs `confirmName` (exact name) |
| `aws_call` | D | | Any EC2 or Lightsail operation by API name, with its request object. Refuses termination and deletion (use the tools above), operations that return secrets, `CreateReplaceRootVolumeTask` and unknown operations. Redacts secrets |
| `aws_query` | R | | Read-only twin: only `Describe*`, `Get*` and `List*`, with the same refusals and redaction |

### netcup

| Tool | Kind | Hub | Notes |
| --- | --- | --- | --- |
| `netcup_servers` | R | Yes | Servers with live state, location, CPU, memory, uptime and IPs |
| `netcup_get_server` | R | | Full details including interfaces, disks and boot order |
| `netcup_list_snapshots`, `netcup_list_images`, `netcup_list_ssh_keys` | R | | Snapshots; installable images; SSH keys stored in the SCP account |
| `netcup_list_tasks`, `netcup_get_task` | R | | Asynchronous tasks and their progress |
| `netcup_list_endpoints` | R | | Every endpoint in netcup's current OpenAPI spec, filterable |
| `netcup_query` | R | | Read-only twin of `netcup_api_request`: GET only |
| `netcup_update_server` | W | | Hostname and nickname |
| `netcup_create_snapshot` | W | | Optionally online (not with UEFI) |
| `netcup_set_rdns` | W | | Reverse DNS for an IPv4 or IPv6 address |
| `netcup_cancel_task` | W | | Cancel a running task |
| `netcup_set_power` | D | | `ON`, `ON` with `POWERCYCLE` or `RESET` (hard restart), `OFF` (ACPI), `OFF` with `POWEROFF`, `SUSPENDED` |
| `netcup_revert_snapshot` | D | | Needs `confirmServerName` |
| `netcup_delete_snapshot` | D | | |
| `netcup_rescue_system` | D | | Rescue system on or off; the server restarts |
| `netcup_reinstall` | D | | Needs `confirmServerName`. Erases the disk. Takes `sshKeyIds` |
| `netcup_api_request` | D | | Any endpoint in netcup's current OpenAPI spec |

`netcup_api_request` and `netcup_query` accept only literal paths: no `?`, `%`, `#`, `.` or `..` segments (query parameters go in `query`). The only placeholder is `{userId}`, filled in automatically. Server ids are compared as numbers (`0501` is 501), and firewall policy ids may not have leading zeros. The path must exist in netcup's current spec. Reinstall, snapshot revert, disk format and `user-image` installs are refused here; use the dedicated tools.

### Linode

| Tool | Kind | Hub | Notes |
| --- | --- | --- | --- |
| `linode_instances` | R | Yes | Instances in every region |
| `linode_query` | R | | Any GET, with the same secret refusals |
| `linode_power` | D | | boot, shutdown or reboot |
| `linode_delete` | D | | Needs `confirmLabel` |
| `linode_rebuild` | D | | Needs `confirmLabel`. Erases the disks |
| `linode_api_request` | D | | Any Linode API v4 endpoint (GET, POST, PUT, DELETE). Refusals in [providers.md](providers.md). Results are not redacted |

### Google Cloud

| Tool | Kind | Hub | Notes |
| --- | --- | --- | --- |
| `gcp_instances` | R | Yes | Instances in every zone of the configured projects |
| `gcp_query` | R | | Any Compute Engine GET under `/projects/` |
| `gcp_power` | D | | start, stop, reset (hard), suspend, resume |
| `gcp_delete` | D | | Needs `confirmName`. Google itself refuses instances with deletion protection |
| `gcp_api_request` | D | | Any Compute Engine v1 endpoint under `/projects/`, literal paths only. Refuses instance deletion (use `gcp_delete`) and disk deletion |

### Alibaba Cloud

| Tool | Kind | Hub | Notes |
| --- | --- | --- | --- |
| `aliyun_instances` | R | Yes | ECS instances in every region |
| `aliyun_billing` | R | Yes | Balance and one month's bill by product, including outstanding amounts |
| `aliyun_query` | R | Yes | Any `Describe*`, `Query*`, `Get*` or `List*` action of `ecs`, `vpc`, `alidns`, `domain`, `cdn`, `cas`, `bss` |
| `aliyun_power` | D | | start, stop or reboot; `stoppedMode` `StopCharging` for pay-as-you-go |
| `aliyun_delete` | D | | Release a pay-as-you-go instance. Needs `confirmName` (name or id) |
| `aliyun_call` | D | | Any action of the same services, except billing changes. Refusals in [providers.md](providers.md) |

### Vultr

| Tool | Kind | Hub | Notes |
| --- | --- | --- | --- |
| `vultr_instances` | R | Yes | Instances in every region |
| `vultr_query` | R | | Any GET, with the same refusals and redaction |
| `vultr_power` | D | | start, halt or reboot |
| `vultr_delete` | D | | Needs `confirmLabel` |
| `vultr_reinstall` | D | | Needs `confirmLabel`. Erases the disk, keeps the IP |
| `vultr_api_request` | D | | Any Vultr API v2 endpoint. Redacts passwords, keys and the `kvm` console URL |

### DigitalOcean

| Tool | Kind | Hub | Notes |
| --- | --- | --- | --- |
| `digitalocean_droplets` | R | Yes | Droplets in every region |
| `digitalocean_query` | R | | Any GET, with the same refusals and redaction |
| `digitalocean_power` | D | | power_on, shutdown, power_off, reboot, power_cycle |
| `digitalocean_delete` | D | | Needs `confirmName` |
| `digitalocean_rebuild` | D | | Needs `confirmName`. Erases the disk |
| `digitalocean_api_request` | D | | Any DigitalOcean API v2 endpoint. Redacts passwords, tokens and keys |

### Kamatera

| Tool | Kind | Hub | Notes |
| --- | --- | --- | --- |
| `kamatera_servers` | R | Yes | Servers in every datacenter, with prices |
| `kamatera_query` | R | | Any GET, plus the read-only POSTs (server info, images, history, statistics, traffic report) |
| `kamatera_power` | D | | poweron, poweroff or reboot |
| `kamatera_delete` | D | | Needs `confirmName`. Forced, even when powered on |
| `kamatera_api_request` | D | | Any cloudcli endpoint (GET or POST), including creating servers. Redacts passwords |

### What Orrery does not do

- Other AWS services (S3, RDS, IAM and so on); Google Cloud services other than Compute Engine, and anything at the account level (billing, IAM); Alibaba Cloud products other than the seven listed services. Alibaba Cloud billing is read-only.
- Interactive programs (vim, top, less). Commands that never end on their own (`tail -f`, `journalctl -f`) run until the timeout.
- Formatting netcup disks, cancelling a Linode account, replacing an EC2 root volume: refused on purpose.
- Cloudflare and GitHub. Use their official MCP servers (Cloudflare runs one at `https://mcp.cloudflare.com/mcp`). Keeping Cloudflare separate has a benefit: when the tunnel or the WAF rule breaks Orrery, you can still fix them from a chat. The reverse also holds: changing Orrery's tunnel, hostname or WAF rule through the Cloudflare connector cuts Orrery off.

## 5. Discovery and onboarding

### Discovery

`list_servers` lists every machine with a public IPv4 from every configured provider. The listing is cached for 60 seconds. Ids:

| Source | Id |
| --- | --- |
| netcup | `netcup:<server id>` |
| EC2 | `ec2:<region>:<instance id>` |
| Lightsail | `lightsail:<region>:<name>` |
| Linode | `linode:<id>` |
| Google Cloud | `gcp:<project>:<zone>:<name>` |
| Alibaba Cloud | `aliyun:<region>:<instance id>` |
| Vultr | `vultr:<instance id>` |
| DigitalOcean | `digitalocean:<droplet id>` |
| Kamatera | `kamatera:<server id>` |
| `~/.ssh/config` | `ssh:<alias>` |
| `add_server` | A random 8-character id |

- The Orrery host (the machine with `ORRERY_SELF_IP`) is listed first and tagged `orrery-host`, whichever configured provider it runs at.
- A saved server with the same IP as a discovered one wins. Use that to change the user, port or key.
- When a provider's API fails, Orrery keeps listing the machines from its last good answer. `discoveryErrors` reports the error with `usingListFrom`. netcup lists servers without IPs and each server's details come from a separate call; when one of those fails, that server keeps its last record. These fallbacks live in memory and are empty after a restart.
- `server_stats`, `server_pulse` and `run_command` look machines up in the last listing and refresh it in the background. A machine created a moment ago can come back as "Unknown server": call `list_servers` once.
- Stopped EC2 and Google Cloud instances have no public IP, so they leave the list until they start again.
- A server that rejects Orrery's login is not tried again for 10 minutes, so polling cannot trip fail2ban on machines that are not onboarded yet. Onboarding or fixing the login clears the wait.

### Onboarding (once per server)

Onboarding makes a server trust Orrery's public key. It runs as a background job; follow it with `ssh_bootstrap_status`. It does nothing if the key already works. The target's port 22 must be reachable from the Orrery host's IP.

| Provider | How | Restart |
| --- | --- | --- |
| EC2 | EC2 Instance Connect accepts a temporary key for 60 seconds; Orrery uses that window to install its key for good. Tries the users `ubuntu`, `ec2-user`, `admin` and `debian` | No |
| Lightsail | Lightsail's temporary SSH certificate (`GetInstanceAccessDetails`), deleted after use. The login user follows the blueprint | No |
| Google Cloud | Adds `orrery:<public key>` to the instance's `ssh-keys` metadata, keeping the existing keys and metadata. Google's guest agent creates the `orrery` user with sudo; Orrery waits up to a minute for the login to work. Instances with OS Login are refused with the reason | No |
| Alibaba Cloud | Cloud Assistant (on every public image) runs the install script as root and writes `/root/.ssh/authorized_keys` | No |
| netcup | The job fails with one command to paste as root in the SCP web console. Run `ssh_bootstrap` again to confirm. Pasting twice adds the key once. Automatic onboarding through the rescue system is off by default; do not turn it on (section 9) | No |
| Linode | Same as netcup, in the Lish console. Linodes created with `authorized_keys` need nothing | No |
| Vultr | Same, in the web console (View Console). Instances created with `sshkey_id` need nothing | No |
| DigitalOcean | Same, in Access → Droplet Console. Droplets created with `ssh_keys` need nothing | No |
| Kamatera | Same, in the server's console (reset the root password in the web console first if needed). Servers created with the key in `script-file` need nothing | No |
| Other machines | Paste the same command (or add the `ssh_public_key` output to `authorized_keys` yourself), then `add_server` without a password or `keyPath` | |
| The Orrery host | `enable-ssh.sh` | |

For netcup, Linode, Vultr, DigitalOcean and Kamatera a `failed` job whose `error` holds the command to paste is the normal result.

To move a server you added by hand back to discovery, remove the saved entry and move its name and note over with `label_server`.

### Asynchronous jobs at the providers

| Provider | Follow progress with |
| --- | --- |
| netcup | `netcup_get_task`, `netcup_list_tasks` |
| Linode | `linode_query /account/events` |
| Google Cloud | `gcp_query /projects/{p}/zones/{z}/operations/{op}` |
| Alibaba Cloud | `aliyun_query ecs DescribeInstanceStatus`, `DescribeInvocationResults` |
| DigitalOcean | `digitalocean_query /actions/{id}` |
| Kamatera | `kamatera_query /service/queue?id=<command id>` |

## 6. Dashboard

`dashboard/orrery.html` is a page for claude.ai's Artifact feature, published from a claude.ai conversation. It looks for a connector named `Orrery` and, in the Claude desktop app, for a local MCP server named `orrery`. It needs permission to call the tools listed in [deploy.md](deploy.md), step 11.

- Server list grouped by provider, with live figures. The page calls `server_pulse` once a second for every listed server while it is visible, and pauses in the background.
- Cloud views per provider, a terminal (`run_command`) and container controls.
- The terminal refuses interactive programs and follow modes (`tail -f`, `journalctl -f`, `docker logs -f`, `kubectl logs -f`, `dmesg -w`), and adds `-c 4` to a `ping` without a count. The stop button only stops the page from waiting; the command keeps running on the server until it ends or times out. End a silent command such as `sleep` with `kill`.
- Artifact watches (`watchTool`) refresh at most every 30 seconds; the platform enforces this. The live figures therefore use plain calls.
- The page redraws every second. Regions that scroll sideways or hold text to copy are only rewritten when their content changes, and redraws pause while a pointer is pressed, so buttons and text selection keep working.

## 7. Troubleshooting

| Symptom | What to do |
| --- | --- |
| Every call returns Bad Gateway | The tunnel is down. Check the tunnel's status in Cloudflare; on the host run `docker compose ps` and `docker compose logs --tail 30 tunnel`. If you just changed the host's firewall, undo it through the provider's web console |
| Bad Gateway right after an update from a chat | Expected: the rebuild cut the reply. Wait one to two minutes |
| 403 from Cloudflare | The WAF rule or Access blocks the client. Local clients connect from your IP, not Anthropic's ([deploy.md](deploy.md), step 7) |
| 404 from the endpoint | Wrong or rotated token. Read `data/token` and update the client |
| A provider's tools are missing | Its credentials are missing or invalid: `cloud_providers` shows the error. After fixing them, restart the container and start a new conversation, because clients fix the tool list when a conversation starts |
| "Unknown server" for a new machine | Call `list_servers` once |
| Login fails and the message says it will not retry for 10 minutes | The server rejected Orrery's key. Onboard it, or fix the user, port or key with `add_server` |
| `enable-ssh.sh` says "No public IPv4 on this machine's interfaces" | The host's public IP is not on a network interface (1:1 NAT clouds). Add `ORRERY_SELF_IP=<public IPv4>` to `deploy/.env` and run the script again |
| netcup returns `invalid_grant` | The refresh token expired or was revoked. Sign in again ([providers.md](providers.md)) |
| AWS returns `AccessDenied` or `UnauthorizedOperation` | The key was deactivated or the policy changed. EC2 onboarding needs `ec2-instance-connect:SendSSHPublicKey` |
| EC2 or Lightsail onboarding times out | The security group or Lightsail firewall does not allow port 22 from the Orrery host's IP |
| Google Cloud: `token failed with 400: invalid_grant` | The service account key was deleted or disabled. Send a new one |
| Google Cloud: 403 "has not been used" or "is disabled" | Enable the Compute Engine API in that project |
| Google Cloud onboarding refused because of OS Login | Set `enable-oslogin` to `FALSE` in the instance metadata, or add the key to `authorized_keys` by hand |
| Alibaba Cloud: `InvalidAccessKeyId` or `SignatureDoesNotMatch` | The AccessKey was disabled or deleted. Create a new one |
| Alibaba Cloud: `Forbidden.RAM` | The RAM user lacks that permission. New permissions take a little while to apply |
| Vultr: 401 | The key is wrong or was regenerated, or the Orrery host's IP is not in the key's Access Control list |
| DigitalOcean: 401 | The token was deleted or expired |
| Kamatera: 401 or 403 | The key was deleted, or its IP restriction does not include the Orrery host |
| `run_command` says "timed out after 60s" | The command may still be running. Run long jobs in the background (section 9) |
| You cannot SSH into the Orrery host | Use the provider's web console, which does not depend on the network or firewall |
| The connector token leaked | [security.md](security.md), "Rotating secrets" |
| A cloud credential leaked | The provider's "Rotate or revoke" step in [providers.md](providers.md) |
| The SSH key leaked | [security.md](security.md), "Orrery's SSH key" |

## 8. Daily operations

The commands for updating, logs, the audit log and restarts are in [deploy.md](deploy.md), "Daily operations". A few tasks that come up in chats:

| Task | How |
| --- | --- |
| Check that all tools are there | `cloud_providers` |
| Onboard an existing machine | `ssh_bootstrap <id>` |
| Reboot a machine (after you agreed to it) | Inside the machine: `sudo -n setsid nohup sh -c 'sleep 2; systemctl reboot' >/dev/null 2>&1 < /dev/null &`. The call returns first. Then poll port 22 from the Orrery host until it answers (usually 30 to 60 seconds) |
| Test machines | Tag them `test` (or label `test=true` on Google Cloud) and delete them when done, with any DNS records you made |

## 9. Known pitfalls

- **netcup's firewall drops replies to outbound connections.** A policy that drops all inbound traffic except some source IPs also drops the replies to the host's own outbound connections: the tunnel, DNS, the provider APIs. Applied to the Orrery host, the tunnel goes offline at once. If you must restrict inbound traffic there, also allow TCP and UDP from any source to destination ports 32768 to 60999 (the ephemeral range). For this reason Orrery refuses to change firewall policies attached to protected netcup servers.
- **Changing the Orrery host's own network or firewall from a chat can lock the assistant out.** Open the provider's web console first and be ready to undo the change there.
- **netcup's rescue system is not safe to automate.** It can only be switched while the server is off; switching is an asynchronous task that also powers the server on and off by itself; a start request sent before that task finishes gets 409, and so does the request that would undo it. A server can end up stuck in the rescue system. Automatic onboarding through rescue is therefore off unless `ORRERY_NETCUP_RESCUE=1`, which the compose file does not pass. Leave it off.
- **Pin base images.** The floating `node:22-alpine` moved to an Alpine release whose OpenSSH client (10.3p1) crashes when logging in with an OpenSSH certificate, which is how Lightsail onboarding works. The image uses `node:22-bookworm-slim` (OpenSSH 9.2p1) instead. The cloudflared image is pinned too.
- **Containers only get the environment variables listed in `docker-compose.yml`.** The `orrery` service receives `ORRERY_ROLE`, `ORRERY_SELF_IP`, `ORRERY_PROTECTED_IPS` and `ORRERY_GCP_SSH_USER`. Anything else in `.env` has no effect until you add it to the compose file.
- **Check the target's cloud firewall before onboarding.** A policy that allows port 22 only from other addresses makes the connection time out, which looks like a key problem but is not.
- **Do not run the `docker run` command the Cloudflare dashboard shows.** The compose file already runs cloudflared. A container started by hand is not on the compose network and cannot resolve `orrery`.
- **`run_command` waits about 60 seconds at most.** Clients give up on a tool call after roughly a minute, whatever `timeoutSec` says, and the command may still be running. Run longer jobs in the background and poll their log with short loops (under 50 seconds each).
- **Detach background jobs completely.** `cd x && nohup cmd &` puts the whole `&&` chain in a background subshell that keeps the command's output open, so the call still waits until the timeout. Write `cd x && (setsid nohup cmd > log 2>&1 < /dev/null &)`.
- **`pkill -f` kills its own shell.** The command line of the shell `run_command` starts contains the pattern you match. Use `pkill <process name>` without `-f`, or look first with `pgrep -f`.
- **Alibaba Cloud images set `vm.swappiness` to 0** in `/etc/sysctl.d/99-apsara-sysctl.conf` (and `99-sysctl.conf` is read after it too). Your own setting needs a file name that sorts later, such as `99-zz-swappiness.conf`.
- **Alibaba Cloud RAM sometimes fails with `ServerError.500`** when attaching a policy. Retry. New permissions take a while to apply.
- **Alibaba Cloud's security center agent protects itself.** Root cannot remove it and the official uninstall script fails. Uninstall it from the Alibaba Cloud console.
- **Hosts in mainland China may not reach GitHub release downloads.** The API answers but downloads stall or break. Download on the Orrery host, check the checksum, and copy the file over SSH: `ssh -i ~/orrery/deploy/data/keys/id_ed25519 root@203.0.113.30 'cat > /tmp/file' < file`.
- **Use HTTP/2 for cloudflared on Google Cloud VMs.** With the default QUIC (UDP) transport, some requests stalled for several seconds; `--protocol http2` fixed it. Orrery's own tunnel already uses HTTP/2.
- **Google Cloud snapshot schedules keep orphan snapshots.** When a disk with a snapshot schedule is deleted, its last automatic snapshots stay forever (the default deletion rule keeps them, and the retention period no longer applies). They are billed. After deleting a machine, check `gcp_query /projects/{p}/global/snapshots`.
- **Do not hard-reset a brand-new VM.** On Google Cloud, `reset` is a power cut. A reset in the first minute after creation can leave empty SSH host keys, and sshd then fails to start. Reboot with `systemctl reboot` inside the machine, or `stop` and `start`. To repair a machine that no longer accepts SSH, add a `startup-script` metadata entry that deletes the empty `/etc/ssh/ssh_host_*_key` files, runs `ssh-keygen -A` and restarts ssh, then `stop` and `start` it. Read the serial console with `gcp_query /projects/{p}/zones/{z}/instances/{name}/serialPort?port=1&start=-6000`.
- **Kamatera key and create quirks.** The `ssh-key` field of `POST /service/server` rejects Orrery's ed25519 key with `400 General Error. (1)` and no reason. Put `echo <public key> >> /root/.ssh/authorized_keys` in `script-file` instead, **without quotes**: Kamatera keeps quotes literally, the key lands in `authorized_keys` with them, and sshd ignores it. Pass `disk` and `network` as space-separated strings; arrays cause a 500. Some Kamatera images have no `Include` line in `sshd_config` (see "New server baseline" in [security.md](security.md)).

## 10. Configuration reference

### Agent

| Variable | Default | Meaning |
| --- | --- | --- |
| `ORRERY_ROLE` | `hub` (the compose file sets `admin`) | `admin`: the deployed connector with every tool. `hub`: SSH tools and read-only cloud views |
| `ORRERY_SELF_IP` | empty (`enable-ssh.sh` writes it to `.env`) | The Orrery host's public IP. Protected. Without it, netcup refuses all stop, restart, rescue, reinstall and revert operations |
| `ORRERY_PROTECTED_IPS` | empty | More protected machines, comma separated |
| `ORRERY_DIR` | `~/.orrery` (`/data` in the image) | Data directory |
| `ORRERY_TOKEN` | not set | Replaces the `token` file. At least 32 characters. Set it in `deploy/.env` |
| `ORRERY_ALLOW_EXEC` | on | `0` removes `run_command` and `container_action`. Only affects the `hub` role |
| `ORRERY_NETCUP_RESCUE` | off | `1` enables netcup onboarding through the rescue system. Leave it off (section 9). Not passed by the compose file |
| `ORRERY_SSH_CONFIG` | `~/.ssh/config` | Extra host source for `list_servers` |
| `ORRERY_GCP_SSH_USER` | `orrery` | Login user that onboarding creates on Google Cloud instances |
| `PORT` | 8787 | HTTP port. Setting it also switches to HTTP mode |
| `HOST` | `127.0.0.1` (`0.0.0.0` in the image) | HTTP listen address |
| `TUNNEL_TOKEN` | required | cloudflared's token, in `deploy/.env`. Every compose command fails without it |

Command-line flag: `--http` serves HTTP instead of stdio.

### Provider variables (local use)

The deployed container does not receive these. Use the files in `data/` there.

| Variable | Meaning |
| --- | --- |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` | AWS credentials (take precedence over `aws.json`) |
| `AWS_REGIONS` | Comma-separated regions instead of every enabled one |
| `AWS_LIGHTSAIL` | `0` leaves out Lightsail |
| `AWS_COST_EXPLORER` | `1` adds `aws_cost` |
| `NETCUP_REFRESH_TOKEN` | netcup refresh token (not written back when netcup rotates it) |
| `NETCUP_USER_ID` | SCP user id, if Orrery cannot find it |
| `LINODE_TOKEN` | Linode token |
| `GCP_PROJECTS` | Comma-separated Google Cloud projects (overrides `projects` in `gcp.json`; the key itself must still be in `gcp.json`) |
| `VULTR_API_KEY` | Vultr API key |
| `DIGITALOCEAN_TOKEN` | DigitalOcean token |
| `KAMATERA_API_CLIENT_ID`, `KAMATERA_API_SECRET` | Kamatera key |

Alibaba Cloud only reads `aliyun.json`.

## 11. Code layout

| Path | Purpose |
| --- | --- |
| `agent/src/index.js` | Entry point: stdio by default, HTTP with `--http` or `PORT` |
| `agent/src/http.js` | HTTP entry: token check, body limit, one stateless MCP server per request |
| `agent/src/server.js` | Registers the tools per role: SSH tools, onboarding, `cloud_providers` |
| `agent/src/ssh.js` | SSH connection pool, the stats script, command execution, the live sampling script |
| `agent/src/live.js` | The per-server live samplers behind `server_pulse` |
| `agent/src/discovery.js` | Discovery across providers, labels, the Orrery host first |
| `agent/src/bootstrap.js` | `ssh_bootstrap` jobs for each provider |
| `agent/src/keys.js` | Orrery's SSH key |
| `agent/src/inventory.js` | `servers.json` and `~/.ssh/config` |
| `agent/src/cloud.js` | Loads the provider modules and matches cloud resources to servers by IP |
| `agent/src/audit.js` | The audit log and argument redaction |
| `agent/Dockerfile` | The image, built from the repository root |
| `agent/test/` | Agent tests, including the SSH smoke test |
| `providers/<provider>/index.js` | One module per provider: credentials, API client, discovery and tools. `aws`, `netcup`, `linode`, `gcp`, `aliyun`, `vultr`, `digitalocean`, `kamatera` |
| `providers/netcup/admin.js`, `providers/netcup/login.js` | netcup control tools; the device login |
| `providers/<provider>/test/` | Provider tests with recorded fixtures |
| `dashboard/orrery.html` | The claude.ai Artifact dashboard |
| `deploy/docker-compose.yml` | The `orrery` and `tunnel` services |
| `deploy/enable-ssh.sh` | One-time setup: records the host IP, starts the containers, trusts the agent's key for root |

The root `package.json` defines npm workspaces (the agent and each provider). Only `aws` has dependencies (the AWS SDK v3). The others use `fetch`: `gcp` signs its own JWT, `aliyun` signs its own requests (HMAC-SHA1). `.dockerignore` lets only code into the image, and `.gitignore` keeps credentials and runtime data out of the repository.

### Adding a provider

A provider module exports `id`, `name`, `loadConfig(env, dataDir)` and `register(server, ctx)`, which registers its tools and returns `{ id, name, configured, tools }`. Register list tools for every role and control tools only when `ctx.admin` is true, wrapped in `ctx.adminTool` so they are audited. To make its machines discoverable and onboardable, add it to `PROVIDERS` in `agent/src/cloud.js`, to the sources and id pattern in `agent/src/discovery.js`, and to `bootstrap.js`. Add its `COPY` lines to `agent/Dockerfile` and its test to the `test` script in `agent/package.json`.

## 12. Tests

```bash
npm install && npm test      # at the repository root; Node 20.6 or later
```

The unit tests use recorded API answers and fake SSH servers. They never touch a real account.

The SSH smoke test talks to a real machine through a real MCP client. It runs as part of `npm test` when `SMOKE_HOST` and `SMOKE_USER` are set, and is skipped otherwise:

```bash
cd agent
SMOKE_HOST=203.0.113.30 SMOKE_PORT=22 SMOKE_USER=root SMOKE_KEY=~/.ssh/id_ed25519 npm test
SMOKE_TRANSPORT=http SMOKE_HOST=203.0.113.30 SMOKE_USER=root SMOKE_KEY=~/.ssh/id_ed25519 npm test   # through the HTTP endpoint
ORRERY_ALLOW_EXEC=0 SMOKE_HOST=203.0.113.30 SMOKE_USER=root SMOKE_KEY=~/.ssh/id_ed25519 npm test    # read-only tool set
ORRERY_ROLE=admin SMOKE_TRANSPORT=http SMOKE_HOST=203.0.113.30 SMOKE_USER=root SMOKE_KEY=~/.ssh/id_ed25519 npm test   # the deployed role over HTTP
```

The smoke test uses a fresh temporary data directory and removes `AWS_*`, `NETCUP_*` and `LINODE_*` variables from its environment, so it does not reach your cloud accounts. Unset `VULTR_API_KEY`, `DIGITALOCEAN_TOKEN` and the Kamatera variables too if you have them set. Over HTTP it also checks that a wrong token gets 404 and that the token never appears in the log.
