#!/usr/bin/env bash
# Interactive single-server installer for Daybook on Linux.
set -Eeuo pipefail
umask 077

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

usage() {
  cat <<'HELP'
Usage: ./install.sh [--resume | --upgrade]

First install asks for a public domain, optional certificate email, time zone,
loopback port, and owner account. It builds Daybook and starts Caddy with HTTPS.

--resume   Finish a first installation that stopped after writing its config.
--upgrade  Back up the existing database, rebuild, and restart with saved settings.

Requirements: Linux, Docker Engine with Compose V2, curl, a public DNS record
pointing to this server, and inbound TCP 80/443 (UDP 443 optional).
HELP
}

mode=install
case "${1:-}" in
  '') ;;
  --resume) mode=resume ;;
  --upgrade) mode=upgrade ;;
  -h|--help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac
if (($# > 1)); then usage >&2; exit 2; fi

die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
say() { printf '\n%s\n' "$*"; }
trap 'printf "Install stopped at line %s. Existing data volumes were kept.\n" "$LINENO" >&2' ERR

[[ "$(uname -s)" == Linux ]] || die 'Run this script on the Linux server.'
[[ -t 0 && -t 1 ]] || die 'Run in an interactive terminal, such as an SSH session.'
for program in docker curl getent ss; do
  command -v "$program" >/dev/null || die "$program is required. Install it, then rerun this script."
done
docker compose version >/dev/null 2>&1 || die 'Docker Compose V2 is required.'
docker info >/dev/null 2>&1 || die 'Docker Engine is unavailable to this account. Start Docker or add your user to the docker group.'

compose=(docker compose -p daybook -f compose.yaml -f compose.install.yaml)

valid_domain() {
  local value=$1 label
  [[ ${#value} -le 253 && "$value" == *.* && "$value" =~ ^[a-z0-9.-]+$ ]] || return 1
  IFS=. read -r -a labels <<< "$value"
  for label in "${labels[@]}"; do
    [[ ${#label} -le 63 && "$label" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || return 1
  done
  [[ "${labels[-1]}" =~ ^[a-z]{2,}$ ]]
}

if [[ "$mode" == install ]]; then
  [[ ! -e .env && ! -e config/Caddyfile ]] || die 'An installation already exists here. Use ./install.sh --upgrade.'
  [[ -z "$(ss -H -ltn '( sport = :80 or sport = :443 )')" ]] || die 'TCP port 80 or 443 is already in use. Install on a free server or configure your existing reverse proxy manually.'

  say 'Daybook setup'
  read -r -p 'Public domain (for example tasks.example.com): ' domain
  domain=${domain,,}
  valid_domain "$domain" || die 'Enter a valid public domain name.'
  getent ahosts "$domain" >/dev/null || die "No DNS record was found for $domain. Point it to this server first."
  read -r -p 'Certificate contact email (optional): ' email
  if [[ -n "$email" && ! "$email" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]; then
    die 'Enter a valid email address or leave it blank.'
  fi
  read -r -p 'Time zone [UTC]: ' time_zone
  time_zone=${time_zone:-UTC}
  [[ "$time_zone" =~ ^[A-Za-z0-9_+./-]+$ && "$time_zone" != *..* && -f "/usr/share/zoneinfo/$time_zone" ]] || die 'Use an installed IANA time zone, such as UTC or America/Phoenix.'
  read -r -p 'Private loopback port [8098]: ' port
  port=${port:-8098}
  [[ "$port" =~ ^[0-9]+$ ]] && ((port >= 1024 && port <= 65535)) || die 'Choose a port from 1024 to 65535.'
  [[ -z "$(ss -H -ltn "( sport = :$port )")" ]] || die "Port $port is already in use. Choose another loopback port."

  mkdir -p config
  {
    printf 'PUBLIC_URL=https://%s\n' "$domain"
    printf 'DAYBOOK_PORT=%s\n' "$port"
    printf 'APP_TIMEZONE=%s\n' "$time_zone"
    printf 'TRUST_PROXY=1\n'
  } > .env
  chmod 600 .env
  {
    if [[ -n "$email" ]]; then printf '{\n    email %s\n}\n\n' "$email"; fi
    printf '%s {\n    encode zstd gzip\n    reverse_proxy daybook:8098 {\n        header_up X-Real-IP {remote_host}\n    }\n}\n' "$domain"
  } > config/Caddyfile
  chmod 600 config/Caddyfile
else
  [[ -f .env && -f config/Caddyfile ]] || die 'No installed configuration found. Run ./install.sh first.'
  # Read only the values written by this installer; never execute the .env file.
  domain=$(sed -n 's#^PUBLIC_URL=https://##p' .env | head -n 1)
  valid_domain "$domain" || die 'The saved PUBLIC_URL is invalid.'
fi

"${compose[@]}" config --quiet

if [[ "$mode" == upgrade ]]; then
  say 'Creating a verified database backup before the upgrade...'
  backup_path=$("${compose[@]}" exec -T daybook node scripts/backup.mjs)
  [[ "$backup_path" == /app/backups/daybook-*.sqlite ]] || die 'The backup did not return an expected path.'
  printf 'Backup stored in the persistent backup volume: %s\n' "$backup_path"
  if docker image inspect daybook:local >/dev/null 2>&1; then
    rollback_tag="daybook:before-$(date -u +%Y%m%dT%H%M%SZ)"
    docker image tag daybook:local "$rollback_tag"
    printf 'Previous application image retained as %s\n' "$rollback_tag"
  fi
fi

say 'Building Daybook...'
"${compose[@]}" build daybook

if [[ "$mode" != upgrade ]]; then
  say 'Create the owner account. The password prompt is hidden and requires at least 14 characters.'
  "${compose[@]}" run --rm --no-deps daybook node scripts/account.mjs
fi

say 'Starting Daybook and Caddy...'
"${compose[@]}" up -d --no-build

say "Checking https://$domain/healthz (certificate issuance can take a few minutes)..."
healthy=0
for ((attempt=1; attempt<=90; attempt++)); do
  if curl --silent --show-error --fail --max-time 5 "https://$domain/healthz" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 3
done
if ((healthy == 0)); then
  "${compose[@]}" ps
  printf '\nHTTPS is not ready. Check DNS, firewall TCP 80/443, and: docker compose -p daybook -f compose.yaml -f compose.install.yaml logs caddy\n' >&2
  exit 1
fi

"${compose[@]}" ps
printf '\nDaybook is ready at https://%s/\n' "$domain"
printf 'Back up the database with: docker compose -p daybook -f compose.yaml -f compose.install.yaml exec -T daybook node scripts/backup.mjs\n'
