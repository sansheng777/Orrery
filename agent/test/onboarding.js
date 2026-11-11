// Discovery (netcup/AWS machines in list_servers) and ssh_bootstrap, with fake providers and SSH.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "orrery-onboard-"));
process.env.ORRERY_DIR = dataDir;
process.env.ORRERY_SSH_CONFIG = path.join(dataDir, "none");
const { fromNetcup, fromAws, fromLinode, fromGcp, fromAliyun, fromVultr, fromDigitalocean, fromKamatera, createDiscovery, applyLabel } = await import("../src/discovery.js");
const { createBootstrapper, installScript, rescueScript, pasteCommand, sshFailure } = await import("../src/bootstrap.js");
const { addServer, removeServer } = await import("../src/inventory.js");

const PUB = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleExampleExampleExampleExampleExample orrery";

// ---------- mapping (shapes as the providers return them) ----------
const nc = (id, ip, extra = {}) => ({ id, name: `v22026${id}`, nickname: null, hostname: `v22026${id}.goodsrv.de`, state: "RUNNING", product: "VPS 500 G12", site: "Nuremberg", ipv4: [ip], ipv6: [], ...extra });
const middle = fromNetcup(nc(400001, "198.51.100.10"), "198.51.100.10");
assert.equal(middle.id, "netcup:400001");
assert.equal(middle.username, "root");
assert.equal(middle.name, "v22026400001", "generic v22… hostnames fall back to the server name");
assert.equal(middle.self, true);
assert.ok(middle.tags.includes("orrery-host"));
assert.equal(fromNetcup(nc(1, "1.1.1.1", { hostname: "agent" })).name, "agent");
assert.equal(fromNetcup(nc(2, "1.1.1.2", { nickname: "db" })).name, "db");
assert.equal(fromNetcup({ ...nc(3, "x"), ipv4: [] }), null, "no IPv4, nothing to SSH to");

const ec2 = { id: "i-012963bba8bfaa551", service: "ec2", name: "web", region: "ap-northeast-1", zone: "ap-northeast-1c", state: "running", publicIp: "203.0.113.60", platform: "Linux/UNIX" };
const ls = { id: "tokyo-1", service: "lightsail", name: "tokyo-1", region: "ap-northeast-1", state: "running", publicIp: "198.51.100.30", platform: "Debian" };
assert.deepEqual(fromAws(ec2).provider, { kind: "ec2", region: "ap-northeast-1", instanceId: "i-012963bba8bfaa551", zone: "ap-northeast-1c" });
assert.equal(fromAws(ec2).id, "ec2:ap-northeast-1:i-012963bba8bfaa551");
assert.equal(fromAws(ls).id, "lightsail:ap-northeast-1:tokyo-1");
assert.equal(fromAws(ls).username, "admin", "Debian on Lightsail logs in as admin");
assert.equal(fromAws({ ...ls, platform: "Ubuntu" }).username, "ubuntu");
assert.equal(fromAws({ ...ec2, publicIp: null }), null);
const lin = { id: 70123456, label: "osaka-1", status: "running", region: "jp-osa", type: "g6-nanode-1", ipv4: ["192.168.139.7", "203.0.113.20"], ipv6: "2400:8902::f03c/128" };
assert.deepEqual(
  { id: fromLinode(lin).id, host: fromLinode(lin).host, username: fromLinode(lin).username, provider: fromLinode(lin).provider },
  { id: "linode:70123456", host: "203.0.113.20", username: "root", provider: { kind: "linode", linodeId: 70123456 } },
  "the public IPv4, not the private 192.168 one",
);
assert.equal(fromLinode({ ...lin, ipv4: ["192.168.1.2"] }), null, "no public IPv4, nothing to SSH to");
const gce = { id: "7310", name: "web-1", project: "demo-proj", zone: "asia-east1-b", status: "RUNNING", machineType: "e2-micro", externalIp: "203.0.113.80", ipv6: null };
assert.deepEqual(fromGcp(gce), {
  id: "gcp:demo-proj:asia-east1-b:web-1", name: "web-1", host: "203.0.113.80", port: 22, username: "orrery", tags: ["gcp", "asia-east1-b", "e2-micro"],
  source: "gcp", auth: "agent key", state: "running", self: false, provider: { kind: "gcp", project: "demo-proj", zone: "asia-east1-b", name: "web-1", instanceId: "7310" },
});
assert.equal(fromGcp({ ...gce, status: "TERMINATED", externalIp: null }), null, "a stopped instance has no external IP");
const ecs = { id: "i-2zeexample0001abcd", name: "beijing-1", region: "cn-beijing", status: "Running", type: "ecs.e-c1m1.large", publicIp: "203.0.113.40" };
assert.deepEqual(fromAliyun(ecs), {
  id: "aliyun:cn-beijing:i-2zeexample0001abcd", name: "beijing-1", host: "203.0.113.40", port: 22, username: "root", tags: ["aliyun", "cn-beijing", "ecs.e-c1m1.large"],
  source: "aliyun", auth: "agent key", state: "running", self: false, provider: { kind: "aliyun", region: "cn-beijing", instanceId: "i-2zeexample0001abcd", name: "beijing-1" },
});
assert.equal(fromAliyun({ ...ecs, publicIp: null }), null, "no public IP, nothing to SSH to");
const vul = { id: "cb676a46-66fd-4dfb-b839-443f2e6c0b60", label: "nrt-1", region: "nrt", plan: "vc2-1c-1gb", status: "active", powerStatus: "running", ipv4: "203.0.113.30" };
assert.deepEqual(fromVultr(vul), {
  id: "vultr:cb676a46-66fd-4dfb-b839-443f2e6c0b60", name: "nrt-1", host: "203.0.113.30", port: 22, username: "root", tags: ["vultr", "nrt", "vc2-1c-1gb"],
  source: "vultr", auth: "agent key", state: "running", self: false, provider: { kind: "vultr", instanceId: "cb676a46-66fd-4dfb-b839-443f2e6c0b60", label: "nrt-1" },
});
assert.equal(fromVultr({ ...vul, powerStatus: "stopped" }).state, "stopped");
assert.equal(fromVultr({ ...vul, ipv4: null }), null, "no address yet, nothing to SSH to");
const drop = { id: 512345678, name: "sgp-1", region: "sgp1", size: "s-1vcpu-512mb-10gb", status: "active", ipv4: ["203.0.113.40"], privateIpv4: ["10.104.0.2"], ipv6: null };
assert.deepEqual(fromDigitalocean(drop), {
  id: "digitalocean:512345678", name: "sgp-1", host: "203.0.113.40", port: 22, username: "root", tags: ["digitalocean", "sgp1", "s-1vcpu-512mb-10gb"],
  source: "digitalocean", auth: "agent key", state: "running", self: false, provider: { kind: "digitalocean", dropletId: 512345678, name: "sgp-1" },
});
assert.equal(fromDigitalocean({ ...drop, status: "off" }).state, "stopped");
assert.equal(fromDigitalocean({ ...drop, ipv4: [] }), null, "no public IPv4, nothing to SSH to");
const kam = { id: "4ef1a2b3c4d5e6f7a8b9c0d1e2f3a4b5", name: "hk-1", datacenter: "AS", cpu: "1A", power: "on", ipv4: "203.0.113.50", publicIps: ["203.0.113.50"] };
assert.deepEqual(fromKamatera(kam), {
  id: "kamatera:4ef1a2b3c4d5e6f7a8b9c0d1e2f3a4b5", name: "hk-1", host: "203.0.113.50", port: 22, username: "root", tags: ["kamatera", "AS", "1A"],
  source: "kamatera", auth: "agent key", state: "running", self: false, provider: { kind: "kamatera", serverId: "4ef1a2b3c4d5e6f7a8b9c0d1e2f3a4b5", name: "hk-1" },
});
assert.equal(fromKamatera({ ...kam, power: "off" }).state, "stopped");
assert.equal(fromKamatera({ ...kam, ipv4: null }), null, "no public IPv4, nothing to SSH to");

