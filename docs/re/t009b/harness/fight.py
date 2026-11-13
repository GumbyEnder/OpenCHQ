#!/usr/bin/env python3
"""T-009: put two opposing pieces adjacent on a chosen terrain and read every strength change.

usage: sudo -n python3 fight.py <pid> <aKind> <bKind> <secs> [terrainName] [aFacing] [bFacing]

Picks the first blue piece of kind A and the first red piece of kind B, teleports B next to
A on the target terrain, writes both terrain bytes (0x836), clears orders, and logs strength,
target, facing and flags every 100 ms until a round boundary or secs elapse.
"""
import sys
import time

sys.path.insert(0, __import__("os").path.dirname(__import__("os").path.abspath(__file__)))
from cmem import CombatMem, TERRAIN, KIND, row  # noqa: E402

TMAP = "/mnt/nas/Projects/Command HQ/modern/extracted/data/tmap.bin"
BUF = open(TMAP, "rb").read()


def terrain_at(x, y):
    if not (0 <= y <= 135):
        return 99
    x %= 320
    b = BUF[y * 0xA2 + (x >> 1)]
    return (b >> 4) if (x & 1) == 0 else (b & 0xF)


def find_cell(want, near_x, near_y, avoid=None):
    """Nearest cell of terrain `want` to (near_x, near_y) that is not `avoid`."""
    best = None
    for y in range(0, 136):
        for x in range(0, 320):
            if terrain_at(x, y) != want:
                continue
            if avoid and (x, y) == avoid:
                continue
            d = abs(x - near_x) + abs(y - near_y)
            if best is None or d < best[0]:
                best = (d, x, y)
    return best[1], best[2]


def place(g, i, x, y):
    g.set_u16(0x1B6 + i * 2, x)
    g.set_u8(0x286 + i, y)
    g.set_u8(0x836 + i, terrain_at(x, y))
    g.set_u8(0xC46 + i, g.u8(0xC46 + i) & ~0x40)


def main():
    pid = int(sys.argv[1])
    aKind, bKind = int(sys.argv[2]), int(sys.argv[3])
    secs = float(sys.argv[4]) if len(sys.argv) > 4 else 30.0
    want = sys.argv[5] if len(sys.argv) > 5 else None
    aFacing = int(sys.argv[6]) if len(sys.argv) > 6 else None
    bFacing = int(sys.argv[7]) if len(sys.argv) > 7 else None

    g = CombatMem(pid)
    g.clear_film()
    blue = [p for p in g.pieces() if p["side"] == "blue" and p["kind"] == aKind]
    red = [p for p in g.pieces() if p["side"] == "red" and p["kind"] == bKind]
    if not blue or not red:
        raise SystemExit(f"no pair for blue k{aKind} / red k{bKind}")
    A, B = blue[0], red[0]
    print("A:", row(A))
    print("B:", row(B))

    if want:
        tx, ty = find_cell({v: k for k, v in TERRAIN.items()}[want], A["x"], A["y"],
                           avoid=(A["x"], A["y"]))
    else:
        tx, ty = A["x"], A["y"]
        want = TERRAIN.get(terrain_at(tx, ty), "?")
    print(f"target cell ({tx},{ty}) terrain={terrain_at(tx, ty)} ({want})")

    place(g, A["i"], tx, ty)
    # B adjacent, preferring the cell east then south of A that has the same terrain
    for dx, dy in ((1, 0), (0, 1), (-1, 0), (0, -1)):
        if terrain_at(tx + dx, ty + dy) == terrain_at(tx, ty):
            bx, by = tx + dx, ty + dy
            break
    else:
        bx, by = tx + 1, ty
    place(g, B["i"], bx, by)
    if aFacing is not None:
        g.set_u8(0x7CE + A["i"], aFacing)
    if bFacing is not None:
        g.set_u8(0x7CE + B["i"], bFacing)

    print(f"placed A k{aKind} at ({tx},{ty}) and B k{bKind} at ({bx},{by}) "
          f"terrain {terrain_at(bx, by)}")
    ai, bi = A["i"], B["i"]
    t0 = time.time()
    last = (g.u8(0x89E + ai), g.u8(0x89E + bi))
    print(f"  t     strA strB  tgtA tgtB faceA faceB flA  flB  cdA cdB")
    print(f"{0.0:6.1f}  {last[0]:4d} {last[1]:4d}   {g.u8(0xBDE+ai):4d} {g.u8(0xBDE+bi):4d}"
          f"   {g.u8(0x7CE+ai):4d}  {g.u8(0x7CE+bi):4d}  0x{g.u8(0xC46+ai):02x} 0x{g.u8(0xC46+bi):02x}")
    tl = g.u16(0x157E)
    while time.time() - t0 < secs:
        time.sleep(0.1)
        cur = (g.u8(0x89E + ai), g.u8(0x89E + bi))
        now = g.u16(0x157E)
        if cur != last or g.u8(0xBDE + ai) != 255 and last == (100, 100):
            print(f"{time.time()-t0:6.1f}  {cur[0]:4d} {cur[1]:4d}   {g.u8(0xBDE+ai):4d} "
                  f"{g.u8(0xBDE+bi):4d}   {g.u8(0x7CE+ai):4d}  {g.u8(0x7CE+bi):4d}  "
                  f"0x{g.u8(0xC46+ai):02x} 0x{g.u8(0xC46+bi):02x}  "
                  f"{g.u8(0xD16+ai):3d} {g.u8(0xD16+bi):3d}")
        last = cur
        if now > tl + 1000:
            print(f"-- round boundary at t+{time.time()-t0:.1f}s")
            tl = now
    print("final A:", row(g.piece(ai)))
    print("final B:", row(g.piece(bi)))


if __name__ == "__main__":
    main()
