#!/usr/bin/env python3
"""T-016 Q5: cells per pass on plain vs forest vs mountain, in the original.

Same harness as T-008's q33_cross.py: teleport one live land piece onto a straight
corridor, write the walker order (dest + start), run the pass, and log every cell
change with the pass cursor (DS:0x147c) and the round clock (DS:0x157e).

usage: sudo -n python3 t016_q5.py <pid> <unitIdx> <speed> <seconds> <x> <y> <dx> <dy> <run>
"""
import struct
import sys
import time

sys.path.insert(0, "/home/gumbyender/agents/game/notes/t008")
from speed_rate import GameMem  # noqa: E402

TMAP = "/mnt/nas/Projects/Command HQ/modern/extracted/data/tmap.bin"
CLOCK_SEED = 0x1DDE
NAMES = {8: "plain", 9: "forest", 10: "mountain", 11: "desert", 12: "jungle", 13: "polar"}


def terrain(buf, x, y):
    if not (0 <= y <= 135):
        return 99
    x %= 320
    b = buf[y * 0xA2 + (x >> 1)]
    return (b >> 4) if (x & 1) == 0 else (b & 0xF)


def main():
    pid, i, speed, secs = (int(sys.argv[1]), int(sys.argv[2]),
                           int(sys.argv[3]), float(sys.argv[4]))
    x, y, dx, dy, run = (int(sys.argv[5]), int(sys.argv[6]), int(sys.argv[7]),
                         int(sys.argv[8]), int(sys.argv[9]))
    g = GameMem(pid)
    buf = open(TMAP, "rb").read()

    st = g.u8(0x906 + i)
    kind, owner = st & 0xF, st & 0xC0
    if owner != 0x40 or kind >= 5:
        print(f"REFUSED: idx {i} status 0x{st:02x} is not a blue land piece")
        return 2

    path = [(x + dx * d, y + dy * d) for d in range(0, run + 1)]
    classes = [(p, terrain(buf, p[0], p[1])) for p in path]
    print(f"idx {i} kind {kind} owner 0x{owner:02x} speed {speed}")
    print("intended leg:", " ".join(f"{p}:{c}" for p, c in classes))
    legs = {c for _, c in classes[1:]}
    print("terrain set on the leg:", {NAMES.get(c, c) for c in legs})

    tx, ty = path[-1]
    g.set_u16(0x1B6 + i * 2, x)
    g.mem.seek(g.base + 0x286 + i); g.mem.write(bytes([y]))
    g.set_u16(0x2EE + i * 2, x)
    g.mem.seek(g.base + 0x3BE + i); g.mem.write(bytes([y]))
    g.set_u16(0x96E + i * 2, tx)
    g.mem.seek(g.base + 0xA3E + i); g.mem.write(bytes([ty]))
    g.set_u16(0x426 + i * 2, tx)
    g.mem.seek(g.base + 0x4F6 + i); g.mem.write(bytes([ty]))
    g.set_u16(0xC700, speed)
    g.set_u16(0xC8CC, 0)
    g.set_u16(0x1478, 0)
    g.set_u16(0x157E, CLOCK_SEED)

    def pts():
        g.mem.seek(g.base + 0x6FE + i * 2)
        return struct.unpack("<i", g.mem.read(4))[0]

    print(f"speed byte read back: {g.speed}")
    print(f"teleported to ({x},{y}) terr {terrain(buf, x, y)} -> ({tx},{ty}) run {run} pts0 {pts()}")

    t0 = time.time()
    last = (g.u16(0x1B6 + i * 2), g.u8(0x286 + i))
    cursor = g.u16(0x147C)
    wraps = 0
    steps = []
    reached = False
    while time.time() - t0 < secs:
        c = g.u16(0x147C)
        if c < cursor:
            wraps += 1
        cursor = c
        p = (g.u16(0x1B6 + i * 2), g.u8(0x286 + i))
        if p != last:
            steps.append((round(time.time() - t0, 2), wraps, p,
                          terrain(buf, p[0], p[1]), pts(), g.u16(0x157E)))
            last = p
            if p == (tx, ty):
                reached = True
                break
        if g.u16(0x157E) in (0xFFFF, 0):
            break
        time.sleep(0.005)

    cells = len(steps)
    print(f"  cells {cells} wraps {wraps} reached_target {reached} pts_now {pts()} wall {time.time()-t0:.1f}s")
    for s in steps:
        print("   t=%.2f pass=%d pos=%s terr=%s pts=%d clock=%d" %
              (s[0], s[1], s[2], NAMES.get(s[3], s[3]), s[4], s[5]))
    if cells and wraps:
        print(f"  Q5 RESULT: {cells} cells / {wraps} pass-wraps = {cells/wraps:.2f} cells/pass")
        clk0 = steps[0][5]
        clk1 = steps[-1][5]
        rounds = (CLOCK_SEED - clk1) / 7646.0
        if rounds > 0:
            print(f"  Q5 RESULT: {cells} cells in {rounds:.3f} rounds = {cells/rounds:.2f} cells/round")
    return 0


if __name__ == "__main__":
    sys.exit(main())
