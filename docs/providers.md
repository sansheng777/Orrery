# Cloud provider credentials

How to create a least-privilege credential for each provider, the file it goes in, how to rotate or revoke it, and each provider's quirks. The tool reference is in [architecture.md](architecture.md). Which machines the tools refuse to touch is in [security.md](security.md).

## Common rules

- Each credential is one JSON file in `deploy/data/` on the Orrery host: `aws.json`, `netcup.json`, `linode.json`, `gcp.json`, `aliyun.json`, `vultr.json`, `digitalocean.json`, `kamatera.json`.
- Every file is mode 600 and owned by uid 1000 (the `node` user in the container). The directory is mode 700.
- After adding or changing a file, run `docker compose restart orrery` in `deploy/`, then call `cloud_providers` to confirm the provider is configured.
- A file that cannot be parsed shows up in `cloud_providers` as an error. The error never includes the file's content.
- Use files, not environment variables. The code also reads variables such as `AWS_ACCESS_KEY_ID`, `NETCUP_REFRESH_TOKEN`, `LINODE_TOKEN`, `VULTR_API_KEY`, `DIGITALOCEAN_TOKEN` and `KAMATERA_API_CLIENT_ID` / `KAMATERA_API_SECRET`. The deployed container only receives the variables listed in `docker-compose.yml`, so these only matter when you run the agent locally.
- Never paste a credential into a chat with your AI assistant. Conversations are stored, and tool results go back to the model.

## Putting a secret on the host

Pick one of these.

### Type it into a terminal on the host

Read the secret without echoing it, and write the file with a private umask. For example, for a single token:

```bash
cd ~/orrery/deploy
(umask 077; read -rsp "Linode token: " T && printf '{"token":"%s"}\n' "$T" > data/linode.json && unset T)
chown 1000:1000 data/linode.json && docker compose restart orrery
```

### Pipe it in over a one-time SSH key

Use this when the secret is created somewhere else, such as a cloud provider's browser shell (AWS CloudShell, Google Cloud Shell, Alibaba Cloud Shell). The secret goes from the command that creates it straight into the file on the Orrery host. It never appears on a screen, and nobody needs to log in to the host.

1. On the machine that will create the secret, make a throwaway key and print its public half:

   ```bash
   ssh-keygen -t ed25519 -N '' -q -f ~/orrery-upload -C orrery-upload && cat ~/orrery-upload.pub
   ```

2. On the Orrery host, create a small receiver script, `/root/orrery-receive.sh`:

   ```sh
   #!/bin/sh
   # Writes stdin to deploy/data/<name>, after checking that it is JSON.
   set -eu
   dest=/root/orrery/deploy/data/$1
   tmp=$(mktemp "$dest.XXXXXX")
   cat > "$tmp"
   if ! docker run --rm -i orrery:local node -e 'JSON.parse(require("fs").readFileSync(0, "utf8"))' < "$tmp"; then
     rm -f "$tmp"; echo "not valid JSON, nothing saved" >&2; exit 1
   fi
   chmod 600 "$tmp" && chown 1000:1000 "$tmp" && mv "$tmp" "$dest"
   echo "saved $dest"
   ```

   Make it executable (`chmod 700 /root/orrery-receive.sh`) and add one line to `/root/.ssh/authorized_keys`. The line forces that one command, with the file name fixed, and turns off shells, terminals and forwarding:

   ```
   restrict,command="/root/orrery-receive.sh gcp.json" ssh-ed25519 AAAA... orrery-upload
   ```

   The public key is not a secret. You can ask your AI assistant to add this line with `run_command` on the Orrery host.

3. Back on the other machine, create the secret and pipe it to the host. Each provider section below has the exact command. The pattern is:

   ```bash
   <command that prints the credential JSON> | ssh -i ~/orrery-upload -o StrictHostKeyChecking=accept-new root@198.51.100.20
   rm -f ~/orrery-upload ~/orrery-upload.pub
   ```

4. Remove the `orrery-upload` line from `/root/.ssh/authorized_keys`, then `docker compose restart orrery`.

