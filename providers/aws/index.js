// AWS for Orrery, on the official AWS SDK for JavaScript v3.
// Read tools (every agent): EC2 and Lightsail instances in every enabled region (or the configured ones), CloudWatch CPU,
// and optionally a Cost Explorer month-to-date estimate.
// Control tools (only the admin agent, ORRERY_ROLE=admin): start, stop, reboot, terminate/delete,
// and any other EC2 or Lightsail API call. What the keys may do is decided by their IAM policy (docs/providers.md).
import fs from "node:fs";
import path from "node:path";
import * as ec2 from "@aws-sdk/client-ec2";
import * as lightsail from "@aws-sdk/client-lightsail";
import { EC2InstanceConnectClient, SendSSHPublicKeyCommand } from "@aws-sdk/client-ec2-instance-connect";
import { CloudWatchClient, GetMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { CostExplorerClient, GetCostAndUsageCommand } from "@aws-sdk/client-cost-explorer";

export const id = "aws";
export const name = "AWS";

const REGION = /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/;
const COST_TTL_MS = 6 * 3600 * 1000; // every Cost Explorer request is billed (USD 0.01), so ask rarely

const splitList = (s) => s?.split(/[\s,]+/).filter(Boolean);
const list = (v) => (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]);
const iso = (d) => (d instanceof Date ? d.toISOString() : d || null);

// Credentials come from the environment or $ORRERY_DIR/aws.json, never from the repo or the page.
export function loadConfig(env = process.env, dataDir) {
  let file = {};
  const filePath = dataDir && path.join(dataDir, "aws.json");
  try {
    file = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT" && filePath) return { configured: false, error: `${filePath}: ${e.code ? e.message : "not valid JSON"}` }; // never echo file content
  }
  const fromEnv = !!env.AWS_ACCESS_KEY_ID;
  const credentials = {
    accessKeyId: fromEnv ? env.AWS_ACCESS_KEY_ID : file.accessKeyId,
    secretAccessKey: fromEnv ? env.AWS_SECRET_ACCESS_KEY : file.secretAccessKey,
    sessionToken: (fromEnv ? env.AWS_SESSION_TOKEN : file.sessionToken) || undefined,
  };
  if (!credentials.accessKeyId || !credentials.secretAccessKey) return { configured: false };
  // No regions (or "all") means every region enabled in the account, looked up at run time.
  const regions = (splitList(env.AWS_REGIONS) || list(file.regions)).filter((r) => r !== "all");
  const bad = regions.filter((r) => !REGION.test(r));
  if (bad.length) return { configured: false, error: `Invalid AWS region: ${bad.join(", ")}` };
  const cost = env.AWS_COST_EXPLORER !== undefined ? env.AWS_COST_EXPLORER === "1" : file.costExplorer === true;
  const lightsail = env.AWS_LIGHTSAIL !== undefined ? env.AWS_LIGHTSAIL !== "0" : file.lightsail !== false;
  return { configured: true, credentials, regions: regions.length ? [...new Set(regions)] : "all", cost, lightsail };
}

// One client per service and region, shared across requests. `config.sdk` lets tests inject a request handler.
const clientCache = new Map();
function client(config, Kind, region) {
  if (config.sdk) return new Kind({ region, credentials: config.credentials, maxAttempts: 1, ...config.sdk });
  const key = `${Kind.name}|${region}|${config.credentials.accessKeyId}`;
  if (!clientCache.has(key)) clientCache.set(key, new Kind({ region, credentials: config.credentials, maxAttempts: 2 }));
  return clientCache.get(key);
}

export const errorText = (e) => (e?.name && e.name !== "Error" ? `${e.name}: ${e.message}` : e?.message || String(e));
const denied = (e) => /AccessDenied|UnauthorizedOperation|NotAuthorized/i.test(e?.name || "") || e?.$metadata?.httpStatusCode === 403;

// ---------- EC2 ----------
export function toEc2(i, region) {
  const tags = Object.fromEntries(list(i.Tags).map((t) => [t.Key, t.Value]));
  return {
    id: i.InstanceId,
    service: "ec2",
    name: tags.Name || null,
    region,
    zone: i.Placement?.AvailabilityZone || null,
    state: i.State?.Name || "unknown",
    type: i.InstanceType || null,
    publicIp: i.PublicIpAddress || null,
    privateIp: i.PrivateIpAddress || null,
    ipv6: i.Ipv6Address || null,
    launchTime: iso(i.LaunchTime),
    platform: i.PlatformDetails || i.Platform || null,
    architecture: i.Architecture || null,
    keyName: i.KeyName || null,
  };
}