// ---------- merge ----------
let calls = 0;
const providers = {
  aws: { loadConfig: () => ({ configured: true }), instances: async () => (calls++, { instances: [ec2, ls] }) },
  netcup: { loadConfig: () => ({ configured: true }), servers: async () => ({ servers: [nc(400001, "198.51.100.10"), nc(400003, "192.0.2.72", { hostname: "agent" })] }) },
  linode: { loadConfig: () => ({ configured: true }), createApi: () => ({}), instances: async () => ({ instances: [lin] }) },
  gcp: { loadConfig: () => ({ configured: true, clientEmail: "hub@demo-proj.iam.gserviceaccount.com" }), createApi: () => ({}), instances: async () => ({ instances: [gce] }) },
  aliyun: { loadConfig: () => ({ configured: true }), createApi: () => ({}), instances: async () => ({ instances: [ecs] }) },
  vultr: { loadConfig: () => ({ configured: true }), createApi: () => ({}), instances: async () => ({ instances: [vul] }) },
  digitalocean: { loadConfig: () => ({ configured: true }), createApi: () => ({}), droplets: async () => ({ droplets: [drop] }) },
  kamatera: { loadConfig: () => ({ configured: true }), createApi: () => ({}), servers: async () => ({ servers: [kam] }) },
};
let t = 0;
const discovery = createDiscovery({ env: { ORRERY_SELF_IP: "198.51.100.10" }, dataDir, providers, now: () => t });
let { servers, errors } = await discovery.list();
assert.deepEqual(servers.map((s) => s.id).sort(), ["aliyun:cn-beijing:i-2zeexample0001abcd", "digitalocean:512345678", "ec2:ap-northeast-1:i-012963bba8bfaa551", "gcp:demo-proj:asia-east1-b:web-1", "kamatera:4ef1a2b3c4d5e6f7a8b9c0d1e2f3a4b5", "lightsail:ap-northeast-1:tokyo-1", "linode:70123456", "netcup:400001", "netcup:400003", "vultr:cb676a46-66fd-4dfb-b839-443f2e6c0b60"]);
assert.deepEqual(errors, []);
await discovery.list();
assert.equal(calls, 1, "provider APIs are cached");
t += 61000;
await discovery.list();
assert.equal(calls, 2, "and refreshed after a minute");

const saved = addServer({ name: "agent-box", host: "192.0.2.72", port: 2222, username: "deploy" });
discovery.invalidate();
({ servers } = await discovery.list());
assert.ok(!servers.some((s) => s.id === "netcup:400003"), "a saved server with the same IP replaces the discovered one");
assert.ok(servers.some((s) => s.id === saved.id && s.port === 2222));

