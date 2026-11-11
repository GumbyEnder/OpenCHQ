#!/bin/bash
# B-3(a) control probe: same running 1986 game, hover a CITY (id 3) then a CAPITAL (id 63),
# capture the full frame and the Monitor Two / Monitor Four crops for each.
set -eu
cd /mnt/nas/projects/OpenCHQ
export DISPLAY=:99
PID=$(pgrep -x dosbox | head -1)
echo "pid=$PID"
WID=$(xdotool search --class dosbox | tail -1)
xdotool windowfocus --sync "$WID"
xdotool key --clearmodifiers Escape; sleep 0.6
xdotool key --clearmodifiers Escape; sleep 0.6
xdotool mousemove 252 424; sleep 0.3; xdotool click 1; sleep 1.0
shot() { ffmpeg -hide_banner -loglevel error -f x11grab -video_size 1024x768 -i :99 -frames:v 1 -y "$1"; }
crop() { python3 -c "
from PIL import Image
im=Image.open('$1')
im.crop((352,450,512,584)).resize((640,536),Image.NEAREST).save('$2')
im.crop((672,450,832,584)).resize((640,536),Image.NEAREST).save('$3')
"; }
sudo -n python3 tools/t2/t2-nudge.py "$PID" 175 26 || echo "nudge city failed"
sleep 0.8; shot /tmp/t6/city-hover.png; crop /tmp/t6/city-hover.png /tmp/t6/city-m2.png /tmp/t6/city-m4.png
sudo -n python3 tools/t2/t2-nudge.py "$PID" 183 31 || echo "nudge capital failed"
sleep 0.8; shot /tmp/t6/cap-hover.png; crop /tmp/t6/cap-hover.png /tmp/t6/cap-m2.png /tmp/t6/cap-m4.png
echo done