async function ec2Instances(config, region) {
  const out = [];
  for await (const page of ec2.paginateDescribeInstances({ client: client(config, ec2.EC2Client, region), pageSize: 1000 }, {})) {
    for (const r of list(page.Reservations)) for (const i of list(r.Instances)) out.push(toEc2(i, region));
  }
  return out;
}

// ---------- Lightsail ----------
export function toLightsail(i, region) {
  return {
    id: i.name,
    service: "lightsail",
    name: i.name,
    region,
    zone: i.location?.availabilityZone || null,
    state: i.state?.name || "unknown",
    type: i.bundleId || null,
    publicIp: i.publicIpAddress || null,
    privateIp: i.privateIpAddress || null,
    ipv6: list(i.ipv6Addresses)[0] || null,
    launchTime: iso(i.createdAt),
    platform: i.blueprintName || null,
    architecture: null,
    keyName: i.sshKeyName || null,
  };
}

async function lightsailInstances(config, region) {
  const out = [];
  let pageToken;
  for (let n = 0; n < 50; n++) {
    const page = await client(config, lightsail.LightsailClient, region).send(new lightsail.GetInstancesCommand(pageToken ? { pageToken } : {}));
    out.push(...list(page.instances).map((i) => toLightsail(i, region)));
    pageToken = page.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}

// ---------- CloudWatch ----------
async function cpuByInstance(config, region, ids) {
  const out = {};
  const end = new Date();
  const start = new Date(end.getTime() - 30 * 60 * 1000);
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const res = await client(config, CloudWatchClient, region).send(
      new GetMetricDataCommand({
        StartTime: start,
        EndTime: end,
        ScanBy: "TimestampDescending",
        MetricDataQueries: chunk.map((id, n) => ({
          Id: `m${n}`,
          MetricStat: { Metric: { Namespace: "AWS/EC2", MetricName: "CPUUtilization", Dimensions: [{ Name: "InstanceId", Value: id }] }, Period: 300, Stat: "Average" },
          ReturnData: true,
        })),
      }),
    );
    const byId = Object.fromEntries(list(res.MetricDataResults).map((r) => [r.Id, list(r.Values)[0]]));
    chunk.forEach((id, n) => (out[id] = byId[`m${n}`] == null ? null : Math.round(byId[`m${n}`] * 10) / 10));
  }
  return out;
}

// ---------- regions ----------
const REGIONS_TTL_MS = 3600 * 1000;
const regionCache = new Map(); // accessKeyId -> { at, promise }

// EC2 regions enabled for the account, and the subset where Lightsail exists.
export async function resolveRegions(config) {
  if (config.regions !== "all") return { ec2: config.regions, lightsail: new Set(config.regions) };
  const key = config.credentials.accessKeyId;
  const hit = !config.sdk && regionCache.get(key);
  if (hit && Date.now() - hit.at < REGIONS_TTL_MS) return hit.promise;
  const promise = (async () => {
    const res = await client(config, ec2.EC2Client, "us-east-1").send(new ec2.DescribeRegionsCommand({}));
    const enabled = list(res.Regions).map((r) => r.RegionName).filter((r) => REGION.test(r)).sort();
    let ls = new Set();
    if (config.lightsail) {
      try {
        const lr = await client(config, lightsail.LightsailClient, "us-east-1").send(new lightsail.GetRegionsCommand({}));
        ls = new Set(list(lr.regions).map((r) => r.name));
      } catch {
        ls = new Set(enabled); // fall back to asking every region
      }
    }
    return { ec2: enabled, lightsail: ls };
  })();
  regionCache.set(key, { at: Date.now(), promise });
  promise.catch(() => regionCache.delete(key));
  return promise;
}

