#!/usr/bin/env bash
# One-command setup of the Orrery host. As root on a fresh Debian or Ubuntu VPS, in your own terminal:
#
#   curl -fsSL https://raw.githubusercontent.com/sansheng777/Orrery/main/deploy/install.sh | bash -s -- orrery.example.com
#
# It asks once for a Cloudflare API token (typed hidden, used for this run only, stored nowhere), then
# installs Docker, adds swap if there is none, creates the tunnel, DNS record and WAF rule for the
# hostname, starts Orrery and lets it monitor this machine. Nothing existing in Cloudflare is changed.
# Without a hostname it updates an Orrery that is already set up.
#
# The token (dash.cloudflare.com > My Profile > API Tokens > Create Custom Token) needs:
#   Account > Cloudflare Tunnel > Edit, and for the domain: Zone > Zone > Read, DNS > Edit, Zone WAF > Edit.
#
# Environment, set after the pipe (curl ... | NAME=value bash -s -- host): CLOUDFLARE_API_TOKEN (instead of
# the prompt), ORRERY_ALLOW_IPS="203.0.113.30 ..." (more addresses that may reach the hostname, for
# clients on your own computer; applies when the rule is created), ORRERY_HOME (default ~/orrery).
set -euo pipefail

REPO=https://github.com/sansheng777/Orrery
LOG=/var/log/orrery-install.log

say() { printf '\n== %s\n' "$*"; }
die() { printf '\n%s\n' "$*" >&2; exit 1; }
# Runs a noisy step with its output in the log; on failure shows the end of the log.
run() { "$@" >>"$LOG" 2>&1 || { tail -n 20 "$LOG" >&2; die "Failed: $* (full log: $LOG)"; }; }

# This file's path when it is run from a checkout; empty when it is piped into bash.
SELF=${BASH_SOURCE[0]:-}

# Everything runs from main, so a download cut short runs nothing.
main() {
  local hostname=${1:-} dir=${ORRERY_HOME:-$HOME/orrery} from_checkout="" token=""
  [ "$(id -u)" = 0 ] || die "Run this as root."
  command -v apt-get >/dev/null || die "This installer is for Debian and Ubuntu. Elsewhere, follow docs/deploy.md."
  if [ -n "$SELF" ] && [ -f "$(dirname "$SELF")/cloudflare.mjs" ]; then
    dir=$(cd "$(dirname "$SELF")/.." && pwd)
    from_checkout=1
  fi
  : >>"$LOG"

  if [ -z "$hostname" ] && ! grep -qs '^TUNNEL_TOKEN=' "$dir/deploy/.env"; then
    die "Give the public hostname for Orrery, on a domain you have on Cloudflare: bash install.sh orrery.example.com"
  fi
  if [ -n "$hostname" ]; then
    [[ "$hostname" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]] || die "Not a hostname: $hostname. Use lowercase, such as orrery.example.com."
    token=${CLOUDFLARE_API_TOKEN:-}
    if [ -z "$token" ]; then
      { true </dev/tty; } 2>/dev/null || die "No terminal to ask for the Cloudflare API token. Run this in your own terminal, or set CLOUDFLARE_API_TOKEN."
      cat <<EOF

Create a Cloudflare API token for this run:
  dash.cloudflare.com > My Profile > API Tokens > Create Token > Create Custom Token
    Account   Cloudflare Tunnel   Edit
    Zone      Zone                Read
    Zone      DNS                 Edit
    Zone      Zone WAF            Edit
  Under Zone Resources, pick the domain of $hostname.
EOF
      read -rsp "Paste the token (input hidden): " token </dev/tty
      echo
    fi
    [ -n "$token" ] || die "No token given."
  fi

  say "Installing git, curl and Docker"
  export DEBIAN_FRONTEND=noninteractive
  run apt-get update
  run apt-get install -y git curl ca-certificates
  if [ -n "$token" ]; then
    # The token goes to curl through a config on a file descriptor, never on a command line.
    curl -fsS -o /dev/null -K <(printf 'header = "Authorization: Bearer %s"\n' "$token") "https://api.cloudflare.com/client/v4/zones?per_page=1" 2>>"$LOG" ||
      die "Cloudflare did not accept the API token. Check that you pasted all of it and that it is active."
  fi
  if ! docker compose version >/dev/null 2>&1; then
    run bash -c 'curl -fsSL https://get.docker.com | sh'
  fi

  if [ -z "$(swapon --show --noheadings 2>/dev/null)" ] && [ ! -e /swapfile ]; then
    say "Adding 2 GB of swap"
    if fallocate -l 2G /swapfile 2>>"$LOG" && chmod 600 /swapfile && mkswap /swapfile >>"$LOG" 2>&1 && swapon /swapfile 2>>"$LOG"; then
      echo '/swapfile none swap sw 0 0' >>/etc/fstab
    else
      rm -f /swapfile
      echo "   This machine does not allow it (see $LOG). Continuing without swap."
    fi
  fi

  say "Getting Orrery into $dir"
  if [ -n "$from_checkout" ]; then
    echo "   Using this checkout"
  elif [ ! -d "$dir/.git" ]; then
    run git clone "$REPO" "$dir"
  else
    git -C "$dir" pull --ff-only >>"$LOG" 2>&1 || echo "   Could not update it (local changes?). Using it as it is."
  fi
  cd "$dir/deploy"
  mkdir -p data && chown 1000:1000 data && chmod 700 data
  touch .env && chmod 600 .env

  say "Building Orrery (a few minutes the first time)"
  run docker build -t orrery:local -f ../agent/Dockerfile ..

  if [ -n "$hostname" ]; then
    say "Setting up Cloudflare for $hostname"
    CLOUDFLARE_API_TOKEN=$token docker run --rm --user 0 --entrypoint node -e CLOUDFLARE_API_TOKEN -e ORRERY_ALLOW_IPS \
      -v "$PWD":/deploy orrery:local /deploy/cloudflare.mjs "$hostname" /deploy/.env || die "Nothing was started. Fix the problem above and run this again."
    token=""
  fi

  bash enable-ssh.sh

  say "Waiting for the tunnel"
  local up=""
  for _ in $(seq 30); do
    if docker compose logs tunnel 2>/dev/null | grep -q "Registered tunnel connection"; then up=1; break; fi
    sleep 2
  done
  if [ -n "$up" ]; then echo "   Connected"; else echo "   Not connected yet. Check: cd $dir/deploy && docker compose logs --tail 30 tunnel"; fi

  if [ -z "$hostname" ]; then
    printf '\nOrrery is updated and running.\n'
    return
  fi
  # The connector token is shown only to a person at a terminal, never into a log or an assistant's transcript.
  local secret="<token>"
  for _ in $(seq 30); do [ -s data/token ] && break; sleep 1; done
  if [ -t 1 ] && [ -s data/token ]; then secret=$(cat data/token); fi
  cat <<EOF

Orrery is running at https://$hostname.

1. Add it to your AI client. Keep this URL secret: it unlocks every tool.
     claude.ai > Settings > Connectors > Add custom connector
       Name  Orrery
       URL   https://$hostname/mcp/$secret
EOF
  [ "$secret" != "<token>" ] || echo "     The token: cat $dir/deploy/data/token"
  cat <<EOF
2. Delete the Cloudflare API token you created. It is not needed again.
3. Add your cloud credentials (docs/providers.md), then ask your assistant to list your servers.

Clients on your own computer (Claude Code, Codex, Cursor) use https://$hostname/mcp with the header
"Authorization: Bearer <token>" and need their IP allowed: docs/deploy.md, step 7.
EOF
}

main "$@"
