#!/usr/bin/env python3
"""T-018 AC2: diff the model's 1942 Show Ownership fill against the original capture.

The capture is the original's screenshot (docs/captures/era-1942-blue-ownership.png), whose map
viewport is exactly 320x136 cells at 2x, offset (192,196). Ink is classified from the measured
palette; a cell's class is compared with the model's owner for the region that cell belongs to.

Writes, under local/t018-shots/:
  overlay-1942.png    capture | model | side-by-side difference, 4x, nearest neighbour
  ownership-1942.png  the model's fill alone, 4x
and prints the numbers the report quotes: per-class agreement and the regions that disagree.
"""
import json
import sys
from collections import Counter

from PIL import Image, ImageDraw

CAPTURE = "docs/captures/era-1942-blue-ownership.png"
TERRITORY = "web/data/territory.json"
ERAS = "web/data/eras.json"
OUT_DIR = "local/t018-shots"
ERA = sys.argv[1] if len(sys.argv) > 1 else "1942"
SHOT = sys.argv[2] if len(sys.argv) > 2 else CAPTURE

# Measured ink, from the capture itself.
FILL = {
    (85, 85, 255): "blue",
    (0, 0, 170): "blue",      # the outlined edge inside blue ground
    (255, 85, 85): "red",
    (170, 0, 0): "red",       # the outlined edge inside red ground
    (170, 170, 170): "neutral",
    (255, 255, 255): "neutral",   # the live view paints unheld ground white, not OMAP's grey
    (85, 255, 255): "sea",
}
MARKER = {(85, 85, 85), (0, 0, 0)}  # unit / city markers: not territory ink

PALETTE = {
    "blue": (85, 85, 255),
    "red": (255, 85, 85),
    "neutral": (255, 255, 255),
    "sea": (85, 255, 255),
    None: (0, 0, 0),
}


def main():
    territory = json.load(open(TERRITORY))
    eras = json.load(open(ERAS))["eras"]
    width, height = territory["width"], territory["height"]
    no_region = territory["noRegion"]

    grid = [no_region] * (width * height)
    at = 0
    for rid, count in territory["regionRuns"]:
        for i in range(at, at + count):
            grid[i] = rid
        at += count
    assert at == width * height, (at, width * height)

    sites = eras[ERA]["sites"]
    region_site = territory["byEra"][ERA]
    owners = []
    for site_id in region_site:
        owner = sites[site_id]["owner"] if site_id is not None else None
        owners.append(owner)

    shot = Image.open(SHOT).convert("RGB")
    px = shot.load()

    # The board's land mask, so sea is judged as sea and not as "no region".
    world = json.load(open("web/data/world.json"))
    cells = []
    for code, count in world["terrainRuns"]:
        cells += [code] * count
    names = world["terrain"]

    model = []
    actual = []
    agree = Counter()
    disagree = Counter()
    by_region = Counter()
    total_land = 0
    for y in range(height):
        for x in range(width):
            index = y * width + x
            terrain = names[cells[index]] if cells else "plain"
            rid = grid[index]
            owner = owners[rid] if rid != no_region else None
            # The live view's water is open ocean and lakes. Shallows are drawn with the coast
            # they belong to (the capture colours them), and polar ground is ground like any
            # other: what the original did not do was give ice its own colour.
            if terrain in ("ocean", "lake"):
                want = "sea"
            else:
                want = owner or "neutral"
                total_land += 1
            rgb = px[192 + x * 2 + 1, 196 + y * 2 + 1]
            if rgb in MARKER:
                got = want  # a unit standing on the cell says nothing about the ground
            else:
                got = FILL.get(rgb, "?")
            model.append(want)
            actual.append(got)
            if got == "?":
                continue
            if want == got:
                agree[(want, got)] += 1
            else:
                disagree[(want, got)] += 1
                if terrain not in ("ocean", "shallows", "lake"):
                    by_region[rid] += 1

    same = sum(agree.values())
    diff = sum(disagree.values())
    land_same = sum(n for (w, g), n in agree.items() if w != "sea")
    land_diff = sum(n for (w, g), n in disagree.items() if w != "sea")
    print(f"{ERA}: cells compared {same + diff}, agree {same} ({100*same/(same+diff):.2f}%), disagree {diff}")
    print(f"  land cells {land_same + land_diff}: agree {land_same} "
          f"({100*land_same/max(1, land_same+land_diff):.2f}%), disagree {land_diff}")
    print("  disagreement by class:", dict(disagree))
    worst = by_region.most_common(12)
    if worst:
        print("  regions with the most disagreement (region -> site -> model owner -> cells):")
        for rid, n in worst:
            sid = region_site[rid]
            print(f"    r{rid:3d} site {sid} owner {owners[rid]} cells {n}")

    S = 4
    model_img = Image.new("RGB", (width, height))
    model_img.putdata([PALETTE[m] for m in model])
    diff_img = Image.new("RGB", (width, height))
    diff_img.putdata([
        (0, 255, 0) if m == a else (255, 0, 255) for m, a in zip(model, actual)
    ])
    model_big = model_img.resize((width * S, height * S), Image.NEAREST)
    shot_crop = Image.open(SHOT).convert("RGB").crop((192, 196, 192 + width * 2, 196 + height * 2))
    shot_big = shot_crop.resize((width * S, height * S), Image.NEAREST)
    diff_big = diff_img.resize((width * S, height * S), Image.NEAREST)
    sheet = Image.new("RGB", (width * S * 2, height * S * 2), (0, 0, 0))
    sheet.paste(shot_big, (0, 0))
    sheet.paste(model_big, (width * S, 0))
    sheet.paste(diff_big, (0, height * S))
    label = ImageDraw.Draw(sheet)
    label.text((6, 6), f"{ERA} original capture", fill=(255, 255, 255))
    label.text((width * S + 6, 6), f"{ERA} model (region -> site -> owner)", fill=(255, 255, 255))
    label.text((6, height * S + 6), "green = agree, magenta = disagree", fill=(255, 255, 255))
    sheet.save(f"{OUT_DIR}/overlay-{ERA}.png")
    model_big.save(f"{OUT_DIR}/ownership-{ERA}.png")
    print(f"  wrote {OUT_DIR}/overlay-{ERA}.png and {OUT_DIR}/ownership-{ERA}.png")


if __name__ == "__main__":
    main()