// ---------- tool bodies ----------
export async function instances(config, { matchHosts } = {}) {
  const where = await resolveRegions(config);
  const regions = await Promise.all(
    where.ec2.map(async (region) => {
      const r = { region, instances: [], error: null, lightsailError: null };
      const wantLightsail = config.lightsail && where.lightsail.has(region);
      const [e, l] = await Promise.allSettled([ec2Instances(config, region), wantLightsail ? lightsailInstances(config, region) : Promise.resolve([])]);
      if (e.status === "fulfilled") r.instances.push(...e.value);
      else r.error = errorText(e.reason);
      if (l.status === "fulfilled") r.instances.push(...l.value);
      else r.lightsailError = errorText(l.reason);
      return r;
    }),
  );
  if (regions.every((r) => r.error && (!config.lightsail || !where.lightsail.has(r.region) || r.lightsailError))) {
    throw new Error(regions.map((r) => `${r.region}: ${r.error}`).join("; "));
  }

  const cpu = { status: "ok", error: null };
  await Promise.all(
    regions.map(async (r) => {
      const running = r.instances.filter((i) => i.service === "ec2" && i.state === "running").map((i) => i.id);
      if (!running.length) return;
      try {
        const values = await cpuByInstance(config, r.region, running);
        for (const i of r.instances) if (i.id in values) i.cpuPercent = values[i.id];
      } catch (e) {
        cpu.status = denied(e) ? "denied" : "error";
        cpu.error = errorText(e);
      }
    }),
  );
  const all = regions.flatMap((r) => r.instances);
  const match = matchHosts ? await matchHosts() : () => null;
  for (const i of all) {
    i.cpuPercent ??= null;
    i.server = match([i.publicIp, i.ipv6].filter(Boolean));
  }
  return {
    regions: regions.map((r) => ({ region: r.region, count: r.instances.length, error: r.error, lightsailError: r.lightsailError })),
    instances: all,
    cpu,
    collectedAt: new Date().toISOString(),
  };
}

export function parseCost(res, period) {
  const byTime = res.ResultsByTime?.[0] || {};
  const services = (byTime.Groups || [])
    .map((g) => ({ service: g.Keys?.[0] || "?", amount: Number(g.Metrics?.UnblendedCost?.Amount || 0), unit: g.Metrics?.UnblendedCost?.Unit || "USD" }))
    .filter((s) => Math.abs(s.amount) >= 0.005)
    .sort((a, b) => b.amount - a.amount);
  const total = services.reduce((n, s) => n + s.amount, 0);
  return { ...period, currency: services[0]?.unit || "USD", total: Math.round(total * 100) / 100, estimated: byTime.Estimated !== false, services };
}

// Month to date (End is exclusive); on the 1st, the previous full month.
export function costPeriod(now = new Date()) {
  const ymd = (d) => d.toISOString().slice(0, 10);
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (today.getTime() === first.getTime()) {
    return { start: ymd(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))), end: ymd(first), monthToDate: false };
  }
  return { start: ymd(first), end: ymd(today), monthToDate: true };
}

const costCache = new Map(); // accessKeyId -> { at, promise }

export async function cost(config) {
  const key = config.credentials.accessKeyId;
  const hit = costCache.get(key);
  if (hit && Date.now() - hit.at < COST_TTL_MS) return hit.promise;
  const period = costPeriod();
  const promise = client(config, CostExplorerClient, "us-east-1")
    .send(
      new GetCostAndUsageCommand({
        TimePeriod: { Start: period.start, End: period.end },
        Granularity: "MONTHLY",
        Metrics: ["UnblendedCost"],
        GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
      }),
    )
    .then((res) => ({ ...parseCost(res, period), collectedAt: new Date().toISOString() }))
    .catch((e) => {
      throw new Error(errorText(e));
    });
  costCache.set(key, { at: Date.now(), promise });
  promise.catch(() => costCache.delete(key));
  return promise;
}

