#!/usr/bin/env python3
"""Crop the four bottom monitor panels out of a captured 1024x768 original frame.

Usage: python3 t2-panels.py <full-frame.png> <out-prefix> [--scale N]

Writes <out-prefix>-m1.png .. -m4.png. Panel boxes are the fixed positions on this
host's Xvfb :99 1024x768 frame (DOSBox window 640x400 at 192,184): the four panels
sit on one row at y 450..584, 160 px wide, starting at x 192, 352, 512, 672.

Why this exists: docs/captures/era-1918-blue-cap-*-m2.png and -m4.png were once
hand-cut for three sites and turned out to be one pre-hover frame reused (the -m2
files were byte-identical, the -m4 files all showed the same ocean tile). Cut the
panels from the verified full frame instead, so the crop always belongs to the
hover it claims to belong to.
"""
import sys
from pathlib import Path

from PIL import Image

PANELS = {
    "m1": (192, 450, 352, 584),
    "m2": (352, 450, 512, 584),
    "m3": (512, 450, 672, 584),
    "m4": (672, 450, 832, 584),
}


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    src = Path(sys.argv[1])
    prefix = Path(sys.argv[2])
    scale = 4
    if "--scale" in sys.argv:
        scale = int(sys.argv[sys.argv.index("--scale") + 1])
    im = Image.open(src).convert("RGB")
    for name, box in PANELS.items():
        crop = im.crop(box)
        crop = crop.resize((crop.width * scale, crop.height * scale), Image.Resampling.NEAREST)
        out = prefix.with_name(prefix.name + f"-{name}.png")
        crop.save(out)
        print(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
