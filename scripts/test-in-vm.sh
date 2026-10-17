#!/usr/bin/env bash
set -euo pipefail

VM="${GA_VM:-ga-wave1}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

if ! command -v limactl >/dev/null 2>&1; then
  echo "limactl tidak ditemukan. Install dulu: brew install lima" >&2
  exit 1
fi

if limactl list --format '{{.Name}}' 2>/dev/null | grep -qx "$VM"; then
  if ! limactl list --format '{{.Name}} {{.Status}}' | grep -qx "$VM Running"; then
    limactl start "$VM" --tty=false
  fi
else
  limactl start --name="$VM" --tty=false "$REPO_DIR/vm/guardian.yaml"
fi

limactl shell "$VM" -- bash -lc '
  set -euo pipefail
  export PATH="$HOME/.bun/bin:$PATH"

  echo "=== read-only mount check"
  if touch /mnt/guardian-angel/.ga-write-probe 2>/dev/null; then
    echo "mount is writable"
    rm -f /mnt/guardian-angel/.ga-write-probe || true
    exit 1
  else
    echo "read-only mount: OK"
  fi

  echo "=== canary"
  CANARY=/tmp/ga-canary
  rm -f "$CANARY"
  printf "canary-intact\n" > "$CANARY"

  echo "=== copy repo to /tmp"
  rm -rf /tmp/ga && mkdir -p /tmp/ga
  tar -C /mnt/guardian-angel --exclude=node_modules --exclude=.git --exclude=.omo -cf - . | tar -C /tmp/ga -xf -
  cd /tmp/ga

  echo "=== install"
  bun install --silent

  echo "=== typecheck"
  ./node_modules/.bin/tsc --noEmit

  echo "=== tests"
  bun test

  echo "=== canary verify"
  if [ "$(cat "$CANARY" 2>/dev/null || true)" = "canary-intact" ]; then
    echo "canary: intact"
  else
    echo "canary: modified"
    exit 1
  fi

  echo "=== all checks passed"
'