// ---------- control (admin agent only) ----------
// Calls that have a dedicated tool with a name confirmation are not reachable through aws_call.
const GUARDED = { ec2: ["TerminateInstances"], lightsail: ["DeleteInstance"] };
// Operations whose answer is a password, secret key or private key: a tool result lands in the chat, so
// aws_call refuses them. (ssh_bootstrap uses GetInstanceAccessDetails internally and never returns the key.)
const SECRET_OPS = {
  ec2: ["GetPasswordData", "CreateKeyPair", "ExportVerifiedAccessInstanceClientConfiguration", "GetVpnConnectionDeviceSampleConfiguration"],
  lightsail: ["GetInstanceAccessDetails", "DownloadDefaultKeyPair", "CreateKeyPair", "GetRelationalDatabaseMasterUserPassword", "CreateBucketAccessKey", "CreateContainerServiceRegistryLogin"],
};
// Members that hold a secret inside otherwise ordinary answers (VPN pre-shared keys, OIDC client secrets,
// a pending database password, bucket keys): replaced before an aws_call result reaches the chat.
const SECRET_FIELDS = /^(password|passwordData|masterUserPassword|secretAccessKey|privateKey|privateKeyBase64|certKey|KeyMaterial|PreSharedKey|CustomerGatewayConfiguration|ClientSecret)$/i;
// Operations that erase an instance's disk without a name confirmation: left to the AWS console.
const CONSOLE_ONLY = { ec2: ["CreateReplaceRootVolumeTask"], lightsail: [] };
const SDK = { ec2: [ec2, ec2.EC2Client], lightsail: [lightsail, lightsail.LightsailClient] };
const summarizeEc2 = (changes) => list(changes).map((x) => ({ instanceId: x.InstanceId, from: x.PreviousState?.Name, to: x.CurrentState?.Name }));
const summarizeOps = (ops) => list(ops).map((o) => ({ id: o.id, type: o.operationType, status: o.status, resource: o.resourceName, error: o.errorDetails || null }));

export const redactSecrets = (v) =>
  Array.isArray(v)
    ? v.map(redactSecrets)
    : v && Object.getPrototypeOf(v) === Object.prototype
      ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_FIELDS.test(k) && x != null && x !== "" ? "[redacted]" : redactSecrets(x)]))
      : v;

// ORRERY_SELF_IP (the middle server) plus ORRERY_PROTECTED_IPS (comma list, such as the user's
// proxy): instances a chat may start but never stop, reboot, terminate, delete or change.
export const protectedIps = (env = process.env) =>
  [...new Set([env.ORRERY_SELF_IP, ...String(env.ORRERY_PROTECTED_IPS || "").split(/[\s,]+/)].map((ip) => String(ip || "").trim().toLowerCase()).filter(Boolean))];

const protectedIp = (config, ips) => list(ips).map((ip) => String(ip || "").toLowerCase()).find((ip) => ip && (config.protectedIps || []).includes(ip)) || null;
const refuseProtected = (what, ip) =>
  new Error(`Refusing: ${what} has the protected IP ${ip} (ORRERY_SELF_IP or ORRERY_PROTECTED_IPS) and must keep running. Do this in the AWS console if you really mean it.`);
const ec2Ips = (i) => [i.PublicIpAddress, i.Ipv6Address, ...list(i.NetworkInterfaces).flatMap((n) => [n.Association?.PublicIp, ...list(n.Ipv6Addresses).map((a) => a.Ipv6Address)])];

async function assertEc2NotProtected(config, region, instanceIds) {
  if (!config.protectedIps?.length || !instanceIds.length) return;
  const res = await client(config, ec2.EC2Client, region).send(new ec2.DescribeInstancesCommand({ InstanceIds: instanceIds }));
  for (const i of list(res.Reservations).flatMap((r) => list(r.Instances))) {
    const ip = protectedIp(config, ec2Ips(i));
    if (ip) throw refuseProtected(`EC2 instance ${i.InstanceId}`, ip);
  }
}

// A static IP shows as the instance's publicIpAddress, so it is covered too.
async function assertLightsailNotProtected(config, region, instanceName) {
  if (!config.protectedIps?.length) return;
  let instance;
  try {
    ({ instance } = await client(config, lightsail.LightsailClient, region).send(new lightsail.GetInstanceCommand({ instanceName })));
  } catch (e) {
    if (e?.name === "NotFoundException") return; // a name that does not exist yet (CreateInstances): nothing to protect
    throw e;
  }
  const ip = protectedIp(config, [instance?.publicIpAddress, ...list(instance?.ipv6Addresses)]);
  if (ip) throw refuseProtected(`Lightsail instance ${instanceName}`, ip);
}