The host must accept root logins with keys (`PermitRootLogin prohibit-password`), which `enable-ssh.sh` needs anyway.

---

## AWS

Covers EC2 and Lightsail through the official AWS SDK for JavaScript v3, plus CloudWatch (EC2 CPU) and, optionally, Cost Explorer. Other AWS services (S3, RDS, IAM and so on) are not covered.

### IAM user and policy

Create an IAM user named `orrery` without console access, and attach only this inline policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "ControlEc2AndLightsail", "Effect": "Allow", "Action": ["ec2:*", "lightsail:*"], "Resource": "*" },
    { "Sid": "OnboardEc2", "Effect": "Allow", "Action": "ec2-instance-connect:SendSSHPublicKey", "Resource": "*" },
    { "Sid": "ReadCpu", "Effect": "Allow", "Action": "cloudwatch:GetMetricData", "Resource": "*" },
    {
      "Sid": "KeepSecretsOutOfChats",
      "Effect": "Deny",
      "Action": [
        "ec2:GetPasswordData",
        "ec2:ExportVerifiedAccessInstanceClientConfiguration",
        "ec2:GetVpnConnectionDeviceSampleConfiguration",
        "ec2:CreateReplaceRootVolumeTask",
        "lightsail:DownloadDefaultKeyPair",
        "lightsail:GetRelationalDatabaseMasterUserPassword",
        "lightsail:CreateBucketAccessKey",
        "lightsail:CreateContainerServiceRegistryLogin"
      ],
      "Resource": "*"
    }
  ]
}
```

- The Deny statement blocks calls that return a password or private key, plus root volume replacement. `aws_call` refuses these too, and also refuses `CreateKeyPair` (use `ImportKeyPair` with your own public key). The policy is a second layer in case the code has a gap.
- Do **not** deny `lightsail:GetInstanceAccessDetails`. Lightsail onboarding needs it. The temporary private key it returns stays inside the Orrery process and is deleted after use.
- `ec2-instance-connect:SendSSHPublicKey` is needed for EC2 onboarding. `ec2:*` does not include it.
- There is no `iam:PassRole`, so new EC2 instances cannot get an IAM role. Some Lightsail features ask for `iam:CreateServiceLinkedRole` the first time; add it only when asked, with a condition limiting it to Lightsail.
- To limit the user to some regions, add `"Condition": { "StringEquals": { "aws:RequestedRegion": ["eu-central-1"] } }` to the first statement.

### Create the key and send it to the host

In AWS CloudShell, with the policy saved as `orrery-policy.json` and the upload key from "Pipe it in over a one-time SSH key" set up for `aws.json`:

```bash
aws iam create-user --user-name orrery
aws iam put-user-policy --user-name orrery --policy-name orrery --policy-document file://orrery-policy.json
aws iam create-access-key --user-name orrery \
  --query 'AccessKey.{accessKeyId:AccessKeyId,secretAccessKey:SecretAccessKey}' --output json \
  | ssh -i ~/orrery-upload -o StrictHostKeyChecking=accept-new root@198.51.100.20
```

### `data/aws.json`

```json
{ "accessKeyId": "AKIA...", "secretAccessKey": "...", "regions": "all", "lightsail": true, "costExplorer": false }
```

| Field | Meaning |
| --- | --- |
| `accessKeyId`, `secretAccessKey` | Required. `sessionToken` is accepted for temporary credentials |
| `regions` | `"all"` or missing: every region enabled in the account, looked up at run time. Or a list such as `["eu-central-1", "us-east-1"]` |
| `lightsail` | `false` leaves out the Lightsail tools and Lightsail discovery |
| `costExplorer` | `true` adds `aws_cost` |

### Cost (`aws_cost`)

Add `ce:GetCostAndUsage` to the policy, enable Cost Explorer once in the AWS console (data can take up to 24 hours to appear), and set `"costExplorer": true`. AWS bills every Cost Explorer request (USD 0.01). Orrery caches the answer for 6 hours, so a month costs about a dollar at most. The tool shows the unblended month-to-date cost, grouped by service.

### Rotate or revoke

Deactivate the key in the IAM console, create a new one, write it to `aws.json`, restart the container, and delete the old key.

---

## netcup

Uses netcup's SCP REST API (`https://www.servercontrolpanel.de/scp-core/api/v1/openapi`).

