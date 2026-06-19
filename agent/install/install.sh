#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# B6 — One-line installer (spec §B6 line 313).
#
# Usage (run as root):
#   curl -fsSL https://releases.tellus/agent/install.sh | bash -s -- \
#     --version 0.1.0 \
#     --coordinator wss://magritte.tellus.example/agent \
#     --group rra-prod-pg \
#     --token <joining-token>
#
# What it does:
#   1. Creates /opt/tellus/agent/bin, /etc/tellus/agent, /var/lib/tellus/agent.
#   2. Creates user `tellus` if missing.
#   3. Downloads tellus-agent-<version>-linux-x64 to /opt/tellus/agent/bin/.
#   4. Writes /etc/tellus/agent/agent.yml + /etc/tellus/agent/allowlist.yml
#      with root:root, 0644 (allowlist) / 0640 (agent.yml).
#   5. Installs the systemd unit and starts it.
# ---------------------------------------------------------------------------
set -euo pipefail

VERSION=""
COORD=""
GROUP=""
TOKEN=""
RELEASE_BASE="${TELLUS_AGENT_RELEASE_BASE:-https://releases.tellus/agent}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) VERSION="$2"; shift 2;;
    --coordinator) COORD="$2"; shift 2;;
    --group) GROUP="$2"; shift 2;;
    --token) TOKEN="$2"; shift 2;;
    *) echo "unknown arg: $1" >&2; exit 64;;
  esac
done

[[ -z "$VERSION" || -z "$COORD" || -z "$GROUP" || -z "$TOKEN" ]] && {
  echo "missing required args: --version --coordinator --group --token" >&2
  exit 64
}

[[ "$(id -u)" -eq 0 ]] || { echo "must run as root" >&2; exit 77; }

id -u tellus &>/dev/null || useradd -r -s /usr/sbin/nologin tellus

install -d -m 0755 -o root  -g root  /opt/tellus/agent/bin
install -d -m 0755 -o root  -g root  /etc/tellus/agent
install -d -m 0750 -o tellus -g tellus /var/lib/tellus/agent

BIN_PATH="/opt/tellus/agent/bin/tellus-agent"
curl -fsSL "${RELEASE_BASE}/${VERSION}/tellus-agent-${VERSION}-linux-x64" -o "${BIN_PATH}"
chmod 0755 "${BIN_PATH}"
chown root:root "${BIN_PATH}"

AGENT_ID="agent-$(hostname -s)-$(date -u +%Y%m%d%H%M%S)"
cat >/etc/tellus/agent/agent.yml <<EOF
coordinatorUrl: '${COORD}'
agentId: '${AGENT_ID}'
group: '${GROUP}'
version: '${VERSION}'
token: '${TOKEN}'
EOF
chmod 0640 /etc/tellus/agent/agent.yml
chown root:tellus /etc/tellus/agent/agent.yml

if [[ ! -f /etc/tellus/agent/allowlist.yml ]]; then
  cat >/etc/tellus/agent/allowlist.yml <<'EOF'
targets: []
updated_at: '1970-01-01T00:00:00Z'
EOF
fi
chmod 0644 /etc/tellus/agent/allowlist.yml
chown root:root /etc/tellus/agent/allowlist.yml

install -m 0644 -o root -g root \
  "$(dirname "$0")/tellus-agent.service" /etc/systemd/system/tellus-agent.service
systemctl daemon-reload
systemctl enable tellus-agent
systemctl restart tellus-agent
echo "[install] tellus-agent installed; check 'systemctl status tellus-agent'."
