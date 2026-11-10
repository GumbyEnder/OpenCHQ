#!/usr/bin/env bash
# T-006 Part A: find the key that switches Monitor Four to its Alternate Function.
#
# Sweeps candidate keys in a PAUSED war room (a paused room is pixel-stable, so a diff is
# caused by the key, not by units moving), screenshots after each, and prints only the keys
# whose change is confined to the bottom monitor strip. Nothing here guesses a key: a hit is
# a screenshot the caller still has to read.
#
# usage: t6-m4key.sh [outdir]
set -u
R=/mnt/nas/projects/OpenCHQ/tools/t6/rea-run.sh
O="${1:-/tmp/t6/m4/keys}"
mkdir -p "$O"

bash "$R" "$O" move 550 520 >/dev/null
bash "$R" "$O" shoot base >/dev/null

keys="a b c d e f g h i j k l m n o p q r s t u v w x y z 0 1 2 3 4 5 6 7 8 9
      F1 F2 F3 F4 F5 F6 F7 F8 F9 F10 F11 F12 Tab Insert Delete Home End Prior Next
      ctrl+a ctrl+b ctrl+c ctrl+d ctrl+e ctrl+f ctrl+g ctrl+h ctrl+i ctrl+j ctrl+k
      ctrl+l ctrl+m ctrl+n ctrl+o ctrl+p ctrl+q ctrl+r ctrl+s ctrl+t ctrl+u ctrl+v
      ctrl+w ctrl+x ctrl+y ctrl+z
      alt+a alt+b alt+c alt+d alt+e alt+f alt+g alt+h alt+i alt+j alt+k alt+l
      alt+n alt+o alt+q alt+r alt+s alt+t alt+u alt+v alt+w alt+x alt+y alt+z"

for k in $keys; do
  safe=$(echo "$k" | tr -d '+')
  DISPLAY=:99 xdotool key --clearmodifiers "$k" 2>/dev/null
  sleep 0.9
  bash "$R" "$O" shoot "k_$safe" >/dev/null
  # restore: the room is paused, so nothing should need undoing, but a menu may have opened
  DISPLAY=:99 xdotool key --clearmodifiers Escape 2>/dev/null
  sleep 0.6
done

python3 - "$O" <<'PY'
import sys, glob, os
from PIL import Image, ImageChops
O = sys.argv[1]
base = Image.open(os.path.join(O, "base.png")).convert("RGB")
W, H = base.size
STRIP_TOP = 470          # monitors start here in a 1024x768 frame
hits, noisy = [], []
for f in sorted(glob.glob(os.path.join(O, "k_*.png"))):
    im = Image.open(f).convert("RGB")
    if im.size != base.size:
        noisy.append((os.path.basename(f), "size " + str(im.size)))
        continue
    box = ImageChops.difference(base, im).getbbox()
    if not box:
        continue
    name = os.path.basename(f)[2:-4]
    if box[1] >= STRIP_TOP:
        hits.append((name, box))
    else:
        noisy.append((name, box))
print("STRIP-ONLY HITS:")
for n, b in hits:
    print("  %-10s %s" % (n, b))
print("OTHER DIFFS (map/text, not a monitor toggle):")
for n, b in noisy[:20]:
    print("  %-10s %s" % (n, b))
PY