// aws_call leaves protected instances alone: reading, starting and snapshotting them is all it does.
async function assertCallAllowed(config, { service, region, operation, input }) {
  if (!config.protectedIps?.length || /^(Get|Describe|Is|List)/.test(operation) || /^(StartInstances?|CreateInstanceSnapshot)$/.test(operation)) return;
  if (service === "ec2") return assertEc2NotProtected(config, region, [...list(input.InstanceIds), ...list(input.InstanceId)].map(String));
  // resourceName names an instance in calls such as SetIpAddressType (which can drop its public IPv4);
  // a name that is not an instance comes back NotFound and is let through.
  const names = [...list(input.instanceName), ...list(input.instanceNames), ...(input.resourceName && (!input.resourceType || input.resourceType === "Instance") ? [input.resourceName] : [])];
  for (const name of names) await assertLightsailNotProtected(config, region, String(name));
  // Attaching a static IP that a protected instance holds would move it away from that instance.
  if (["AttachStaticIp", "DetachStaticIp", "ReleaseStaticIp"].includes(operation) && input.staticIpName) {
    const { staticIp } = await client(config, lightsail.LightsailClient, region).send(new lightsail.GetStaticIpCommand({ staticIpName: String(input.staticIpName) }));
    const ip = protectedIp(config, [staticIp?.ipAddress]);
    if (ip) throw refuseProtected(`static IP ${input.staticIpName}`, ip);
    if (staticIp?.attachedTo) await assertLightsailNotProtected(config, region, staticIp.attachedTo);
  }
}

export async function ec2Power(config, { region, instanceId, action, force }) {
  const c = client(config, ec2.EC2Client, region);
  const ids = { InstanceIds: [instanceId] };
  if (action !== "start") await assertEc2NotProtected(config, region, [instanceId]);
  if (action === "start") return summarizeEc2((await c.send(new ec2.StartInstancesCommand(ids))).StartingInstances);
  if (action === "stop") return summarizeEc2((await c.send(new ec2.StopInstancesCommand({ ...ids, Force: !!force }))).StoppingInstances);
  if (action === "reboot") {
    await c.send(new ec2.RebootInstancesCommand(ids));
    return [{ instanceId, rebooting: true }];
  }
  throw new Error(`Unknown action ${action}`);
}

export async function ec2Terminate(config, { region, instanceId, confirmName }) {
  const c = client(config, ec2.EC2Client, region);
  const found = list((await c.send(new ec2.DescribeInstancesCommand({ InstanceIds: [instanceId] }))).Reservations).flatMap((r) => list(r.Instances));
  if (!found.length) throw new Error(`Instance ${instanceId} not found in ${region}`);
  const inst = toEc2(found[0], region);
  const names = [inst.id, inst.name].filter(Boolean);
  if (!names.includes(String(confirmName || "").trim())) throw new Error(`Refusing: confirmName must be ${names.map((n) => `"${n}"`).join(" or ")}.`);
  const ip = protectedIp(config, ec2Ips(found[0]));
  if (ip) throw refuseProtected(`EC2 instance ${instanceId}`, ip);
  return summarizeEc2((await c.send(new ec2.TerminateInstancesCommand({ InstanceIds: [instanceId] }))).TerminatingInstances);
}

export async function lightsailPower(config, { region, instanceName, action, force }) {
  const make = {
    start: () => new lightsail.StartInstanceCommand({ instanceName }),
    stop: () => new lightsail.StopInstanceCommand({ instanceName, force: !!force }),
    reboot: () => new lightsail.RebootInstanceCommand({ instanceName }),
  }[action];
  if (!make) throw new Error(`Unknown action ${action}`);
  if (action !== "start") await assertLightsailNotProtected(config, region, instanceName);
  return summarizeOps((await client(config, lightsail.LightsailClient, region).send(make())).operations);
}

export async function lightsailDelete(config, { region, instanceName, confirmName }) {
  if (String(confirmName || "").trim() !== instanceName) throw new Error(`Refusing: confirmName must be "${instanceName}".`);
  await assertLightsailNotProtected(config, region, instanceName);
  return summarizeOps((await client(config, lightsail.LightsailClient, region).send(new lightsail.DeleteInstanceCommand({ instanceName }))).operations);
}

