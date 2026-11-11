// The Alibaba Cloud module against a fake OpenAPI: the documented signature example, request signing as
// the server checks it, every region and page, the instance shape, billing, protected instances, name
// confirmation, what the generic tool refuses and Cloud Assistant commands. No Aliyun account needed.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, createApi, stringToSign, sign, flatten, percentEncode, instances, toInstance, billing, instanceIdsIn, guardRequest, redactSecrets, runShell, register as aliyunRegister } from "../index.js";

// ---------- credentials ----------
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aliyun-test-"));
assert.deepEqual(loadConfig({}, dataDir), { configured: false });
fs.writeFileSync(path.join(dataDir, "aliyun.json"), JSON.stringify({ accessKeyId: "LTAI-test", accessKeySecret: "secret-test" }));
assert.deepEqual(loadConfig({}, dataDir), { configured: true, accessKeyId: "LTAI-test", accessKeySecret: "secret-test", regions: "all" });
fs.writeFileSync(path.join(dataDir, "aliyun.json"), JSON.stringify({ accessKeyId: "LTAI-test", accessKeySecret: "secret-test", regions: ["cn-beijing", "cn-hangzhou"] }));
assert.deepEqual(loadConfig({}, dataDir).regions, ["cn-beijing", "cn-hangzhou"]);
fs.writeFileSync(path.join(dataDir, "aliyun.json"), JSON.stringify({ accessKeyId: "LTAI-test", accessKeySecret: "x", regions: ["../x"] }));
assert.match(loadConfig({}, dataDir).error, /invalid region/);
fs.writeFileSync(path.join(dataDir, "aliyun.json"), "LTAI-secret-not-json");
assert.match(loadConfig({}, dataDir).error, /not valid JSON$/);
assert.doesNotMatch(loadConfig({}, dataDir).error, /secret/, "file content never reaches the connector");
fs.writeFileSync(path.join(dataDir, "aliyun.json"), JSON.stringify({ accessKeyId: "LTAI-test" }));
assert.match(loadConfig({}, dataDir).error, /accessKeySecret are required/);

// ---------- signing: Aliyun's documented example ----------
{
  const p = { AccessKeyId: "testid", Action: "DescribeRegions", Format: "XML", SignatureMethod: "HMAC-SHA1", SignatureNonce: "3ee8c1b8-83d3-44af-a94f-4e0ad82fd6cf", SignatureVersion: "1.0", Timestamp: "2016-02-23T12:46:24Z", Version: "2014-05-26" };
  assert.equal(stringToSign("GET", p), "GET&%2F&AccessKeyId%3Dtestid%26Action%3DDescribeRegions%26Format%3DXML%26SignatureMethod%3DHMAC-SHA1%26SignatureNonce%3D3ee8c1b8-83d3-44af-a94f-4e0ad82fd6cf%26SignatureVersion%3D1.0%26Timestamp%3D2016-02-23T12%253A46%253A24Z%26Version%3D2014-05-26");
  assert.equal(sign("GET", p, "testsecret"), "OLeaidS1JvxuMvnyHOwuJ+uX5qY=");
  assert.equal(percentEncode("a b*c~d'(e)!"), "a%20b%2Ac~d%27%28e%29%21");
  assert.deepEqual(flatten({ InstanceId: ["i-1", "i-2"], Tag: [{ Key: "k", Value: "v" }], PageSize: 100, Skip: null }), { "InstanceId.1": "i-1", "InstanceId.2": "i-2", "Tag.1.Key": "k", "Tag.1.Value": "v", PageSize: "100" });
}

