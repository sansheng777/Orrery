// One-time onboarding of a discovered server: make it trust the agent's public key (keys.js), so that
// monitoring and commands work from then on. Runs as a background job because the netcup path reboots
// the machine. Temporary credentials (Lightsail keys, the rescue password) stay inside this process and
// never reach a tool result or the audit log.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { quote } from "./ssh.js";

const JOB_TTL_MS = 24 * 3600 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const PUBKEY_RE = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp\d+) [A-Za-z0-9+/=]+( [^\n'"]*)?$/;

// Shell: end a non-empty file that lacks a final newline, so an appended key starts on its own line
// and is not glued to the last key ($(tail -c1) is empty only when the last byte is a newline).
const endLine = (f) => `[ -z "$(tail -c1 ${f} 2>/dev/null)" ] || echo >> ${f}`;

// Appends the key to the login user's authorized_keys once. Each step reports itself on failure
// ("ORRERY_FAIL <step>: <error>") so a refusal on the remote side is never silent.
export function installScript(pub) {
  if (!PUBKEY_RE.test(pub)) throw new Error("Refusing to install a malformed public key");
  const k = quote(pub);
  return `umask 077
D="$HOME/.ssh"; F="$D/authorized_keys"
fail() { echo "ORRERY_FAIL $1: $(cat /tmp/orrery-err.$$ 2>/dev/null)"; rm -f /tmp/orrery-err.$$; exit 1; }
mkdir -p "$D" 2>/tmp/orrery-err.$$ || fail "mkdir $D"
touch "$F" 2>/tmp/orrery-err.$$ || fail "touch $F"
grep -qxF ${k} "$F" 2>/dev/null || { ${endLine('"$F"')}; echo ${k} >> "$F"; } 2>/tmp/orrery-err.$$ || fail "append to $F"
chmod 700 "$D" 2>/tmp/orrery-err.$$ && chmod 600 "$F" 2>>/tmp/orrery-err.$$ || fail "chmod"
grep -qxF ${k} "$F" || fail "the key is not in $F after writing (immutable file? full disk?)"
rm -f /tmp/orrery-err.$$
echo ORRERY_OK`;
}

// Runs inside netcup's rescue system: find the installed system's root file system, add the key to
// /root/.ssh/authorized_keys, and turn "PermitRootLogin no" into "prohibit-password" (key-only).
export function rescueScript(pub) {
  if (!PUBKEY_RE.test(pub)) throw new Error("Refusing to install a malformed public key");
  return `set -u
PUB=${quote(pub)}
M=\${ORRERY_MNT:-/mnt/orrery}
mkdir -p "$M"
command -v vgchange >/dev/null 2>&1 && vgchange -ay >/dev/null 2>&1
ROOT=""
for dev in $(lsblk -lnpo NAME,FSTYPE | awk '$2 ~ /^(ext4|ext3|xfs|btrfs)$/ {print $1}'); do
  mount "$dev" "$M" 2>/dev/null || continue
  for p in "" /@ /@rootfs; do
    if [ -f "$M$p/etc/os-release" ] && [ -d "$M$p/root" ]; then ROOT="$M$p"; DEV="$dev"; break 2; fi
  done
  umount "$M"
done
[ -n "$ROOT" ] || { echo ORRERY_NOROOT; exit 3; }
umask 077
mkdir -p "$ROOT/root/.ssh" && touch "$ROOT/root/.ssh/authorized_keys"
A="$ROOT/root/.ssh/authorized_keys"
grep -qxF "$PUB" "$A" || { ${endLine('"$A"')}; echo "$PUB" >> "$A"; }
chmod 700 "$ROOT/root/.ssh"; chmod 600 "$ROOT/root/.ssh/authorized_keys"; chown -R 0:0 "$ROOT/root/.ssh"
for f in "$ROOT/etc/ssh/sshd_config" "$ROOT"/etc/ssh/sshd_config.d/*.conf; do
  [ -f "$f" ] && sed -i -E 's/^[[:space:]]*PermitRootLogin[[:space:]]+no([[:space:]]|$)/PermitRootLogin prohibit-password\\1/' "$f"
done
[ -f "$ROOT/.autorelabel" ] || { [ -d "$ROOT/etc/selinux" ] && touch "$ROOT/.autorelabel"; }
sync
umount "$M" 2>/dev/null
echo "ORRERY_OK $DEV"`;
}

// The one line to paste as root where no API can install the key. Pasting it twice adds the key once.
export const pasteCommand = (pub) =>
  `K=${quote(pub)}; F=~/.ssh/authorized_keys; mkdir -p ~/.ssh && touch "$F" && (grep -qxF "$K" "$F" || { ${endLine('"$F"')}; echo "$K" >> "$F"; }) && chmod 700 ~/.ssh && chmod 600 "$F"`;

const looksUnreachable = (e) => /ETIMEDOUT|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|Timed out while waiting for handshake/i.test(e?.message || "");

// deps: { exec(server, cmd, opts), publicKey(), keyPath, discovery, selfIp, aws: {config, sendSshPublicKey, lightsailAccess},
//         netcup: { scp, toServer, serverStateRequest } | null, gcp: { addSshKey(target) } | null,
//         aliyun: { runShell({region, instanceId, script}) } | null, runSsh?(args, input), sleep?, log? }
export function createBootstrapper(deps) {
  const jobs = new Map();
  const wait = deps.sleep || sleep;

  function prune() {
    for (const [id, j] of jobs) if (j.finishedAt && Date.now() - Date.parse(j.finishedAt) > JOB_TTL_MS) jobs.delete(id);
  }

  function view(j) {
    const { server, ...rest } = j;
    return { ...rest, server: { id: server.id, name: server.name, host: server.host } };
  }

  function start(server) {
    prune();
    const running = [...jobs.values()].find((j) => j.server.id === server.id && j.status === "running");
    if (running) return view(running);
    const job = { id: crypto.randomUUID().slice(0, 8), server, status: "running", steps: [], startedAt: new Date().toISOString(), finishedAt: null, error: null };
    jobs.set(job.id, job);
    const step = (msg) => {
      job.steps.push({ at: new Date().toISOString(), msg });
      deps.log?.(`[bootstrap ${job.id} ${server.name}] ${msg}`);
    };
    run(server, step)
      .then((username) => {
        job.status = "done";
        step(`Done: logging in as ${username}@${server.host} with the Orrery key`);
      })
      .catch((e) => {
        job.status = "failed";
        job.error = e.message;
        step(`Failed: ${e.message}`);
      })
      .finally(() => (job.finishedAt = new Date().toISOString()));
    return view(job);
  }

  const status = (id) => (id ? (jobs.has(id) ? [view(jobs.get(id))] : []) : [...jobs.values()].map(view));

  const withKey = (server, username = server.username) => ({ ...server, username, keyPath: deps.keyPath, password: undefined });

  async function canLogin(server, username) {
    try {
      const r = await deps.exec(withKey(server, username), "echo ORRERY_OK", { timeoutSec: 20 });
      return r.stdout.includes("ORRERY_OK");
    } catch {
      return false;
    }
  }

  async function finish(server, username, step) {
    if (!(await canLogin(server, username))) throw new Error(`The key is installed, but ${username}@${server.host} still refuses the login`);
    deps.discovery.remember(server.id, { username, bootstrappedAt: new Date().toISOString() });
    step("Verified: the key logs in");
    return username;
  }

  async function run(server, step) {
    step("Checking whether the Orrery key already logs in");
    if (await canLogin(server, server.username)) {
      deps.discovery.remember(server.id, { username: server.username, bootstrappedAt: new Date().toISOString() });
      return server.username;
    }
    const kind = server.provider?.kind;
    if (kind === "ec2") return viaInstanceConnect(server, step);
    if (kind === "lightsail") return viaLightsail(server, step);
    if (kind === "netcup") return viaRescue(server, step);
    if (kind === "gcp") return viaGcpMetadata(server, step);
    if (kind === "aliyun") return viaAliyunAssist(server, step);
    // Linode's API reaches a running system only by rebuilding it (erasing the disk): paste by hand.
    if (kind === "vultr") throw new Error(`Vultr's API cannot add a key to a running instance. Log in as root in this instance's View Console on the Vultr website and run: ${pasteCommand(deps.publicKey())}. Then run ssh_bootstrap again; it confirms the login and finishes onboarding. Instances created with sshkey_id skip this step.`);
    if (kind === "digitalocean") throw new Error(`DigitalOcean's API cannot add a key to a running Droplet. Log in as root in this Droplet's Access → Droplet Console on the DigitalOcean website and run: ${pasteCommand(deps.publicKey())}. Then run ssh_bootstrap again; it confirms the login and finishes onboarding. Droplets created with ssh_keys skip this step.`);
    if (kind === "kamatera") throw new Error(`Kamatera's API cannot add a key to a running server. Log in as root in this server's Console on the Kamatera website and run: ${pasteCommand(deps.publicKey())}. Then run ssh_bootstrap again; it confirms the login and finishes onboarding. Servers created with the key written into their script-file (without quotes) skip this step; Kamatera's ssh-key field rejects Orrery's ed25519 key.`);
    if (kind === "linode") throw new Error(`Linode cannot add a key without a rebuild. Log in as root on this Linode's Lish console on the Linode website and run: ${pasteCommand(deps.publicKey())}. Then run ssh_bootstrap again; it confirms the login and finishes onboarding.`);
    throw new Error("This server was not discovered from netcup, AWS, Linode, Google Cloud, Alibaba Cloud, Vultr, DigitalOcean or Kamatera, so there is no automatic way to onboard it. Add the key from ssh_public_key to its authorized_keys by hand.");
  }

  // EC2: EC2 Instance Connect accepts our public key for 60 seconds; use that window to install it for good.
  async function viaInstanceConnect(server, step) {
    const { region, instanceId, zone } = server.provider;
    const pub = deps.publicKey();
    const users = [...new Set([server.username, "ubuntu", "ec2-user", "admin", "debian"])];
    for (const user of users) {
      step(`Pushing a temporary key through EC2 Instance Connect (user ${user})`);
      try {
        await deps.aws.sendSshPublicKey(deps.aws.config, { region, instanceId, zone, osUser: user, publicKey: pub });
      } catch (e) {
        if (/AccessDenied|UnauthorizedOperation|NotAuthorized/i.test(e.name || e.message)) {
          throw new Error(`The AWS key lacks the ec2-instance-connect:SendSSHPublicKey permission (${e.message})`);
        }
        throw new Error(`EC2 Instance Connect failed: ${e.message}`);
      }
      let r;
      try {
        r = await deps.exec(withKey(server, user), installScript(pub), { timeoutSec: 30 });
      } catch (e) {
        if (looksUnreachable(e)) throw new Error(`Cannot reach ${server.host}:22. Check that the security group lets in the Orrery host's IP (${e.message})`);
        step(`${user} cannot log in, trying the next user`);
        continue;
      }
      if (r.stdout.includes("ORRERY_OK")) {
        step(`Installed the key for ${user} permanently`);
        return finish(server, user, step);
      }
      // Logged in, but writing the key failed: retrying other users would not help.
      const why = r.stdout.match(/ORRERY_FAIL[^\n]*/)?.[0];
      if (why) throw new Error(`Logged in as ${user}, but installing the key failed: ${why.replace("ORRERY_FAIL ", "")}`);
    }
    throw new Error(`None of ${users.join(", ")} could log in. The instance may not have ec2-instance-connect installed`);
  }

  // Google Cloud: "user:key" in the instance's ssh-keys metadata; the guest agent creates the user with
  // sudo and installs the key within seconds. No restart.
  async function viaGcpMetadata(server, step) {
    if (!deps.gcp) throw new Error("Google Cloud credentials are not configured (data/gcp.json); see docs/providers.md");
    const { project, zone, name } = server.provider;
    step(`Adding the key to the metadata of instance ${name} (${project}/${zone})`);
    const r = await deps.gcp.addSshKey({ project, zone, name, publicKey: deps.publicKey() });
    step(r.changed ? `Metadata updated; waiting for the Google guest agent to create user ${r.user} with the key` : `The metadata already has this key (user ${r.user})`);
    for (let i = 0; i < 12; i++) {
      if (await canLogin(server, r.user)) return finish(server, r.user, step);
      await wait(5000);
    }
    throw new Error(`The key is in the metadata, but ${r.user}@${server.host} still cannot log in after a minute. Check that the firewall lets the Orrery host reach port 22 and that google-guest-agent is running on the instance`);
  }

  // Alibaba Cloud: Cloud Assistant (on every public image) runs the install script as root. No restart.
  async function viaAliyunAssist(server, step) {
    if (!deps.aliyun) throw new Error("Alibaba Cloud credentials are not configured (data/aliyun.json); see docs/providers.md");
    const { region, instanceId, name } = server.provider;
    step(`Installing the key as root on ${name} (${region}/${instanceId}) through Cloud Assistant`);
    const r = await deps.aliyun.runShell({ region, instanceId, script: installScript(deps.publicKey()) });
    if (!r.output.includes("ORRERY_OK")) {
      const why = r.output.match(/ORRERY_FAIL[^\n]*/)?.[0];
      throw new Error(`Cloud Assistant finished with ${r.status}${r.error ? ` (${r.error})` : ""}: ${why || r.output.trim().slice(-300) || "no output"}`);
    }
    step("The key is in /root/.ssh/authorized_keys");
    return finish(server, "root", step);
  }

  // Lightsail: a short-lived key plus OpenSSH certificate from GetInstanceAccessDetails.
  async function viaLightsail(server, step) {
    const { region, instanceName } = server.provider;
    const pub = deps.publicKey();
    step("Requesting a temporary SSH login from Lightsail");
    const access = await deps.aws.lightsailAccess(deps.aws.config, { region, instanceName });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orrery-"));
    try {
      fs.writeFileSync(path.join(dir, "key"), access.privateKey.endsWith("\n") ? access.privateKey : access.privateKey + "\n", { mode: 0o600 });
      fs.writeFileSync(path.join(dir, "key-cert.pub"), access.certificate + "\n", { mode: 0o600 });
      step(`Logging in as ${access.username}@${access.host} with the temporary login to install the key`);
      const out = await (deps.runSsh || runSsh)([
        "-i", path.join(dir, "key"),
        "-o", `CertificateFile=${path.join(dir, "key-cert.pub")}`,
        "-o", "IdentitiesOnly=yes",
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=20",
        "-o", "LogLevel=ERROR", // no "Permanently added" / post-quantum notices hiding the real error
        "-n", // stdin from /dev/null, so ssh never waits on it
        `${access.username}@${access.host}`,
        installScript(pub),
      ]);
      if (!out.includes("ORRERY_OK")) throw new Error(`The command that installs the key did not succeed: ${out.trim().slice(-300) || "no output"}`);
    } catch (e) {
      if (looksUnreachable(e) || /timed out|Connection refused/i.test(e.message)) {
        throw new Error(`Cannot reach ${server.host}:22. Check that the Lightsail firewall lets in the Orrery host's IP (${e.message})`);
      }
      throw e;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    return finish(server, access.username, step);
  }

  // netcup: boot the rescue system, write the key into the installed system, boot it again. The server
  // restarts (clean ACPI shutdown) and is always started again, whatever fails on the way.
  async function viaRescue(server, step) {
    if (server.self) throw new Error("This is the Orrery host itself; it is never restarted into the rescue system. Run deploy/enable-ssh.sh on it instead.");
    if ((deps.protectedIps || []).includes(String(server.host).trim().toLowerCase())) {
      throw new Error(`${server.host} is a protected machine (ORRERY_PROTECTED_IPS): it is never restarted into the rescue system. Install the key with the paste command instead.`);
    }
    // Switched off by default: netcup runs rescue on/off as asynchronous tasks that also power the
    // server on and off by themselves, and a mismatch left a production server in rescue once.
    // Checked before ORRERY_SELF_IP: the paste command reboots nothing, so it works without it.
    if (!deps.allowRescue) {
      throw new Error(`Automatic netcup onboarding (through the rescue system, which restarts the server) is turned off. Log in as root in the netcup SCP web console and run: ${pasteCommand(deps.publicKey())}. Then run ssh_bootstrap again; it confirms the login and finishes onboarding.`);
    }
    if (!deps.selfIp) throw new Error("The Orrery host is unknown (ORRERY_SELF_IP is not set), so the rescue system is not used on any netcup server, to avoid restarting it by mistake. Run deploy/enable-ssh.sh on the Orrery host first.");
    if (!deps.netcup) throw new Error("netcup credentials are missing");
    const { scp, toServer, serverStateRequest } = deps.netcup;
    const id = Number(server.provider.serverId);
    const pub = deps.publicKey();
    const merge = { contentType: "application/merge-patch+json" };
    const rescueInfo = async () => (await scp.request("GET", `/api/v1/servers/${id}/rescuesystem`)).body || {};
    const state = async () => toServer((await scp.request("GET", `/api/v1/servers/${id}?loadServerLiveInfo=true`)).body).state;
    const power = async (s, option) => {
      const r = serverStateRequest(s, option);
      await scp.request("PATCH", `/api/v1/servers/${id}${r.query}`, { body: r.body, ...merge });
    };
    const rescueLogin = (password) => ({ ...server, username: "root", password, keyPath: undefined });
    const inRescue = async (password) => {
      try {
        const r = await deps.exec(rescueLogin(password), "findmnt -n -o FSTYPE / ; echo ORRERY_OK", { timeoutSec: 20 });
        return r.stdout.includes("ORRERY_OK") && !/^(ext[234]|xfs|btrfs)\s*$/m.test(r.stdout);
      } catch {
        return false;
      }
    };
    // Checks every 10 seconds, about `seconds` long.
    const waitFor = async (check, seconds) => {
      for (let i = 0; i < Math.ceil(seconds / 10); i++) {
        if (await check()) return true;
        await wait(10000);
      }
      return check();
    };
    // netcup switches the rescue system on and off only while the server is SHUTOFF, so the order is:
    // shut down, rescue on, start (boots rescue), write the key, shut down, rescue off, start.
    const isOff = async () => (await state()) === "SHUTOFF";
    let shutDown = false; // we powered the server off at least once: it must end up running again
    const shutdown = async (password) => {
      shutDown = true;
      if (password && (await inRescue(password))) {
        step("Stopping the server in the rescue system");
        await deps.exec(rescueLogin(password), "(sleep 2; poweroff) >/dev/null 2>&1 & echo ORRERY_OK", { timeoutSec: 20 }).catch(() => {});
        if (await waitFor(isOff, 120)) return;
      }
      step("Shutting down (ACPI)");
      await power("OFF");
      if (await waitFor(isOff, 180)) return;
      step("Not off after 3 minutes, powering off");
      await power("OFF", "POWEROFF");
      if (!(await waitFor(isOff, 60))) throw new Error("The server did not power off");
    };
    const start = async () => {
      step("Powering on");
      await power("ON");
    };

    let password = null;
    let activated = false;
    try {
      await shutdown(null);
      step("Turning on the rescue system");
      await scp.request("POST", `/api/v1/servers/${id}/rescuesystem`);
      activated = true;
      await waitFor(async () => ((password = (await rescueInfo()).password), !!password), 120);
      if (!password) throw new Error("netcup returned no rescue system password");
      await start();
      step("Waiting for the server to boot into the rescue system");
      if (!(await waitFor(() => inRescue(password), 300))) throw new Error("The server did not reach the rescue system within 5 minutes");
      step("Installing the key from the rescue system");
      const r = await deps.exec(rescueLogin(password), rescueScript(pub), { timeoutSec: 120 });
      if (r.stdout.includes("ORRERY_NOROOT")) throw new Error("No root partition of the installed system was found from the rescue system");
      if (!r.stdout.includes("ORRERY_OK")) throw new Error(`Installing the key failed: ${(r.stdout + r.stderr).trim().slice(-300)}`);
      step(`The key is in ${r.stdout.trim().split(" ").pop()}`);
    } finally {
      // Whatever happened: rescue off again, and a server we powered off is started again.
      try {
        if (activated) {
          if (!(await isOff())) await shutdown(password);
          step("Turning off the rescue system");
          await scp.request("DELETE", `/api/v1/servers/${id}/rescuesystem`);
        }
        if (shutDown && (await isOff())) await start();
      } catch (e) {
        step(`Restoring failed: ${e.message}. Check in the netcup SCP website now: the rescue system must be off and the server on`);
      }
    }
    step("Waiting for the installed system to boot");
    if (!(await waitFor(() => canLogin(server, "root"), 300))) throw new Error("The key did not log in within 5 minutes; check the server in the netcup SCP console");
    return finish(server, "root", step);
  }

  return { start, status };
}

// OpenSSH client run; a failure says how it ended (exit code, signal, timeout) and keeps the useful
// part of stderr and stdout, so the cause is never lost behind client warnings.
export function sshFailure(err, stdout = "", stderr = "") {
  const noise = /^(\*\*|Warning: Permanently added)/;
  const errText = String(stderr).split("\n").filter((l) => l.trim() && !noise.test(l.trim())).join("\n").trim();
  const how = err.killed ? "was killed after the 60 s timeout" : err.signal ? `was killed by signal ${err.signal}` : `exited with code ${err.code}`;
  const parts = [`ssh ${how}`];
  if (errText) parts.push(errText.slice(-500));
  const out = String(stdout).trim();
  if (out) parts.push(`remote output: ${out.slice(-300)}`);
  return new Error(parts.join("; "));
}

function runSsh(args) {
  return new Promise((resolve, reject) => {
    execFile("ssh", args, { timeout: 60000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(sshFailure(err, stdout, stderr));
      else resolve(stdout);
    });
  });
}
