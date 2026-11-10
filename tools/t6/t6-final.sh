#!/usr/bin/env bash
# T-006 Part A, on-screen check: fresh 1918/blue vs SGT. STAN STIL, default spinner,
# paused war room. Capture Monitor Four in all three modes:
#   e378=0 terrain, e378=1 own MONEY(BIL$)/INCOME/BALANCE, e378=2 opponent INCOME, cash "???"
# The mode byte is read back from the live process beside every shot, so the label is the
# game's own value. The alternate display reverts to terrain when DS:0x3eb2 counts to 1
# (~5 s), so each shot is taken ~1 s after the press.
#
# usage: t6-final.sh [era 1..5] [side 1..2] [opp 1..6] [tag]
set -u
R=/mnt/nas/projects/OpenCHQ/tools/t6/rea-run.sh
D=/mnt/nas/projects/OpenCHQ/tools/t6/t6-dump.py
O=/tmp/t6/final
ERA="${1:-1}"; SIDE="${2:-1}"; OPP="${3:-2}"; TAG="${4:-1918blue}"
mkdir -p "$O"

bash "$R" "$O" kill
bash "$R" "$O" start 16
bash "$R" "$O" key Return 2.5            # START A NEW WAR
for i in $(seq 1 $((OPP-1))); do bash "$R" "$O" key Down 0.45; done
bash "$R" "$O" key Return 2.5            # opponent
for i in $(seq 1 $((ERA-1))); do bash "$R" "$O" key Down 0.45; done
bash "$R" "$O" key Return 2.5            # crisis
for i in $(seq 1 $((SIDE-1))); do bash "$R" "$O" key Down 0.45; done
bash "$R" "$O" key Return 3              # side
if [ "$ERA" -eq 3 ]; then bash "$R" "$O" key Return 3; fi   # 1986 BLUE LAYOUTS screen
bash "$R" "$O" move 950 750
bash "$R" "$O" shoot "0_spinner_$TAG"
bash "$R" "$O" key Return 4              # OK -> paused war room
bash "$R" "$O" move 550 520

PID=$(pgrep -x dosbox | head -1)
echo "pid=$PID  tag=$TAG"
sudo -n python3 "$D" "$PID" > "$O/0_globals_$TAG.txt"
cat "$O/0_globals_$TAG.txt"

crop() { python3 - "$1" <<'PY'
import sys
from PIL import Image
p = "/tmp/t6/final/" + sys.argv[1] + ".png"
Image.open(p).crop((688, 462, 838, 578)).resize((750, 580), Image.NEAREST).save(
    p.replace(".png", "_z.png"))
PY
}

bash "$R" "$O" shoot "1_m4_terrain_$TAG"; crop "1_m4_terrain_$TAG"

for m in 1 2; do
  DISPLAY=:99 xdotool key --clearmodifiers ctrl+v
  sleep 1
  sudo -n python3 "$D" "$PID" > "$O/${m}_globals_${TAG}_m$m.txt"
  echo "--- press $m ---"
  grep -E "player_side|m4mode|m4arm|mod148c|cash148e|money1446" "$O/${m}_globals_${TAG}_m$m.txt"
  bash "$R" "$O" shoot "${m}_m4_m${m}_$TAG"; crop "${m}_m4_m${m}_$TAG"
done
