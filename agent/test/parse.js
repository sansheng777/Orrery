// Parses a captured probe output (Ubuntu host with Docker) without needing SSH.
import assert from "node:assert/strict";
import { parseStats, parseSample, sampleFrom } from "../src/ssh.js";

const sample = `@@host
ip-172-31-2-34
@@os
Ubuntu 22.04.5 LTS
@@kernel
Linux 6.8.0-1040-aws x86_64
@@cpuinfo
2
 Intel(R) Xeon(R) Platinum 8259CL CPU @ 2.50GHz
@@stat1
cpu  1000 0 500 8000 100 0 0 0 0 0
@@stat2
cpu  1060 0 520 8100 120 0 0 0 0 0
@@loadavg
0.02 0.05 0.01 1/105 4242
@@uptime
86400.5 170000.1
@@meminfo
MemTotal:        8000000 kB
MemAvailable:    6400000 kB
Buffers:          100000 kB
Cached:          1000000 kB
SwapTotal:             0 kB
SwapFree:              0 kB
@@disk
/dev/root 7940000 3597000 4327000 46% /
/dev/nvme0n1p15 106832 6186 100646 6% /boot/efi
@@net
  eth0: 1000 10 0 0 0 0 0 0 2000 20 0 0 0 0 0 0
    lo: 500 5 0 0 0 0 0 0 500 5 0 0 0 0 0 0
@@ips
172.31.2.34 172.17.0.1
@@ipaddr
2: eth0    inet 172.31.2.34/20 metric 100 brd 172.31.15.255 scope global dynamic eth0\       valid_lft 3000sec preferred_lft 3000sec
2: eth0    inet6 2001:db8:fab:7000::48af/128 scope global dynamic noprefixroute \       valid_lft 400sec preferred_lft 100sec
3: docker0    inet 172.17.0.1/16 brd 172.17.255.255 scope global docker0\       valid_lft forever preferred_lft forever
4: br-9742a8aa2237    inet 172.22.0.1/16 brd 172.22.255.255 scope global br-9742a8aa2237\       valid_lft forever preferred_lft forever
@@users
0
@@procs
105
@@reboot
yes
@@updates
39
@@motd
@@lastlog
ubuntu   pts/0        198.51.100.20   Tue May  5 13:45:21 2026 - Tue May  5 14:00:00 2026  (00:14)
@@docker
docker
@@dockerps
{"ID":"abc123def4567890","Names":"web","Image":"nginx:1.27","State":"running","Status":"Up 3 days","Ports":"0.0.0.0:80->80/tcp","CreatedAt":"2026-10-25"}
{"ID":"0011223344556677","Names":"job","Image":"alpine","State":"exited","Status":"Exited (0) 2 hours ago","Ports":"","CreatedAt":"2026-10-20"}
@@dockerstats
{"Name":"web","CPUPerc":"0.15%","MemUsage":"12.5MiB / 7.63GiB","MemPerc":"0.16%"}
@@end
`;

const s = parseStats(sample);
assert.equal(s.hostname, "ip-172-31-2-34");
assert.equal(s.cpu.cores, 2);
assert.equal(s.cpu.percent, 40); // 80 busy ticks out of 200
assert.equal(s.memory.total, 8000000 * 1024);
assert.equal(s.memory.percent, 20);
assert.equal(s.swap.total, 0);
assert.equal(s.disk.mount, "/");
assert.equal(s.disks.length, 1, "/boot/efi is hidden");
assert.deepEqual(s.network, { rxBytes: 1000, txBytes: 2000 });
assert.equal(s.rebootRequired, true);
assert.equal(s.lastLogin, "Last login: Tue May  5 13:45:21 2026 from 198.51.100.20");
assert.equal(s.updatesAvailable, 39);
assert.equal(s.docker.status, "ok");
assert.equal(s.docker.running, 1);
const [web, job] = s.docker.containers;
assert.equal(web.id, "abc123def456");
assert.equal(web.cpuPercent, 0.15);
assert.equal(web.memUsed, Math.round(12.5 * 1024 ** 2));
assert.equal(job.memUsed, null);
assert.deepEqual(s.ips, ["172.31.2.34", "2001:db8:fab:7000::48af"], "Docker bridge gateways are not listed");
assert.equal(s.bridgeNetworks, 2);
{
  const { splitIps } = await import("../src/ssh.js");
  assert.deepEqual(splitIps("", "1.2.3.4 172.17.0.1"), { ips: ["1.2.3.4", "172.17.0.1"], bridgeNetworks: 0 }, "without ip, hostname -I as before");
  assert.deepEqual(splitIps("2: eth0@if7    inet 203.0.113.5/24 brd x\n3: docker0    inet 172.17.0.1/16", "").ips, ["203.0.113.5"], "an @peer suffix is dropped");
  // A server cannot stall Orrery with a line built to make the pattern backtrack, nor with an endless line.
  const hostile = "1: " + "@a".repeat(200000) + " inet x";
  let started = Date.now();
  splitIps(hostile, "");
  assert.ok(Date.now() - started < 500, `splitIps took ${Date.now() - started} ms on a hostile line`);
  started = Date.now();
  const parsed = parseStats(`@@ipaddr\n${hostile}\n2: eth0    inet 203.0.113.5/24\n@@end\n`);
  assert.ok(Date.now() - started < 500 && parsed.ips.includes("203.0.113.5"), "an oversized line is skipped, the rest is read");
}
// The live sampler: two consecutive blocks give CPU over the interval and network rates per second.
const block = (up, stat, eth, lo, docker) => `@@t
${up}
@@stat
${stat}
@@net
    lo: ${lo} 10 0 0 0 0 0 0 ${lo} 10 0 0 0 0 0 0
  eth0: ${eth[0]} 900 0 0 0 0 0 0 ${eth[1]} 700 0 0 0 0 0 0
docker0: ${docker} 1 0 0 0 0 0 0 ${docker} 1 0 0 0 0 0 0
@@loadavg
0.42 0.30 0.20 2/180 9999
@@meminfo
MemTotal:        2000000 kB
MemAvailable:    1500000 kB
SwapTotal:       1000000 kB
SwapFree:         750000 kB`;
const a = parseSample(block("1000.00", "cpu  1000 0 500 8000 100 0 0 0 0 0", [1000000, 400000], 5000, 9999999));
const b = parseSample(block("1002.00", "cpu  1060 0 520 8100 120 0 0 0 0 0", [3000000, 600000], 9000, 19999999));
const pz = sampleFrom(a, b, "2026-10-29T00:00:00.000Z");
assert.equal(pz.t, "2026-10-29T00:00:00.000Z");
assert.equal(pz.cpu.percent, 40, "same CPU formula as server_stats");
assert.deepEqual(pz.load, { m1: 0.42, m5: 0.3, m15: 0.2 });
assert.equal(pz.memory.percent, 25);
assert.equal(pz.swap.percent, 25);
assert.deepEqual(pz.net, { rxRate: 1000000, txRate: 100000 }, "bytes per second over the 2 s between samples, loopback and docker0 left out");

console.log("parse test passed");