// A saved server that covers the Orrery host (to override its user or port) is still the host.
{
  const hostSaved = addServer({ name: "host-override", host: "198.51.100.10", port: 2200, username: "root" });
  ({ servers } = await discovery.list());
  const hs = servers.find((s) => s.id === hostSaved.id);
  assert.ok(hs.self, "it keeps the self flag");
  assert.deepEqual(hs.tags.filter((x) => x === "orrery-host"), ["orrery-host"], "and the orrery-host tag");
  assert.equal(servers[0].id, hostSaved.id, "and comes first");
  removeServer(hostSaved.id);
}

discovery.remember("ec2:ap-northeast-1:i-012963bba8bfaa551", { username: "ec2-user" });
assert.equal((await discovery.resolve("ec2:ap-northeast-1:i-012963bba8bfaa551")).username, "ec2-user", "what onboarding learns is kept");
assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, "discovered.json"), "utf8"))["ec2:ap-northeast-1:i-012963bba8bfaa551"].username, "ec2-user");
await assert.rejects(discovery.resolve("netcup:1"), /Unknown server/);

discovery.remember("lightsail:ap-northeast-1:tokyo-1", { ignored: true });
let ignored;
({ servers, ignored } = await discovery.list());
assert.ok(!servers.some((s) => s.id === "lightsail:ap-northeast-1:tokyo-1"), "ignored machines are hidden");
assert.deepEqual(ignored.map((s) => s.id), ["lightsail:ap-northeast-1:tokyo-1"], "and listed separately");
assert.equal((await discovery.resolve("lightsail:ap-northeast-1:tokyo-1")).host, "198.51.100.30", "but can still be addressed");
discovery.remember("lightsail:ap-northeast-1:tokyo-1", { ignored: false });
({ servers } = await discovery.list());
assert.ok(servers.some((s) => s.id === "lightsail:ap-northeast-1:tokyo-1"), "and brought back");

// Labels: display name, role tags, note; the Orrery host is always listed first.
discovery.setLabel("netcup:400001", { label: "orrery host" });
discovery.setLabel("lightsail:ap-northeast-1:tokyo-1", { tags: ["shared"] });
({ servers } = await discovery.list());
assert.equal(servers[0].id, "netcup:400001", "the Orrery host comes first");
assert.equal(servers[0].tags.filter((t) => t === "orrery-host").length, 1, "the Orrery host is tagged once");
assert.equal(servers[0].name, "orrery host");
assert.equal(servers[0].originalName, "v22026400001", "the provider's name is kept");
const debian = servers.find((s) => s.id === "lightsail:ap-northeast-1:tokyo-1");
assert.deepEqual(debian.roleTags, ["shared"]);
assert.equal(debian.tags[0], "shared", "role tags come before provider tags");
assert.ok(debian.tags.includes("lightsail"));
assert.equal((await discovery.resolve("netcup:400001")).name, "orrery host", "resolve uses the label too");
discovery.setLabel("lightsail:ap-northeast-1:tokyo-1", { tags: [] });
assert.ok(!JSON.parse(fs.readFileSync(path.join(dataDir, "labels.json"), "utf8"))["lightsail:ap-northeast-1:tokyo-1"], "an empty list removes the label");
assert.equal((fs.statSync(path.join(dataDir, "labels.json")).mode & 0o777).toString(8), "600");
assert.deepEqual(applyLabel({ id: "x", name: "a", tags: ["t"] }, {}), { id: "x", name: "a", tags: ["t"] }, "no label, unchanged");

const broken = createDiscovery({ dataDir, providers: { ...providers, aws: { loadConfig: () => ({ configured: true }), instances: async () => Promise.reject(new Error("AuthFailure")) } } });
({ servers, errors } = await broken.list());
assert.deepEqual(errors, [{ provider: "aws", error: "AuthFailure" }]);
assert.ok(servers.some((s) => s.source === "netcup"), "one provider failing does not hide the others");

// A provider whose refresh fails keeps its last list: its machines stay addressable, and the error says so.
{
  let down = false;
  let clock = 0;
  const netcupDown = { loadConfig: () => ({ configured: true }), servers: async () => (down ? Promise.reject(new Error("invalid_grant")) : { servers: [nc(400001, "198.51.100.10")] }) };
  const flaky = createDiscovery({ env: { ORRERY_SELF_IP: "198.51.100.10" }, dataDir, providers: { ...providers, netcup: netcupDown }, now: () => clock });
  assert.equal((await flaky.resolve("netcup:400001")).host, "198.51.100.10");
  down = true;
  clock += 61000;
  assert.equal((await flaky.resolve("netcup:400001")).host, "198.51.100.10", "a netcup outage does not make the Orrery host unknown");
  ({ servers, errors } = await flaky.list());
  assert.ok(servers.some((s) => s.id === "netcup:400001"), "and it is still listed");
  assert.deepEqual(errors, [{ provider: "netcup", error: "invalid_grant", usingListFrom: new Date(0).toISOString() }]);
}

