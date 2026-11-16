#!/usr/bin/env python3
"""T-018 probe: does REGIONS.DAT describe the 184 region rectangles/quads the ownership view fills?

REGIONS.DAT is 3680 bytes = 184 records of 20 bytes = ten big-endian uint16 = five (x, y) points.
Point 0 sits inside the other four, so a record reads as a centre plus a 4-corner quad.

This probe rasterises the quads over the 320x136 board and samples the original ownership capture
(scaled 2x inside the DOSBox frame at 192,196) to see which ink each region lands on. It writes
local/t018-probe/region-quads.png and prints a per-era tally. Nothing here ships; it is a check.
"""
import json
import struct
import sys
from collections import Counter

from PIL import Image, ImageDraw

DATA = "/home/gumbyender/Games/CHQ"
SHOT = "docs/captures/era-1942-blue-ownership.png"
MAP_X, MAP_Y, SCALE = 192, 196, 2
MAP_W, MAP_H = 320, 136


def read_regions(root=DATA):
    raw = open(f"{root}/REGIONS.DAT", "rb").read()
    assert len(raw) % 20 == 0, len(raw)
    out = []
    for i in range(len(raw) // 20):
        v = struct.unpack(">10H", raw[i * 20:i * 20 + 20])
        pts = [(v[2 * k], v[2 * k + 1]) for k in range(5)]
        out.append(pts)
    return out


def read_cbr(era, root=DATA):
    txt = open(f"{root}/CBR-REGN.DT{era}", "rb").read().decode("latin1")
    return [int(x, 16) for x in __import__("re").findall(r"0x([0-9A-Fa-f]{2})", txt)]


def point_in_poly(x, y, poly):
    inside = False
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        if (y1 > y) != (y2 > y):
            if x < x1 + (y - y1) * (x2 - x1) / (y2 - y1):
                inside = not inside
    return inside


def build_mask(regions):
    mask = [[-1] * MAP_W for _ in range(MAP_H)]
    for rid, pts in enumerate(regions):
        quad = pts[1:5]
        minx = max(0, min(p[0] for p in quad))
        maxx = min(MAP_W - 1, max(p[0] for p in quad))
        miny = max(0, min(p[1] for p in quad))
        maxy = min(MAP_H - 1, max(p[1] for p in quad))
        for y in range(miny, maxy + 1):
            for x in range(minx, maxx + 1):
                if mask[y][x] == -1 and point_in_poly(x + 0.5, y + 0.5, quad):
                    mask[y][x] = rid
    return mask


def main():
    regions = read_regions()
    mask = build_mask(regions)
    covered = sum(1 for row in mask for v in row if v >= 0)
    print(f"regions={len(regions)} covered_cells={covered} of {MAP_W*MAP_H}")

    shot = Image.open(SHOT).convert("RGB")
    inkmask = []
    for y in range(MAP_H):
        for x in range(MAP_W):
            px = shot.getpixel((MAP_X + x * SCALE + 1, MAP_Y + y * SCALE + 1))
            inkmask.append(px)

    tally = Counter()
    per_region = {}
    for y in range(MAP_H):
        for x in range(MAP_W):
            rid = mask[y][x]
            if rid < 0:
                continue
            col = inkmask[y * MAP_W + x]
            per_region.setdefault(rid, Counter())[col] += 1
            tally[col] += 1
    print("ink over quad cells:")
    names = {(85, 255, 255): "sea", (85, 85, 255): "blue", (170, 0, 0): "red",
             (170, 170, 170): "grey", (0, 170, 0): "green", (0, 0, 170): "darkblue",
             (85, 255, 85): "lightgreen", (255, 255, 255): "white", (0, 0, 0): "black"}
    for col, n in tally.most_common(8):
        print(f"  {col} {names.get(col,'?'):10s} {n}")

    # per-region dominant ink, ignoring sea/black so land regions are judged on land ink
    print("\nper-region dominant land ink (region, n cells, ink):")
    for rid in sorted(per_region):
        c = per_region[rid]
        land = Counter({k: v for k, v in c.items() if k not in ((85, 255, 255), (0, 0, 0))})
        if not land:
            continue
        col, n = land.most_common(1)[0]
        print(f"  {rid:3d} {sum(c.values()):5d} {names.get(col,str(col)):10s} {n}")

    # draw
    img = Image.new("RGB", (MAP_W, MAP_H), (0, 0, 0))
    d = ImageDraw.Draw(img)
    for rid, pts in enumerate(regions):
        d.polygon(pts[1:5], outline=(255, 0, 255))
        d.point(pts[0], fill=(0, 255, 0))
    img.resize((MAP_W * 4, MAP_H * 4), Image.NEAREST).save("local/t018-probe/region-quads.png")
    print("\nwrote local/t018-probe/region-quads.png")

    if "--json" in sys.argv:
        meta = {}
        for era in range(5):
            vals = read_cbr(era)
            meta[era] = Counter(vals).most_common(8)
        print(json.dumps({str(k): v for k, v in meta.items()}, indent=1))


if __name__ == "__main__":
    main()
