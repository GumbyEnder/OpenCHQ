#!/usr/bin/env bash
# T-006 Part A: capture Monitor Four's three display modes with Ctrl+Z, reading DS:0xe32c
# beside each shot so the label is the game's own mode value, not a guess.
# usage: t6-m4modes.sh <tag>
set -u
R=/mnt/nas/projects/OpenCHQ/tools/t6/rea-run.sh
G=/mnt/nas/projects/OpenCHQ/tools/t6/read-globals.py
O=/tmp/t6/m4
TAG="${1:-modes}"
mkdir -p "$O"
m4() { sudo -n python3 "$G" "$(pgrep -x dosbox | head -1)" 2>/dev/null | awk '/m4mode/ {print $NF}'; }

for i in 1 2 3; do
  bash "$R" "$O" move 550 520 >/dev/null
  bash "$R" "$O" shoot "${TAG}_mode$(m4)" >/dev/null
  echo "captured mode=$(m4) as ${TAG}_mode$(m4).png"
  DISPLAY=:99 xdotool key --clearmodifiers ctrl+z; sleep 1.5
done
