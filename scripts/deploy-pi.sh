#!/usr/bin/env bash
set -euo pipefail

# Deploy DOCKYARD Live 3D Toolchanger Cockpit to a Raspberry Pi / Linux printer host.
# - Builds locally with VITE_MAINSAIL_URL=auto (no private IPs baked into dist/).
# - Installs isolated Node.js 22 LTS into ~/.local/node22 (never touches /usr/bin/node).
# - Syncs runtime files only (dist/, server/, src/, package.json) — zero node_modules on Pi.
# - Runs as a user-level systemd service (~/.config/systemd/user/dockyard.service).
# - Never touches HelixScreen, Klipper, Moonraker, Mainsail or Crowsnest.
#
# Usage:
#   ./scripts/deploy-pi.sh [host]
#
# Optional environment variables:
#   DEPLOY_HOST=<host>                 Target hostname or IP (defaults to host from local .env.local)
#   DEPLOY_USER=pi                     SSH user (default: pi)
#   DEPLOY_DIR=dockyard
#   DEPLOY_PORT=4173                   Cockpit listen port (default: 4173)
#   DEPLOY_PRINTER_URL=http://127.0.0.1
#   DEPLOY_PRINTER_NAME=STORMTROOPER   Display badge shown next to DOCKYARD
#   SKIP_TESTS=0                       Set to 1 to skip local `npm test`
#   REFRESH_ENV=0                      Set to 1 to regenerate remote .env.local ALLOWED_ORIGINS

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT_DIR}"

DEPLOY_USER="${DEPLOY_USER:-pi}"
DEPLOY_HOST="${1:-${DEPLOY_HOST:-}}"
DEPLOY_DIR="${DEPLOY_DIR:-dockyard}"
DEPLOY_PORT="${DEPLOY_PORT:-4173}"
DEPLOY_PRINTER_URL="${DEPLOY_PRINTER_URL:-http://127.0.0.1}"
DEPLOY_PRINTER_NAME="${DEPLOY_PRINTER_NAME:-STORMTROOPER}"
SKIP_TESTS="${SKIP_TESTS:-0}"
REFRESH_ENV="${REFRESH_ENV:-0}"

