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
SAVED_IP=$( (grep -s '^ORRERY_SELF_IP=' .env || true) | tail -1 | cut -d= -f2- | cut -d'#' -f1 | tr -d "[:space:]\"'")
# Skip private (RFC 1918), loopback and carrier-grade NAT (100.64.0.0/10) addresses.
FOUND_IP=$(ip -4 -o addr show scope global | awk '{print $4}' | cut -d/ -f1 | grep -vE '^(10|127|192\.168|172\.(1[6-9]|2[0-9]|3[01])|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7]))\.' | head -1 || true)
if [ -z "$FOUND_IP" ]; then
  FOUND_IP=$(curl -4 -fsS --max-time 10 https://www.cloudflare.com/cdn-cgi/trace 2>/dev/null | sed -n 's/^ip=//p' || true)
fi
SELF_IP=${SAVED_IP:-$FOUND_IP}
if [ -z "$SELF_IP" ]; then
  echo "Could not find this machine's public IPv4. Add ORRERY_SELF_IP=<this machine's public IP> to .env and run again." >&2
  exit 1
fi
if ! [[ "$SELF_IP" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
  echo "ORRERY_SELF_IP must be a plain IPv4 address such as 203.0.113.10, got: $SELF_IP. Fix it in .env and run again." >&2
  exit 1
fi
touch .env && chmod 600 .env
chmod 700 . # .env and data/ live here
if grep -q '^ORRERY_SELF_IP=' .env; then
  sed -i "s/^ORRERY_SELF_IP=.*/ORRERY_SELF_IP=$SELF_IP/" .env
else
  [ -z "$(tail -c1 .env 2>/dev/null)" ] || echo >> .env
  echo "ORRERY_SELF_IP=$SELF_IP" >> .env
fi
echo "   $SELF_IP"
# The address in .env is the one Orrery refuses to stop or delete. If the machine got another one
# since (a stopped and restarted cloud instance), that protection points at the wrong address.
if [ -n "$FOUND_IP" ] && [ "$FOUND_IP" != "$SELF_IP" ]; then
  echo "   WARNING: .env says $SELF_IP, but this machine now seems to be $FOUND_IP. If its address changed, set ORRERY_SELF_IP=$FOUND_IP in .env and run this again." >&2
fi

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
# The file is written by the container. Only one well-formed ed25519 key goes into root's authorized_keys.
if ! [[ "$PUB" =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+(\ [A-Za-z0-9@._-]+)?$ ]]; then
  echo "data/keys/id_ed25519.pub does not hold one ed25519 public key. Not trusting it." >&2
  exit 1
fi

echo "== Trusting the key for root on this machine"
install -d -m 700 /root/.ssh
touch /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys
if ! grep -qxF "$PUB" /root/.ssh/authorized_keys; then
  [ -z "$(tail -c1 /root/.ssh/authorized_keys)" ] || echo >> /root/.ssh/authorized_keys # never glued to an unterminated last line
  echo "$PUB" >> /root/.ssh/authorized_keys
fi

if sshd -T 2>/dev/null | grep -Ei '^permitrootlogin (no|forced-commands-only)' >/dev/null; then
  echo "Note: sshd has PermitRootLogin no or forced-commands-only, so the connector cannot run commands on this machine as root. Set PermitRootLogin prohibit-password and restart sshd." >&2
fi
if sshd -T 2>/dev/null | grep -Eiq '^passwordauthentication yes'; then
  echo >&2
  echo "WARNING: this machine still accepts SSH logins with a password. It is about to hold the keys to" >&2
  echo "all your servers: make it key-only before you add cloud credentials (docs/deploy.md, step 9)." >&2
fi

echo
echo "Done. Connect your AI assistant to Orrery and ask it to list your servers."
