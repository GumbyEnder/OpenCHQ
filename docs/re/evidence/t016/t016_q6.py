#!/usr/bin/env python3
"""T-016 Q6: attrition per pass on the live original, pinned to one cell.

Places a blue infantry (kind 3) on a named terrain cell and holds it there every
20 ms (position, terrain byte, target link), logging every strength change with
the pass-cursor wraps (DS:0x147c) and the round clock (DS:0x157e).

usage: sudo -n python3 t016_q6.py <pid> <x> <y> <name> <seconds>
"""
import sys
import time

sys.path.insert(0, "/home/gumbyender/agents/game/notes/t009b")
from t009b import H  # noqa: E402


def main():
    pid, x, y, name, secs = (int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3]),
                             sys.argv[4], float(sys.argv[5]))
    h = H(pid)
    g = h.g
    P = 1
    IDS = {"lake": 3, "desert": 11, "jungle": 12, "polar": 13, "wasteland": 14}
    h.place(P, x, y, tb=IDS.get(name, 0), strength=100, target=0xFF, flags=0x20)
    tb = h.g.u8(0x836 + P)
    g.set_u16(0x157E, 0x1DDE)  # keep the round clock alive for the leg
    st = g.u8(0x906 + P)
    print(f"Q6 {name}: P={P} status=0x{st:02x} kind={st & 0xF} at ({x},{y}) terrain_byte={tb} start=100")

    cursor = g.u16(0x147C)
    wraps = 0
    last = g.u8(0x89E + P)
    t0 = time.time()
    while time.time() - t0 < secs:
        c = g.u16(0x147C)
        if c < cursor:
            wraps += 1
        cursor = c
        h.hold(P, x, y, target=0xFF, tb=tb)
        s = g.u8(0x89E + P)
        if s != last:
            print("  t=%.2f wraps=%d str %d -> %d delta=%d clock=%d" %
                  (time.time() - t0, wraps, last, s, last - s, g.u16(0x157E)))
            last = s
        if g.u16(0x157E) == 0xFFFF:
            print("  round ended early at", round(time.time() - t0, 2), "s")
            break
        time.sleep(0.02)
    print(f"Q6 {name} RESULT: {100 - last} total loss in {round(time.time()-t0,1)}s over {wraps} wraps")


if __name__ == "__main__":
    sys.exit(main())
