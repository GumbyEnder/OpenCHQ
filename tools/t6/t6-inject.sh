#!/usr/bin/env bash
# Probe how the game RENDERS a money value: inject a known number into DS:0x157e, force the
# Monitor Four alternate mode (DS:0xe32c = 0xff), let the running loop redraw, and shoot.
# usage: t6-inject.sh <value> <tag>
set -u
R=/mnt/nas/projects/OpenCHQ/tools/t6/rea-run.sh
O=/tmp/t6/m4
TAG="${2:-inj}"
VAL="${1:-12345}"
PID=$(pgrep -x dosbox | head -1)
mkdir -p "$O"
# the redraw runs in the frame loop, so the room must be running, not paused
DISPLAY=:99 xdotool key --clearmodifiers alt+p >/dev/null 2>&1; sleep 1
sudo -n python3 /mnt/nas/projects/OpenCHQ/tools/t6/write-global.py "$PID" "0x157e=$VAL" 0xe32c=255 >/dev/null
sleep 1.5
DISPLAY=:99 xdotool mousemove 550 520
bash "$R" "$O" shoot "$TAG" >/dev/null
echo "$TAG: injected money=$VAL, shot $O/$TAG.png"