// A provider whose API hangs does not hold the listing up: the others are listed, and it is reported.
{
  const hung = { loadConfig: () => ({ configured: true }), instances: () => new Promise(() => {}), createApi: () => ({}) };
  const d = createDiscovery({ env: { ORRERY_SELF_IP: "198.51.100.10" }, dataDir, providers: { ...providers, linode: hung }, now: () => t, providerTimeoutMs: 30 });
  const r = await d.list();
  assert.ok(r.servers.some((s) => s.id === "netcup:400001"), "the other providers are listed");
  assert.ok(!r.servers.some((s) => s.source === "linode"));
  assert.match(r.errors.find((e) => e.provider === "linode").error, /did not answer within/);
}

// One netcup server's details failing (no IPs then) keeps that server's last record, and says so.
{
  let failing = false;
  let clock = 0;
  const detailFails = (id) => ({ id, name: `v22026${id}`, nickname: null, hostname: null, state: null, ipv4: [], ipv6: [], error: "netcup GET failed with 502" });
  const netcupPartial = {
    loadConfig: () => ({ configured: true }),
    servers: async () => ({ servers: [nc(400001, "198.51.100.10"), failing ? detailFails(400002) : nc(400002, "203.0.113.45"), detailFails(400004)] }),
  };
  const d = createDiscovery({ env: { ORRERY_SELF_IP: "198.51.100.10" }, dataDir, providers: { ...providers, netcup: netcupPartial }, now: () => clock });
  ({ servers, errors } = await d.list());
  assert.ok(!servers.some((s) => s.id === "netcup:400004"), "never seen with an IP: nothing to list");
  assert.deepEqual(errors, [{ provider: "netcup", server: "netcup:400004", error: "netcup GET failed with 502" }], "but the failure is reported");
  failing = true;
  clock += 61000;
  ({ servers, errors } = await d.list());
  assert.equal(servers.find((s) => s.id === "netcup:400002")?.host, "203.0.113.45", "a server whose details failed stays listed");
  assert.equal((await d.resolve("netcup:400002")).host, "203.0.113.45", "and addressable");
  assert.deepEqual(
    errors.find((e) => e.server === "netcup:400002"),
    { provider: "netcup", server: "netcup:400002", error: "netcup GET failed with 502", usingListFrom: new Date(0).toISOString() },
  );
}

// Past the TTL, resolve() answers from the last listing at once while a slow refresh runs behind it
// (the live figures resolve every second); list() still waits for the fresh one.
{
  let clock = 0;
  let slow = null;
  const netcupSlow = { loadConfig: () => ({ configured: true }), servers: () => slow || Promise.resolve({ servers: [nc(400001, "198.51.100.10")] }) };
  const d = createDiscovery({ env: { ORRERY_SELF_IP: "198.51.100.10" }, dataDir, providers: { ...providers, netcup: netcupSlow }, now: () => clock });
  await d.resolve("netcup:400001");
  let release;
  slow = new Promise((r) => (release = () => r({ servers: [nc(400001, "198.51.100.99")] })));
  clock += 61000;
  const t0 = Date.now();
  assert.equal((await d.resolve("netcup:400001")).host, "198.51.100.10", "the old listing, without waiting");
  assert.ok(Date.now() - t0 < 50);
  const listed = d.list();
  release();
  assert.ok((await listed).servers.some((s) => s.host === "198.51.100.99"), "list() waited for the fresh listing");
  assert.equal((await d.resolve("netcup:400001")).host, "198.51.100.99", "and resolve() uses it from then on");
}

