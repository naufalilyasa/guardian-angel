#!/usr/bin/env bash
set -uo pipefail

VM="${GA_VM:-ga-wave1}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

if ! command -v limactl >/dev/null 2>&1; then
  echo "limactl tidak ditemukan. Install dulu: brew install lima" >&2
  exit 1
fi

if ! limactl list --format '{{.Name}} {{.Status}}' 2>/dev/null | grep -qx "$VM Running"; then
  limactl start "$VM" --tty=false
fi

limactl shell "$VM" -- bash -s <<'VMSCRIPT'
set -uo pipefail
export PATH="$HOME/.bun/bin:$PATH"

echo "=== refresh working copy"
rm -rf /tmp/ga && mkdir -p /tmp/ga
tar -C /mnt/guardian-angel --exclude=node_modules --exclude=.git --exclude=.omo -cf - . | tar -C /tmp/ga -xf -
cd /tmp/ga || exit 1
bun install --silent

CLI="bun run /tmp/ga/src/cli/ga.ts"
WS="$(mktemp -d /tmp/ga-cli-XXXXXX)"
cd "$WS" || exit 1
printf 'hello-vm\n' > dummy.txt

echo "=== trash"
ID=$($CLI trash dummy.txt)
echo "id=$ID"
[ -n "$ID" ] || { echo "FAIL: no id"; exit 1; }

echo "=== list"
$CLI list || { echo "FAIL: list"; exit 1; }

echo "=== restore --last"
$CLI restore --last || { echo "FAIL: restore"; exit 1; }

echo "=== content"
CONTENT=$(cat dummy.txt)
echo "content=$CONTENT"
[ "$CONTENT" = "hello-vm" ] || { echo "FAIL: content mismatch"; exit 1; }

echo "=== status"
$CLI status || { echo "FAIL: status"; exit 1; }

echo "=== gc"
$CLI gc || { echo "FAIL: gc"; exit 1; }

echo "=== failure: unknown id"
$CLI restore nope-id >/dev/null 2>&1
[ $? -eq 1 ] || { echo "FAIL: unknown id should exit 1"; exit 1; }
echo "unknown id: exit 1 OK"

echo "=== failure: unknown command"
$CLI bogus >/dev/null 2>&1
[ $? -eq 1 ] || { echo "FAIL: unknown command should exit 1"; exit 1; }
echo "unknown command: exit 1 OK"

echo "=== CLI QA PASSED"
VMSCRIPT