// Any EC2 or Lightsail API operation by its API name (e.g. DescribeImages, RunInstances, CreateInstances).
export async function call(config, { service, region, operation, input = {} }) {
  const [mod, Kind] = SDK[service] || [];
  if (!mod) throw new Error("service must be ec2 or lightsail");
  if (!/^[A-Z][A-Za-z0-9]+$/.test(operation)) throw new Error("operation must be an API name such as DescribeInstances");
  if (GUARDED[service].includes(operation)) throw new Error(`Use the dedicated tool for ${operation}; it asks for the instance name first.`);
  if (SECRET_OPS[service].includes(operation)) throw new Error(`${operation} returns a password, secret key or private key, which must not end up in the chat. For key pairs, use ImportKeyPair with your own public key instead.`);
  if (CONSOLE_ONLY[service].includes(operation)) throw new Error(`${operation} replaces an instance's root volume and erases its data; do it in the AWS console.`);
  const Command = mod[`${operation}Command`];
  if (typeof Command !== "function") throw new Error(`${service} has no operation ${operation}`);
  await assertCallAllowed(config, { service, region, operation, input });
  const { $metadata, ...result } = await client(config, Kind, region).send(new Command(input));
  return { service, region, operation, requestId: $metadata?.requestId || null, result: redactSecrets(result) };
}

// aws_query: reads only (Describe*, Get*, List*), with aws_call's refusals and redaction.
export async function query(config, a) {
  if (!/^(Describe|Get|List)[A-Z][A-Za-z0-9]*$/.test(a?.operation || "")) throw new Error("aws_query only runs Describe*, Get* and List* operations; use aws_call for changes.");
  return call(config, a);
}

// ---------- SSH bootstrap (used by the agent's ssh_bootstrap, never exposed as tools) ----------
// EC2 Instance Connect: the instance accepts `publicKey` for `osUser` during the next 60 seconds.
export async function sendSshPublicKey(config, { region, instanceId, zone, osUser, publicKey }) {
  const res = await client(config, EC2InstanceConnectClient, region).send(
    new SendSSHPublicKeyCommand({ InstanceId: instanceId, InstanceOSUser: osUser, SSHPublicKey: publicKey, ...(zone ? { AvailabilityZone: zone } : {}) }),
  );
  if (res.Success === false) throw new Error(`EC2 Instance Connect refused the key for ${osUser}@${instanceId}`);
}

// Lightsail's short-lived SSH login (a private key plus an OpenSSH certificate). The result holds a
// private key: callers must keep it out of tool results and logs.
export async function lightsailAccess(config, { region, instanceName }) {
  const res = await client(config, lightsail.LightsailClient, region).send(new lightsail.GetInstanceAccessDetailsCommand({ instanceName, protocol: "ssh" }));
  const d = res.accessDetails || {};
  if (!d.privateKey || !d.certKey || !d.ipAddress) throw new Error(`Lightsail returned no SSH access details for ${instanceName}`);
  return { username: d.username, host: d.ipAddress, privateKey: d.privateKey, certificate: d.certKey };
}