### There is no read-only credential

The SCP API only offers an OAuth device login. The refresh token it returns has no scope: it can do everything your SCP account can, including stopping, reinstalling and deleting snapshots. It is one of the most sensitive files on the host. All limits come from Orrery's code: protected machines, name confirmation for reinstall and snapshot revert, and the path checks in `netcup_api_request`.

### Sign in

```bash
cd ~/orrery/deploy
docker compose run --rm orrery node /app/providers/netcup/login.js
docker compose restart orrery
```

The command prints an address and a code. Open the address, sign in with your SCP account and confirm. The refresh token is saved to `data/netcup.json` as `{"refreshToken": "..."}`. netcup may issue a new refresh token when the old one is used; Orrery writes the new one back to the same file.

### Quirks

- **Expiry.** The refresh token stops working after 30 days without use. Orrery lists servers every minute while anyone uses it, so this rarely happens. When it does, calls fail with `invalid_grant`: sign in again.
- **Revoke.** Open `https://www.servercontrolpanel.de/realms/scp/account/` → Applications → `scp` → Remove access. The token stops working at once. Sign in again to get a new one.
- **`{userId}`.** Endpoints under `/api/v1/users/{userId}` need the SCP user id, which is not your customer number. Orrery reads it from the userinfo endpoint and falls back to the user of the latest task. `netcup_api_request` and `netcup_query` fill in `{userId}` for you.
- **Asynchronous tasks.** Power changes, snapshots and reinstalls are tasks. Follow them with `netcup_get_task` or `netcup_list_tasks`.
- **Memory of a stopped server.** netcup reports 0 MiB current memory for a stopped server; Orrery shows the configured maximum instead.
- netcup does not offer technical support for its API, and endpoints can change. `netcup_api_request` checks every path against netcup's current OpenAPI spec at run time.

---

## Linode

Uses the Linode API v4. Results from Linode are not redacted, so keep the token's scope narrow.

### Create the token

Cloud Manager → your profile → API Tokens → Create a Personal Access Token. Name it `orrery` and set the expiry to Never (otherwise the connector stops working when it expires). Scopes:

| Scope | Access | Why |
| --- | --- | --- |
| Linodes | Read/Write | Discovery, power, rebuild, delete |
| Events | Read Only | Progress of boots, creates and rebuilds |
| Firewalls, Domains, Volumes, Images, IPs, ... | As needed | Only if you want these through `linode_api_request` |
| Account | Read Only (optional) | Invoices and transfer usage |

The token is shown once. Write it to the host without echoing it:

```bash
cd ~/orrery/deploy
(umask 077; read -rsp "Linode token: " T && printf '{"token":"%s"}\n' "$T" > data/linode.json && unset T)
chown 1000:1000 data/linode.json && docker compose restart orrery
```

### `data/linode.json`

```json
{ "token": "..." }
```

### Rotate or revoke

Cloud Manager → API Tokens: revoke the old token, create a new one and write it as above.

### Notes

- `linode_api_request` refuses: deleting or rebuilding a Linode (use `linode_delete` / `linode_rebuild`), deleting a disk, restoring a backup with `overwrite`, cancelling the account, enabling two-factor authentication, and requests that return a token, key or kubeconfig (new personal tokens, Object Storage keys, OAuth client secrets, database credentials, LKE kubeconfigs).
- Passwords in arguments (such as `root_pass`) are replaced with `[redacted]` in the audit log. Results are returned as Linode sends them.

---

## Google Cloud

Uses the Compute Engine REST API v1. Only Compute Engine is covered: instances, disks, snapshots, images, firewalls, networks and the other Compute Engine resources. A service account key signs its own token (an RS256 JWT, renewed every hour), so there is no SDK.

