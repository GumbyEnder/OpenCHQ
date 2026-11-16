#!/usr/bin/env python3
"""Independent re-derivation of the gap-composition clause landed as 05a83b0.

Reads REGIONS.DAT (184 x 20 B: label point then four quad corners, big-endian uint16),
tmap.bin (320x136 nibbles, row stride 162) and this tree's web/data/world.json (the
bundled board payload) directly. Makes no use of the bake's counters.

Prints: raw-tmap land, board-payload land, the painted set by terrain name, where those
painted cells sit in the raw map (the "over water" wording), and how many painted or land
cells fall in no quad.

Paths: the Command HQ asset root defaults to /mnt/nas/Projects/Command HQ and can be
pointed elsewhere with OPENCHQ_CHQ; the payload side is always this repo tree, so the
script can be run in any worktree without editing it.

Exit 0 on "CLAUSE RE-DERIVED", 1 on MISMATCH.
"""
import json
import os
import struct
import sys

W, H, STRIDE = 320, 136, 162
TERRAIN = ["ocean", "docks", "shallows", "lake", "capital", "base", "city", "oilfield",
           "plain", "forest", "mountain", "desert", "jungle", "polar", "wasteland", "facility"]
WATER = {"ocean", "shallows", "lake"}

ROOT = os.environ.get("OPENCHQ_CHQ", "/mnt/nas/Projects/Command HQ")
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def raw_map():
    b = open(os.path.join(ROOT, "modern/extracted/data/tmap.bin"), "rb").read()
    tid = [[0] * W for _ in range(H)]
    for y in range(H):
        for x in range(W):
            v = b[y * STRIDE + (x >> 1)]
            tid[y][x] = (v >> 4) & 0xF if x % 2 == 0 else v & 0xF
    return tid


def raw_land():
    tid = raw_map()
    land = [[0] * W for _ in range(H)]
    n = 0
    for y in range(H):
        for x in range(W):
            if TERRAIN[tid[y][x]] not in WATER:
                land[y][x] = 1
                n += 1
    return land, n


def board_cells():
    world = json.load(open(os.path.join(REPO, "web/data/world.json")))
    flat = []
    for code, count in world["terrainRuns"]:
        flat.extend([code] * count)
    assert len(flat) == W * H, f"runs expand to {len(flat)}"
    return world, flat


def board_land():
    world, cells = board_cells()
    terrain = world["terrain"]
    land = [[0] * W for _ in range(H)]
    names = {}
    n = 0
    for y in range(H):
        for x in range(W):
            name = terrain[cells[y * W + x]]
            if name not in WATER:
                land[y][x] = 1
                n += 1
                names[name] = names.get(name, 0) + 1
    return land, n, names


def quad_mask():
    b = open(os.path.join(ROOT, "COMMAND/REGIONS.DAT"), "rb").read()
    assert len(b) == 184 * 20, f"REGIONS.DAT is {len(b)} bytes"
    mask = [[0] * W for _ in range(H)]
    for r in range(184):
        base = r * 20
        corners = [struct.unpack_from(">HH", b, base + k * 4) for k in (1, 2, 3, 4)]
        xs = [p[0] for p in corners]
        ys = [p[1] for p in corners]
        for y in range(max(0, min(ys)), min(H - 1, max(ys)) + 1):
            for x in range(max(0, min(xs)), min(W - 1, max(xs)) + 1):
                if mask[y][x]:
                    continue
                px, py = x + 0.5, y + 0.5
                hit = False
                for i in range(4):
                    x1, y1 = corners[i]
                    x2, y2 = corners[(i + 1) % 4]
                    if (y1 > py) != (y2 > py):
                        if px < x1 + (py - y1) * (x2 - x1) / (y2 - y1):
                            hit = not hit
                if hit:
                    mask[y][x] = 1
    return mask


def main():
    tid = raw_map()
    rl, raw_n = raw_land()
    bl, board_n, _ = board_land()
    qm = quad_mask()
    quad_cells = sum(sum(row) for row in qm)

    painted = []
    back = 0
    for y in range(H):
        for x in range(W):
            if bl[y][x] and not rl[y][x]:
                painted.append((x, y))
            if rl[y][x] and not bl[y][x]:
                back += 1
    world, cells = board_cells()
    by_name = {}
    for x, y in painted:
        nm = world["terrain"][cells[y * W + x]]
        by_name[nm] = by_name.get(nm, 0) + 1
    # where the painted cells actually sit on the raw map -- this is the doc's wording
    over = {}
    for x, y in painted:
        nm = TERRAIN[tid[y][x]]
        over[nm] = over.get(nm, 0) + 1

    noquad = [p for p in painted if not qm[p[1]][p[0]]]
    gap_board = sum(1 for y in range(H) for x in range(W) if bl[y][x] and not qm[y][x])
    gap_raw = sum(1 for y in range(H) for x in range(W) if rl[y][x] and not qm[y][x])

    print(f"raw tmap land            {raw_n}")
    print(f"board payload land       {board_n}")
    print(f"delta (painted)          {board_n - raw_n}  {by_name}")
    print(f"painted cells sit, on the raw map, over {over}")
    print(f"raw land but board water {back}")
    print(f"quad cells               {quad_cells}")
    print(f"painted cells with no quad {len(noquad)} -> {noquad if len(noquad) <= 40 else ''}")
    print(f"gap candidates: board mask {gap_board} | raw-tmap mask {gap_raw} | difference {gap_board - gap_raw}")
    ok = (raw_n == 14440 and board_n == 14612 and len(painted) == 172
          and by_name == {"docks": 150, "city": 22} and quad_cells == 18725
          and over == {"ocean": 165, "lake": 5, "shallows": 2}
          and len(noquad) == 29 and gap_board == 2412 and gap_raw == 2383)
    print("CLAUSE RE-DERIVED" if ok else "MISMATCH")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
