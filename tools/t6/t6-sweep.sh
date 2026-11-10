#!/usr/bin/env bash
# T-006 Part A, full pass for one era/side/opponent:
#   walk setup -> capture spinner dialog (default untouched) -> OK -> unpause briefly so the
#   game assigns opening money -> pause -> force the own-money display flag -> capture the
#   game-rendered readout -> read the value straight out of the data segment.
# usage: t6-sweep.sh <era 1..5> <side 1=BLUE 2=RED> <opp 1..6> <tag>
set -u
R=/mnt/nas/projects/OpenCHQ/tools/t6/rea-run.sh
O=/tmp/t6
ERA="${1:-1}"; SIDE="${2:-1}"; OPP="${3:-2}"; TAG="${4:-shot}"

bash /mnt/nas/projects/OpenCHQ/tools/t6/t6-run.sh "$ERA" "$SIDE" "$OPP" "$TAG" | tail -2

# start the war so the opening money is assigned, then pause again
DISPLAY=:99 xdotool key alt+p; sleep 3
DISPLAY=:99 xdotool key alt+p; sleep 1

PID=$(pgrep -x dosbox | head -1)
# force "show own money" so FUN_3711_0074 redraws the readout every frame
sudo -n python3 -c "
import sys
sys.path.insert(0,'/mnt/nas/projects/OpenCHQ/local')
import importlib.util
spec=importlib.util.spec_from_file_location('re','/mnt/nas/projects/OpenCHQ/tools/t6/read-era.py')
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
base=m.ds_base('$PID')
with open('/proc/$PID/mem','r+b',0) as f:
    f.seek(base+0xe32c); f.write(b'\xff')
print('display flag set')
"
sleep 2
bash "$R" "$O" move 950 750
bash "$R" "$O" shoot "money_$TAG"
sudo -n python3 /mnt/nas/projects/OpenCHQ/tools/t6/read-era.py "$PID" "$TAG"
