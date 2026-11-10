#!/usr/bin/env bash
# T-006 Part A: probe candidate ways to switch Monitor Four to its Alternate Function.
# Reads DS:0xe32c (m4mode: 0=terrain/unit, 1=own BPR+cash, -1/0xff=opponent BPR) after each
# candidate, so a hit is a number, not a guess about pixels.
#
# usage: t6-m4probe.sh <tag>
set -u
R=/mnt/nas/projects/OpenCHQ/tools/t6/rea-run.sh
G=/mnt/nas/projects/OpenCHQ/tools/t6/read-globals.py
O=/tmp/t6/m4
TAG="${1:-probe}"
mkdir -p "$O"

m4() {   # m4 <label>
  PID=$(pgrep -x dosbox | head -1)
  if [ -z "$PID" ]; then echo "$1: NO DOSBOX"; return; fi
  V=$(sudo -n python3 "$G" "$PID" 2>/dev/null | awk '/m4mode/ {print $NF}')
  echo "$1 -> m4mode=$V"
}

bash "$R" "$O" move 550 520            # park pointer over Monitor Four strip
m4 "baseline"

for k in z Z; do
  DISPLAY=:99 xdotool key --clearmodifiers "ctrl+$k"; sleep 1
  m4 "ctrl+$k"
done
for k in z Z; do
  DISPLAY=:99 xdotool key --clearmodifiers "alt+$k"; sleep 1
  m4 "alt+$k"
done

# A left click inside Monitor Four (the terrain/unit panel, bottom-right).
DISPLAY=:99 xdotool mousemove 840 520 click 1; sleep 1
m4 "click monitor4"
DISPLAY=:99 xdotool mousemove 840 520 click 3; sleep 1
m4 "right-click monitor4"

# Hover into the hidden menu bar at the very top of the screen.
DISPLAY=:99 xdotool mousemove 512 8; sleep 1
bash "$R" "$O" shoot "menubar_$TAG"
m4 "hover menubar"
