#!/usr/bin/env python3
"""T-009 live legs on the running 1942 board: repair, attrition by terrain, sea range.

The per-piece pass (FUN_15f4_0002 @ 15f4:0002) is what calls the combat, attrition and repair
handlers, so every measurement here is per pass. 0x147e counts passes.

usage: sudo -n python3 t009_probe.py <pid> find
       sudo -n python3 t009_probe.py <pid> repair <idx> <secs>
       sudo -n python3 t009_probe.py <pid> attrition <idx> <terrain> <secs>
       sudo -n python3 t009_probe.py <pid> range <seaIdx> <landIdx> <cells> <secs>
"""
import struct
import sys
import time

sys.path.insert(0, __import__("os").path.dirname(__import__("os").path.abspath(__file__)))
from speed_rate import GameMem  # noqa: E402

TMAP = "/mnt/nas/Projects/Command HQ/modern/extracted/data/tmap.bin"
TNAMES = ["ocean", "docks", "ocean2", "lake", "capital", "base", "city", "oilfield",
          "plain", "forest", "mountain", "desert", "jungle", "polar", "wasteland"]


def terr(buf, x, y):
    if not (0 <= y <= 135):
        return 99
    x %= 320
    b = buf[y * 0xA2 + (x >> 1)]
    return (b >> 4) if (x & 1) == 0 else (b & 0xF)


class Probe:
    def __init__(self, pid):
        self.g = GameMem(pid)
        self.buf = open(TMAP, "rb").read()

    def w8(self, off, i, v):
        self.g.mem.seek(self.g.base + off + i)
        self.g.mem.write(bytes([v & 0xFF]))

    def w16(self, off, i, v):
        self.g.mem.seek(self.g.base + off + i * 2)
        self.g.mem.write(struct.pack("<H", v & 0xFFFF))

    def r16(self, off, i):
        return self.g.u16(off + i * 2)

    def place(self, i, x, y, face=0):
        """Teleport a piece and stop it dead.

        0x1b6/0x2ee/0x426/0x96e/0x55e are PACKED words (x << 8 | y); the y byte of each pair
        lives one array over (0x286, 0x3be, 0x4f6, 0xa3e, 0x62e). Writing the bare x into the
        word leaves y = 0 and the piece reads as sitting on row 0.
        """
        packed = ((x & 0xFF) << 8) | (y & 0xFF)
        for wo, bo in ((0x1B6, 0x286), (0x2EE, 0x3BE), (0x426, 0x4F6),
                       (0x96E, 0xA3E), (0x55E, 0x62E)):
            self.w16(wo, i, packed)
            self.w8(bo, i, y)
        self.w8(0x7CE, i, face)
        self.w8(0xD16, i, 0)

    def sites(self):
        out = []
        for s in range(84):
            x = self.r16(0x0F5E, s)
            y = self.g.u8(0x1006 + s)
            t = self.g.u8(0x1102 + s)
            out.append((s, x, y, t))
        return out

    def site_at(self, x, y):
        for (s, sx, sy, t) in self.sites():
            if sx == x and sy == y and (t & 0x1F):
                return (s, t)
        return None


def find(p):
    g = p.g
    print("live pieces (idx kind owner strength x y terrain):")
    for i in range(100):
        st = g.u8(0x906 + i)
        if st == 0:
            continue
        x, y = p.r16(0x1B6, i), g.u8(0x286 + i)
        print(f"  {i:3d} kind {st & 0xf} own 0x{st & 0xc0:02x} str {g.u8(0x89e + i):3d} "
              f"({x},{y}) {TNAMES[terr(p.buf, x, y)] if terr(p.buf, x, y) < 15 else '?'}")
    print("\nblue-owned cities/bases (terrain byte under the site):")
    for (s, x, y, t) in p.sites():
        if (t & 0xC0) == 0x40 and (t & 7) in (3, 4):
            print(f"  site {s:2d} ({x},{y}) typebyte 0x{t:02x} terrain {TNAMES[terr(p.buf, x, y)]}")


def _watch(p, idx, secs, label, was_repair):
    g = p.g
    t0 = time.time()
    strong = g.u8(0x89E + idx)
    cursor = g.u16(0x147C)
    wraps = 0
    print(f"  t0 strength={strong} cursor={cursor} clock={g.u16(0x157E)}")
    last = strong
    while time.time() - t0 < secs:
        c = g.u16(0x147C)
        if c < cursor:
            wraps += 1
        cursor = c
        s = g.u8(0x89E + idx)
        if s != last:
            print(f"  t={time.time()-t0:5.2f} {last} -> {s} (delta {s-last:+d}) "
                  f"pass_wraps={wraps} cursor={c} clock={g.u16(0x157E)}")
            last = s
        if s == 0 or (was_repair and s >= 100):
            break
        time.sleep(0.008)
    print(f"  END {label} strength={g.u8(0x89E+idx)} pass_wraps={wraps} "
          f"wall={time.time()-t0:.1f}s status=0x{g.u8(0x906+idx):02x}")


