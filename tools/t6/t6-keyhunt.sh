#!/usr/bin/env bash
# Sweep candidate keys in the CHQ war room, flag any press that changes ONLY the bottom monitor
# strip (bar) while leaving the map untouched -- that is the Monitor alternate-function toggle.
# usage: t6-keyhunt.sh <outdir>
set -u
R=/mnt/nas/projects/OpenCHQ/tools/t6/rea-run.sh
O="${1:-/tmp/t6/kb}"
mkdir -p "$O"
bash "$R" "$O" move 900 740
bash "$R" "$O" shoot base
for k in a b c d e f g h i j k l m n o p q r s t u v w x y z 0 1 2 3 4 5 6 7 8 9 \
         F1 F2 F3 F4 F5 F6 F7 F8 F9 F10 Tab; do
  bash "$R" "$O" key "$k" 0.7
  bash "$R" "$O" move 900 740
  bash "$R" "$O" shoot "k_$k"
  bash "$R" "$O" key Escape 0.5
  bash "$R" "$O" move 900 740
  bash "$R" "$O" shoot "r_$k"
done
python3 - "$O" <<'PY'
import sys, glob, os
from PIL import Image, ImageChops
O = sys.argv[1]
base = Image.open(os.path.join(O, 'base.png')).convert('RGB')
BAR = (192, 470, 908, 590)     # monitor strip
MAP = (192, 190, 908, 460)     # world map above it
def crops(img):
    return img.crop(BAR), img.crop(MAP)
bb, bm = crops(base)
for f in sorted(glob.glob(os.path.join(O, 'k_*.png'))):
    k = os.path.basename(f)[2:-4]
    im = Image.open(f).convert('RGB')
    b, m = crops(im)
    db, dm = ImageChops.difference(bb, b).getbbox(), ImageChops.difference(bm, m).getbbox()
    if db and not dm:
        print('HIT', k, 'bar-changed map-unchanged')
    elif db and dm:
        print('both', k, 'bar', db, 'map', dm)
PY
