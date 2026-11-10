#!/usr/bin/env python3
"""T-002: contact sheet of a run's capital hover readouts, for name verification.

Reads docs/re/era-captures/era-<tag>.sites.json (written by t2-run.py), stacks the
name-panel crops of every hover into one image with a large ID + expected-name label
beside each, and writes docs/re/era-captures/era-<tag>-names.png.

The label is what we *expect* from modern/extracted/data/sites.json; the pixels are
what the game actually printed. They are compared by eye (vision), and the verdict is
recorded in ERA_SETUP.md — the sheet never asserts a match by itself.

Usage: python3 tools/t2/t2-names.py <tag> [<tag> ...]
"""
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path("/mnt/nas/projects/OpenCHQ")
CAP = ROOT / "docs/captures"
REC = ROOT / "docs/re/era-captures"

ROW_H = 63            # one strip per hover: the 2x-cropped name line
# The site name is drawn centred on the whole 320x200 frame (screen x 192..832,
# y 548..562), NOT inside the 160px status panel, so a panel-shaped crop cuts the
# long names ("WASHINGTON" ran off both sides).
PANEL = (192, 544, 832, 568)


def font(size):
    for p in ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
              "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"):
        if Path(p).exists():
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def sheet(tag):
    data = json.loads((REC / f"era-{tag}.sites.json").read_text())
    hovers = data.get("hovers") or []
    if not hovers:
        print(f"{tag}: no hovers")
        return None
    f = font(34)
    rows = []
    for h in hovers:
        p = CAP / h["shot"]
        if not p.exists():
            print(f"{tag}: missing {p.name}")
            continue
        im = Image.open(p).convert("RGB").crop(PANEL).resize(
            ((PANEL[2] - PANEL[0]) * 2, (PANEL[3] - PANEL[1]) * 2), Image.NEAREST)
        rows.append((h, im))
    W = 1280 + 40 + 560
    out = Image.new("RGB", (W, ROW_H * len(rows) + 10), (20, 20, 20))
    d = ImageDraw.Draw(out)
    for i, (h, im) in enumerate(rows):
        y = i * ROW_H + 5
        d.text((14, y + 14), f"id {h['id']}:", fill=(255, 255, 0), font=f)
        d.text((170, y + 14), h["sites_json_name"] or "?", fill=(0, 255, 120), font=f)
        out.paste(im, (560, y))
    dst = REC / f"era-{tag}-names.png"
    out.save(dst)
    print(f"{tag}: {len(rows)} hovers -> {dst}")
    return dst


if __name__ == "__main__":
    for t in sys.argv[1:]:
        sheet(t)