### Service account

In Google Cloud Shell, with the right project selected:

```bash
P=$(gcloud config get-value project); SA=orrery@$P.iam.gserviceaccount.com
gcloud services enable compute.googleapis.com
gcloud iam service-accounts create orrery --display-name "Orrery"
gcloud projects add-iam-policy-binding $P --member serviceAccount:$SA --role roles/compute.instanceAdmin.v1 --condition=None -q >/dev/null
gcloud projects add-iam-policy-binding $P --member serviceAccount:$SA --role roles/iam.serviceAccountUser --condition=None -q >/dev/null
```

- `roles/compute.instanceAdmin.v1` covers starting, stopping, creating and deleting instances and changing their metadata (onboarding uses metadata).
- `roles/iam.serviceAccountUser` is needed to change the metadata of, or create, instances that run as a service account.
- To manage firewalls and networks, add `roles/compute.networkAdmin` or `roles/compute.securityAdmin`.
- If the organization policy `iam.disableServiceAccountKeyCreation` is on, you cannot create a key. Projects without an organization are not affected.

### Create the key and send it to the host

With the upload key from "Pipe it in over a one-time SSH key" set up for `gcp.json`:

```bash
gcloud iam service-accounts keys create ~/k.json --iam-account $SA -q \
  && ssh -i ~/orrery-upload -o StrictHostKeyChecking=accept-new root@198.51.100.20 < ~/k.json
shred -u ~/k.json ~/orrery-upload ~/orrery-upload.pub
```

### `data/gcp.json`

The service account key exactly as Google issues it (`type`, `project_id`, `client_email`, `private_key`, `token_uri`, ...). Optionally add a `projects` list:

```json
{ "type": "service_account", "project_id": "my-project-123", "client_email": "...", "private_key": "...", "projects": ["my-project-123", "my-other-project-456"] }
```

Without `projects`, Orrery manages only the key's own project. `GCP_PROJECTS` (comma separated) overrides the list, but the deployed container does not receive that variable, so use the file.

### Adding more projects

The same service account can manage other projects, even in another Google account. No new key is needed.

1. In Cloud Shell, switch to the other project, enable the API and grant the same two roles to the existing service account:

   ```bash
   SA=orrery@my-project-123.iam.gserviceaccount.com; P=my-other-project-456
   gcloud services enable compute.googleapis.com --project $P
   gcloud projects add-iam-policy-binding $P --member serviceAccount:$SA --role roles/compute.instanceAdmin.v1 --condition=None -q >/dev/null
   gcloud projects add-iam-policy-binding $P --member serviceAccount:$SA --role roles/iam.serviceAccountUser --condition=None -q >/dev/null
   ```

2. Add the project id to `projects` in `gcp.json` without printing the key. On the Orrery host:

   ```bash
   cd ~/orrery/deploy
   docker compose run --rm orrery node -e '
     const fs = require("fs"), f = "/data/gcp.json", k = JSON.parse(fs.readFileSync(f, "utf8"));
     k.projects = [...new Set([...(k.projects || [k.project_id]), "my-other-project-456"])];
     fs.writeFileSync(f, JSON.stringify(k, null, 2) + "\n", { mode: 0o600 });'
   docker compose restart orrery
   ```

3. Call `cloud_providers` and check that the project is listed. A mistyped project id comes back as 404 "not found"; a project where the roles are missing comes back as 403.

A project in an organization with domain-restricted sharing (`iam.allowedPolicyMemberDomains`) cannot grant roles to an outside service account. Orrery reads only one key, so such a project cannot be added this way.

To remove a project, delete the two role bindings in that project's IAM page and remove it from `projects`.

### What it can and cannot reach