// ---------- a fake Aliyun that checks every signature ----------
const SECRET = "secret-test";
const inst = (id, region, extra = {}) => ({
  InstanceId: id, InstanceName: extra.name || id, ZoneId: `${region}-h`, Status: "Running", InstanceType: "ecs.e-c1m1.large", Cpu: 2, Memory: 2048, OSName: "Ubuntu  22.04 64位",
  PublicIpAddress: { IpAddress: extra.ip ? [extra.ip] : [] }, VpcAttributes: { PrivateIpAddress: { IpAddress: ["172.19.225.194"] } },
  InternetMaxBandwidthOut: 3, InstanceChargeType: extra.charge || "PrePaid", ExpiredTime: "2027-11-04T16:00Z", CreationTime: "2026-11-04T04:40Z", Tags: { Tag: extra.tags || [] },
});
function fakeAliyun({ failRegion, finalStatus = "Success" } = {}) {
  const calls = [];
  const beijing = [inst("i-bj1", "cn-beijing", { name: "web", ip: "203.0.113.40" }), ...Array.from({ length: 100 }, (_, n) => inst(`i-bjx${n}`, "cn-beijing", { charge: "PostPaid" }))];
  const fetchImpl = async (url, init) => {
    const host = new URL(url).host;
    const params = Object.fromEntries(new URLSearchParams(init.body));
    const { Signature, ...rest } = params;
    assert.equal(Signature, sign("POST", rest, SECRET), "every request is signed over exactly what is sent");
    assert.equal(params.AccessKeyId, "LTAI-test");
    calls.push({ host, action: params.Action, params: rest });
    const ok = (b) => new Response(JSON.stringify({ RequestId: "req-1", ...b }), { status: 200 });
    const err = (status, Code, Message) => new Response(JSON.stringify({ RequestId: "req-e", Code, Message }), { status });
    switch (params.Action) {
      case "DescribeRegions": return ok({ Regions: { Region: [{ RegionId: "cn-beijing" }, { RegionId: "cn-hangzhou" }, { RegionId: "ap-southeast-1" }] } });
      case "DescribeInstances": {
        if (params.RegionId === failRegion) return err(403, "Forbidden.RAM", "User not authorized to operate on the specified resource.");
        assert.equal(host, `ecs.${params.RegionId}.aliyuncs.com`);
        let list = params.RegionId === "cn-beijing" ? beijing : params.RegionId === "cn-hangzhou" ? [inst("i-hz1", "cn-hangzhou", { ip: "203.0.113.96", tags: [{ TagKey: "role", TagValue: "test" }] })] : [];
        if (params.InstanceIds) list = list.filter((i) => JSON.parse(params.InstanceIds).includes(i.InstanceId));
        const page = Number(params.PageNumber || 1), size = Number(params.PageSize || 10);
        return ok({ TotalCount: list.length, Instances: { Instance: list.slice((page - 1) * size, page * size) } });
      }
      case "QueryAccountBalance": assert.equal(host, "business.aliyuncs.com"); return ok({ Success: true, Data: { AvailableAmount: "1,234.50", AvailableCashAmount: "1,000.00", CreditAmount: "0.00", Currency: "CNY" } });
      case "QueryBillOverview": return ok({ Success: true, Data: { BillingCycle: params.BillingCycle, Items: { Item: [
        { ProductName: "云服务器 ECS", ProductCode: "ecs", SubscriptionType: "Subscription", PretaxAmount: 99, PaymentAmount: 99, OutstandingAmount: 0, Currency: "CNY" },
        { ProductName: "CDN", ProductCode: "cdn", SubscriptionType: "PayAsYouGo", PretaxAmount: 3.2, PaymentAmount: 0, OutstandingAmount: 3.2, Currency: "CNY" },
        { ProductName: "CDN", ProductCode: "cdn", SubscriptionType: "PayAsYouGo", PretaxAmount: 1.05, PaymentAmount: 0, OutstandingAmount: 1.05, Currency: "CNY" },
      ] } } });
      case "RunCommand": return ok({ InvokeId: "t-1", CommandId: "c-1" });
      case "DescribeInvocationResults": {
        const n = calls.filter((c) => c.action === "DescribeInvocationResults").length;
        return ok({ Invocation: { InvocationResults: { InvocationResult: [n < 2 ? { InvocationStatus: "Running" } : finalStatus === "Success" ? { InvocationStatus: "Success", ExitCode: 0, Output: "ORRERY_OK\n" } : { InvocationStatus: finalStatus, ErrorCode: "InstanceNotRunning" }] } } });
      }
      case "StartInstance": case "StopInstance": case "RebootInstance": case "DeleteInstance": case "ModifyInstanceAttribute": case "UnassociateEipAddress": case "AssociateEipAddress": return ok({});
      case "DescribeDomainRecords": assert.equal(host, "alidns.aliyuncs.com"); assert.equal(params.RegionId, undefined, "one endpoint for the account, no RegionId"); return ok({ TotalCount: 1, DomainRecords: { Record: [{ RR: "www", Type: "A", Value: "203.0.113.40" }] } });
      case "AddDomainRecord": assert.equal(host, "alidns.aliyuncs.com"); return ok({ RecordId: "r-1" });
      case "DescribeEipAddresses": {
        assert.equal(host, `vpc.${params.RegionId}.aliyuncs.com`);
        const eips = params.RegionId === "cn-beijing" ? [{ AllocationId: "eip-web", IpAddress: "198.51.100.70", InstanceId: "i-bj1", InstanceType: "EcsInstance" }, { AllocationId: "eip-free", IpAddress: "198.51.100.71", InstanceId: "", InstanceType: "" }, { AllocationId: "eip-prot", IpAddress: "203.0.113.41", InstanceId: "ngw-1", InstanceType: "Nat" }] : [];
        return ok({ EipAddresses: { EipAddress: params.AllocationId ? eips.filter((e) => e.AllocationId === params.AllocationId) : [] } });
      }
      case "DescribeCdnDomainConfigs": return ok({ DomainConfigs: { DomainConfig: [{ FunctionName: "aliyun_auth", FunctionArgs: { FunctionArg: [{ ArgName: "auth_type", ArgValue: "type_a" }, { ArgName: "auth_key1", ArgValue: "s1gn1ng" }, { ArgName: "auth_key2", ArgValue: "s1gn2" }] } }, { FunctionName: "set_req_host_header", FunctionArgs: { FunctionArg: [{ ArgName: "domain_name", ArgValue: "example.cn" }] } }] } });
      case "QueryBadSignature": return err(400, "SignatureDoesNotMatch", "Specified signature is not matched with our calculation.");
      default: return err(404, "InvalidAction.NotFound", "Specified api is not found");
    }
  };
  return { calls, fetchImpl };
}
const config = { configured: true, accessKeyId: "LTAI-test", accessKeySecret: SECRET, regions: "all" };

