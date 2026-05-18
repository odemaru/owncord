#!/usr/bin/env bash
# Privileged deploy script for OwnCord. Called from CI as:
#   sudo /usr/local/bin/owncord-deploy.sh <source-dir>
# Whitelisted via /etc/sudoers.d/owncord-deploy for the gitlab-runner user.
set -euo pipefail

SRC="${1:?usage: owncord-deploy.sh <source-dir>}"
TARGET="/apps/prod/OwnCord"

if [[ ! -d "$SRC" ]]; then
  echo "source dir not found: $SRC" >&2
  exit 1
fi

echo "==> rsync $SRC -> $TARGET"
rsync -a --delete \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='server/.env' \
  --exclude='server/uploads' \
  --exclude='server/data' \
  --exclude='server/data.sqlite*' \
  "$SRC/" "$TARGET/"

echo "==> chown owncord"
chown -R owncord:owncord "$TARGET"

echo "==> npm install + build (as owncord)"
cd "$TARGET"
sudo -u owncord -H bash -c 'npm run install:all && npm run build' 2>&1 | tail -20

echo "==> restart systemd service"
systemctl restart owncord
sleep 3
systemctl is-active owncord
curl -sS http://127.0.0.1:3089/api/health
echo
echo "==> deploy OK"