if [[ -z "${DEPLOY_HOST}" && -f "${ROOT_DIR}/.env.local" ]]; then
  DEPLOY_HOST="$(node -e "
    import { readFileSync } from 'node:fs';
    const raw = readFileSync('.env.local', 'utf8');
    const m = raw.match(/^\s*PRINTER_URL\s*=\s*(.+)\s*$/m);
    if (m) {
      const val = m[1].trim().replace(/^['\"]|['\"]$/g, '');
      console.log(new URL(val).hostname);
    }
  " 2>/dev/null || true)"
fi

if [[ -z "${DEPLOY_HOST}" || "${DEPLOY_HOST}" == "127.0.0.1" || "${DEPLOY_HOST}" == "localhost" ]]; then
  echo "Error: Specify the printer host via './scripts/deploy-pi.sh <host>' or DEPLOY_HOST=<host>." >&2
  echo "       (Or set a non-loopback PRINTER_URL in local .env.local.)" >&2
  exit 1
fi

if [[ ! "${DEPLOY_PORT}" =~ ^[0-9]+$ ]] || (( DEPLOY_PORT < 1 || DEPLOY_PORT > 65535 )); then
  echo "Error: DEPLOY_PORT must be an integer between 1 and 65535." >&2
  exit 1
fi

if [[ "${DEPLOY_DIR}" == /* || "${DEPLOY_DIR}" == *..* || ! "${DEPLOY_DIR}" =~ ^[A-Za-z0-9._/-]+$ ]]; then
  echo "Error: DEPLOY_DIR must be a safe relative path under the remote user's home directory." >&2
  exit 1
fi

if ! node -e "
  const u = new URL(process.argv[1]);
  if (u.protocol !== 'http:' || u.username || u.password || u.pathname !== '/' || u.search || u.hash) process.exit(1);
" "${DEPLOY_PRINTER_URL}" 2>/dev/null; then
  echo "Error: DEPLOY_PRINTER_URL must be an HTTP origin (e.g. http://127.0.0.1)." >&2
  exit 1
fi

TARGET="${DEPLOY_USER}@${DEPLOY_HOST}"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=8)

echo "==> [1/6] Running local checks & production build (VITE_MAINSAIL_URL=auto)..."
if [[ "${SKIP_TESTS}" != "1" ]]; then
  npm test
fi
VITE_MAINSAIL_URL=auto npm run build

echo "==> [2/6] Verifying SSH access to ${TARGET}..."
ssh "${SSH_OPTS[@]}" "${TARGET}" "true"

echo "==> [3/6] Ensuring isolated Node.js >= 22.12 LTS in ~/.local/node22..."
ssh "${SSH_OPTS[@]}" "${TARGET}" 'bash -s' <<'EOF'
set -euo pipefail
NODE_DIR="${HOME}/.local/node22"
NODE_BIN="${NODE_DIR}/bin/node"

have_valid_node() {
  [[ -x "${NODE_BIN}" ]] || return 1
  local ver major minor
  ver="$("${NODE_BIN}" -v 2>/dev/null || true)"
  [[ "${ver}" =~ ^v([0-9]+)\.([0-9]+)\. ]] || return 1
  major="${BASH_REMATCH[1]}"
  minor="${BASH_REMATCH[2]}"
  (( major > 22 || (major == 22 && minor >= 12) ))
}

if have_valid_node; then
  echo "    Using existing isolated Node.js: $("${NODE_BIN}" -v)"
  exit 0
fi

case "$(uname -m)" in
  aarch64|arm64) ARCH="arm64" ;;
  x86_64|amd64)  ARCH="x64" ;;
  armv7l)        ARCH="armv7l" ;;
  *)
    echo "Error: Unsupported remote architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}" "${NODE_DIR}.tmp"' EXIT

echo "    Downloading official Node.js 22 LTS (linux-${ARCH})..."
curl -fsSL "https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt" -o "${TMP_DIR}/SHASUMS256.txt"
SHA_LINE="$(grep -E "  node-v22\.[0-9]+\.[0-9]+-linux-${ARCH}\.tar\.xz$" "${TMP_DIR}/SHASUMS256.txt" | head -n 1)"
if [[ -z "${SHA_LINE}" ]]; then
  echo "Error: Could not locate Node.js 22 linux-${ARCH} tarball in SHASUMS256.txt" >&2
  exit 1
fi
TARBALL="${SHA_LINE##*  }"

curl -fsSL "https://nodejs.org/dist/latest-v22.x/${TARBALL}" -o "${TMP_DIR}/${TARBALL}"
(
  cd "${TMP_DIR}"
  printf '%s\n' "${SHA_LINE}" | sha256sum -c -
)

mkdir -p "${HOME}/.local" "${NODE_DIR}.tmp"
tar -xJf "${TMP_DIR}/${TARBALL}" --strip-components=1 -C "${NODE_DIR}.tmp"
rm -rf "${NODE_DIR}"
mv "${NODE_DIR}.tmp" "${NODE_DIR}"

echo "    Installed isolated Node.js: $("${NODE_BIN}" -v) (system /usr/bin/node untouched)"
EOF

echo "==> [4/6] Syncing runtime files (dist/, server/, src/, package.json)..."
ssh "${SSH_OPTS[@]}" "${TARGET}" "mkdir -p \"\$HOME/${DEPLOY_DIR}\" \"\$HOME/.config/systemd/user\""
rsync -az --delete -e "ssh ${SSH_OPTS[*]}" "${ROOT_DIR}/dist/" "${TARGET}:${DEPLOY_DIR}/dist/"
rsync -az --delete -e "ssh ${SSH_OPTS[*]}" "${ROOT_DIR}/server/" "${TARGET}:${DEPLOY_DIR}/server/"
rsync -az --delete -e "ssh ${SSH_OPTS[*]}" "${ROOT_DIR}/src/" "${TARGET}:${DEPLOY_DIR}/src/"
rsync -az -e "ssh ${SSH_OPTS[*]}" "${ROOT_DIR}/package.json" "${TARGET}:${DEPLOY_DIR}/package.json"

echo "==> [5/6] Configuring remote .env.local & user-level systemd service..."
sed "s|%h/dockyard|%h/${DEPLOY_DIR}|g" \
  "${ROOT_DIR}/deploy/dockyard.user.service.example" \
  | ssh "${SSH_OPTS[@]}" "${TARGET}" "cat > \"\$HOME/.config/systemd/user/dockyard.service\""

ssh "${SSH_OPTS[@]}" "${TARGET}" \
  "DEPLOY_DIR='${DEPLOY_DIR}' DEPLOY_PORT='${DEPLOY_PORT}' DEPLOY_PRINTER_URL='${DEPLOY_PRINTER_URL}' DEPLOY_PRINTER_NAME='${DEPLOY_PRINTER_NAME}' REFRESH_ENV='${REFRESH_ENV}' bash -s" <<'EOF'
set -euo pipefail
APP_DIR="${HOME}/${DEPLOY_DIR}"
ENV_FILE="${APP_DIR}/.env.local"
NODE_BIN="${HOME}/.local/node22/bin/node"

if [[ ! -f "${ENV_FILE}" || "${REFRESH_ENV}" == "1" ]]; then
  BIND_HOST="0.0.0.0"
  if [[ -r /proc/sys/net/ipv6/bindv6only && "$(cat /proc/sys/net/ipv6/bindv6only)" == "0" ]]; then
    BIND_HOST="::"
  fi

  ORIGINS="$("${NODE_BIN}" -e "
    import os from 'node:os';
    import { readFileSync } from 'node:fs';
    const port = process.env.DEPLOY_PORT;
    const shortHost = os.hostname().split('.')[0].trim();
    const origins = new Set();
    if (shortHost) {
      origins.add(\`http://\${shortHost}.local:\${port}\`);
      origins.add(\`http://\${shortHost}:\${port}\`);
    }
    try {
      const resolv = readFileSync('/etc/resolv.conf', 'utf8');
      for (const line of resolv.split(/\r?\n/)) {
        const m = line.match(/^\s*(?:search|domain)\s+(.+)$/);
        if (!m || !shortHost) continue;
        for (const dom of m[1].trim().split(/\s+/)) {
          const clean = dom.replace(/\.+$/, '');
          if (/^[A-Za-z0-9.-]+$/.test(clean)) {
            origins.add(\`http://\${shortHost}.\${clean}:\${port}\`);
          }
        }
      }
    } catch {}
    for (const list of Object.values(os.networkInterfaces())) {
      for (const iface of list ?? []) {
        if (iface.family === 'IPv4' && !iface.internal && !iface.address.startsWith('169.254.')) {
          origins.add(\`http://\${iface.address}:\${port}\`);
        }
      }
    }
    console.log([...origins].join(','));
  ")"

  umask 077
  cat > "${ENV_FILE}" <<ENVEOF
# Auto-generated by scripts/deploy-pi.sh — kept private on the printer host.
HOST=${BIND_HOST}
PORT=${DEPLOY_PORT}
PRINTER_URL=${DEPLOY_PRINTER_URL}
PRINTER_NAME=${DEPLOY_PRINTER_NAME}
ALLOWED_ORIGINS=${ORIGINS}
ENVEOF
  echo "    Wrote ${ENV_FILE} (HOST=${BIND_HOST}, PORT=${DEPLOY_PORT})"
else
  echo "    Keeping existing ${ENV_FILE} (pass REFRESH_ENV=1 to regenerate)"
fi

systemctl --user daemon-reload
systemctl --user disable --now stormtrooper-cockpit.service >/dev/null 2>&1 || true
systemctl --user enable dockyard.service >/dev/null 2>&1 || true
systemctl --user restart dockyard.service
EOF

echo "==> [6/6] Verifying live health (read-only)..."
ssh "${SSH_OPTS[@]}" "${TARGET}" "DEPLOY_PORT='${DEPLOY_PORT}' bash -s" <<'EOF'
set -euo pipefail
NODE_BIN="${HOME}/.local/node22/bin/node"
SHORT_HOST="$(hostname -s)"

READY=0
for _ in $(seq 1 20); do
  if curl -fsS -o /dev/null "http://127.0.0.1:${DEPLOY_PORT}/" 2>/dev/null \
    && STATUS_JSON="$(curl -fsS "http://127.0.0.1:${DEPLOY_PORT}/api/status" 2>/dev/null)"; then
    READY=1
    break
  fi
  sleep 0.5
done

if [[ "${READY}" != "1" ]]; then
  echo "Error: DOCKYARD did not become ready on port ${DEPLOY_PORT}." >&2
  systemctl --user status dockyard.service --no-pager >&2 || true
  journalctl --user -u dockyard.service -n 30 --no-pager >&2 || true
  exit 1
fi

SUMMARY="$("${NODE_BIN}" -e "
  const data = JSON.parse(process.argv[1]);
  const klipper = data.klipperState ?? 'unknown';
  const tools = Array.isArray(data.tools) ? data.tools.length : 0;
  console.log(\`klipper=\${klipper}, tools=\${tools}\`);
" "${STATUS_JSON}")"

ACTIVE="$(systemctl --user is-active dockyard.service || true)"
LINGER="$(loginctl show-user "${USER}" -p Linger --value 2>/dev/null || echo unknown)"

echo "    Service: dockyard.service (${ACTIVE})"
echo "    Health : HTTP 200 / & /api/status (${SUMMARY})"
echo "    URL    : http://${SHORT_HOST}.local:${DEPLOY_PORT}/"
echo "    Kiosk  : http://${SHORT_HOST}.local:${DEPLOY_PORT}/?display=1"
echo ""
if [[ "${LINGER}" != "yes" ]]; then
  echo "WARNING: systemd user linger is currently '${LINGER}' for user '${USER}'."
  echo "         Without linger, user-level services stop when the SSH session closes"
  echo "         and will not auto-start after a Pi reboot."
  echo "         Enable 24/7 operation once with:"
  echo ""
  echo "           ssh -t ${USER}@${SHORT_HOST}.local \"sudo loginctl enable-linger ${USER}\""
  echo ""
else
  echo "    Linger : enabled (24/7 operation survives SSH logout & reboots)"
fi
EOF
