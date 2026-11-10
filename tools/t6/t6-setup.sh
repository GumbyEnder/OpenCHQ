#!/usr/bin/env bash
# T-006: walk the original's setup for one era/side/opponent and stop on the
# OPPONENT'S STARTING MONEY spinner with the default untouched.
# usage: t6-setup.sh <era 1..5> <side 1=BLUE 2=RED> <opponent 1..6> <outdir> <tag>
set -u
R=/mnt/nas/projects/OpenCHQ/tools/t6/rea-run.sh
ERA="${1:-1}"; SIDE="${2:-1}"; OPP="${3:-2}"; OUT="${4:-/tmp/t6}"; TAG="${5:-shot}"
mkdir -p "$OUT"
bash "$R" "$OUT" kill
bash "$R" "$OUT" start 16

# main options -> START A NEW WAR
bash "$R" "$OUT" key Return 2.5
# opponent options: start at ANOTHER HUMAN, move down (OPP-1) times
for i in $(seq 1 $((OPP-1))); do bash "$R" "$OUT" key Down 0.45; done
bash "$R" "$OUT" key Return 2.5
# crisis options: 1918,1942,1986,2023,????
for i in $(seq 1 $((ERA-1))); do bash "$R" "$OUT" key Down 0.45; done
bash "$R" "$OUT" key Return 2.5
# side options: BLUE / RED
for i in $(seq 1 $((SIDE-1))); do bash "$R" "$OUT" key Down 0.45; done
bash "$R" "$OUT" key Return 3
# park the pointer away from the dialog so it never overlaps a digit
bash "$R" "$OUT" move 900 700
sleep 1
bash "$R" "$OUT" shoot "$TAG"
echo "reached spinner: $TAG"
