#!/usr/bin/env bash
# T-006 Part A: walk the original's setup for one era/side/opponent, capture the
# OPPONENT'S STARTING MONEY dialog at its default, enter the paused war room, and read the
# game's own money global (DS:0x157e) out of the live process.
# usage: t6-run.sh <era 1..5> <side 1=BLUE 2=RED> <opp 1..6> <tag>
set -u
R=/mnt/nas/projects/OpenCHQ/tools/t6/rea-run.sh
O=/tmp/t6
ERA="${1:-1}"; SIDE="${2:-1}"; OPP="${3:-2}"; TAG="${4:-shot}"

bash "$R" "$O" kill
bash "$R" "$O" start 16
bash "$R" "$O" key Return 2.5          # START A NEW WAR
for i in $(seq 1 $((OPP-1))); do bash "$R" "$O" key Down 0.45; done
bash "$R" "$O" key Return 2.5          # opponent
for i in $(seq 1 $((ERA-1))); do bash "$R" "$O" key Down 0.45; done
bash "$R" "$O" key Return 2.5          # crisis
for i in $(seq 1 $((SIDE-1))); do bash "$R" "$O" key Down 0.45; done
bash "$R" "$O" key Return 3            # side
if [ "$ERA" -eq 3 ]; then bash "$R" "$O" key Return 3; fi   # 1986 BLUE LAYOUTS
bash "$R" "$O" move 950 750
bash "$R" "$O" shoot "dlg_$TAG"
bash "$R" "$O" key Return 4            # OK -> war room, paused
bash "$R" "$O" move 950 750
bash "$R" "$O" shoot "war_$TAG"
sleep 1
PID=$(pgrep -x dosbox | head -1)
echo "pid=$PID tag=$TAG"
sudo -n python3 /mnt/nas/projects/OpenCHQ/tools/t6/read-era.py "$PID" "$TAG"
