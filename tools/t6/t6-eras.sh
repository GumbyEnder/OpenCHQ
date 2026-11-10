#!/usr/bin/env bash
# T-006 Part A: capture the OPPONENT'S STARTING MONEY spinner default for every era, blue side,
# opponent 2 (SGT. STAN STIL). One clean shot per era, plus a red-side run for 1918.
# usage: t6-eras.sh [outdir]
set -u
R=/mnt/nas/projects/OpenCHQ/tools/t6/rea-run.sh
O="${1:-/tmp/t6/eras}"
mkdir -p "$O"
run_one() { # era side tag
  local era="$1" side="$2" tag="$3"
  bash /mnt/nas/projects/OpenCHQ/tools/t6/t6-setup.sh "$era" "$side" 2 "$O" "$tag"
}
for era in 1 2 3 4 5; do
  case "$era" in
    1) name=1918;; 2) name=1942;; 3) name=1986;; 4) name=2023;; 5) name=concealed;;
  esac
  run_one "$era" 1 "spinner-${name}-blue-sgtstan"
done
run_one 1 2 "spinner-1918-red-sgtstan"
run_one 3 2 "spinner-1986-red-sgtstan"
bash "$R" "$O" kill
ls -l "$O"/spinner-*.png