def repair(p, idx, secs):
    g = p.g
    kind = g.u8(0x906 + idx) & 0xF
    x, y = p.r16(0x1B6, idx), g.u8(0x286 + idx)
    print(f"repair leg: idx {idx} kind {kind} at ({x},{y}) terrain {TNAMES[terr(p.buf, x, y)]} "
          f"site {p.site_at(x, y)}")
    p.w8(0xBDE, idx, 0xFF)
    p.w8(0x89E, idx, 40)
    _watch(p, idx, secs, "repair", True)


def attrition(p, idx, want, secs):
    g = p.g
    # find an open cell of that terrain with no site on it
    spot = None
    for y in range(2, 134):
        for x in range(0, 320):
            if terr(p.buf, x, y) != want:
                continue
            if p.site_at(x, y) or p.site_at((x + 1) % 320, y) or p.site_at((x - 1) % 320, y):
                continue
            spot = (x, y)
            break
        if spot:
            break
    if not spot:
        print(f"no open {TNAMES[want]} cell")
        return 1
    x, y = spot
    kind = g.u8(0x906 + idx) & 0xF
    if kind >= 5:
        print(f"REFUSED: idx {idx} kind {kind} is not a land piece")
        return 2
    p.place(idx, x, y)
    p.w8(0xBDE, idx, 0xFF)
    p.w8(0x89E, idx, 100)
    p.w8(0xC46, idx, 0x20)
    print(f"attrition leg: idx {idx} kind {kind} on {TNAMES[want]} at ({x},{y}) "
          f"nosite={p.site_at(x,y) is None}")
    _watch(p, idx, secs, "attrition", False)


def range_leg(p, sea, land, cells, secs):
    g = p.g
    ks = g.u8(0x906 + sea) & 0xF
    kl = g.u8(0x906 + land) & 0xF
    if ks < 5 or kl >= 5:
        print(f"REFUSED: idx {sea} kind {ks} (need sea), idx {land} kind {kl} (need land)")
        return 2
    # put the land piece on open plains, the ship `cells` to its left on water
    spot = None
    for y in range(4, 132):
        for x in range(4, 316):
            if terr(p.buf, x, y) != 8 or p.site_at(x, y):
                continue
            if all(terr(p.buf, x - d, y) in (0, 2) for d in range(1, cells + 1)):
                spot = (x, y)
                break
        if spot:
            break
    if not spot:
        print("no coast cell found")
        return 1
    x, y = spot
    p.place(land, x, y)
    p.place(sea, x - cells, y, face=4)
    p.w8(0x89E, land, 100)
    p.w8(0x89E, sea, 100)
    p.w8(0xC46, sea, 0x20)
    p.w8(0xC46, land, 0x20)
    p.w8(0xBDE, land, 0xFF)
    p.w8(0xBDE, sea, 0xFF)
    print(f"range leg: ship idx {sea} kind {ks} at ({x-cells},{y}) "
          f"{TNAMES[terr(p.buf,x-cells,y)]}, land idx {land} kind {kl} at ({x},{y}) plains, "
          f"{cells} cells apart")
    t0 = time.time()
    target_hits = 0
    lastl, lasts = g.u8(0x89E + land), g.u8(0x89E + sea)
    while time.time() - t0 < secs:
        l, s_ = g.u8(0x89E + land), g.u8(0x89E + sea)
        if l != lastl:
            target_hits += 1
            print(f"  t={time.time()-t0:5.2f} land strength {lastl} -> {l} "
                  f"link_ship={g.u8(0xBDE+sea)} dist2={dx2(p,sea,land)}")
            lastl = l
        if s_ != lasts:
            print(f"  t={time.time()-t0:5.2f} SHIP took damage {lasts} -> {s_} (not expected)")
            lasts = s_
        time.sleep(0.008)
    print(f"  END land_hits={target_hits} land={g.u8(0x89E+land)} ship={g.u8(0x89E+sea)} "
          f"ship_link={g.u8(0xBDE+sea)}")


def dx2(p, a, b):
    ax, ay = p.r16(0x1B6, a), p.g.u8(0x286 + a)
    bx, by = p.r16(0x1B6, b), p.g.u8(0x286 + b)
    dx = abs(ax - bx)
    dx = min(dx, 320 - dx)
    return dx * dx + (ay - by) ** 2


def main():
    pid, verb = int(sys.argv[1]), sys.argv[2]
    p = Probe(pid)
    if verb == "find":
        find(p)
    elif verb == "repair":
        repair(p, int(sys.argv[3]), float(sys.argv[4]))
    elif verb == "attrition":
        sys.exit(attrition(p, int(sys.argv[3]), int(sys.argv[4]), float(sys.argv[5])))
    elif verb == "range":
        sys.exit(range_leg(p, int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5]),
                           float(sys.argv[6])))
    return 0


if __name__ == "__main__":
    sys.exit(main() or 0)
