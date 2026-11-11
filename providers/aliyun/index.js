// Alibaba Cloud (Aliyun, China site) for Orrery, through the RPC-style OpenAPI: ECS, VPC, DNS, domains,
// CDN and SSL certificates, plus billing (BssOpenApi) read-only. Aliyun's hosted OpenAPI MCP server reaches
// every API, payments included, with none of the checks below (protected machines, name confirmation, no
// domain transfer-out, no private keys in the chat, audit log), so control lives here: aliyun_instances,
// aliyun_billing and aliyun_query (any read action) for both agents; power, delete and any other call
// only on the admin agent. Requests are signed here (signature version 1.0, HMAC-SHA1), so there is no SDK.
// Another RPC-style product is one more line in SERVICES.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const id = "aliyun";
export const name = "Alibaba Cloud";

// regional: the endpoint and RegionId follow the region; the others have one endpoint for the account.
export const SERVICES = {
  ecs: { version: "2014-05-26", regional: true, host: (region) => (region ? `ecs.${region}.aliyuncs.com` : "ecs.aliyuncs.com"), what: "ECS (instances, disks, snapshots, images, security groups, Cloud Assistant)" },
  vpc: { version: "2016-04-28", regional: true, host: (region) => (region ? `vpc.${region}.aliyuncs.com` : "vpc.aliyuncs.com"), what: "VPC (networks, vSwitches, elastic IPs)" },
  alidns: { version: "2015-01-09", host: () => "alidns.aliyuncs.com", what: "Alibaba Cloud DNS (domain records)" },
  domain: { version: "2018-01-29", host: () => "domain.aliyuncs.com", what: "Domains (registration, renewal, details, name servers)" },
  cdn: { version: "2018-05-10", host: () => "cdn.aliyuncs.com", what: "CDN (domains, configuration, certificates, refresh and prefetch, usage)" },
  cas: { version: "2020-04-07", host: () => "cas.aliyuncs.com", what: "Certificate Management Service (SSL certificates)" },
  bss: { version: "2017-12-14", host: () => "business.aliyuncs.com", readOnly: true, what: "Billing (balance, bills), read-only" },
};
const TIMEOUT_MS = 30000;
const REGION = /^[a-z]{2,3}(-[a-z0-9]+)+$/;
const ACTION = /^[A-Z][A-Za-z0-9]{2,80}$/;
const READ_ACTION = /^(Describe|Query|Get|List)/;

// $ORRERY_DIR/aliyun.json: {"accessKeyId": "...", "accessKeySecret": "...", "regions": "all" | ["cn-beijing", ...]}.
export function loadConfig(env = process.env, dataDir) {
  const file = dataDir && path.join(dataDir, "aliyun.json");
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return e.code === "ENOENT" || !file ? { configured: false } : { configured: false, error: `${file}: ${e.code ? e.message : "not valid JSON"}` }; // never echo file content
  }
  if (!data.accessKeyId || !data.accessKeySecret) return { configured: false, error: `${file}: accessKeyId and accessKeySecret are required` };
  const regions = data.regions && data.regions !== "all" ? [].concat(data.regions).map(String) : "all";
  if (regions !== "all" && regions.some((r) => !REGION.test(r))) return { configured: false, error: `${file}: invalid region in "regions"` };
  return { configured: true, accessKeyId: data.accessKeyId, accessKeySecret: data.accessKeySecret, regions };
}

export class AliyunError extends Error {
  constructor(status, body, service, action) {
    super(`Alibaba Cloud ${service} ${action} failed with ${status}${body?.Code ? `: ${body.Code}` : ""}${body?.Message ? `: ${body.Message}` : ""}`);
    this.status = status;
    this.code = body?.Code || null;
  }
}

// RFC 3986 encoding as the signature wants it: space %20, * %2A, ~ kept.
export const percentEncode = (s) => encodeURIComponent(String(s)).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export function stringToSign(method, params) {
  const canonical = Object.keys(params).sort().map((k) => `${percentEncode(k)}=${percentEncode(params[k])}`).join("&");
  return `${method}&${percentEncode("/")}&${percentEncode(canonical)}`;
}

