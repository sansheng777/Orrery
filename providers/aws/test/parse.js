// Drives the AWS module through the official SDK with a fake HTTP handler, so the SDK's own parsers
// read fixture responses shaped like EC2 (XML), CloudWatch, Lightsail and Cost Explorer (JSON) replies.
// No AWS credentials or network needed.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { loadConfig, parseCost, costPeriod, instances, cost, ec2Power, ec2Terminate, lightsailPower, lightsailDelete, call, query, protectedIps, redactSecrets } from "../index.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (f) => fs.readFileSync(path.join(dir, f), "utf8");

// A request handler in the shape the SDK expects; routes on host and operation, records every call.
function fakeAws(routes) {
  const calls = [];
  const requestHandler = {
    handle: async (req) => {
      const body = req.body == null ? "" : ArrayBuffer.isView(req.body) ? new TextDecoder().decode(req.body) : String(req.body);
      const op = req.headers["x-amz-target"]?.split(".").pop() || new URLSearchParams(body).get("Action");
      const service = req.hostname.split(".")[0];
      calls.push({ service, region: req.hostname.split(".")[1], op, body, auth: req.headers.authorization });
      const [status, file] = routes(service, op, body, req.hostname) || [500, null];
      const text = file ? fixture(file) : "";
      const type = file?.endsWith(".xml") ? "text/xml" : "application/x-amz-json-1.1";
      return { response: { statusCode: status, headers: { "content-type": type, "x-amzn-requestid": "req-1" }, body: Readable.from([Buffer.from(text)]) } };
    },
  };
  return { calls, sdk: { requestHandler } };
}
const base = { configured: true, credentials: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret" }, regions: ["ap-northeast-1"], cost: true, lightsail: true };
const matchHosts = async () => (ips) => (ips.includes("203.0.113.10") ? { id: "a1b2c3d4", name: "aws-tokyo" } : ips.includes("203.0.113.50") ? { id: "l1", name: "blog" } : null);

// ---------- instances: EC2 pages, Lightsail, CloudWatch ----------
const readRoutes = (cloudwatch = "ok") => (service, op, body, host) => {
  if (op === "GetRegions") return [200, "lightsail-get-regions.json"];
  if (service === "ec2" && host.includes("ap-northeast-1")) return [200, new URLSearchParams(body).get("NextToken") ? "describe-instances-page2.xml" : "describe-instances-page1.xml"];
  if (service === "ec2" && host.includes("us-west-2")) return [200, "describe-instances-empty.xml"];
  if (service === "ec2") return [403, "ec2-unauthorized.xml"];
  if (service === "lightsail" && host.includes("ap-northeast-1")) return [200, "lightsail-get-instances.json"];
  if (service === "lightsail") return [400, "lightsail-not-found.json"]; // asking a region without Lightsail fails
  if (service === "monitoring") return cloudwatch === "ok" ? [200, "get-metric-data.json"] : [400, "cloudwatch-access-denied.json"];
};

let fake = fakeAws(readRoutes());
let res = await instances({ ...base, regions: ["ap-northeast-1", "us-west-2", "eu-south-2"], sdk: fake.sdk }, { matchHosts });
assert.deepEqual(res.instances.map((i) => [i.service, i.id, i.state, i.server?.id ?? null]), [
  ["ec2", "i-0123456789abcdef0", "running", "a1b2c3d4"],
  ["ec2", "i-0fedcba9876543210", "stopped", null],
  ["lightsail", "blog-tokyo", "running", "l1"],
]);
const [web, stopped, blog] = res.instances;
assert.deepEqual(web, {
  id: "i-0123456789abcdef0", service: "ec2", name: "web & api", region: "ap-northeast-1", zone: "ap-northeast-1a", state: "running", type: "t3.small",
  publicIp: "203.0.113.10", privateIp: "172.31.2.34", ipv6: null, launchTime: "2026-09-14T03:21:07.000Z", platform: "Linux/UNIX", architecture: "x86_64",
  keyName: "aws-tokyo", cpuPercent: 12.3, server: { id: "a1b2c3d4", name: "aws-tokyo" },
});
assert.equal(stopped.publicIp, null, "a stopped instance has no public IP");
assert.equal(stopped.cpuPercent, null);
assert.equal(blog.type, "small_3_0");
assert.equal(blog.platform, "Ubuntu");
assert.equal(blog.ipv6, "2001:db8:aa::50");
assert.equal(blog.launchTime, new Date(1788000000 * 1000).toISOString());
assert.equal(blog.cpuPercent, null, "CloudWatch is only asked for EC2");
assert.equal(res.regions.length, 3);
assert.match(res.regions[2].error, /UnauthorizedOperation/, "a failing region is reported, not fatal");
assert.deepEqual(fake.calls.filter((c) => c.op === "GetInstances").map((c) => c.region), ["ap-northeast-1"], "configured regions: Lightsail is only asked where it exists");
assert.deepEqual(res.regions.map((r) => r.lightsailError), [null, null, null]);
assert.equal(res.cpu.status, "ok");
const cw = fake.calls.find((c) => c.service === "monitoring");
assert.deepEqual(JSON.parse(cw.body).MetricDataQueries.map((q) => q.MetricStat.Metric.Dimensions[0].Value), ["i-0123456789abcdef0"], "only running EC2 instances are queried");
assert.ok(fake.calls.every((c) => /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\//.test(c.auth)), "requests are signed by the SDK");
assert.ok(fake.calls.every((c) => ["DescribeInstances", "GetInstances", "GetRegions", "GetMetricData"].includes(c.op)), "the dashboard only reads");

fake = fakeAws(readRoutes("denied"));
res = await instances({ ...base, sdk: fake.sdk }, { matchHosts });
assert.equal(res.cpu.status, "denied");
assert.equal(res.instances.length, 3, "instances still show without CloudWatch access");

await assert.rejects(instances({ ...base, regions: ["eu-south-2"], lightsail: false, sdk: fakeAws(readRoutes()).sdk }), /UnauthorizedOperation/, "all regions failing is an error");

// ---------- every enabled region when none are configured ----------
fake = fakeAws((service, op, body, host) => {
  if (op === "DescribeRegions") return [200, "ec2-describe-regions.xml"];
  if (op === "GetRegions") return [200, "lightsail-get-regions.json"];
  if (service === "ec2") return [200, host.includes("ap-northeast-1") && !new URLSearchParams(body).get("NextToken") ? "describe-instances-page2.xml" : "describe-instances-empty.xml"];
  if (service === "lightsail") return [200, "lightsail-get-instances.json"];
});
res = await instances({ ...base, regions: "all", sdk: fake.sdk });
assert.deepEqual(res.regions.map((r) => r.region), ["ap-northeast-1", "eu-central-1", "us-east-1"], "all enabled EC2 regions are read");
const lsCalls = fake.calls.filter((c) => c.op === "GetInstances").map((c) => c.region).sort();
assert.deepEqual(lsCalls, ["ap-northeast-1", "us-east-1"], "Lightsail is only asked where it exists");
assert.equal(res.instances.filter((i) => i.service === "lightsail").length, 2);

// ---------- Cost Explorer ----------
const c = parseCost(JSON.parse(fixture("cost-and-usage.json")), { start: "2026-10-01", end: "2026-10-29", monthToDate: true });
assert.equal(c.total, 14.97);
assert.deepEqual(c.services.map((s) => s.service), ["Amazon Elastic Compute Cloud - Compute", "EC2 - Other", "Tax"], "sub-cent lines are dropped");
assert.deepEqual(costPeriod(new Date("2026-10-29T05:00:00Z")), { start: "2026-10-01", end: "2026-10-29", monthToDate: true });
assert.deepEqual(costPeriod(new Date("2026-10-01T05:00:00Z")), { start: "2026-09-01", end: "2026-10-01", monthToDate: false });
fake = fakeAws((service) => (service === "ce" ? [200, "cost-and-usage.json"] : null));
assert.equal((await cost({ ...base, sdk: fake.sdk })).total, 14.97);
await cost({ ...base, sdk: fake.sdk });
assert.equal(fake.calls.length, 1, "Cost Explorer answers are cached");
const ceDenied = fakeAws(() => [400, "ce-access-denied.json"]);
await assert.rejects(cost({ ...base, credentials: { ...base.credentials, accessKeyId: "AKIAOTHER" }, sdk: ceDenied.sdk }), /AccessDeniedException/);

// ---------- control ----------
fake = fakeAws((service, op) => ({ StartInstances: [200, "ec2-start-instances.xml"], StopInstance: [200, "lightsail-stop-instance.json"], DescribeInstances: [200, "describe-instances-page1.xml"], TerminateInstances: [200, "ec2-terminate-instances.xml"], GetInstance: [200, "lightsail-get-instance.json"], DeleteInstance: [200, "lightsail-stop-instance.json"] })[op]);
const cfg = { ...base, sdk: fake.sdk };
assert.deepEqual(await ec2Power(cfg, { region: "ap-northeast-1", instanceId: "i-0fedcba9876543210", action: "start" }), [{ instanceId: "i-0fedcba9876543210", from: "stopped", to: "pending" }]);
assert.equal(new URLSearchParams(fake.calls.at(-1).body).get("InstanceId.1"), "i-0fedcba9876543210");
const ls = await lightsailPower(cfg, { region: "ap-northeast-1", instanceName: "blog-tokyo", action: "stop" });
assert.deepEqual(ls, [{ id: "e0d2b1c4-0000-4000-8000-000000000002", type: "StopInstance", status: "Started", resource: "blog-tokyo", error: null }]);
assert.deepEqual(JSON.parse(fake.calls.at(-1).body), { instanceName: "blog-tokyo", force: false });

const before = fake.calls.length;
await assert.rejects(ec2Terminate(cfg, { region: "ap-northeast-1", instanceId: "i-0123456789abcdef0", confirmName: "web" }), /Refusing: confirmName must be "web & api" \(the instance's Name tag\)/);
await assert.rejects(ec2Terminate(cfg, { region: "ap-northeast-1", instanceId: "i-0123456789abcdef0", confirmName: "i-0123456789abcdef0" }), /must be "web & api"/, "an instance with a Name tag is not confirmed by its id");
assert.ok(!fake.calls.slice(before).some((x) => x.op === "TerminateInstances"), "nothing is terminated without the right name");
assert.deepEqual(await ec2Terminate(cfg, { region: "ap-northeast-1", instanceId: "i-0123456789abcdef0", confirmName: "web & api" }), [{ instanceId: "i-0123456789abcdef0", from: "running", to: "shutting-down" }]);
await assert.rejects(lightsailDelete(cfg, { region: "ap-northeast-1", instanceName: "blog-tokyo", confirmName: "blog" }), /Refusing: confirmName must be "blog-tokyo"/);
assert.ok(!fake.calls.slice(before).some((x) => x.op === "DeleteInstance"));
await lightsailDelete(cfg, { region: "ap-northeast-1", instanceName: "blog-tokyo", confirmName: "blog-tokyo" });
assert.deepEqual(fake.calls.slice(-2).map((x) => x.op), ["GetInstance", "DeleteInstance"], "the name is compared with the instance Lightsail returns");
{
  // An instance without a Name tag is confirmed by its id.
  const unnamed = fakeAws((service, op) => ({ DescribeInstances: [200, "describe-instances-page2.xml"], TerminateInstances: [200, "ec2-terminate-instances.xml"] })[op]);
  await assert.rejects(ec2Terminate({ ...base, sdk: unnamed.sdk }, { region: "ap-northeast-1", instanceId: "i-0fedcba9876543210", confirmName: "web" }), /must be "i-0fedcba9876543210" \(the instance id; it has no Name tag\)/);
  await ec2Terminate({ ...base, sdk: unnamed.sdk }, { region: "ap-northeast-1", instanceId: "i-0fedcba9876543210", confirmName: "i-0fedcba9876543210" });
  assert.equal(unnamed.calls.at(-1).op, "TerminateInstances");
}

const generic = await call(cfg, { service: "ec2", region: "ap-northeast-1", operation: "StartInstances", input: { InstanceIds: ["i-0fedcba9876543210"] } });
assert.equal(generic.result.StartingInstances[0].CurrentState.Name, "pending");
assert.equal(generic.requestId, "req-1");
await assert.rejects(call(cfg, { service: "ec2", region: "ap-northeast-1", operation: "TerminateInstances", input: {} }), /dedicated tool/);
await assert.rejects(call(cfg, { service: "lightsail", region: "ap-northeast-1", operation: "DeleteInstance", input: {} }), /dedicated tool/);
await assert.rejects(call(cfg, { service: "ec2", region: "ap-northeast-1", operation: "NoSuchThing" }), /has no operation/);
await assert.rejects(call(cfg, { service: "s3", region: "ap-northeast-1", operation: "ListBuckets" }), /ec2 or lightsail/);
// aws_query: Describe*, Get*, List* only, and still none of the operations that hand out secrets.
for (const operation of ["StartInstances", "RunInstances", "TerminateInstances", "DescribeInstances; x", "describeInstances", "Get"]) {
  await assert.rejects(query(cfg, { service: "ec2", region: "ap-northeast-1", operation }), /only runs Describe\*, Get\* and List\*/, operation);
}
await assert.rejects(query(cfg, { service: "ec2", region: "ap-northeast-1", operation: "GetPasswordData", input: {} }), /must not end up in the chat/);
await assert.rejects(query(cfg, { service: "lightsail", region: "ap-northeast-1", operation: "GetInstanceAccessDetails", input: {} }), /must not end up in the chat/);
// The instance console can show passwords printed at first boot: refused in both tools.
for (const operation of ["GetConsoleOutput", "GetConsoleScreenshot"]) {
  for (const fn of [call, query]) await assert.rejects(fn(cfg, { service: "ec2", region: "ap-northeast-1", operation, input: { InstanceId: "i-0123456789abcdef0" } }), /returns the instance's console, which can show passwords/, operation);
}

// ---------- config ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hub-aws-"));
assert.equal(loadConfig({}, tmp).configured, false);
fs.writeFileSync(path.join(tmp, "aws.json"), JSON.stringify({ accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret", regions: ["ap-northeast-1", "us-west-2"], costExplorer: true, lightsail: false }));
const fromFile = loadConfig({}, tmp);
assert.deepEqual([fromFile.regions, fromFile.cost, fromFile.lightsail], [["ap-northeast-1", "us-west-2"], true, false]);
const fromEnv = loadConfig({ AWS_ACCESS_KEY_ID: "AKIAENV", AWS_SECRET_ACCESS_KEY: "s", AWS_REGIONS: "eu-central-1, eu-central-1", AWS_LIGHTSAIL: "1" }, tmp);
assert.equal(fromEnv.credentials.accessKeyId, "AKIAENV", "env wins over the file");
assert.deepEqual([fromEnv.regions, fromEnv.lightsail], [["eu-central-1"], true]);
assert.equal(loadConfig({ AWS_ACCESS_KEY_ID: "a", AWS_SECRET_ACCESS_KEY: "b" }).regions, "all", "no regions means every enabled region");
assert.equal(loadConfig({ AWS_ACCESS_KEY_ID: "a", AWS_SECRET_ACCESS_KEY: "b", AWS_REGIONS: "all" }).regions, "all");
assert.match(loadConfig({ AWS_ACCESS_KEY_ID: "a", AWS_SECRET_ACCESS_KEY: "b", AWS_REGIONS: "evil.example.com/" }).error, /Invalid AWS region/);
fs.writeFileSync(path.join(tmp, "aws.json"), "AKIAEXAMPLE-not-json");
assert.equal(loadConfig({}, tmp).error, `${path.join(tmp, "aws.json")}: not valid JSON`, "file content is never echoed");
fs.rmSync(tmp, { recursive: true, force: true });

{
  const { call } = await import("../index.js");
  await assert.rejects(call({ credentials: {} }, { service: "lightsail", region: "ap-northeast-1", operation: "GetInstanceAccessDetails", input: {} }), /private key/);
  await assert.rejects(call({ credentials: {} }, { service: "ec2", region: "ap-northeast-1", operation: "GetPasswordData", input: {} }), /password/);
  for (const [service, operation] of [["lightsail", "GetRelationalDatabaseMasterUserPassword"], ["lightsail", "CreateBucketAccessKey"], ["lightsail", "CreateContainerServiceRegistryLogin"], ["ec2", "ExportVerifiedAccessInstanceClientConfiguration"]]) {
    await assert.rejects(call({ credentials: {} }, { service, region: "ap-northeast-1", operation, input: {} }), /must not end up in the chat/, operation);
  }
  await assert.rejects(call({ credentials: {} }, { service: "ec2", region: "ap-northeast-1", operation: "CreateReplaceRootVolumeTask", input: {} }), /do it in the AWS console/);
}

// ---------- secrets inside ordinary answers are redacted ----------
{
  const keys = fakeAws((service, op) => (op === "GetBucketAccessKeys" ? [200, "lightsail-get-bucket-access-keys.json"] : null));
  const r = await call({ ...base, sdk: keys.sdk }, { service: "lightsail", region: "ap-northeast-1", operation: "GetBucketAccessKeys", input: { bucketName: "b" } });
  assert.equal(r.result.accessKeys[0].secretAccessKey, "[redacted]");
  assert.equal(r.result.accessKeys[0].accessKeyId, "AKIAEXAMPLEBUCKET01");
  assert.ok(r.result.accessKeys[0].createdAt instanceof Date, "other values are left as the SDK parsed them");
  // User data (base64 cloud-init) often carries passwords and tokens.
  const ud = fakeAws((service, op) => (op === "DescribeInstanceAttribute" ? [200, "describe-instance-attribute-userdata.xml"] : null));
  const u = await query({ ...base, sdk: ud.sdk }, { service: "ec2", region: "ap-northeast-1", operation: "DescribeInstanceAttribute", input: { InstanceId: "i-0123456789abcdef0", Attribute: "userData" } });
  assert.deepEqual(u.result, { InstanceId: "i-0123456789abcdef0", UserData: "[redacted]" });
  const nested = { LaunchTemplateVersions: [{ LaunchTemplateData: { ImageId: "ami-1", UserData: "I2Nsb3VkLWNvbmZpZw==" } }], userData: "x" };
  assert.deepEqual(redactSecrets(nested), { LaunchTemplateVersions: [{ LaunchTemplateData: { ImageId: "ami-1", UserData: "[redacted]" } }], userData: "[redacted]" });
}

// ---------- protected IPs (ORRERY_SELF_IP, ORRERY_PROTECTED_IPS): read and start only ----------
{
  assert.deepEqual(protectedIps({ ORRERY_SELF_IP: "198.51.100.10", ORRERY_PROTECTED_IPS: "198.51.100.20" }), ["198.51.100.10", "198.51.100.20"]);
  const p = fakeAws((service, op, body) => {
    const q = new URLSearchParams(body);
    if (op === "DescribeAddresses") {
      return [200, { "eipalloc-0a1b2c3d4e5f60718": "describe-addresses-protected.xml", "eipassoc-0b1b2c3d4e5f60718": "describe-addresses-secondary.xml" }[q.get("Filter.1.Value.1")] || "describe-addresses-free.xml"];
    }
    if (op === "DescribeNetworkInterfaces") return [200, q.get("NetworkInterfaceId.1") === "eni-0e1b2c3d4e5f60718" ? "describe-network-interfaces-associated.xml" : "describe-network-interfaces-attached.xml"];
    if (op === "ReleaseAddress") return [200, "ec2-release-address.xml"];
    if (op === "DescribeInstances") return [200, new URLSearchParams(body).get("InstanceId.1") === "i-0123456789abcdef0" ? "describe-instances-page1.xml" : "describe-instances-page2.xml"];
    if (op === "GetInstance" && JSON.parse(body).instanceName === "new-1") return [400, "lightsail-not-found.json"];
    if (op === "CreateInstances") return [200, "lightsail-stop-instance.json"];
    return { GetInstance: [200, "lightsail-get-instance.json"], GetStaticIp: [200, "lightsail-get-static-ip.json"], StartInstances: [200, "ec2-start-instances.xml"], StartInstance: [200, "lightsail-stop-instance.json"], StopInstances: [200, "ec2-start-instances.xml"], StopInstance: [200, "lightsail-stop-instance.json"], TerminateInstances: [200, "ec2-terminate-instances.xml"] }[op];
  });
  const pcfg = { ...base, sdk: p.sdk, protectedIps: ["203.0.113.10", "203.0.113.50"] }; // web (EC2) and blog-tokyo (Lightsail)
  const web = "i-0123456789abcdef0";
  const changed = () => p.calls.filter((c) => !/^(Describe|Get)/.test(c.op)).map((c) => c.op);
  for (const action of ["stop", "reboot"]) await assert.rejects(ec2Power(pcfg, { region: "ap-northeast-1", instanceId: web, action }), /EC2 instance i-0123456789abcdef0 has the protected IP 203\.0\.113\.10/);
  await assert.rejects(ec2Terminate(pcfg, { region: "ap-northeast-1", instanceId: web, confirmName: "web & api" }), /protected IP/);
  for (const action of ["stop", "reboot"]) await assert.rejects(lightsailPower(pcfg, { region: "ap-northeast-1", instanceName: "blog-tokyo", action }), /Lightsail instance blog-tokyo has the protected IP 203\.0\.113\.50/);
  await assert.rejects(lightsailDelete(pcfg, { region: "ap-northeast-1", instanceName: "blog-tokyo", confirmName: "blog-tokyo" }), /protected IP/);
  await assert.rejects(call(pcfg, { service: "ec2", region: "ap-northeast-1", operation: "StopInstances", input: { InstanceIds: [web] } }), /protected IP/);
  await assert.rejects(call(pcfg, { service: "ec2", region: "ap-northeast-1", operation: "ModifyInstanceAttribute", input: { InstanceId: web, DisableApiStop: { Value: false } } }), /protected IP/);
  await assert.rejects(call(pcfg, { service: "lightsail", region: "ap-northeast-1", operation: "StopInstance", input: { instanceName: "blog-tokyo" } }), /protected IP/);
  await assert.rejects(call(pcfg, { service: "lightsail", region: "ap-northeast-1", operation: "ReleaseStaticIp", input: { staticIpName: "StaticIp-blog" } }), /static IP StaticIp-blog has the protected IP 203\.0\.113\.50/);
  // resourceName is an instance too (SetIpAddressType can drop its public IPv4), and a protected static IP is not moved away.
  await assert.rejects(call(pcfg, { service: "lightsail", region: "ap-northeast-1", operation: "SetIpAddressType", input: { resourceType: "Instance", resourceName: "blog-tokyo", ipAddressType: "ipv6" } }), /Lightsail instance blog-tokyo has the protected IP/);
  await assert.rejects(call(pcfg, { service: "lightsail", region: "ap-northeast-1", operation: "AttachStaticIp", input: { staticIpName: "StaticIp-blog", instanceName: "new-1" } }), /static IP StaticIp-blog has the protected IP/);
  // Elastic IPs and network interfaces: a protected address, or one held by a protected instance, is not
  // moved, disassociated or released, and a protected instance's interfaces keep their addresses and groups.
  const ec2Call = (operation, input) => call(pcfg, { service: "ec2", region: "ap-northeast-1", operation, input });
  await assert.rejects(ec2Call("ReleaseAddress", { AllocationId: "eipalloc-0a1b2c3d4e5f60718" }), /Elastic IP eipalloc-0a1b2c3d4e5f60718 has the protected IP 203\.0\.113\.10/);
  await assert.rejects(ec2Call("AssociateAddress", { AllocationId: "eipalloc-0a1b2c3d4e5f60718", InstanceId: "i-0fedcba9876543210", AllowReassociation: true }), /Elastic IP .* protected IP 203\.0\.113\.10/);
  const looked = p.calls.length;
  await assert.rejects(ec2Call("DisassociateAddress", { PublicIp: "203.0.113.10" }), /Elastic IP 203\.0\.113\.10 has the protected IP/);
  assert.equal(p.calls.length, looked, "a protected PublicIp is refused without a lookup");
  await assert.rejects(ec2Call("DisassociateAddress", { AssociationId: "eipassoc-0b1b2c3d4e5f60718" }), /EC2 instance i-0123456789abcdef0 has the protected IP 203\.0\.113\.10/, "a second address of a protected instance stays");
  await assert.rejects(ec2Call("ModifyNetworkInterfaceAttribute", { NetworkInterfaceId: "eni-0d1b2c3d4e5f60718", Groups: ["sg-0123456789abcdef0"] }), /EC2 instance i-0123456789abcdef0 has the protected IP/);
  await assert.rejects(ec2Call("UnassignPrivateIpAddresses", { NetworkInterfaceId: "eni-0e1b2c3d4e5f60718", PrivateIpAddresses: ["172.31.2.41"] }), /network interface eni-0e1b2c3d4e5f60718 has the protected IP 203\.0\.113\.10/);
  assert.deepEqual(changed(), [], "nothing was stopped, rebooted, terminated, deleted or released");
  await ec2Power(pcfg, { region: "ap-northeast-1", instanceId: web, action: "start" });
  await lightsailPower(pcfg, { region: "ap-northeast-1", instanceName: "blog-tokyo", action: "start" });
  await call(pcfg, { service: "ec2", region: "ap-northeast-1", operation: "StartInstances", input: { InstanceIds: [web] } });
  await ec2Power(pcfg, { region: "ap-northeast-1", instanceId: "i-0fedcba9876543210", action: "stop" }); // not protected
  await call(pcfg, { service: "lightsail", region: "ap-northeast-1", operation: "CreateInstances", input: { instanceNames: ["new-1"], availabilityZone: "ap-northeast-1a", blueprintId: "debian_12", bundleId: "nano_3_0" } });
  await ec2Call("ReleaseAddress", { AllocationId: "eipalloc-0c1b2c3d4e5f60718" }); // unattached, not protected
  assert.deepEqual(changed(), ["StartInstances", "StartInstance", "StartInstances", "StopInstances", "CreateInstances", "ReleaseAddress"], "starting stays allowed; other and new instances and free addresses can be changed");
}
console.log("aws test passed");
