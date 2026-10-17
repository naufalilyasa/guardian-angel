#!/usr/bin/env bash
set -euo pipefail

VM="${GA_VM:-guardian-angel-test}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

if ! command -v limactl >/dev/null 2>&1; then
  echo "limactl tidak ditemukan. Install dulu: brew install lima" >&2
  exit 1
fi

if limactl list --format '{{.Name}}' 2>/dev/null | grep -qx "$VM"; then
  limactl start "$VM" --tty=false
else
  limactl start --name="$VM" --tty=false "$REPO_DIR/vm/guardian.yaml"
fi

limactl shell "$VM" -- bash -lc '
  set -euo pipefail
  export PATH="$HOME/.bun/bin:$PATH"
  rm -rf /tmp/ga && mkdir -p /tmp/ga
  tar -C /mnt/guardian-angel --exclude=node_modules --exclude=.git -cf - . | tar -C /tmp/ga -xf -
  cd /tmp/ga
  if [ -f package.json ]; then
    bun install
    bun test
  else
    echo "package.json belum ada (Fase 0 scaffold belum jalan). VM siap dipakai."
  fi
'