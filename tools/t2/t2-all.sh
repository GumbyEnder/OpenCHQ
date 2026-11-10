#!/bin/bash
# T-002 Phase A: the full matrix of opening captures, one line per run.
# Every row of the Phase A table comes from one harness build (t2-run.py).
cd /mnt/nas/projects/OpenCHQ || exit 1
set -u
run() {
  era=$1 side=$2 tag=$3
  echo "=== $(date +%H:%M:%S) era=$era side=$side tag=$tag"
  sudo -n python3 tools/t2/t2-run.py "$era" "$side" 2 "$tag" > "/tmp/t6/run-$tag.log" 2>&1
  echo "exit=$? $(grep -E '^(war room|  hover|menubar|done)' "/tmp/t6/run-$tag.log" | tr '\n' '|')"
}
# 1918-blue already captured with this harness: docs/re/era-captures/era-1918-blue.sites.json
# 1918-red captured: docs/re/era-captures/era-1918-red.sites.json
run 2 1 1942-blue
run 2 2 1942-red
run 3 1 1986-blue
run 4 1 2023-blue-a
run 4 1 2023-blue-b
run 5 1 concealed-blue-a
run 5 1 concealed-blue-b
echo "=== batch done $(date +%H:%M:%S)"
