#!/usr/bin/env python3
"""T-009b AC5: resolve an air strike by enqueueing the game's own event.

The original resolves an air strike in FUN_1ac5_0dbe(record) where record is the
5-byte event the map-click handler (FUN_1ac5_0390) pushes with
FUN_1eb5_000c(7, aircraft|xhi, targetPiece, xlo, y). The ring is 40 bytes at
0xEFBC, write pointer 0xE940, read pointer 0xE42A.

usage: air.py <pid> land|ship34|ship25 <secs> [repeats]
"""
import sys
import time

sys.path.insert(0, __import__("os").path.dirname(__import__("os").path.abspath(__file__)))
from t009b import H, BLUE, RED, pick, terr, row, d2   # noqa: E402

RING = 0xEFBC
RINGSZ = 0x28
WP = 0xE940
RP = 0xE42A


def enqueue(g, code, b1, b2, b3, b4):
    wp = g.u16(WP) % RINGSZ
    for k, v in enumerate((code, b1, b2, b3, b4)):
        g.mem.seek(g.base + RING + ((wp + k) % RINGSZ))
        g.mem.write(bytes([v & 0xFF]))
    g.set_u16(WP, (wp + 5) % RINGSZ)


def main():
    h = H(int(sys.argv[1]))
    g = h.g
    mode = sys.argv[2]
    secs = float(sys.argv[3])
    reps = int(sys.argv[4]) if len(sys.argv) > 4 else 2
    side = g.u16(0xE978)
    owner = 0x40 if side == 0 else 0x80
    print(f"side-to-move *0xe978={side} -> aircraft owner 0x{owner:02x}; "
          f"write ptr={g.u16(WP)} read ptr={g.u16(RP)}")
    # first aircraft record of the striking side with ammo/countdown clear
    air = None
    for i in range(30):
        st = g.u8(0x1364 + i)
        if (st & 0xC0) == owner:
            air = i
            break
    if air is None:
        raise SystemExit("no aircraft for the side to move")
    print(f"aircraft record {air}: status 0x{g.u8(0x1364+air):02x} "
          f"pos ({g.u16(0x130a+air*2)},{g.u8(0x1346+air)}) "
          f"target 0x{g.u8(0x1382+air):02x} cd={g.u8(0x13a0+air)}")

    if mode == "land":
        T = pick(h, BLUE, 2)            # land: (str>>1)+1
        expect = "26 from 100 (s>>1)+1"
    elif mode == "ship34":
        T = pick(h, BLUE, 7)            # kinds 5-7: 34
        expect = "34"
    elif mode == "ship25":
        T = pick(h, BLUE, 8)            # kinds 8/9: 25
        expect = "25"
    else:
        raise SystemExit("mode?")
    x, y = h.r16(0x1B6, T), g.u8(0x286 + T)
    print(f"target piece {T} kind {g.u8(0x906+T)&0xf} at ({x},{y}) expect {expect}")

    for r in range(reps):
        h.w8(0x89E, T, 100)
        h.w8(0xBDE, T, 0xFF)
        g.set_u16(0x130a + air * 2, x & 0x1FF)
        g.mem.seek(g.base + 0x1346 + air); g.mem.write(bytes([y & 0xFF]))
        g.mem.seek(g.base + 0x1382 + air); g.mem.write(bytes([T & 0xFF]))
        g.mem.seek(g.base + 0x1346 + air)
        g.mem.write(bytes([y & 0xFF]))
        g.mem.seek(g.base + 0x13a0 + air)
        g.mem.write(bytes([0]))
        b1 = air | (((x >> 8) & 1) << 7)
        enqueue(g, 7, b1, T, x & 0xFF, y & 0xFF)
        print(f"-- repeat {r+1}: queued event(7, aer={air}|xhi={b1>>7}, tgt={T}, "
              f"{x & 0xFF},{y})")
        t0 = time.time()
        prev = {i: h.S(i) for i in h.live()}
        while time.time() - t0 < secs:
            time.sleep(0.03)
            cur = {i: h.S(i) for i in h.live()}
            for i, s in cur.items():
                if i in prev and prev[i] != s:
                    tag = "*" if i == T else " "
                    print(f"  {tag} piece {i} k{g.u8(0x906+i)&0xf} {prev[i]}->{s} "
                          f"dmg {prev[i]-s}")
            prev = cur
        print(f"   target now {h.S(T)}  wp={g.u16(WP)} rp={g.u16(RP)}")


if __name__ == "__main__":
    main()
