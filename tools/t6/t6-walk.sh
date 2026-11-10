#!/usr/bin/env bash
# T-006 Part A: walk the setup to the spinner for one era/side/opponent and stop there.
# 1918 and 1942 reach OPPONENT'S STARTING MONEY straight after the side; 1986 and 2023 put a
# BLUE LAYOUTS modal (STANDARD / CUSTOM) first, so the walk accepts the default and re-shoots
# until the small spinner box is on screen. Never presses Return on a screen it could not name.
# usage: t6-walk.sh <era 1..5> <side 1=BLUE 2=RED> <opponent 1..6> <outdir> <tag>
set -u
R=/mnt/nas/projects/OpenCHQ/tools/t6/rea-run.sh
DET=/mnt/nas/projects/OpenCHQ/tools/t6/t6-spinner.py
ERA="${1:-1}"; SIDE="${2:-1}"; OPP="${3:-2}"; OUT="${4:-/tmp/t6}"; TAG="${5:-shot}"
mkdir -p "$OUT"
bash "$R" "$OUT" kill
bash "$R" "$OUT" start 16
bash "$R" "$OUT" key Return 2.5
for i in $(seq 1 $((OPP-1))); do bash "$R" "$OUT" key Down 0.45; done
bash "$R" "$OUT" key Return 2.5
for i in $(seq 1 $((ERA-1))); do bash "$R" "$OUT" key Down 0.45; done
bash "$R" "$OUT" key Return 2.5
for i in $(seq 1 $((SIDE-1))); do bash "$R" "$OUT" key Down 0.45; done
bash "$R" "$OUT" key Return 3
bash "$R" "$OUT" move 900 700
for step in 1 2 3 4 5; do
  sleep 1
  bash "$R" "$OUT" shoot "probe-$TAG"
  line=$(PYTHONPATH= /usr/bin/python3 "$DET" "$OUT/probe-$TAG.png")
  kind=$(printf '%s' "$line" | awk '{print $2}')
  echo "step $step: $line"
  if [ "$kind" = "SPINNER" ]; then
    cp "$OUT/probe-$TAG.png" "$OUT/$TAG.png"
    rm -f "$OUT/probe-$TAG.png"
    echo "reached spinner: $TAG"
    exit 0
  fi
  # BLUE LAYOUTS / a menu drawn late: accept the highlighted default and look again.
  bash "$R" "$OUT" key Return 2
done
echo "NO_SPINNER $TAG (last screen: $kind)"
exit 3
