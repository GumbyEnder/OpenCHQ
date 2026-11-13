#!/usr/bin/env python3
"""T-009 duel: place two opposing pieces alone on a chosen terrain and log every strength change.

usage: sudo -n python3 duel.py <pid> <aKind> <bKind> <terrainName> <secs> [aFace] [bFace]

- picks the first blue piece of kind A and first red of kind B
- finds the terrain cell farthest from every other live piece (isolation: no third shooter)
- places A there and B adjacent on the same terrain, writes 0x836, clears orders
- resets both strengths to 100 (the value the game itself writes at turn start)
- logs each strength change with the pieces that had that piece as their target
"""
import sys
import time

sys.path.insert(0, __import__("os").path.dirname(__import__("os").path.abspath(__file__)))
from cmem import CombatMem, TERRAIN, KIND, row  # noqa: E402
from fight import terrain_at  # noqa: E402

NAME2ID = {v: k for k, v in TERRAIN.items()}


def isolated_cell(want, pts):
    best = (-1, 0, 0)
    for y in range(10, 126):
        for x in range(5, 316):
            if terrain_at(x, y) != want:
                continue
            d = min(min(abs(x - px), 320 - abs(x - px)) + abs(y - py) for px, py in pts)
            if d > best[0]:
                best = (d, x, y)
    return best[1], best[2]


def main():
    pid = int(sys.argv[1])
    aKind, bKind = int(sys.argv[2]), int(sys.argv[3])
    want = NAME2ID[sys.argv[4]]
    secs = float(sys.argv[5])
    aFace = int(sys.argv[6]) if len(sys.argv) > 6 else None
    bFace = int(sys.argv[7]) if len(sys.argv) > 7 else None

    g = CombatMem(pid)
    g.clear_film()
    blue = [p for p in g.pieces() if p["side"] == "blue" and p["kind"] == aKind]
    red = [p for p in g.pieces() if p["side"] == "red" and p["kind"] == bKind]
    if not blue or not red:
        raise SystemExit(f"no pair blue k{aKind} red k{bKind}")
    A, B = blue[0], red[-1]
    pts = [(p["x"], p["y"]) for p in g.pieces() if p["i"] not in (A["i"], B["i"])]
    tx, ty = isolated_cell(want, pts)
    bx, by = tx + 1, ty
    if terrain_at(bx, by) != want:
        bx, by = tx, ty + 1
    for i, x, y in ((A["i"], tx, ty), (B["i"], bx, by)):
        g.set_u16(0x1B6 + i * 2, x)
        g.set_u8(0x286 + i, y)
        # order target = current cell, or the pass sees an outstanding order, sets flags 0x40
        # and un-entrenches the piece (decompiled.c 4520-4525)
        g.set_u16(0x96E + i * 2, x)
        g.set_u8(0xA3E + i, y)
        g.set_u8(0x836 + i, terrain_at(x, y))
        g.set_u8(0xC46 + i, g.u8(0xC46 + i) & ~0x40)
        g.set_u8(0x89E + i, 100)
        g.set_u8(0xBDE + i, 0xFF)
    if aFace is not None:
        g.set_u8(0x7CE + A["i"], aFace)
    if bFace is not None:
        g.set_u8(0x7CE + B["i"], bFace)
    print(f"A = piece {A['i']} blue k{aKind} at ({tx},{ty}) {TERRAIN[want]}")
    print(f"B = piece {B['i']} red  k{bKind} at ({bx},{by}) {terrain_at(bx,by)}")
    print(f"nearest other piece: {min(min(abs(tx-px),320-abs(tx-px))+abs(ty-py) for px,py in pts)} cells")

    prev = {p["i"]: p["strength"] for p in g.pieces()}
    t0 = time.time()
    tl = g.u16(0x157E)
    shots = 0
    while time.time() - t0 < secs:
        time.sleep(0.06)
        cur = {p["i"]: p["strength"] for p in g.pieces()}
        for i, s in cur.items():
            if i in prev and prev[i] != s:
                st = g.u8(0x906 + i)
                who = [j for j in cur if g.u8(0xBDE + j) == i]
                extra = " ".join(f"->{j}(k{g.u8(0x906+j)&0xf},face{g.u8(0x7CE+j)})" for j in who)
                print(f"{time.time()-t0:6.2f}  piece {i:3d} {'blue' if st&0x40 else 'red ':4s} "
                      f"k{st&0xf}  {prev[i]:3d} -> {s:3d}   dmg {prev[i]-s:3d}   {extra}")
                shots += 1
        prev = cur
        now = g.u16(0x157E)
        if now > tl + 1000:
            print(f"-- round boundary t+{time.time()-t0:.1f}s")
            tl = now
    print(f"{shots} strength changes\nA: {row(g.piece(A['i']))}\nB: {row(g.piece(B['i']))}")


if __name__ == "__main__":
    main()