export const sign = (method, params, secret) => crypto.createHmac("sha1", `${secret}&`).update(stringToSign(method, params)).digest("base64");

// Nested request parameters in the RPC style: {InstanceId: ["a", "b"]} -> InstanceId.1, InstanceId.2;
// {Tag: [{Key: "k"}]} -> Tag.1.Key. Strings, numbers and booleans are passed as they are.
export function flatten(params, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(params || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) v.forEach((item, i) => (item && typeof item === "object" ? flatten(item, `${key}.${i + 1}`, out) : (out[`${key}.${i + 1}`] = String(item))));
    else if (typeof v === "object") flatten(v, key, out);
    else out[key] = String(v);
  }
  return out;
}

const RETRY_STATUS = new Set([500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createApi(config, fetchImpl = fetch, { retryWaitMs = 1000, now = () => new Date(), nonce = () => crypto.randomUUID() } = {}) {
  // service: "ecs" | "bss"; region: the ECS region (endpoint and RegionId), or null.
  async function request(service, region, action, params = {}) {
    const svc = SERVICES[service];
    if (!svc) throw new Error(`Unsupported Alibaba Cloud service ${service}`);
    if (!ACTION.test(String(action))) throw new Error(`Invalid action ${action}`);
    if (region && !REGION.test(region)) throw new Error(`Invalid region ${region}`);
    const all = {
      ...flatten(params),
      ...(region && svc.regional && params.RegionId === undefined ? { RegionId: region } : {}),
      Action: action,
      Format: "JSON",
      Version: svc.version,
      AccessKeyId: config.accessKeyId,
      SignatureMethod: "HMAC-SHA1",
      SignatureVersion: "1.0",
      SignatureNonce: nonce(),
      Timestamp: now().toISOString().replace(/\.\d{3}Z$/, "Z"),
    };
    all.Signature = sign("POST", all, config.accessKeySecret);
    const body = Object.keys(all).map((k) => `${percentEncode(k)}=${percentEncode(all[k])}`).join("&");
    // Reads are retried once on a 5xx or throttling; a change is never sent twice.
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(`https://${svc.host(region)}/`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {}
      if (res.ok && !(json && json.Code && json.Success === false)) return json ?? {};
      const throttled = /Throttling/i.test(json?.Code || "");
      if (READ_ACTION.test(action) && attempt === 0 && (RETRY_STATUS.has(res.status) || throttled)) {
        await sleep(retryWaitMs);
        continue;
      }
      const err = new AliyunError(res.status, json, service, action);
      if (/InvalidAccessKeyId|SignatureDoesNotMatch|IncompleteSignature/i.test(err.code || "")) err.message += " (the AccessKey is wrong, disabled or deleted; see docs/providers.md, Alibaba Cloud)";
      if (/Forbidden|NoPermission/i.test(err.code || "")) err.message += " (the RAM user lacks this permission)";
      throw err;
    }
  }
  return { request };
}

// Every enabled region, or the configured ones.
export async function regions(api, config) {
  if (config.regions !== "all") return config.regions;
  const r = await api.request("ecs", null, "DescribeRegions", { AcceptLanguage: "en-US" });
  return (r.Regions?.Region || []).map((x) => x.RegionId).filter((x) => REGION.test(x));
}

// ECS instance -> the shape the tools return.
export function toInstance(i, region) {
  return {
    id: i.InstanceId,
    name: i.InstanceName || i.InstanceId,
    region,
    zone: i.ZoneId || null,
    status: i.Status || null, // Running, Stopped, Starting, Stopping, Pending
    type: i.InstanceType || null,
    cpu: i.Cpu ?? null,
    memoryMiB: i.Memory ?? null,
    os: i.OSName || null,
    publicIp: i.PublicIpAddress?.IpAddress?.[0] || i.EipAddress?.IpAddress || null,
    privateIp: i.VpcAttributes?.PrivateIpAddress?.IpAddress?.[0] || i.InnerIpAddress?.IpAddress?.[0] || null,
    bandwidthOutMbps: i.InternetMaxBandwidthOut ?? null,
    chargeType: i.InstanceChargeType || null, // PrePaid (subscription) or PostPaid (pay as you go)
    expires: i.ExpiredTime || null,
    created: i.CreationTime || null,
    tags: Object.fromEntries((i.Tags?.Tag || []).map((t) => [t.TagKey, t.TagValue])),
  };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

// Every instance in every region. One region failing is reported in regions[].error and hides nothing else.
export async function instances(api, config, { matchHosts } = {}) {
  const per = await mapLimit(await regions(api, config), 6, async (region) => {
    const list = [];
    try {
      for (let page = 1; page <= 50; page++) {
        const r = await api.request("ecs", region, "DescribeInstances", { PageSize: 100, PageNumber: page });
        const items = r.Instances?.Instance || [];
        list.push(...items.map((i) => toInstance(i, region)));
        if (items.length < 100 || list.length >= (r.TotalCount ?? 0)) break;
      }
      return { region, list, error: null };
    } catch (e) {
      return { region, list, error: e.message };
    }
  });
  const list = per.flatMap((p) => p.list);
  if (list.length === 0 && per.length && per.every((p) => p.error)) throw new Error(per.map((p) => `${p.region}: ${p.error}`).join("; "));
  const match = matchHosts ? await matchHosts() : () => null;
  for (const i of list) i.server = match([i.publicIp].filter(Boolean));
  return { instances: list, regions: per.map(({ region, list, error }) => ({ region, count: list.length, error })).filter((r) => r.count || r.error), collectedAt: new Date().toISOString() };
}

const amount = (v) => (v === undefined || v === null || v === "" ? null : Number(String(v).replace(/,/g, "")));

// Account balance and one month's bill by product (read-only). month: "YYYY-MM", default this month.
export async function billing(api, { month } = {}) {
  const cycle = month || new Date().toISOString().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(cycle)) throw new Error(`Invalid month ${month} (YYYY-MM)`);
  const [bal, bill] = await Promise.all([api.request("bss", null, "QueryAccountBalance"), api.request("bss", null, "QueryBillOverview", { BillingCycle: cycle })]);
  const b = bal.Data || {};
  const items = bill.Data?.Items?.Item || [];
  const byProduct = new Map();
  for (const it of items) {
    const key = `${it.ProductName || it.ProductCode}|${it.SubscriptionType || ""}`;
    const cur = byProduct.get(key) || { product: it.ProductName || it.ProductCode, code: it.ProductCode || null, subscriptionType: it.SubscriptionType || null, pretaxAmount: 0, paid: 0, outstanding: 0 };
    cur.pretaxAmount += amount(it.PretaxAmount) || 0;
    cur.paid += amount(it.PaymentAmount) || 0;
    cur.outstanding += amount(it.OutstandingAmount) || 0;
    byProduct.set(key, cur);
  }
  const products = [...byProduct.values()].map((p) => ({ ...p, pretaxAmount: +p.pretaxAmount.toFixed(2), paid: +p.paid.toFixed(2), outstanding: +p.outstanding.toFixed(2) })).sort((x, y) => y.pretaxAmount - x.pretaxAmount);
  return {
    month: cycle,
    currency: b.Currency || items[0]?.Currency || "CNY",
    balance: { available: amount(b.AvailableAmount), cash: amount(b.AvailableCashAmount), credit: amount(b.CreditAmount) },
    total: +products.reduce((s, p) => s + p.pretaxAmount, 0).toFixed(2),
    outstanding: +products.reduce((s, p) => s + p.outstanding, 0).toFixed(2),
    byProduct: products,
    collectedAt: new Date().toISOString(),
  };
}

// Instance ids a request names, in the ways ECS takes them: InstanceId, InstanceId.N, InstanceIds (a JSON list).
export function instanceIdsIn(params = {}) {
  const flat = flatten(params);
  const ids = Object.entries(flat).filter(([k]) => /^InstanceId(\.\d+)?$/.test(k)).map(([, v]) => v);
  if (flat.InstanceIds) {
    try {
      ids.push(...[].concat(JSON.parse(flat.InstanceIds)).map(String));
    } catch {
      ids.push(flat.InstanceIds);
    }
  }
  return [...new Set(ids.filter(Boolean))];
}

// What the generic tools refuse: deleting instances goes through aliyun_delete (asks for the name); a
// domain is never transferred out or unlocked for transfer, and its transfer code never read; answers that
// carry a private key or a console login token; billing is read-only.
export function guardRequest(service, action) {
  if (!SERVICES[service]) throw new Error(`Unsupported Alibaba Cloud service ${service} (supported: ${Object.keys(SERVICES).join(", ")})`);
  if (SERVICES[service].readOnly && !READ_ACTION.test(action)) throw new Error(`${service} is read-only here: ${action} is refused (only Query*, Describe*, Get*, List*).`);
  if (service === "ecs" && /^DeleteInstances?$/.test(action)) throw new Error("Deleting instances goes through aliyun_delete, which asks for the name.");
  if (service === "ecs" && /^(CreateKeyPair|DescribeInstanceVncUrl)$/.test(action)) throw new Error(`${action} returns a private key or a console login token, which must not end up in the chat; do it in the Aliyun console.`);
  if (service === "domain" && /TransferOut|TransferProhibition|AuthorizationCode/i.test(action)) throw new Error(`${action} would let the domain leave this account or reveals its transfer code; do it in the Aliyun console.`);
  if (service === "cas" && /^(GetUserCertificateDetail|DescribeCertificatePrivateKey|DescribeDownloadCertificate)/.test(action)) throw new Error(`${action} returns a certificate's private key, which must not end up in the chat; download it in the Aliyun console.`);
}

// ORRERY_SELF_IP plus ORRERY_PROTECTED_IPS: instances a chat may start but never stop, reboot,
// delete or change.
export const protectedIps = (env = process.env) =>
  [...new Set([env.ORRERY_SELF_IP, ...String(env.ORRERY_PROTECTED_IPS || "").split(/[\s,]+/)].map((ip) => String(ip || "").trim().toLowerCase()).filter(Boolean))];

export async function getInstances(api, region, ids) {
  const r = await api.request("ecs", region, "DescribeInstances", { InstanceIds: JSON.stringify(ids), PageSize: 100 });
  return (r.Instances?.Instance || []).map((i) => toInstance(i, region));
}

export function assertNotProtected(list, protect) {
  for (const i of list) {
    if (i.publicIp && protect.includes(String(i.publicIp).toLowerCase())) {
      throw new Error(`Refusing: instance ${i.name} (${i.id}, ${i.region}) has the protected IP ${i.publicIp} (ORRERY_SELF_IP or ORRERY_PROTECTED_IPS) and must keep running. Do this in the Aliyun console if you really mean it.`);
    }
  }
}

// ssh_bootstrap: runs a shell script as root through Cloud Assistant (RunCommand) and waits for its output.
// Every public image ships the Cloud Assistant agent; no restart, no password.
export async function runShell(api, { region, instanceId, script, timeoutSec = 60 }, { pollMs = 2000, maxWaitMs = 90000 } = {}) {
  const r = await api.request("ecs", region, "RunCommand", {
    Type: "RunShellScript",
    Name: "orrery",
    CommandContent: Buffer.from(script).toString("base64"),
    ContentEncoding: "Base64",
    Timeout: timeoutSec,
    InstanceId: [instanceId],
  });
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    const d = await api.request("ecs", region, "DescribeInvocationResults", { InvokeId: r.InvokeId, InstanceId: instanceId, ContentEncoding: "PlainText" });
    const res = d.Invocation?.InvocationResults?.InvocationResult?.[0];
    const status = res?.InvocationStatus || res?.InvokeRecordStatus;
    if (res && /^(Success|Failed|Timeout|Error|Aborted|Cancelled|Terminated|Finished)$/.test(status || "")) {
      return { status, exitCode: res.ExitCode ?? null, output: res.Output || "", error: res.ErrorInfo || res.ErrorCode || null };
    }
    if (Date.now() > deadline) throw new Error(`Cloud Assistant command ${r.InvokeId} still ${status || "pending"} after ${Math.round(maxWaitMs / 1000)}s`);
    await sleep(pollMs);
  }
}

export function register(server, { z, tool, adminTool, READ, DESTRUCTIVE, admin, env, dataDir, matchHosts }, fetchImpl = fetch) {
  const config = loadConfig(env, dataDir);
  if (!config.configured) return { id, name, configured: false, error: config.error || null, tools: [] };
  const api = createApi(config, fetchImpl);
  const tools = [];
  const add = (toolName, spec, handler) => {
    server.registerTool(toolName, spec, handler);
    tools.push(toolName);
  };

  add("aliyun_instances", {
    title: "Alibaba Cloud ECS instances",
    description: "ECS instances in every region: status, type, CPU and memory, OS, public and private IP, outbound bandwidth, charge type (PrePaid / PostPaid) and expiry, tags. Each carries the matching Orrery server (by public IP), if any.",
    annotations: READ,
  }, tool(() => instances(api, config, { matchHosts })));
  const serviceList = Object.entries(SERVICES).map(([k, v]) => `${k} (${v.what})`).join("; ");
  add("aliyun_query", {
    title: "Any read-only Alibaba Cloud API call",
    description: `Call a read action (Describe*, Query*, Get*, List*) of a supported service and return the answer. Services: ${serviceList}. region is the region id for ecs and vpc, null for the others. Examples: alidns DescribeDomains / DescribeDomainRecords (DomainName); domain QueryDomainList (PageNum, PageSize) / QueryDomainByDomainName; cdn DescribeUserDomains / DescribeDomainBpsData / DescribeCdnDomainDetail; cas ListUserCertificateOrder; bss QueryInstanceBill / QueryAccountBill; vpc DescribeEipAddresses. Answers with private keys, console tokens or a domain's transfer code are refused.`,
    inputSchema: {
      service: z.enum(Object.keys(SERVICES)),
      region: z.string().nullable().optional(),
      action: z.string(),
      params: z.record(z.string(), z.any()).optional(),
    },
    annotations: READ,
  }, tool(async ({ service, region, action, params = {} }) => {
    if (!READ_ACTION.test(action)) throw new Error(`${action} is not a read action; changes go through aliyun_call.`);
    guardRequest(service, action);
    return api.request(service, SERVICES[service].regional ? region || null : null, action, params);
  }));
  add("aliyun_billing", {
    title: "Alibaba Cloud balance and monthly bill",
    description: "Read-only: account balance (available, cash, credit) and one month's bill by product (pretax amount, paid, outstanding), largest first. month is YYYY-MM, default this month. Nothing here can pay, top up or change billing.",
    inputSchema: { month: z.string().regex(/^\d{4}-\d{2}$/).optional() },
    annotations: READ,
  }, tool(({ month }) => billing(api, { month })));
  if (!admin) return { id, name, configured: true, tools };

  const protect = protectedIps(env);
  const notProtected = async (region, ids) => {
    if (protect.length && ids.length) assertNotProtected(await getInstances(api, region, ids), protect);
  };
  const where = { region: z.string().describe("Region id, e.g. cn-beijing (from aliyun_instances)"), instanceId: z.string().regex(/^i-[a-z0-9]+$/, "ECS instance id, e.g. i-2zeexample0001abcd") };
  add("aliyun_power", {
    title: "Start, stop or reboot an ECS instance",
    description: "start a stopped instance, stop (clean shutdown; force=true skips it) or reboot a running one. A pay-as-you-go instance stopped with stoppedMode StopCharging stops billing for CPU and memory but may lose its public IP. An instance with a protected IP can only be started.",
    inputSchema: { ...where, action: z.enum(["start", "stop", "reboot"]), force: z.boolean().optional(), stoppedMode: z.enum(["KeepCharging", "StopCharging"]).optional() },
    annotations: DESTRUCTIVE,
  }, adminTool("aliyun_power", async ({ region, instanceId, action, force, stoppedMode }) => {
    if (action !== "start") await notProtected(region, [instanceId]);
    const act = { start: "StartInstance", stop: "StopInstance", reboot: "RebootInstance" }[action];
    const params = { InstanceId: instanceId, ...(force !== undefined && action !== "start" ? { ForceStop: force } : {}), ...(stoppedMode && action === "stop" ? { StoppedMode: stoppedMode } : {}) };
    const r = await api.request("ecs", region, act, params);
    return { ok: true, region, instanceId, action, requestId: r.RequestId };
  }));
  add("aliyun_delete", {
    title: "Release (delete) an ECS instance",
    description: "Permanently release one pay-as-you-go instance and the disks set to go with it. confirmName must repeat its name or id. Subscription (PrePaid) instances are refused by Aliyun; unsubscribe those in the console. Instances with a protected IP are refused.",
    inputSchema: { ...where, confirmName: z.string(), force: z.boolean().optional().describe("true releases a running instance too") },
    annotations: DESTRUCTIVE,
  }, adminTool("aliyun_delete", async ({ region, instanceId, confirmName, force }) => {
    const [i] = await getInstances(api, region, [instanceId]);
    if (!i) throw new Error(`No instance ${instanceId} in ${region}`);
    const c = String(confirmName || "").trim();
    if (c !== i.name && c !== i.id) throw new Error(`Refusing: confirmName must be "${i.name}" or "${i.id}".`);
    assertNotProtected([i], protect);
    const r = await api.request("ecs", region, "DeleteInstance", { InstanceId: instanceId, ...(force ? { Force: true } : {}) });
    return { ok: true, deleted: `${region}/${instanceId}`, requestId: r.RequestId };
  }));
  add("aliyun_call", {
    title: "Call any Alibaba Cloud API action (ECS, VPC, DNS, domains, CDN, certificates)",
    description: `Call any action of a supported service, changes included. Services: ${serviceList}. region is the region id for ecs and vpc, null for the others. Examples: ecs RunInstances, ModifyInstanceSpec, AuthorizeSecurityGroup, CreateSnapshot, RunCommand; alidns AddDomainRecord (DomainName, RR, Type, Value), UpdateDomainRecord (RecordId, ...), DeleteDomainRecord; domain SaveSingleTaskForCreatingOrderRenew (renew, charges the account); cdn AddCdnDomain (DomainName, CdnType web, Sources JSON), SetCdnDomainSSLCertificate, RefreshObjectCaches (ObjectPath), BatchSetCdnDomainConfig; cas UploadUserCertificate. Use aliyun_query for reads. params are the action's parameters; lists may be given as arrays ({"InstanceId": ["i-1"]}). Refused: deleting ECS instances (aliyun_delete), billing changes (bss is read-only), domain transfer-out, unlocking or transfer codes, private keys and console tokens, and changes to an instance with a protected IP.`,
    inputSchema: {
      service: z.enum(Object.keys(SERVICES)),
      region: z.string().nullable().optional(),
      action: z.string(),
      params: z.record(z.string(), z.any()).optional(),
    },
    annotations: DESTRUCTIVE,
  }, adminTool("aliyun_call", async ({ service, region, action, params = {} }) => {
    guardRequest(service, action);
    if (service === "ecs" && !READ_ACTION.test(action) && !/^StartInstances?$/.test(action)) await notProtected(region || params.RegionId, instanceIdsIn(params));
    return api.request(service, SERVICES[service].regional ? region || null : null, action, params);
  }));
  return { id, name, configured: true, tools };
}