- It can manage everything Compute Engine offers in the configured projects. Firewalls and networks need the extra roles above.
- It cannot reach billing, payment methods, IAM grants, service account keys, project deletion or other services (Cloud Storage, BigQuery and so on). Three layers enforce this: the service account's roles, the token's scope (`auth/compute` only), and the code, which only calls Compute Engine v1.
- **One way around it.** `roles/iam.serviceAccountUser` allows creating an instance that runs as the default compute service account with the `cloud-platform` scope. In many projects that account has the Editor role, so code on that instance could use other services and spend money (billing accounts stay out of reach). To close this, remove the Editor role from the default compute service account. Do not remove `serviceAccountUser` from `orrery`, or onboarding breaks.

### Onboarding

`ssh_bootstrap gcp:<project>:<zone>:<name>` adds `orrery:<public key>` to the instance's `ssh-keys` metadata. Google's guest agent creates the `orrery` user with sudo and installs the key within seconds. Instances with OS Login enabled ignore metadata keys and are refused with an explanation. Set `ORRERY_GCP_SSH_USER` to use another login name.

### Rotate or revoke

IAM → Service accounts → `orrery` → Keys: delete the old key, then create and send a new one as above. To stop all access, delete the service account.

---

## Alibaba Cloud

Uses the RPC-style OpenAPI of the China site (aliyun.com). Requests are signed in the code (signature version 1.0, HMAC-SHA1), so there is no SDK.

| `service` | API version | Covers |
| --- | --- | --- |
| `ecs` | 2014-05-26 | Instances, disks, snapshots, images, security groups, Cloud Assistant (per region) |
| `vpc` | 2016-04-28 | VPCs, vSwitches, elastic IPs (per region) |
| `alidns` | 2015-01-09 | DNS records |
| `domain` | 2018-01-29 | Domains: list, details, renewal, name servers |
| `cdn` | 2018-05-10 | CDN domains, configuration, certificates, refresh and prefetch, usage |
| `cas` | 2020-04-07 | SSL certificates |
| `bss` | 2017-12-14 | Billing: balance and bills, **read-only** |

Another RPC-style product (SLB, RDS and so on) is one more entry in `SERVICES` in `providers/aliyun/index.js`, plus the matching RAM policy. OSS uses a different (REST) API and is not covered.

### RAM user and policies

Create a RAM user named `orrery` with these system policies:

| Policy | For |
| --- | --- |
| `AliyunECSFullAccess` | ECS |
| `AliyunVPCFullAccess` | VPC (it may not cover elastic IP actions; if `DescribeEipAddresses` returns `Forbidden.RAM`, attach an EIP policy too) |
| `AliyunDNSFullAccess` | DNS |
| `AliyunDomainFullAccess` | Domains |
| `AliyunCDNFullAccess` | CDN |
| `AliyunYundunCertFullAccess` | Certificates |
| `AliyunBSSReadOnlyAccess` | Billing, read-only |

Leave out the services you do not need. The user gets no RAM management, no payments and no OSS.

In Alibaba Cloud's Cloud Shell (the `aliyun` CLI is already signed in as you):

```bash
aliyun ram CreateUser --UserName orrery --DisplayName "Orrery" >/dev/null
for p in AliyunECSFullAccess AliyunVPCFullAccess AliyunDNSFullAccess AliyunDomainFullAccess AliyunCDNFullAccess AliyunYundunCertFullAccess AliyunBSSReadOnlyAccess; do
  aliyun ram AttachPolicyToUser --PolicyType System --PolicyName $p --UserName orrery >/dev/null || echo "failed: $p"
done
```

Attaching a policy sometimes fails with `ServerError.500`. Run it again. New permissions can take a little while to apply, so an early `Forbidden.RAM` does not always mean the policy is missing. `aliyun ram ListPoliciesForUser --UserName orrery` shows what is attached.

### Create the AccessKey and send it to the host

With the upload key from "Pipe it in over a one-time SSH key" set up for `aliyun.json`:

```bash
aliyun ram CreateAccessKey --UserName orrery \
  | python3 -c 'import json,sys; a=json.load(sys.stdin)["AccessKey"]; print(json.dumps({"accessKeyId": a["AccessKeyId"], "accessKeySecret": a["AccessKeySecret"]}))' \
  | ssh -i ~/orrery-upload -o StrictHostKeyChecking=accept-new root@198.51.100.20
rm -f ~/orrery-upload ~/orrery-upload.pub
```

