#!/usr/bin/env bash
# One-command setup of the Orrery host. As root on a fresh Debian or Ubuntu VPS, in your own terminal:
#
#   curl -fsSL https://github.com/sansheng777/Orrery/releases/latest/download/install.sh | bash -s -- orrery.example.com
#
# It asks once for a Cloudflare API token (typed hidden, used for this run only, stored nowhere), then
# installs Docker, adds swap if there is none, creates the tunnel, DNS record and WAF rule for the
# hostname, starts Orrery and lets it monitor this machine. In Cloudflare it touches only what is its own.
# Without a hostname it updates an Orrery that is already set up. Either way it installs the release it
# was downloaded from.
#
# The token (dash.cloudflare.com > My Profile > API Tokens > Create Custom Token) needs:
#   Account > Cloudflare Tunnel > Edit, and for the domain: Zone > Zone > Read, DNS > Edit, Zone WAF > Edit.
#
# Environment, set after the pipe (curl ... | NAME=value bash -s -- host): CLOUDFLARE_API_TOKEN (instead of
# the prompt), ORRERY_ALLOW_IPS="203.0.113.30 ..." (more addresses that may reach the hostname, for
# clients on your own computer), ORRERY_VERSION (another release such as v0.1.0, or main), ORRERY_HOME
# (default ~/orrery).
set -euo pipefail

REPO=https://github.com/sansheng777/Orrery
# The release this installer installs. The release workflow writes its tag here; in the repository it
# stays empty, which means the main branch.
RELEASE=""
LOG=/var/log/orrery-install.log

say() { printf '\n== %s\n' "$*"; }
die() { printf '\n%s\n' "$*" >&2; exit 1; }
# Runs a noisy step with its output in the log; on failure shows the end of the log.
run() { "$@" >>"$LOG" 2>&1 || { tail -n 20 "$LOG" >&2; die "Failed: $* (full log: $LOG)"; }; }

# Puts a checkout on a release tag, or on the tip of main.
checkout() {
  if [ "$2" = main ]; then
    git -C "$1" checkout --quiet main && git -C "$1" merge --quiet --ff-only origin/main
  else
    git -C "$1" -c advice.detachedHead=false checkout --quiet "refs/tags/$2"
  fi
}

# This file's path when it is run from a checkout; empty when it is piped into bash.
SELF=${BASH_SOURCE[0]:-}

