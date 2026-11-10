#!/usr/bin/env python3
"""Is this screenshot the OPPONENT'S STARTING MONEY spinner?

Prints SPINNER <box> when the small modal (about 109x55 px, x 402-511, y 270-325) is on screen,
NO otherwise. The box is found from its borders rather than a fixed rectangle, because the
dialog re-centres as digits change. Later eras put a different modal (BLUE LAYOUTS) on the
same path, so a setup walk needs to know which one it is looking at.
"""
import sys
from importlib.util import module_from_spec, spec_from_file_location
from PIL import Image

spec = spec_from_file_location("read_startmoney", "/mnt/nas/projects/OpenCHQ/tools/t6/read-startmoney.py")
rs = module_from_spec(spec)
spec.loader.exec_module(rs)


def classify(path):
    im = Image.open(path).convert("RGB")
    box = rs.find_dialog(im.load(), *im.size)
    if not box:
        return "NO", None
    left, top, right, bottom = box
    w, h = right - left, bottom - top
    if 90 <= w <= 135 and 40 <= h <= 70:
        return "SPINNER", box
    return "OTHER", box


if __name__ == "__main__":
    for f in sys.argv[1:]:
        kind, box = classify(f)
        print(f"{f} {kind} {box}")