### `data/aliyun.json`

```json
{ "accessKeyId": "...", "accessKeySecret": "...", "regions": "all" }
```

`regions` is optional. `"all"` (or missing) lists ECS instances in every region every minute. A list such as `["cn-hangzhou"]` limits discovery to those regions.

### Notes

- `aliyun_delete` releases pay-as-you-go instances only. Subscription (PrePaid) instances must be unsubscribed in the console first.
- Refused by the code: deleting instances through `aliyun_call` (use `aliyun_delete`), `CreateKeyPair`, `DescribeInstanceVncUrl`, domain transfer-out, unlocking a domain for transfer, reading its transfer code, reading certificate private keys, and any billing change.
- **Not refused:** actions that spend money (renewals, buying domains, adding CDN domains) and deleting DNS records or CDN domains. Keep approval on for `aliyun_call`.

### Rotate or revoke

RAM console → Users → `orrery` → AccessKey: disable and delete the old key, then create and send a new one as above.

---

## Vultr

Uses the Vultr API v2 (`https://api.vultr.com/v2`). Vultr's own hosted MCP server is read-only, so control lives in Orrery. `vultr_api_request` can reach the whole account: instances, firewalls, DNS, snapshots, block storage, VPCs, bare metal, Kubernetes, databases, object storage, inference and billing.

### Create the API key

1. Vultr → Account → API → Enable API. The key of the main account can manage everything. Vultr also lets you create sub-users with fewer permissions (Account → Users); the API key of such a user can do less.
2. In **Access Control** on the same page, allow only the Orrery host's IPv4 as `/32` (for example `198.51.100.20/32`). The container reaches the internet over IPv4, so no IPv6 entry is needed. A leaked key is then useless anywhere else.
3. Write the key to the host:

   ```bash
   cd ~/orrery/deploy
   (umask 077; read -rsp "Vultr API key: " K && printf '{"apiKey":"%s"}\n' "$K" > data/vultr.json && unset K)
   chown 1000:1000 data/vultr.json && docker compose restart orrery
   ```

### `data/vultr.json`

```json
{ "apiKey": "..." }
```

### Notes