# Everything runs from main, so a download cut short runs nothing.
main() {
  local hostname=${1:-} dir=${ORRERY_HOME:-$HOME/orrery} from_checkout="" token="" ref=${ORRERY_VERSION:-${RELEASE:-main}}
  [ "$(id -u)" = 0 ] || die "Run this as root."
  [[ "$ref" == main || "$ref" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || die "ORRERY_VERSION must be a release such as v0.1.0, or main."
  command -v apt-get >/dev/null || die "This installer is for Debian and Ubuntu. Elsewhere, follow docs/deploy.md."
  if [ -n "$SELF" ] && [ -f "$(dirname "$SELF")/cloudflare.mjs" ]; then
    dir=$(cd "$(dirname "$SELF")/.." && pwd)
    from_checkout=1
  fi
  : >>"$LOG" && chmod 600 "$LOG"

  if [ -z "$hostname" ] && ! grep -qs '^TUNNEL_TOKEN=' "$dir/deploy/.env"; then
    die "Give the public hostname for Orrery, on a domain you have on Cloudflare: bash install.sh orrery.example.com"
  fi
  if [ -n "$hostname" ]; then
    [[ "$hostname" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]] || die "Not a hostname: $hostname. Use lowercase, such as orrery.example.com."
    token=${CLOUDFLARE_API_TOKEN:-}
    unset CLOUDFLARE_API_TOKEN # nothing this script starts inherits it
    if [ -z "$token" ]; then
      { true </dev/tty; } 2>/dev/null || die "No terminal to ask for the Cloudflare API token. Run this in your own terminal on the host."
      cat <<EOF

Create a Cloudflare API token for this run:
  dash.cloudflare.com > My Profile > API Tokens > Create Token > Create Custom Token
    Account   Cloudflare Tunnel   Edit
    Zone      Zone                Read
    Zone      DNS                 Edit
    Zone      Zone WAF            Edit
  Under Zone Resources, pick the domain of $hostname. Under TTL, let it end tomorrow.
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
    run bash -o pipefail -c 'curl -fsSL https://get.docker.com | sh'
  fi

  if [ -z "$(swapon --show --noheadings 2>/dev/null)" ] && [ ! -e /swapfile ]; then
    say "Adding 2 GB of swap"
    if fallocate -l 2G /swapfile 2>>"$LOG" && chmod 600 /swapfile && mkswap /swapfile >>"$LOG" 2>&1 && swapon /swapfile 2>>"$LOG"; then
      [ -z "$(tail -c1 /etc/fstab 2>/dev/null)" ] || echo >>/etc/fstab # never glued to an unterminated last line
      echo '/swapfile none swap sw 0 0' >>/etc/fstab
    else
      rm -f /swapfile
      echo "   This machine does not allow it (see $LOG). Continuing without swap."
    fi
  fi

  if [ -n "$from_checkout" ]; then
    say "Using the Orrery checkout in $dir"
  else
    say "Getting Orrery ${ref} into $dir"
    [ -d "$dir/.git" ] || run git clone --quiet "$REPO" "$dir"
    run git -C "$dir" fetch --quiet --tags --force origin
    if [ "$ref" != main ] && ! git -C "$dir" rev-parse -q --verify "refs/tags/$ref" >/dev/null; then
      die "There is no release $ref. The releases: $REPO/releases"
    fi
    if ! checkout "$dir" "$ref" >>"$LOG" 2>&1; then
      echo "   Could not switch to $ref (local changes in $dir?). Using the checkout as it is."
    fi
  fi
  local version
  version=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$dir/package.json" | head -1)
  [ "$ref" != main ] || [ -n "$from_checkout" ] || version="$version (main branch)"
  cd "$dir/deploy"
  chmod 700 . # .env and data/ live here
  mkdir -p data && chown 1000:1000 data && chmod 700 data
  touch .env && chmod 600 .env

  say "Building Orrery (a few minutes the first time)"
  run docker build -t orrery:local -f ../agent/Dockerfile ..

  if [ -n "$hostname" ]; then
    say "Setting up Cloudflare for $hostname"
    # The token goes in on stdin: it is in no command line, environment or container description.
    printf '%s' "$token" | docker run --rm -i --user 0 --entrypoint node -e ORRERY_ALLOW_IPS \
      -v "$PWD":/deploy orrery:local /deploy/cloudflare.mjs "$hostname" /deploy/.env || die "Nothing was started. Fix the problem above and run this again."
    token=""
  fi

  bash enable-ssh.sh

  say "Waiting for the tunnel"
  local up=""
  for _ in $(seq 30); do
    # grep reads to the end: with pipefail, "grep -q" on a long log would end the pipe early and read as "no".
    if docker compose logs tunnel 2>/dev/null | grep "Registered tunnel connection" >/dev/null; then up=1; break; fi
    sleep 2
  done
  if [ -n "$up" ]; then echo "   Connected"; else echo "   Not connected yet. Check: cd $dir/deploy && docker compose logs --tail 30 tunnel"; fi

  if [ -z "$hostname" ]; then
    printf '\nOrrery %s is running. What changed: %s/blob/main/CHANGELOG.md\n' "$version" "$REPO"
    return
  fi
  # The connector URL is shown only on a terminal, so it reaches no log and no pipe. A tool that runs
  # this in a terminal of its own would still see it: the person, not an assistant, runs the installer.
  local secret="<token>"
  for _ in $(seq 30); do [ -s data/token ] && break; sleep 1; done
  if [ -t 1 ] && [ -s data/token ]; then secret=$(cat data/token); fi
  cat <<EOF

Orrery $version is running at https://$hostname.

1. Add it to your AI client. Keep this URL secret: it unlocks every tool.
     claude.ai > Settings > Connectors > Add custom connector
       Name  Orrery
       URL   https://$hostname/mcp/$secret
EOF
  [ "$secret" != "<token>" ] || echo "     The token: cat $dir/deploy/data/token"
  cat <<EOF
2. Delete the Cloudflare API token you created. It is not needed again.
3. Make this host's SSH key-only before it holds your cloud credentials: docs/deploy.md, step 9.
4. Add your cloud credentials (docs/providers.md), then ask your assistant to list your servers.

Clients on your own computer (Claude Code, Codex, Cursor) use https://$hostname/mcp with the header
"Authorization: Bearer <token>" and need their IP allowed: docs/deploy.md, step 7.
EOF
}

main "$@"