// ---------- instances: every region and page, shape, matching ----------
{
  const f = fakeAliyun();
  const api = createApi(config, f.fetchImpl);
  const res = await instances(api, config, { matchHosts: async () => (ips) => (ips.includes("203.0.113.40") ? { id: "a1b2c3d4", name: "bj-1" } : null) });
  assert.equal(res.instances.length, 102, "101 in Beijing over two pages, 1 in Hangzhou");
  assert.equal(f.calls.find((c) => c.action === "DescribeRegions").host, "ecs.aliyuncs.com");
  assert.deepEqual(f.calls.filter((c) => c.action === "DescribeInstances" && c.params.RegionId === "cn-beijing").map((c) => c.params.PageNumber), ["1", "2"]);
  assert.deepEqual(res.instances[0], {
    id: "i-bj1", name: "web", region: "cn-beijing", zone: "cn-beijing-h", status: "Running", type: "ecs.e-c1m1.large", cpu: 2, memoryMiB: 2048, os: "Ubuntu  22.04 64位",
    publicIp: "203.0.113.40", privateIp: "172.19.225.194", bandwidthOutMbps: 3, chargeType: "PrePaid", expires: "2027-11-04T16:00Z", created: "2026-11-04T04:40Z", tags: {},
    server: { id: "a1b2c3d4", name: "bj-1" },
  });
  assert.deepEqual(res.instances.at(-1).tags, { role: "test" });
  assert.deepEqual(res.regions, [{ region: "cn-beijing", count: 101, error: null }, { region: "cn-hangzhou", count: 1, error: null }], "empty regions are left out");
  assert.equal(toInstance({ InstanceId: "i-x", EipAddress: { IpAddress: "8.8.4.4" } }, "cn-x").publicIp, "8.8.4.4", "an EIP counts as the public address");

  const half = await instances(createApi(config, fakeAliyun({ failRegion: "cn-hangzhou" }).fetchImpl), config);
  assert.equal(half.instances.length, 101, "one region failing hides nothing else");
  assert.match(half.regions.find((r) => r.region === "cn-hangzhou").error, /failed with 403: Forbidden\.RAM: User not authorized.*\(the RAM user lacks this permission\)/);
  await assert.rejects(createApi(config, f.fetchImpl).request("bss", null, "QueryBadSignature"), /SignatureDoesNotMatch.*\(the AccessKey is wrong/);
  await assert.rejects(createApi(config, f.fetchImpl).request("ecs", "cn-beijing/../x", "DescribeInstances"), /Invalid region/);
  await assert.rejects(createApi(config, f.fetchImpl).request("ecs", "cn-beijing", "Describe Instances"), /Invalid action/);
}

// ---------- billing (read-only) ----------
{
  const f = fakeAliyun();
  const r = await billing(createApi(config, f.fetchImpl), { month: "2026-11" });
  assert.deepEqual(r.balance, { available: 1234.5, cash: 1000, credit: 0 });
  assert.equal(r.month, "2026-11");
  assert.equal(r.currency, "CNY");
  assert.deepEqual(r.byProduct.map((p) => [p.product, p.pretaxAmount, p.outstanding]), [["云服务器 ECS", 99, 0], ["CDN", 4.25, 4.25]], "summed per product, largest first");
  assert.equal(r.total, 103.25);
  assert.equal(r.outstanding, 4.25);
  await assert.rejects(billing(createApi(config, f.fetchImpl), { month: "2026-11-01" }), /Invalid month/);
}

// ---------- what the generic tool refuses ----------
assert.throws(() => guardRequest("bss", "CreateResourcePackage"), /read-only/);
assert.throws(() => guardRequest("oss", "ListBuckets"), /Unsupported Alibaba Cloud service oss/);
for (const a of ["SaveSingleTaskForTransferOutByAuthorizationCode", "QueryTransferOutInfo", "SaveBatchTaskForTransferProhibitionLock", "SaveSingleTaskForTransferProhibitionLock"]) assert.throws(() => guardRequest("domain", a), /leave this account|transfer code/, a);
assert.doesNotThrow(() => guardRequest("domain", "SaveSingleTaskForCreatingOrderRenew"));
for (const a of ["GetUserCertificateDetail", "DescribeCertificatePrivateKey"]) assert.throws(() => guardRequest("cas", a), /private key/, a);
assert.doesNotThrow(() => guardRequest("cas", "ListUserCertificateOrder"));
assert.doesNotThrow(() => guardRequest("alidns", "DeleteDomainRecord"));
assert.doesNotThrow(() => guardRequest("cdn", "AddCdnDomain"));
assert.throws(() => guardRequest("bss", "SetRenewal"), /read-only/);
assert.doesNotThrow(() => guardRequest("bss", "QueryInstanceBill"));
assert.throws(() => guardRequest("ecs", "DeleteInstance"), /aliyun_delete/);
assert.throws(() => guardRequest("ecs", "DeleteInstances"), /aliyun_delete/);
assert.throws(() => guardRequest("ecs", "CreateKeyPair"), /private key/);
assert.throws(() => guardRequest("ecs", "DescribeInstanceVncUrl"), /console login token/);
assert.doesNotThrow(() => guardRequest("ecs", "RunInstances"));
for (const a of ["ModifyInstanceAutoReleaseTime", "ReplaceSystemDisk", "ResetDisk", "ResetDisks", "replaceSystemDisk"]) assert.throws(() => guardRequest("ecs", a), /without the name confirmation.*Aliyun console/, a);
assert.throws(() => guardRequest("ecs", "StartTerminalSession"), /shell session credential/);
assert.throws(() => guardRequest("ecs", "DeleteINSTANCE"), /aliyun_delete/, "ECS refusals ignore case");
assert.throws(() => guardRequest("ecs", "DescribeInstanceVNCUrl"), /console login token/, "ECS refusals ignore case");
assert.throws(() => guardRequest("cas", "DescribeCertificatePRIVATEKey"), /private key/, "CAS refusals ignore case");
assert.doesNotThrow(() => guardRequest("ecs", "ResetDiskAttribute"));

// ---------- redaction: CDN URL-signing keys and private keys ----------
assert.deepEqual(
  redactSecrets({ FunctionArgs: { FunctionArg: [{ ArgName: "auth_key1", ArgValue: "k1" }, { ArgName: "Auth_Key2", ArgValue: "k2" }, { ArgName: "auth_type", ArgValue: "type_a" }] }, auth_key1: "k3", auth_key_backup: "k4", note: "-----BEGIN RSA PRIVATE KEY-----\nMII", empty: { ArgName: "auth_key1", ArgValue: "" } }),
  { FunctionArgs: { FunctionArg: [{ ArgName: "auth_key1", ArgValue: "[redacted]" }, { ArgName: "Auth_Key2", ArgValue: "[redacted]" }, { ArgName: "auth_type", ArgValue: "type_a" }] }, auth_key1: "[redacted]", auth_key_backup: "[redacted]", note: "[redacted]", empty: { ArgName: "auth_key1", ArgValue: "" } },
);
assert.deepEqual(instanceIdsIn({ InstanceId: "i-1", InstanceIds: '["i-2","i-3"]', "InstanceId.4": "i-4" }).sort(), ["i-1", "i-2", "i-3", "i-4"]);
assert.deepEqual(instanceIdsIn({ InstanceId: ["i-5"] }), ["i-5"]);

// ---------- the tools: protected instances, name confirmation, billing on the hub role ----------
{
  const chain = new Proxy(function () {}, { get: () => chain, apply: () => chain }); // stands in for zod
  fs.writeFileSync(path.join(dataDir, "aliyun.json"), JSON.stringify({ accessKeyId: "LTAI-test", accessKeySecret: SECRET, regions: ["cn-beijing"] }));
  const register = (env, admin = true) => {
    const f = fakeAliyun();
    const handlers = {};
    const info = aliyunRegister({ registerTool: (n, spec, h) => (handlers[n] = h) }, { z: chain, tool: (fn) => fn, adminTool: (n, fn) => fn, READ: {}, DESTRUCTIVE: {}, admin, env, dataDir }, f.fetchImpl);
    return { ...handlers, info, calls: f.calls };
  };
  const t = register({ ORRERY_PROTECTED_IPS: "203.0.113.40" });
  assert.deepEqual(t.info.tools, ["aliyun_instances", "aliyun_query", "aliyun_billing", "aliyun_power", "aliyun_delete", "aliyun_call"]);
  const web = { region: "cn-beijing", instanceId: "i-bj1" };
  for (const action of ["stop", "reboot"]) await assert.rejects(t.aliyun_power({ ...web, action }), /instance web \(i-bj1, cn-beijing\) has the protected IP 203\.0\.113\.40/);
  await assert.rejects(t.aliyun_delete({ ...web, confirmName: "web" }), /protected IP/);
  await assert.rejects(t.aliyun_call({ service: "ecs", region: "cn-beijing", action: "ModifyInstanceAttribute", params: { InstanceId: "i-bj1", InstanceName: "x" } }), /protected IP/);
  await assert.rejects(t.aliyun_call({ service: "ecs", region: "cn-beijing", action: "RunCommand", params: { InstanceId: ["i-bj1"], Type: "RunShellScript", CommandContent: "reboot" } }), /protected IP/);
  // The check runs in the region the call goes to, and fails closed when the instance is not found there.
  await assert.rejects(t.aliyun_power({ region: "cn-hangzhou", instanceId: "i-bj1", action: "stop" }), /no instance i-bj1 in cn-hangzhou/);
  await assert.rejects(t.aliyun_call({ service: "ecs", region: "cn-hangzhou", action: "StopInstance", params: { InstanceId: "i-bj1" } }), /no instance i-bj1 in cn-hangzhou/);
  await assert.rejects(t.aliyun_call({ service: "ecs", region: "cn-hangzhou", action: "StopInstance", params: { InstanceId: "i-bj1", RegionId: "cn-beijing" } }), /instance web \(i-bj1, cn-beijing\) has the protected IP/, "params.RegionId is the region the request uses");
  await assert.rejects(t.aliyun_call({ service: "ecs", region: "cn-beijing", action: "StopInstance", params: { InstanceId: "i-bj1", RegionId: "cn-hangzhou" } }), /no instance i-bj1 in cn-hangzhou/);
  await assert.rejects(t.aliyun_call({ service: "ecs", region: "cn-beijing", action: "StopInstances", params: { InstanceId: ["i-bjx1", "i-gone"] } }), /no instance i-gone in cn-beijing/, "every id must be found");
  await assert.rejects(t.aliyun_call({ service: "ecs", action: "StopInstance", params: { InstanceId: "i-bj1" } }), /without a valid region/);
  // Not only ECS: the vpc calls that move an elastic IP off a protected instance.
  await assert.rejects(t.aliyun_call({ service: "vpc", region: "cn-beijing", action: "UnassociateEipAddress", params: { AllocationId: "eip-free", InstanceId: "i-bj1" } }), /instance web \(i-bj1, cn-beijing\) has the protected IP/);
  await assert.rejects(t.aliyun_call({ service: "vpc", region: "cn-beijing", action: "AssociateEipAddress", params: { AllocationId: "eip-free", InstanceId: "i-bj1" } }), /protected IP/);
  await assert.rejects(t.aliyun_call({ service: "vpc", region: "cn-beijing", action: "UnassociateEipAddress", params: { AllocationId: "eip-web" } }), /instance web \(i-bj1, cn-beijing\) has the protected IP/, "an EIP named only by AllocationId is traced to its instance");
  await assert.rejects(t.aliyun_call({ service: "vpc", region: "cn-beijing", action: "UnassociateEipAddress", params: { AllocationId: "eip-nope" } }), /no elastic IP eip-nope in cn-beijing/);
  const p2 = register({ ORRERY_PROTECTED_IPS: "203.0.113.41" });
  await assert.rejects(p2.aliyun_call({ service: "vpc", region: "cn-beijing", action: "UnassociateEipAddress", params: { AllocationId: "eip-prot", InstanceId: "ngw-1", InstanceType: "Nat" } }), /elastic IP eip-prot is the protected IP 203\.0\.113\.41/);
  assert.deepEqual(t.calls.filter((c) => !/^Describe/.test(c.action)).map((c) => c.action), [], "nothing was sent to the protected instance");
  await t.aliyun_call({ service: "vpc", region: "cn-beijing", action: "AssociateEipAddress", params: { AllocationId: "eip-free", InstanceId: "lb-1", InstanceType: "SlbInstance" } });
  assert.ok(t.calls.some((c) => c.action === "AssociateEipAddress" && c.params.InstanceId === "lb-1"), "an id that is no ECS instance id is not looked up as one");
  await t.aliyun_power({ ...web, action: "start" });
  await t.aliyun_call({ service: "ecs", region: "cn-beijing", action: "StartInstances", params: { InstanceId: ["i-bj1"] } }).catch(() => {});
  assert.ok(t.calls.some((c) => c.action === "StartInstance" && c.params.InstanceId === "i-bj1"), "starting stays allowed");

  const o = register({});
  await assert.rejects(o.aliyun_delete({ region: "cn-beijing", instanceId: "i-bjx3", confirmName: "web" }), /confirmName must be "i-bjx3" or "i-bjx3"/);
  assert.equal((await o.aliyun_delete({ region: "cn-beijing", instanceId: "i-bjx3", confirmName: "i-bjx3" })).deleted, "cn-beijing/i-bjx3");
  await assert.rejects(o.aliyun_delete({ region: "cn-beijing", instanceId: "i-nope", confirmName: "x" }), /No instance i-nope/);
  const stop = await o.aliyun_power({ ...web, action: "stop", force: true, stoppedMode: "StopCharging" });
  assert.equal(stop.action, "stop");
  assert.deepEqual(o.calls.find((c) => c.action === "StopInstance").params.StoppedMode, "StopCharging");
  await assert.rejects(o.aliyun_call({ service: "bss", action: "SetRenewal", params: {} }), /read-only/);
  assert.equal((await o.aliyun_call({ service: "bss", region: null, action: "QueryAccountBalance" })).Data.Currency, "CNY");

  // aliyun_query: reads of any supported service, nothing else.
  assert.equal((await o.aliyun_query({ service: "alidns", region: "cn-beijing", action: "DescribeDomainRecords", params: { DomainName: "example.cn" } })).DomainRecords.Record[0].RR, "www");
  assert.deepEqual(await o.aliyun_query({ service: "vpc", region: "cn-beijing", action: "DescribeEipAddresses" }), { RequestId: "req-1", EipAddresses: { EipAddress: [] } });
  await assert.rejects(o.aliyun_query({ service: "alidns", action: "AddDomainRecord", params: {} }), /not a read action; changes go through aliyun_call/);
  await assert.rejects(o.aliyun_query({ service: "domain", action: "QueryTransferOutInfo", params: {} }), /transfer code/);
  assert.equal((await o.aliyun_call({ service: "alidns", region: null, action: "AddDomainRecord", params: { DomainName: "example.cn", RR: "www", Type: "A", Value: "1.2.3.4" } })).RecordId, "r-1");
  await assert.rejects(o.aliyun_call({ service: "domain", action: "SaveSingleTaskForTransferOutByAuthorizationCode", params: {} }), /leave this account/);
  for (const tool of ["aliyun_query", "aliyun_call"]) {
    const cfg = await o[tool]({ service: "cdn", region: null, action: "DescribeCdnDomainConfigs", params: { DomainName: "cdn.example.cn", FunctionNames: "aliyun_auth" } });
    assert.deepEqual(cfg.DomainConfigs.DomainConfig[0].FunctionArgs.FunctionArg.map((a) => a.ArgValue), ["type_a", "[redacted]", "[redacted]"], `${tool} redacts CDN URL-signing keys`);
    assert.equal(cfg.DomainConfigs.DomainConfig[1].FunctionArgs.FunctionArg[0].ArgValue, "example.cn");
  }

  const hub = register({}, false);
  assert.deepEqual(hub.info.tools, ["aliyun_instances", "aliyun_query", "aliyun_billing"], "the hub role only reads");
  assert.equal((await hub.aliyun_billing({})).currency, "CNY");
}

// ---------- Cloud Assistant ----------
{
  const f = fakeAliyun();
  const r = await runShell(createApi(config, f.fetchImpl), { region: "cn-beijing", instanceId: "i-bj1", script: "echo ORRERY_OK" }, { pollMs: 1 });
  assert.deepEqual(r, { status: "Success", exitCode: 0, output: "ORRERY_OK\n", error: null });
  const run = f.calls.find((c) => c.action === "RunCommand").params;
  assert.equal(Buffer.from(run.CommandContent, "base64").toString(), "echo ORRERY_OK");
  assert.equal(run["InstanceId.1"], "i-bj1");
  assert.equal(run.Type, "RunShellScript");
  for (const finalStatus of ["Invalid", "Stopped", "PartialFailed"]) {
    const g = fakeAliyun({ finalStatus });
    const r2 = await runShell(createApi(config, g.fetchImpl), { region: "cn-beijing", instanceId: "i-bj1", script: "true" }, { pollMs: 1, maxWaitMs: 60000 });
    assert.deepEqual(r2, { status: finalStatus, exitCode: null, output: "", error: "InstanceNotRunning" }, `${finalStatus} is final, not polled until the timeout`);
  }
}

// ---------- a retried read is signed afresh ----------
{
  const sent = [];
  let n = 0;
  const fetchImpl = async (url, init) => {
    const params = Object.fromEntries(new URLSearchParams(init.body));
    const { Signature, ...rest } = params;
    assert.equal(Signature, sign("POST", rest, SECRET));
    sent.push(params);
    return n++ ? new Response(JSON.stringify({ RequestId: "r", Regions: { Region: [] } }), { status: 200 }) : new Response(JSON.stringify({ Code: "ServiceUnavailable" }), { status: 503 });
  };
  let k = 0;
  await createApi(config, fetchImpl, { retryWaitMs: 1, nonce: () => `nonce-${k++}` }).request("ecs", null, "DescribeRegions");
  assert.equal(sent.length, 2);
  assert.deepEqual(sent.map((p) => p.SignatureNonce), ["nonce-0", "nonce-1"], "a fresh SignatureNonce per attempt");
  assert.notEqual(sent[0].Signature, sent[1].Signature, "and a fresh Signature");
}

console.log("aliyun test passed");
