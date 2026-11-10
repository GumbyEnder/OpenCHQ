#!/usr/bin/env bash
# Steer the game cursor into the leftmost monitor band (game x < 0x45) with relative mouse
# motion and no absolute warps, then press SPACE (Selector #2) to toggle Monitor Four's
# alternate function (the money readout).  Prints the detected band after each nudge.
set -u
R=/mnt/nas/projects/OpenCHQ/tools/t6/rea-run.sh
O=/tmp/t6
D=:99
det() { python3 /mnt/nas/projects/OpenCHQ/tools/t6/t6-cursor.py "$O/$1.png"; }

bash "$R" "$O" shoot steer0
for i in $(seq 1 24); do
  out=$(det steer0)
  gx=$(printf '%s' "$out" | sed -n 's/.*game_x.: \([0-9]*\).*/\1/p')
  gx=${gx:-999}
  echo "step $i game_x=$gx"
  if [ "$gx" -lt 69 ]; then break; fi
  DISPLAY=$D xdotool mousemove_relative -- -25 0
  sleep 0.5
  bash "$R" "$O" shoot steer0
done
DISPLAY=$D xdotool key space
sleep 1.5
bash "$R" "$O" shoot money_try
echo "after space:"; det money_try