// ---------- registration ----------
export function register(server, { z, tool, adminTool, READ, DESTRUCTIVE, admin, env, dataDir, matchHosts }) {
  const config = loadConfig(env, dataDir);
  if (!config.configured) return { id, name, configured: false, error: config.error || null, tools: [] };
  const tools = [];
  const add = (toolName, spec, handler) => {
    server.registerTool(toolName, spec, handler);
    tools.push(toolName);
  };

  add("aws_instances", {
    title: "AWS instances",
    description: `EC2${config.lightsail ? " and Lightsail" : ""} instances in ${config.regions === "all" ? "every enabled region" : config.regions.join(", ")}: state, type or bundle, public/private IP, launch time and recent CloudWatch CPU (EC2). Each carries the matching Orrery server (by public IP), if any.`,
    annotations: READ,
  }, tool(() => instances(config, { matchHosts })));
  if (config.cost) {
    add("aws_cost", {
      title: "AWS cost estimate",
      description: "Cost Explorer: unblended cost for the current month to date, by service. Cached for 6 hours (each Cost Explorer request is billed).",
      annotations: READ,
    }, tool(() => cost(config)));
  }
  if (!admin) return { id, name, configured: true, regions: config.regions, tools };

  // The control tools refuse to stop, reboot, terminate, delete or change an instance with a protected IP.
  const ctl = { ...config, protectedIps: protectedIps(env) };
  const REGION_ARG = z.string().regex(REGION, "AWS region such as ap-northeast-1").describe("Region of the instance (from aws_instances)");
  const EC2_ID = z.string().regex(/^i-[0-9a-f]{8,17}$/, "EC2 instance id such as i-0123456789abcdef0");
  add("aws_ec2_power", {
    title: "Start, stop or reboot an EC2 instance",
    description: "start, stop or reboot one EC2 instance. force=true with stop skips the operating system shutdown. An instance with a protected IP can only be started.",
    inputSchema: { region: REGION_ARG, instanceId: EC2_ID, action: z.enum(["start", "stop", "reboot"]), force: z.boolean().optional() },
    annotations: DESTRUCTIVE,
  }, adminTool("aws_ec2_power", (a) => ec2Power(ctl, a)));
  add("aws_ec2_terminate", {
    title: "Terminate an EC2 instance",
    description: "Permanently terminate one EC2 instance. confirmName must repeat its instance id or Name tag. Instances with a protected IP are refused.",
    inputSchema: { region: REGION_ARG, instanceId: EC2_ID, confirmName: z.string() },
    annotations: DESTRUCTIVE,
  }, adminTool("aws_ec2_terminate", (a) => ec2Terminate(ctl, a)));
  if (config.lightsail) {
    add("aws_lightsail_power", {
      title: "Start, stop or reboot a Lightsail instance",
      description: "start, stop or reboot one Lightsail instance. force=true with stop skips the operating system shutdown. An instance with a protected IP can only be started.",
      inputSchema: { region: REGION_ARG, instanceName: z.string().min(1).max(255), action: z.enum(["start", "stop", "reboot"]), force: z.boolean().optional() },
      annotations: DESTRUCTIVE,
    }, adminTool("aws_lightsail_power", (a) => lightsailPower(ctl, a)));
    add("aws_lightsail_delete", {
      title: "Delete a Lightsail instance",
      description: "Permanently delete one Lightsail instance. confirmName must repeat the instance name. Instances with a protected IP are refused.",
      inputSchema: { region: REGION_ARG, instanceName: z.string().min(1).max(255), confirmName: z.string() },
      annotations: DESTRUCTIVE,
    }, adminTool("aws_lightsail_delete", (a) => lightsailDelete(ctl, a)));
  }
  add("aws_call", {
    title: "Call any EC2 or Lightsail API",
    description:
      "Run any EC2 or Lightsail API operation through the official AWS SDK, for example ec2 DescribeImages, ec2 RunInstances, ec2 CreateSnapshot, lightsail GetBundles or lightsail CreateInstances. operation is the API name and input its request object as in the AWS API reference. TerminateInstances and DeleteInstance go through their own tools; operations that return passwords or keys, and CreateReplaceRootVolumeTask, are refused, and instances with a protected IP can only be read or started. Can change or delete resources.",
    inputSchema: {
      service: z.enum(config.lightsail ? ["ec2", "lightsail"] : ["ec2"]),
      region: REGION_ARG,
      operation: z.string(),
      input: z.record(z.string(), z.any()).optional(),
    },
    annotations: DESTRUCTIVE,
  }, adminTool("aws_call", (a) => call(ctl, a)));
  add("aws_query", {
    title: "Read any EC2 or Lightsail API",
    description:
      "Read-only twin of aws_call: run any EC2 or Lightsail operation whose name starts with Describe, Get or List, for example ec2 DescribeSecurityGroups, ec2 DescribeImages, ec2 DescribeAddresses, lightsail GetInstancePortStates, lightsail GetStaticIps, lightsail GetBundles. Operations that return passwords or keys are refused and secrets in answers are redacted, as in aws_call. Changes nothing.",
    inputSchema: {
      service: z.enum(config.lightsail ? ["ec2", "lightsail"] : ["ec2"]),
      region: REGION_ARG,
      operation: z.string().regex(/^(Describe|Get|List)[A-Z][A-Za-z0-9]*$/, "a Describe*, Get* or List* operation"),
      input: z.record(z.string(), z.any()).optional(),
    },
    annotations: READ,
  }, tool((a) => query(ctl, a)));
  return { id, name, configured: true, regions: config.regions, tools };
}
