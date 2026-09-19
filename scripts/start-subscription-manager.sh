#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
workspace="$project_root/.subscription-workspace"
export MIHOMO_BIN="${MIHOMO_BIN:-verge-mihomo}"
startup_timeout="${SUBSCRIPTION_STARTUP_TIMEOUT:-5}"
[[ "$startup_timeout" =~ ^[1-9][0-9]?$ ]] || { echo 'Invalid startup timeout.' >&2; exit 1; }
if [[ ! -f "$workspace/clash-verge.yaml" || ! -f "$project_root/dist-subscription-manager/index.html" ]]; then
  echo 'The configuration snapshot and frontend build are required.' >&2
  exit 1
fi
node "$project_root/scripts/subscription-isolation.mjs" "$workspace"
exec 9>"$workspace/manager.lock"
flock -n 9 || { echo 'The test manager is already running.' >&2; exit 1; }
core_pid=''
manager_pid=''
socket_id=''
cleanup() {
  trap '' INT TERM
  for pid in "$manager_pid" "$core_pid"; do
    if [[ -n "$pid" ]]; then kill "$pid" 2>/dev/null || true; fi
  done
  for ((attempt=0; attempt<20; attempt++)); do
    alive=false
    for pid in "$manager_pid" "$core_pid"; do
      if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then alive=true; fi
    done
    [[ "$alive" == true ]] || break
    sleep 0.1
  done
  for pid in "$manager_pid" "$core_pid"; do
    if [[ -n "$pid" ]]; then
      kill -KILL "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
  if [[ -n "$socket_id" && ! -L "$workspace/mihomo.sock" && -S "$workspace/mihomo.sock" ]] &&
     [[ "$(stat -c '%d:%i' -- "$workspace/mihomo.sock")" == "$socket_id" ]]; then
    rm -- "$workspace/mihomo.sock"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
"$MIHOMO_BIN" -d "$workspace" -f "$workspace/clash-verge.yaml" -ext-ctl-unix "$workspace/mihomo.sock" >"$workspace/core.log" 2>&1 &
core_pid=$!
ready=false
for ((attempt=0; attempt<startup_timeout*10; attempt++)); do
  if ! kill -0 "$core_pid" 2>/dev/null; then
    echo "Test core failed to start. See $workspace/core.log" >&2
    exit 1
  fi
  if [[ ! -L "$workspace/mihomo.sock" && -S "$workspace/mihomo.sock" ]]; then
    socket_id="$(stat -c '%d:%i' -- "$workspace/mihomo.sock")"
    ready=true
    break
  fi
  sleep 0.1
done
if [[ "$ready" != true ]]; then
  echo "Test core startup timed out. See $workspace/core.log" >&2
  exit 1
fi
node "$project_root/scripts/subscription-manager.mjs" &
manager_pid=$!
while kill -0 "$manager_pid" 2>/dev/null; do
  if ! kill -0 "$core_pid" 2>/dev/null; then
    echo "Test core stopped. See $workspace/core.log" >&2
    exit 1
  fi
  sleep 0.1
done
wait "$manager_pid"