- `vultr_api_request` allows GET, POST, PUT, PATCH and DELETE only. OPTIONS is left out because that is how Vultr hands out container registry credentials.
- Refused: deleting or reinstalling an instance through the generic tool (use `vultr_delete` / `vultr_reinstall`), restoring a snapshot or backup over a disk, deleting or reinstalling bare-metal servers, creating API keys, regenerating Object Storage keys, Kubernetes configs and inference API keys.
- Redacted in answers: passwords (such as a new instance's `default_password`), keys, tokens and the `kvm` web console URL. That URL carries a token that opens the server's screen and keyboard without a Vultr login, which is one reboot away from root.
- The API cannot install a key on a running instance. New instances get it at creation with `sshkey_id` (register the key first with `POST /ssh-keys`).

### Rotate or revoke

Vultr → Account → API → Regenerate, then write the new key as above.

---

## DigitalOcean

Uses the DigitalOcean API v2 (`https://api.digitalocean.com/v2`). `digitalocean_api_request` can reach the whole account: Droplets, firewalls, DNS, snapshots, volumes, reserved IPs, load balancers, VPCs, Kubernetes, databases, Spaces, App Platform and billing.

### Create the token

DigitalOcean → API → Tokens → Generate New Token. Name it `orrery`, choose No expiry (otherwise the connector breaks on the expiry date) and Full Access, or custom scopes if you want less (discovery needs at least Droplet read access).

**A DigitalOcean token cannot be restricted to an IP address.** Anyone who gets it can use it from anywhere. Keep it only on the Orrery host, and do not store it anywhere else.

```bash
cd ~/orrery/deploy
(umask 077; read -rsp "DigitalOcean token: " T && printf '{"token":"%s"}\n' "$T" > data/digitalocean.json && unset T)
chown 1000:1000 data/digitalocean.json && docker compose restart orrery
```

### `data/digitalocean.json`

```json
{ "token": "..." }
```

### Notes

- A leading `/v2` in a path (copied from DigitalOcean's docs) is dropped automatically.
- Refused: deleting or rebuilding a Droplet through the generic tool (use `digitalocean_delete` / `digitalocean_rebuild`), deleting Droplets by tag, destroying a Droplet with its associated resources, restoring a backup over a disk, and requests that return credentials (kubeconfigs, registry credentials, Spaces keys, function keys, AI agent and model API keys, and others).
- Redacted in answers: passwords, tokens, secrets, private keys and the password inside connection URIs.
- The API cannot install a key on a running Droplet. New Droplets get it at creation with `ssh_keys` (register the key first with `POST /account/keys`).

### Rotate or revoke

DigitalOcean → API → Tokens: delete the old token, generate a new one and write it as above.

---

## Kamatera

Uses Kamatera's cloudcli API (`https://cloudcli.cloudwm.com`). Requests carry the `AuthClientId` and `AuthSecret` headers.

### Create the API key

Kamatera console → API → Keys → create a key named `orrery`. You get a Client ID and a Secret. If the page lets you restrict the key to source IPs, allow only the Orrery host's IPv4.

```bash
cd ~/orrery/deploy
(umask 077; read -rp "Kamatera client id: " I && read -rsp "Kamatera secret: " S \
  && printf '{"clientId":"%s","secret":"%s"}\n' "$I" "$S" > data/kamatera.json && unset I S)
chown 1000:1000 data/kamatera.json && docker compose restart orrery
```

### `data/kamatera.json`

```json
{ "clientId": "...", "secret": "..." }
```

### How the cloudcli API works

- Most calls are POSTs that name the server in the body. Name it with `"id"`. Kamatera treats `"name"` as a regular expression that can match several servers, so Orrery refuses changes that use `name`.
- Changes are queued. They answer with command ids; follow them with `kamatera_query` `GET /service/queue?id=<id>`.
- Useful reads: datacenters `GET /service/server?datacenter=1`, server options `GET /service/server?capabilities=1&datacenter=<code>`, images `GET /service/server?images=1&datacenter=<code>`. `/service/server/options/datacenters` returns 500; do not use it.
- `kamatera_query` allows any GET plus the read-only POSTs `/service/server/info`, `/service/server/options/images`, `/server/history`, `/server/statistics` and `/server/report`.
- Refused by `kamatera_api_request`: terminating (use `kamatera_delete`), reverting a snapshot, setting the root password and opening console sessions (`/service/server/password`, `ssh`, `sshkey`). Passwords in answers are redacted, including the root password Kamatera generates when you create a server with `"password": "__generate__"`.

### Billing

Check Kamatera's billing FAQ for the current terms. At the time of writing:

- Hourly servers are billed after use, per minute, and traffic is charged per GB in both directions. A powered-off server still pays for its disk and IP (`priceHourlyOff` in `kamatera_servers`).
- Monthly servers are billed for the whole month on the first of the month, with a traffic package included. Deleting a monthly server after the first still costs the full month.
- You can switch a server from hourly to monthly with `kamatera_api_request` `POST /server/configure` and `{"id": "...", "billingcycle": "monthly", "monthlypackage": "<package>"}`. It takes a few seconds and does not stop the server.
- The API has no endpoint for the account balance, invoices or payments. Check those in the console's Billing page. The API does show each server's prices (`kamatera_servers`) and this month's traffic (`kamatera_query` `POST /server/report` with `{"id", "year", "month"}`).

### Onboarding

The API cannot install a key on a running server. For an existing server, paste the `ssh_bootstrap` command into the server's console in the Kamatera web console (you may need to reset the root password there first). For new servers, put the key in the create request's `script-file`, unquoted. See "Kamatera key and create quirks" in [architecture.md](architecture.md).

### Rotate or revoke

Kamatera console → API → Keys: delete the old key, create a new one and write it as above.
