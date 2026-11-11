#!/usr/bin/env bash
# One-time step on the machine that runs Orrery, as root, from the deploy/ directory:
#   bash enable-ssh.sh
# Records this machine's public IP (so Orrery never stops or reinstalls the machine it runs on),
# starts the containers, and lets the connector SSH into this machine. After that, ask your AI
# assistant to onboard your other servers (ssh_bootstrap).
set -euo pipefail
cd "$(dirname "$0")"

echo "== Recording this machine's public IPv4"
# A value already in .env wins. Otherwise it is the public address on a network interface, or, on
# clouds with 1:1 NAT (AWS, Google Cloud, Alibaba Cloud and others) where no interface has it, the
# address Cloudflare sees this machine calling from.
# An inline comment (from the first '#') is dropped before trimming spaces and quotes.
SELF_IP=$( (grep -s '^ORRERY_SELF_IP=' .env || true) | tail -1 | cut -d= -f2- | cut -d'#' -f1 | tr -d "[:space:]\"'")
if [ -z "$SELF_IP" ]; then
  # Skip private (RFC 1918), loopback and carrier-grade NAT (100.64.0.0/10) addresses.
  SELF_IP=$(ip -4 -o addr show scope global | awk '{print $4}' | cut -d/ -f1 | grep -vE '^(10|127|192\.168|172\.(1[6-9]|2[0-9]|3[01])|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7]))\.' | head -1 || true)
fi
if [ -z "$SELF_IP" ]; then
  SELF_IP=$(curl -4 -fsS --max-time 10 https://www.cloudflare.com/cdn-cgi/trace 2>/dev/null | sed -n 's/^ip=//p' || true)
fi
if [ -z "$SELF_IP" ]; then
  echo "Could not find this machine's public IPv4. Add ORRERY_SELF_IP=<this machine's public IP> to .env and run again." >&2
  exit 1
fi
if ! [[ "$SELF_IP" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
  echo "ORRERY_SELF_IP must be a plain IPv4 address such as 203.0.113.10, got: $SELF_IP. Fix it in .env and run again." >&2
  exit 1
fi
touch .env && chmod 600 .env
if grep -q '^ORRERY_SELF_IP=' .env; then
  sed -i "s/^ORRERY_SELF_IP=.*/ORRERY_SELF_IP=$SELF_IP/" .env
else
  echo "ORRERY_SELF_IP=$SELF_IP" >> .env
fi
echo "   $SELF_IP"

echo "== Building and starting"
mkdir -p data && chown 1000:1000 data && chmod 700 data
docker compose up -d --build --quiet-pull

echo "== Waiting for the connector's SSH key"
for _ in $(seq 60); do
  [ -s data/keys/id_ed25519.pub ] && break
  sleep 1
done
if [ ! -s data/keys/id_ed25519.pub ]; then
  echo "No key yet. Check the logs: docker compose logs --tail 50 orrery" >&2
  exit 1
fi
PUB=$(cat data/keys/id_ed25519.pub)

echo "== Trusting the key for root on this machine"
install -d -m 700 /root/.ssh
touch /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys
grep -qxF "$PUB" /root/.ssh/authorized_keys || echo "$PUB" >> /root/.ssh/authorized_keys

if sshd -T 2>/dev/null | grep -Ei '^permitrootlogin (no|forced-commands-only)' >/dev/null; then
  echo "Note: sshd has PermitRootLogin no or forced-commands-only, so the connector cannot run commands on this machine as root. Set PermitRootLogin prohibit-password and restart sshd." >&2
fi

echo
echo "Done. Connect your AI assistant to Orrery and ask it to list your servers."
