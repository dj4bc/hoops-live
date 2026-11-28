#!/bin/sh
# Install or update the Hoops Ops agent on the Linode. Run as root from this folder:
#   OPS_TOKEN=<same value as the Worker's AGENT_TOKEN> sh install.sh
# It adds a user, a timer and one config file. It does not touch the scraper, push-alerts or Caddy.
# Remove: systemctl disable --now ops-agent.timer && rm -rf /opt/ops-agent /etc/ops-agent.env /etc/systemd/system/ops-agent.* && userdel opsagent
set -eu
cd "$(dirname "$0")"
id opsagent >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin opsagent
install -d -m 755 /opt/ops-agent
install -m 644 ops-agent.mjs /opt/ops-agent/ops-agent.mjs
if [ ! -f /etc/ops-agent.env ]; then
  : "${OPS_TOKEN:?set OPS_TOKEN for the first install}"
  umask 077
  printf 'OPS_URL=%s\nOPS_TOKEN=%s\n' "${OPS_URL:-https://ops.adamforb.es/api/heartbeat}" "$OPS_TOKEN" > /etc/ops-agent.env
  chmod 600 /etc/ops-agent.env
fi
install -m 644 ops-agent.service ops-agent.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now ops-agent.timer
systemctl start ops-agent.service || true
systemctl --no-pager status ops-agent.service | head -12
