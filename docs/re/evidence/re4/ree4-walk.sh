#!/usr/bin/env bash
# RE-E4 walk: fresh war room in a chosen era, then census. Based on local/t6-final.sh.
# usage: ree4-walk.sh <era 1..4> <side 1..2> <opp 1..6> <tag>
#   era 1=1918 2=1942 3=1986 4=2023 (1930s menu order is the crisis list)
set -u
R=/mnt/nas/projects/OpenCHQ/local/rea-run.sh
P=/mnt/nas/host-ops/openchq/re-e4/ree4.py
O=/mnt/nas/host-ops/openchq/re-e4/captures
ERA="${1:?era}"; SIDE="${2:-1}"; OPP="${3:-2}"; TAG="${4:-era${ERA}blue}"
mkdir -p "$O"

bash "$R" "$O" kill
bash "$R" "$O" start 16
bash "$R" "$O" key Return 2.5            # START A NEW WAR
for i in $(seq 1 $((OPP-1))); do bash "$R" "$O" key Down 0.45; done
bash "$R" "$O" key Return 2.5            # opponent
for i in $(seq 1 $((ERA-1))); do bash "$R" "$O" key Down 0.45; done
bash "$R" "$O" key Return 2.5            # crisis (era)
for i in $(seq 1 $((SIDE-1))); do bash "$R" "$O" key Down 0.45; done
bash "$R" "$O" key Return 3              # side
if [ "$ERA" -eq 3 ]; then bash "$R" "$O" key Return 3; fi   # 1986 BLUE LAYOUTS screen
bash "$R" "$O" shoot "0_spinner_$TAG"
bash "$R" "$O" key Return 4              # OK -> war room (paused)
bash "$R" "$O" move 550 520
bash "$R" "$O" shoot "1_warpaused_$TAG"

PID=$(pgrep -x dosbox | head -1)
echo "pid=$PID tag=$TAG"
sudo -n env PYTHONPATH= /usr/bin/python3 "$P" "$PID" census | tee "$O/census-paused-$TAG.txt"