// ---------- scripts ----------
{
  // installScript, run for real in a scratch HOME: writes once, reports the failing step otherwise.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "orrery-home-"));
  const run = () => execFileSync("sh", ["-c", installScript(PUB)], { env: { ...process.env, HOME: home } }).toString();
  assert.match(run(), /ORRERY_OK/);
  assert.match(run(), /ORRERY_OK/);
  assert.equal(fs.readFileSync(path.join(home, ".ssh", "authorized_keys"), "utf8"), PUB + "\n", "the key is written once");
  assert.equal((fs.statSync(path.join(home, ".ssh")).mode & 0o777).toString(8), "700");
  fs.rmSync(path.join(home, ".ssh"), { recursive: true });
  fs.writeFileSync(path.join(home, ".ssh"), "a file where the directory should be");
  let out = "";
  try {
    execFileSync("sh", ["-c", installScript(PUB)], { env: { ...process.env, HOME: home } });
  } catch (e) {
    out = e.stdout.toString();
  }
  assert.match(out, /ORRERY_FAIL mkdir .*\.ssh: .*File exists/, "a failing step names itself and its error");
  fs.rmSync(home, { recursive: true, force: true });

  // The command to paste by hand: pasted twice, the key is still there once.
  const pasteHome = fs.mkdtempSync(path.join(os.tmpdir(), "orrery-home-"));
  for (let i = 0; i < 2; i++) execFileSync("sh", ["-c", pasteCommand(PUB)], { env: { ...process.env, HOME: pasteHome } });
  assert.equal(fs.readFileSync(path.join(pasteHome, ".ssh", "authorized_keys"), "utf8"), PUB + "\n", "the pasted key is written once");
  assert.equal((fs.statSync(path.join(pasteHome, ".ssh", "authorized_keys")).mode & 0o777).toString(8), "600");
  fs.rmSync(pasteHome, { recursive: true, force: true });

  // An authorized_keys file whose last line has no newline: the key goes on its own line, not glued to it.
  for (const script of [installScript(PUB), pasteCommand(PUB)]) {
    const h = fs.mkdtempSync(path.join(os.tmpdir(), "orrery-home-"));
    fs.mkdirSync(path.join(h, ".ssh"));
    fs.writeFileSync(path.join(h, ".ssh", "authorized_keys"), "ssh-rsa AAAAB3existing other");
    execFileSync("sh", ["-c", script], { env: { ...process.env, HOME: h } });
    assert.equal(fs.readFileSync(path.join(h, ".ssh", "authorized_keys"), "utf8"), `ssh-rsa AAAAB3existing other\n${PUB}\n`);
    fs.rmSync(h, { recursive: true, force: true });
  }

  // ssh failures: client notices are dropped, the real cause and how ssh ended are kept.
  const notices = "Warning: Permanently added '198.51.100.30' (ED25519) to the list of known hosts.\n** WARNING: connection is not using a post-quantum key exchange algorithm.\n** This session may be vulnerable to \"store now, decrypt later\" attacks.\n";
  assert.equal(sshFailure({ code: 1 }, "ORRERY_FAIL touch /home/admin/.ssh/authorized_keys: Permission denied\n", notices).message,
    "ssh exited with code 1; remote output: ORRERY_FAIL touch /home/admin/.ssh/authorized_keys: Permission denied");
  assert.equal(sshFailure({ code: 255 }, "", notices + "admin@198.51.100.30: Permission denied (publickey).\n").message, "ssh exited with code 255; admin@198.51.100.30: Permission denied (publickey).");
  assert.match(sshFailure({ killed: true, signal: "SIGTERM" }, "", notices).message, /timeout/);
}
assert.throws(() => installScript("ssh-ed25519 AAAA'; rm -rf / #"), /malformed/);
execFileSync("sh", ["-n", "-c", rescueScript(PUB)]);
{
  // Run the rescue script against a fake installed system: fake lsblk/mount/umount on PATH.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orrery-rescue-"));
  const mnt = path.join(root, "mnt");
  const bin = path.join(root, "bin");
  fs.mkdirSync(path.join(mnt, "etc", "ssh"), { recursive: true });
  fs.mkdirSync(path.join(mnt, "root"), { recursive: true });
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(mnt, "etc", "os-release"), "ID=debian\n");
  fs.writeFileSync(path.join(mnt, "etc", "ssh", "sshd_config"), "Port 22\nPermitRootLogin no\n");
  fs.writeFileSync(path.join(bin, "lsblk"), "#!/bin/sh\necho '/dev/vda1 vfat'\necho '/dev/vda3 ext4'\n", { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "mount"), `#!/bin/sh\n[ "$1" = /dev/vda3 ]\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "umount"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "chown"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, ORRERY_MNT: mnt };
  const out = execFileSync("sh", ["-c", rescueScript(PUB)], { env }).toString();
  assert.match(out, /ORRERY_OK \/dev\/vda3/);
  execFileSync("sh", ["-c", rescueScript(PUB)], { env }); // a second run adds nothing
  assert.equal(fs.readFileSync(path.join(mnt, "root", ".ssh", "authorized_keys"), "utf8"), PUB + "\n");
  assert.match(fs.readFileSync(path.join(mnt, "etc", "ssh", "sshd_config"), "utf8"), /^PermitRootLogin prohibit-password$/m);
  fs.rmSync(root, { recursive: true, force: true });
}

// ---------- bootstrap ----------
const waitJob = async (b, id) => {
  for (let i = 0; i < 200; i++) {
    const [j] = b.status(id);
    if (j.status !== "running") return j;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("job did not finish");
};
const remembered = [];
const fakeDiscovery = { remember: (id, patch) => remembered.push([id, patch.username]) };
const base = { publicKey: () => PUB, keyPath: "/data/keys/id_ed25519", discovery: fakeDiscovery, sleep: async () => {}, selfIp: "198.51.100.10", allowRescue: true };

// Already trusted: nothing else happens.
{
  const b = createBootstrapper({ ...base, exec: async () => ({ stdout: "ORRERY_OK\n" }), aws: null, netcup: null });
  const j = await waitJob(b, b.start(fromAws(ec2)).id);
  assert.equal(j.status, "done");
}

// EC2: the first user is wrong, the second works.
{
  const pushed = [];
  let trusted = null;
  const exec = async (s, cmd) => {
    if (cmd.startsWith("umask")) {
      if (s.username !== "ec2-user") throw new Error("All configured authentication methods failed");
      trusted = s.username;
      return { stdout: "ORRERY_OK\n" };
    }
    if (trusted === s.username) return { stdout: "ORRERY_OK\n" };
    throw new Error("All configured authentication methods failed");
  };
  const awsDeps = { config: {}, sendSshPublicKey: async (c, a) => pushed.push(a.osUser) };
  const b = createBootstrapper({ ...base, exec, aws: awsDeps });
  const j = await waitJob(b, b.start(fromAws(ec2)).id);
  assert.equal(j.status, "done", j.error);
  assert.deepEqual(pushed, ["ubuntu", "ec2-user"]);
  assert.deepEqual(remembered.pop(), ["ec2:ap-northeast-1:i-012963bba8bfaa551", "ec2-user"]);
}

// EC2: logged in, but the key cannot be written: that is the error, and no other user is tried.
{
  const pushed = [];
  const exec = async (s, cmd) => {
    if (cmd.startsWith("umask")) return { stdout: "ORRERY_FAIL touch /home/ubuntu/.ssh/authorized_keys: Permission denied\n" };
    throw new Error("All configured authentication methods failed");
  };
  const b = createBootstrapper({ ...base, exec, aws: { config: {}, sendSshPublicKey: async (c, a) => pushed.push(a.osUser) } });
  const j = await waitJob(b, b.start(fromAws(ec2)).id);
  assert.equal(j.status, "failed");
  assert.match(j.error, /Logged in as ubuntu, but installing the key failed: touch .*Permission denied/);
  assert.deepEqual(pushed, ["ubuntu"]);
}

// EC2 behind a closed security group: a clear message, no endless retries.
{
  const exec = async () => {
    throw new Error("connect ETIMEDOUT 203.0.113.60:22");
  };
  const b = createBootstrapper({ ...base, exec, aws: { config: {}, sendSshPublicKey: async () => {} } });
  const j = await waitJob(b, b.start(fromAws(ec2)).id);
  assert.equal(j.status, "failed");
  assert.match(j.error, /security group/);
}

// Lightsail: temporary key and certificate are written, used, and removed.
{
  let sshArgs = null;
  let tmp = null;
  let trusted = false;
  const b = createBootstrapper({
    ...base,
    exec: async () => (trusted ? { stdout: "ORRERY_OK\n" } : Promise.reject(new Error("auth failed"))),
    aws: { config: {}, lightsailAccess: async () => ({ username: "admin", host: "198.51.100.30", privateKey: "-----BEGIN KEY-----\nx\n-----END KEY-----", certificate: "ssh-rsa-cert-v01@openssh.com AAAA" }) },
    runSsh: async (args) => {
      sshArgs = args;
      tmp = path.dirname(args[args.indexOf("-i") + 1]);
      assert.equal((fs.statSync(path.join(tmp, "key")).mode & 0o777).toString(8), "600");
      trusted = true;
      return "ORRERY_OK\n";
    },
  });
  const job = b.start(fromAws(ls));
  assert.ok(!JSON.stringify(job).includes("BEGIN KEY"), "the temporary key is never in a result");
  const j = await waitJob(b, job.id);
  assert.equal(j.status, "done", j.error);
  assert.ok(sshArgs.includes("admin@198.51.100.30"));
  assert.ok(sshArgs.some((a) => a.startsWith("CertificateFile=")));
  assert.ok(!fs.existsSync(tmp), "temporary files are removed");
  assert.ok(!JSON.stringify(b.status()).includes("BEGIN KEY"));
}

// netcup: never the Orrery host itself.
{
  const b = createBootstrapper({ ...base, exec: async () => Promise.reject(new Error("auth failed")), netcup: {} });
  const j = await waitJob(b, b.start(middle).id);
  assert.equal(j.status, "failed");
  assert.match(j.error, /Orrery host/);
}

// Linode: no automatic path; the job hands back the command to paste.
{
  const b = createBootstrapper({ ...base, exec: async () => Promise.reject(new Error("All configured authentication methods failed")) });
  const j = await waitJob(b, b.start(fromLinode(lin)).id);
  assert.equal(j.status, "failed");
  assert.match(j.error, /Lish/);
  assert.ok(j.error.includes(PUB));
}

// Vultr: no automatic path either; the command is pasted in the web console.
{
  const b = createBootstrapper({ ...base, exec: async () => Promise.reject(new Error("All configured authentication methods failed")) });
  const j = await waitJob(b, b.start(fromVultr(vul)).id);
  assert.equal(j.status, "failed");
  assert.match(j.error, /View Console/);
  assert.ok(j.error.includes(PUB));
}

// DigitalOcean: the same, through the Droplet Console.
{
  const b = createBootstrapper({ ...base, exec: async () => Promise.reject(new Error("All configured authentication methods failed")) });
  const j = await waitJob(b, b.start(fromDigitalocean(drop)).id);
  assert.equal(j.status, "failed");
  assert.match(j.error, /Droplet Console/);
  assert.ok(j.error.includes(PUB));
}

// Google Cloud: the key goes into instance metadata, then the job waits until the guest agent lets us in.
{
  const added = [];
  let logins = 0;
  const gcpDeps = { addSshKey: async (t) => (added.push(t), { changed: true, user: "orrery" }) };
  const exec = async (srv) => {
    if (srv.username !== "orrery" || ++logins < 3) throw new Error("All configured authentication methods failed"); // the agent takes a moment
    return { stdout: "ORRERY_OK\n" };
  };
  const b = createBootstrapper({ ...base, exec, gcp: gcpDeps });
  const j = await waitJob(b, b.start(fromGcp(gce)).id);
  assert.equal(j.status, "done", j.error);
  assert.deepEqual(added, [{ project: "demo-proj", zone: "asia-east1-b", name: "web-1", publicKey: PUB }]);
  assert.ok(j.steps.some((s) => /Metadata updated/.test(s.msg)));
  const none = createBootstrapper({ ...base, exec: async () => Promise.reject(new Error("auth failed")), gcp: null });
  const k = await waitJob(none, none.start(fromGcp(gce)).id);
  assert.match(k.error, /Google Cloud credentials are not configured/);
  const oslogin = createBootstrapper({ ...base, exec: async () => Promise.reject(new Error("auth failed")), gcp: { addSshKey: async () => Promise.reject(new Error("Instance web-1 has OS Login on")) } });
  const o = await waitJob(oslogin, oslogin.start(fromGcp(gce)).id);
  assert.match(o.error, /OS Login/);
}

// Alibaba Cloud: Cloud Assistant runs the install script as root; a refusal comes back with the reason.
{
  const scripts = [];
  let installed = false;
  const exec = async (srv) => {
    if (srv.username !== "root" || !installed) throw new Error("All configured authentication methods failed");
    return { stdout: "ORRERY_OK\n" };
  };
  const runShell = async (t) => (scripts.push(t), (installed = true), { status: "Success", exitCode: 0, output: "ORRERY_OK\n", error: null });
  const b = createBootstrapper({ ...base, exec, aliyun: { runShell } });
  const j = await waitJob(b, b.start(fromAliyun(ecs)).id);
  assert.equal(j.status, "done", j.error);
  assert.equal(scripts[0].region, "cn-beijing");
  assert.equal(scripts[0].instanceId, "i-2zeexample0001abcd");
  assert.ok(scripts[0].script.includes(PUB), "the install script carries our key");
  const failing = createBootstrapper({ ...base, exec: async () => Promise.reject(new Error("auth failed")), aliyun: { runShell: async () => ({ status: "Failed", exitCode: 1, output: "ORRERY_FAIL append to /root/.ssh/authorized_keys: Read-only file system\n", error: null }) } });
  const k = await waitJob(failing, failing.start(fromAliyun(ecs)).id);
  assert.match(k.error, /Cloud Assistant finished with Failed: ORRERY_FAIL append to \/root\/\.ssh\/authorized_keys: Read-only file system/);
  const none = createBootstrapper({ ...base, exec: async () => Promise.reject(new Error("auth failed")), aliyun: null });
  assert.match((await waitJob(none, none.start(fromAliyun(ecs)).id)).error, /Alibaba Cloud credentials are not configured/);
}

// netcup: by default the rescue path is off; the job hands back the command to paste and touches nothing.
{
  const f = fakeNetcup();
  const b = createBootstrapper({ ...base, allowRescue: false, exec: f.exec, netcup: f.netcup });
  const j = await waitJob(b, b.start(fromNetcup(nc(400002, "203.0.113.45"))).id);
  assert.equal(j.status, "failed");
  assert.match(j.error, /turned off/);
  assert.ok(j.error.includes(PUB), "the error carries the public key to paste");
  assert.deepEqual(f.sim.log, [], "no netcup call at all");
}
{
  // The same without ORRERY_SELF_IP: the paste command reboots nothing, so it does not need it.
  const f = fakeNetcup();
  const b = createBootstrapper({ ...base, allowRescue: false, selfIp: null, exec: f.exec, netcup: f.netcup });
  const j = await waitJob(b, b.start(fromNetcup(nc(400002, "203.0.113.45"))).id);
  assert.match(j.error, /turned off/);
  assert.ok(j.error.includes(PUB));
  assert.deepEqual(f.sim.log, []);
}

// netcup: a machine in ORRERY_PROTECTED_IPS is never restarted into the rescue system.
{
  const f = fakeNetcup();
  const b = createBootstrapper({ ...base, protectedIps: ["192.0.2.14"], exec: f.exec, netcup: f.netcup });
  const j = await waitJob(b, b.start(fromNetcup(nc(400004, "192.0.2.14"))).id);
  assert.equal(j.status, "failed");
  assert.match(j.error, /protected machine/);
  assert.deepEqual(f.sim.log, [], "no netcup call at all");
}

// netcup: without knowing which machine is the Orrery host, no netcup machine is rebooted.
{
  const f = fakeNetcup();
  const b = createBootstrapper({ ...base, selfIp: null, exec: f.exec, netcup: f.netcup });
  const j = await waitJob(b, b.start(fromNetcup(nc(400004, "192.0.2.14"))).id);
  assert.equal(j.status, "failed");
  assert.match(j.error, /ORRERY_SELF_IP/);
  assert.deepEqual(f.sim.log, [], "no netcup call at all");
}

// netcup: rescue system on, key written, rescue off, back to the installed system.
function fakeNetcup({ rootFound = true } = {}) {
  const sim = { mode: "normal", rescue: false, keyInstalled: false, power: "RUNNING", log: [] };
  const scp = {
    async request(method, p, opts = {}) {
      sim.log.push(`${method} ${p}`);
      if (p.endsWith("/rescuesystem")) {
        // As netcup does: the rescue system is switched only while the server is off.
        if (method !== "GET" && sim.power !== "SHUTOFF") throw new Error(`netcup ${method} ${p} failed with 400: Server must be in state 'SHUTOFF'. (current state: '${sim.power}')`);
        if (method === "POST") sim.rescue = true;
        if (method === "DELETE") sim.rescue = false;
        return { body: method === "GET" ? { active: sim.rescue, password: sim.rescue ? "rescue-pw" : null } : null };
      }
      if (method === "PATCH") {
        const state = opts.body.state;
        if (state === "OFF") sim.power = "SHUTOFF";
        if (state === "ON") (sim.power = "RUNNING"), (sim.mode = sim.rescue ? "rescue" : "normal");
        return { body: null };
      }
      return { body: { id: 400003, name: "v22026400003", serverLiveInfo: { state: sim.power } } };
    },
  };
  const exec = async (s, cmd) => {
    if (sim.power !== "RUNNING") throw new Error("connect ETIMEDOUT");
    if (s.password) {
      if (sim.mode !== "rescue" || s.password !== "rescue-pw") throw new Error("auth failed");
      if (cmd.startsWith("findmnt")) return { stdout: "overlay\nORRERY_OK\n" };
      if (cmd.includes("poweroff")) {
        sim.power = "SHUTOFF";
        return { stdout: "ORRERY_OK\n" };
      }
      if (!rootFound) return { stdout: "ORRERY_NOROOT\n", stderr: "" };
      sim.keyInstalled = cmd.includes(PUB);
      return { stdout: "ORRERY_OK /dev/vda3\n", stderr: "" };
    }
    if (sim.mode === "normal" && sim.keyInstalled) return { stdout: "ORRERY_OK\n" };
    throw new Error("All configured authentication methods failed");
  };
  return { sim, exec, netcup: { scp, toServer: (b) => ({ state: b.serverLiveInfo.state }), serverStateRequest: (state, option) => ({ query: option ? `?stateOption=${option}` : "", body: { state } }) } };
}
{
  const f = fakeNetcup();
  const b = createBootstrapper({ ...base, exec: f.exec, netcup: f.netcup });
  const target = fromNetcup(nc(400003, "192.0.2.72", { hostname: "agent" }), "198.51.100.10");
  const j = await waitJob(b, b.start(target).id);
  assert.equal(j.status, "done", j.error);
  assert.equal(f.sim.rescue, false, "the rescue system is switched off again");
  assert.equal(f.sim.mode, "normal");
  const order = f.sim.log.filter((l) => !l.startsWith("GET"));
  assert.deepEqual(order, [
    "PATCH /api/v1/servers/400003", // ACPI off
    "POST /api/v1/servers/400003/rescuesystem",
    "PATCH /api/v1/servers/400003", // on: boots the rescue system
    "DELETE /api/v1/servers/400003/rescuesystem", // after poweroff from inside the rescue system
    "PATCH /api/v1/servers/400003", // on: back to the installed system
  ]);
  assert.equal(f.sim.power, "RUNNING");
  assert.ok(!JSON.stringify(j).includes("rescue-pw"), "the rescue password never reaches a result");
}
{
  const f = fakeNetcup({ rootFound: false });
  const b = createBootstrapper({ ...base, exec: f.exec, netcup: f.netcup });
  const j = await waitJob(b, b.start(fromNetcup(nc(400004, "192.0.2.14"))).id);
  assert.equal(j.status, "failed");
  assert.match(j.error, /root partition/);
  assert.equal(f.sim.rescue, false, "a failure still switches the rescue system off");
  assert.equal(f.sim.mode, "normal", "and boots the installed system again");
}

// Every failure point ends with the rescue system off and the server running again.
const target400002 = () => fromNetcup(nc(400002, "203.0.113.45"));
{
  // netcup refuses to switch the rescue system on: the server is started again, nothing else.
  const f = fakeNetcup();
  const request = f.netcup.scp.request;
  f.netcup.scp.request = async (method, p, opts) => {
    if (method === "POST" && p.endsWith("/rescuesystem")) {
      f.sim.log.push(`${method} ${p}`);
      throw new Error("netcup POST rescuesystem failed with 400");
    }
    return request(method, p, opts);
  };
  const b = createBootstrapper({ ...base, exec: f.exec, netcup: f.netcup });
  const j = await waitJob(b, b.start(target400002()).id);
  assert.equal(j.status, "failed");
  assert.equal(f.sim.power, "RUNNING", "started again");
  assert.ok(!f.sim.log.some((l) => l.startsWith("DELETE")), "nothing to switch off");
}
{
  // Rescue on, but no password comes: switched off again and started.
  const f = fakeNetcup();
  const request = f.netcup.scp.request;
  f.netcup.scp.request = async (method, p, opts) => {
    const r = await request(method, p, opts);
    return method === "GET" && p.endsWith("/rescuesystem") ? { body: { active: true, password: null } } : r;
  };
  const b = createBootstrapper({ ...base, exec: f.exec, netcup: f.netcup });
  const j = await waitJob(b, b.start(target400002()).id);
  assert.equal(j.status, "failed");
  assert.match(j.error, /password/);
  assert.equal(f.sim.rescue, false);
  assert.equal(f.sim.power, "RUNNING");
}
{
  // The rescue system never becomes reachable: shut down, switched off, started into the normal system.
  const f = fakeNetcup();
  const exec = f.exec;
  const b = createBootstrapper({ ...base, exec: (s, cmd, o) => (s.password ? Promise.reject(new Error("ETIMEDOUT")) : exec(s, cmd, o)), netcup: f.netcup });
  const j = await waitJob(b, b.start(target400002()).id);
  assert.equal(j.status, "failed");
  assert.match(j.error, /rescue system/);
  assert.equal(f.sim.rescue, false);
  assert.equal(f.sim.power, "RUNNING");
  assert.equal(f.sim.mode, "normal");
}

fs.rmSync(dataDir, { recursive: true, force: true });
console.log("onboarding test passed");
