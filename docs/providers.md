# Cloud provider credentials

How to create a least-privilege credential for each provider, where it goes, and how to rotate it. Tools are in the [tool reference](architecture.md#4-tool-reference). What the tools refuse and redact is in [security.md](security.md).

## Common rules

- Each credential is one JSON file in `deploy/data/` on the Orrery host, mode 600, owner uid 1000: `aws.json`, `netcup.json`, `linode.json`, `gcp.json`, `aliyun.json`, `vultr.json`, `digitalocean.json`, `kamatera.json`.
- Orrery reads the files on every request, so no restart is needed. Call `cloud_providers` to confirm, and open a new conversation to see the new tools.
- A file that cannot be parsed shows as an error in `cloud_providers`. The error never includes the file's content.
- Use files. The provider environment variables ([configuration](architecture.md#provider-variables-local-use-only)) only work for a local agent: the container does not receive them.
- Never paste a credential into a chat. Conversations are stored, and tool results go back to the model.

## Putting a secret on the host

### Type it into a terminal on the host

Read the secret without echoing it and write the file with a private umask:

```bash
cd ~/orrery/deploy
(umask 077; read -rsp "Linode token: " T && printf '{"token":"%s"}\n' "$T" > data/linode.json && unset T)
chown 1000:1000 data/linode.json
```

### Pipe it in over a one-time SSH key

Use this when the secret is created elsewhere, such as in AWS CloudShell, Google Cloud Shell or Alibaba Cloud Shell. The secret goes straight from the command that creates it into the file on the host, and never appears on a screen.

1. On the machine that will create the secret, make a throwaway key:

   ```bash
   ssh-keygen -t ed25519 -N '' -q -f ~/orrery-upload -C orrery-upload && cat ~/orrery-upload.pub
   ```

2. On the Orrery host, create `/root/orrery-receive.sh` and `chmod 700` it:

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

3. Add one line to `/root/.ssh/authorized_keys`. It forces that command with a fixed file name and turns off shells and forwarding. The public key is not a secret, so the assistant may add it with `run_command`.

   ```
   restrict,command="/root/orrery-receive.sh gcp.json" ssh-ed25519 AAAA... orrery-upload
   ```

4. On the other machine, pipe the credential JSON in (each provider below has the exact command), then delete the key:

   ```bash
   <command that prints the credential JSON> | ssh -i ~/orrery-upload -o StrictHostKeyChecking=accept-new root@198.51.100.20
   rm -f ~/orrery-upload ~/orrery-upload.pub
   ```

5. Remove the `orrery-upload` line from `/root/.ssh/authorized_keys`.

The host must accept root key logins (`PermitRootLogin prohibit-password`), which `enable-ssh.sh` needs anyway.

## AWS

EC2 and Lightsail through the AWS SDK for JavaScript v3, plus CloudWatch (EC2 CPU) and optionally Cost Explorer.

### IAM user and policy

Create an IAM user `orrery` without console access, with only this inline policy:

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
        "ec2:GetConsoleOutput",
        "ec2:GetConsoleScreenshot",
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

- The Deny statement is a second layer behind the code's refusals.
- Do **not** deny `lightsail:GetInstanceAccessDetails`: Lightsail onboarding needs it. The temporary key stays inside the Orrery process.
- `ec2:*` does not include `ec2-instance-connect:SendSSHPublicKey`, which EC2 onboarding needs.
- Without `iam:PassRole`, new EC2 instances cannot get an IAM role. Some Lightsail features ask for `iam:CreateServiceLinkedRole` once; add it only then, limited to Lightsail.
- To limit regions, add `"Condition": { "StringEquals": { "aws:RequestedRegion": ["eu-central-1"] } }` to the first statement.

### Create the key and send it

In AWS CloudShell, with the policy saved as `orrery-policy.json` and the upload key set up for `aws.json`:

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
| `regions` | `"all"` or missing: every region enabled in the account. Or a list such as `["eu-central-1"]` |
| `lightsail` | `false` leaves out Lightsail tools and discovery |
| `costExplorer` | `true` adds `aws_cost` |

For `aws_cost`, also add `ce:GetCostAndUsage` to the policy and enable Cost Explorer once in the console (data can take 24 hours). Each request costs USD 0.01; Orrery caches the answer for 6 hours, so a month costs about a dollar at most.

**Rotate or revoke.** Deactivate the key in IAM, create a new one, write it to `aws.json`, then delete the old key.

## netcup

netcup's SCP REST API (`https://www.servercontrolpanel.de/scp-core/api/v1/openapi`). **There is no read-only credential.** The API only offers an OAuth device login whose refresh token can do everything your SCP account can. All limits come from Orrery's code.

### Sign in

```bash
cd ~/orrery/deploy
docker compose run --rm orrery node /app/providers/netcup/login.js
```

Open the printed address, sign in and confirm. The token is saved to `data/netcup.json` as `{"refreshToken": "..."}`. When netcup issues a new refresh token, Orrery writes it back to the file.

### Quirks

- **Expiry.** The token stops working after 30 days unused. Orrery lists servers every minute while in use, so this is rare. Calls then fail with `invalid_grant`: sign in again.
- **Revoke.** `https://www.servercontrolpanel.de/realms/scp/account/` → Applications → `scp` → Remove access. Sign in again for a new token.
- **`{userId}`.** Endpoints under `/api/v1/users/{userId}` need the SCP user id, not your customer number. Orrery reads it from userinfo, falls back to the user of the latest task, and fills it in.
- **Tasks.** Power changes, snapshots and reinstalls are asynchronous: `netcup_get_task`, `netcup_list_tasks`.
- **Stopped servers** report 0 MiB memory; Orrery shows the configured maximum.
- netcup does not support its API and endpoints can change. Orrery checks every path against the current spec at run time.

## Linode

Linode API v4. Answers are not redacted, so keep the token's scope narrow.

### Create the token

Cloud Manager → profile → API Tokens → Create a Personal Access Token. Name it `orrery`, expiry Never (otherwise the connector breaks when it expires). Scopes: Linodes Read/Write (discovery, power, rebuild, delete), Events Read Only (progress), optionally Account Read Only (invoices, transfer), and Firewalls, Domains, Volumes, Images or IPs only if you want them through `linode_api_request`.

Write it with the terminal method above. `data/linode.json` is `{ "token": "..." }`.

**Rotate or revoke.** Cloud Manager → API Tokens: revoke the old token, create a new one and write it again.

## Google Cloud

Compute Engine REST API v1 only. The service account key signs its own token (RS256 JWT, renewed hourly).

### Service account

In Google Cloud Shell, with the project selected:

```bash
P=$(gcloud config get-value project); SA=orrery@$P.iam.gserviceaccount.com
gcloud services enable compute.googleapis.com
gcloud iam service-accounts create orrery --display-name "Orrery"
gcloud projects add-iam-policy-binding $P --member serviceAccount:$SA --role roles/compute.instanceAdmin.v1 --condition=None -q >/dev/null
gcloud projects add-iam-policy-binding $P --member serviceAccount:$SA --role roles/iam.serviceAccountUser --condition=None -q >/dev/null
```

- `roles/compute.instanceAdmin.v1`: start, stop, create and delete instances and change their metadata (onboarding uses metadata).
- `roles/iam.serviceAccountUser`: change or create instances that run as a service account.
- For firewalls and networks, add `roles/compute.networkAdmin` or `roles/compute.securityAdmin`.
- The organization policy `iam.disableServiceAccountKeyCreation` blocks key creation. Projects without an organization are not affected.

### Create the key and send it

With the upload key set up for `gcp.json`:

```bash
gcloud iam service-accounts keys create ~/k.json --iam-account $SA -q \
  && ssh -i ~/orrery-upload -o StrictHostKeyChecking=accept-new root@198.51.100.20 < ~/k.json
shred -u ~/k.json ~/orrery-upload ~/orrery-upload.pub
```

### `data/gcp.json`

The key exactly as Google issues it, optionally with a `projects` list. Without it, Orrery manages only the key's own project.

```json
{ "type": "service_account", "project_id": "my-project-123", "client_email": "...", "private_key": "...", "projects": ["my-project-123", "my-other-project-456"] }
```

### Adding more projects

The same service account can manage other projects, even in another Google account.

1. In Cloud Shell, enable the API in the other project and grant the existing account the same roles:

   ```bash
   SA=orrery@my-project-123.iam.gserviceaccount.com; P=my-other-project-456
   gcloud services enable compute.googleapis.com --project $P
   gcloud projects add-iam-policy-binding $P --member serviceAccount:$SA --role roles/compute.instanceAdmin.v1 --condition=None -q >/dev/null
   gcloud projects add-iam-policy-binding $P --member serviceAccount:$SA --role roles/iam.serviceAccountUser --condition=None -q >/dev/null
   ```

2. Add the project to `gcp.json` without printing the key:

   ```bash
   cd ~/orrery/deploy
   docker compose run --rm orrery node -e '
     const fs = require("fs"), f = "/data/gcp.json", k = JSON.parse(fs.readFileSync(f, "utf8"));
     k.projects = [...new Set([...(k.projects || [k.project_id]), "my-other-project-456"])];
     fs.writeFileSync(f, JSON.stringify(k, null, 2) + "\n", { mode: 0o600 });'
   ```

3. Check `cloud_providers`. A mistyped project id returns 404; missing roles return 403.

A project with domain-restricted sharing (`iam.allowedPolicyMemberDomains`) cannot grant roles to an outside account. To remove a project, delete its two role bindings and remove it from `projects`.

### What it can and cannot reach

- It manages everything Compute Engine offers in the configured projects.
- It cannot reach billing, IAM grants, service account keys, project deletion or other services. The roles, the token scope (`auth/compute`) and the code all enforce this.
- **One way around it.** `roles/iam.serviceAccountUser` allows creating an instance that runs as the default compute service account with the `cloud-platform` scope. That account often has Editor, so code on the instance could use other services and spend money. Remove Editor from the default compute service account. Keep `serviceAccountUser` on `orrery`, or onboarding breaks.

**Rotate or revoke.** IAM → Service accounts → `orrery` → Keys: delete the old key, then create and send a new one. To stop all access, delete the service account.

## Alibaba Cloud

The RPC-style OpenAPI of the China site (aliyun.com), signed in the code (HMAC-SHA1).

| `service` | API version | Covers |
| --- | --- | --- |
| `ecs` | 2014-05-26 | Instances, disks, snapshots, images, security groups, Cloud Assistant (regional) |
| `vpc` | 2016-04-28 | VPCs, vSwitches, elastic IPs (regional) |
| `alidns` | 2015-01-09 | DNS records |
| `domain` | 2018-01-29 | Domains: list, details, renewal, name servers |
| `cdn` | 2018-05-10 | CDN domains, configuration, certificates, refresh and prefetch, usage |
| `cas` | 2020-04-07 | SSL certificates |
| `bss` | 2017-12-14 | Billing: balance and bills, **read-only** |

Another RPC-style product (SLB, RDS) is one more entry in `SERVICES` in `providers/aliyun/index.js`, plus its RAM policy. OSS uses a REST API and is not covered.

### RAM user and policies

Create a RAM user `orrery` with the system policies you need: `AliyunECSFullAccess`, `AliyunVPCFullAccess`, `AliyunDNSFullAccess`, `AliyunDomainFullAccess`, `AliyunCDNFullAccess`, `AliyunYundunCertFullAccess`, `AliyunBSSReadOnlyAccess`. The user gets no RAM management, payments or OSS. If `DescribeEipAddresses` returns `Forbidden.RAM`, also attach an EIP policy.

In Alibaba Cloud's Cloud Shell:

```bash
aliyun ram CreateUser --UserName orrery --DisplayName "Orrery" >/dev/null
for p in AliyunECSFullAccess AliyunVPCFullAccess AliyunDNSFullAccess AliyunDomainFullAccess AliyunCDNFullAccess AliyunYundunCertFullAccess AliyunBSSReadOnlyAccess; do
  aliyun ram AttachPolicyToUser --PolicyType System --PolicyName $p --UserName orrery >/dev/null || echo "failed: $p"
done
```

Attaching sometimes fails with `ServerError.500`: run it again. New permissions take a while to apply. `aliyun ram ListPoliciesForUser --UserName orrery` shows what is attached.

### Create the AccessKey and send it

With the upload key set up for `aliyun.json`:

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

`regions` is optional: `"all"` (or missing) lists every region every minute; a list such as `["cn-hangzhou"]` limits discovery.

### Notes

- `aliyun_delete` releases pay-as-you-go instances only. Unsubscribe subscription (PrePaid) instances in the console first.
- Calls on a protected instance must carry the region it is in ([security.md](security.md#refused-by-the-code)).
- **Not refused:** actions that spend money (renewals, buying domains, adding CDN domains) and deleting DNS records or CDN domains. Keep approval on for `aliyun_call`.

**Rotate or revoke.** RAM console → Users → `orrery` → AccessKey: disable and delete the old key, then create and send a new one.

## Vultr

Vultr API v2 (`https://api.vultr.com/v2`). `vultr_api_request` reaches the whole account.

### Create the API key

1. Vultr → Account → API → Enable API. A sub-user (Account → Users) with fewer permissions gets a weaker key.
2. In **Access Control**, allow only the Orrery host's IPv4 as `/32` (such as `198.51.100.20/32`). The container uses IPv4, so no IPv6 entry is needed. A leaked key is then useless elsewhere.
3. Write it on the host:

   ```bash
   cd ~/orrery/deploy
   (umask 077; read -rsp "Vultr API key: " K && printf '{"apiKey":"%s"}\n' "$K" > data/vultr.json && unset K)
   chown 1000:1000 data/vultr.json
   ```

### Notes

- The `kvm` console URL is redacted because its token opens the server's screen and keyboard without a Vultr login, one reboot away from root.
- The API cannot install a key on a running instance. Pass `sshkey_id` at creation.

**Rotate or revoke.** Account → API → Regenerate, then write the new key.

## DigitalOcean

DigitalOcean API v2 (`https://api.digitalocean.com/v2`). `digitalocean_api_request` reaches the whole account.

### Create the token

API → Tokens → Generate New Token. Name `orrery`, No expiry, Full Access or custom scopes (discovery needs Droplet read). **A DigitalOcean token cannot be limited to an IP address.** Keep it only on the Orrery host.

```bash
cd ~/orrery/deploy
(umask 077; read -rsp "DigitalOcean token: " T && printf '{"token":"%s"}\n' "$T" > data/digitalocean.json && unset T)
chown 1000:1000 data/digitalocean.json
```

The API cannot install a key on a running Droplet. Pass `ssh_keys` at creation.

**Rotate or revoke.** API → Tokens: delete the old token, generate a new one and write it again.

## Kamatera

Kamatera's cloudcli API (`https://cloudcli.cloudwm.com`), with `AuthClientId` and `AuthSecret` headers.

### Create the API key

Kamatera console → API → Keys → create a key `orrery`. If offered, restrict it to the Orrery host's IPv4.

```bash
cd ~/orrery/deploy
(umask 077; read -rp "Kamatera client id: " I && read -rsp "Kamatera secret: " S \
  && printf '{"clientId":"%s","secret":"%s"}\n' "$I" "$S" > data/kamatera.json && unset I S)
chown 1000:1000 data/kamatera.json
```

### How the cloudcli API works

- Most calls are POSTs that name the server in the body. Use `"id"`: Kamatera treats `"name"` as a regular expression, so Orrery refuses `name` on server actions.
- Changes are queued and answer with command ids: `kamatera_query` `GET /service/queue?id=<id>`.
- Useful reads: datacenters `GET /service/server?datacenter=1`, options `GET /service/server?capabilities=1&datacenter=<code>`, images `GET /service/server?images=1&datacenter=<code>`. `/service/server/options/datacenters` returns 500.
- `kamatera_query` allows any GET plus the read-only POSTs `/service/server/info`, `/service/server/options/images`, `/server/history`, `/server/statistics` and `/server/report`.
- The API cannot install a key on a running server. Paste the `ssh_bootstrap` command in the web console (reset the root password there first if needed). For new servers, see "Kamatera key and create quirks" in [architecture.md](architecture.md#9-known-pitfalls).

### Billing

At the time of writing (check Kamatera's billing FAQ): hourly servers are billed per minute plus traffic per GB, and a powered-off server still pays for disk and IP (`priceHourlyOff`). Monthly servers are billed for the whole month on the first. Switch to monthly, without a stop, with `kamatera_api_request` `POST /server/configure` and `{"id": "...", "billingcycle": "monthly", "monthlypackage": "<package>"}`. The API shows server prices (`kamatera_servers`) and monthly traffic (`kamatera_query` `POST /server/report` with `{"id", "year", "month"}`), but no balance or invoices.

**Rotate or revoke.** API → Keys: delete the old key, create a new one and write it again.
