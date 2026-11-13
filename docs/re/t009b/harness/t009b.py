#!/usr/bin/env python3
"""T-009b live combat legs against the running original (DOSBox, CHQ.EXE).

Every leg pins position + terrain byte + target link each 60 ms so the pass
cannot walk the pieces out of the experiment, and logs every strength delta
with the pieces that pointed at the victim.

usage:
  t009b.py <pid> flank    <secs> <repeats>
  t009b.py <pid> entrench <secs>
  t009b.py <pid> cover    <secs> <repeats>
  t009b.py <pid> attrition <terrain> <secs> [startStr]
  t009b.py <pid> militia  <enemy|unowned|own> <secs>
  t009b.py <pid> range    <aKind> <bKind> <maxDx> <secs>
"""
import sys
import time

sys.path.insert(0, __import__("os").path.dirname(__import__("os").path.abspath(__file__)))
from t009_probe import Probe, TNAMES, terr            # noqa: E402
from duel import isolated_cell, NAME2ID               # noqa: E402
from cmem import KIND, row, CombatMem                            # noqa: E402

BLUE, RED = 0x40, 0x80


def d2(ax, ay, bx, by):
    dx = abs(ax - bx)
    dx = min(dx, 320 - dx)
    return dx * dx + (ay - by) ** 2


class H(Probe):
    def __init__(self, pid):
        self.g = CombatMem(pid)
        self.buf = open("/mnt/nas/Projects/Command HQ/modern/extracted/data/tmap.bin", "rb").read()

    # --- writers -------------------------------------------------------
    def w32(self, off, i, v):
        self.g.mem.seek(self.g.base + off + i * 2)
        self.g.mem.write(int(v & 0xFFFFFFFF).to_bytes(4, "little"))

    def place(self, i, x, y, kind=None, own=None, face=None, strength=100,
              target=0xFF, tb=None, flags=0x20, zero_pts=True):
        for wo, bo in ((0x1B6, 0x286), (0x2EE, 0x3BE), (0x426, 0x4F6),
                       (0x96E, 0xA3E), (0x55E, 0x62E)):
            self.w16(wo, i, x)
            self.w8(bo, i, y)
        st = self.g.u8(0x906 + i)
        k = kind if kind is not None else st & 0xF
        o = own if own is not None else st & 0xC0
        self.w8(0x906, i, o | k)
        if tb is not None:
            self.w8(0x836, i, tb)
        if face is not None:
            self.w8(0x7CE, i, face)
        self.w8(0x89E, i, strength)
        self.w8(0xBDE, i, target)
        self.w8(0xC46, i, flags)
        self.w8(0xD16, i, 0)
        if zero_pts:
            self.w32(0x6FE, i, 0)

    def hold(self, i, x, y, face=None, target=None, tb=None, zero_pts=True):
        """Re-pin a piece without touching its strength."""
        for wo, bo in ((0x1B6, 0x286), (0x2EE, 0x3BE), (0x426, 0x4F6),
                       (0x96E, 0xA3E), (0x55E, 0x62E)):
            self.w16(wo, i, x)
            self.w8(bo, i, y)
        if tb is not None:
            self.w8(0x836, i, tb)
        if face is not None:
            self.w8(0x7CE, i, face)
        if target is not None:
            self.w8(0xBDE, i, target)
        if zero_pts:
            self.w32(0x6FE, i, 0)

    def S(self, i):
        return self.g.u8(0x89E + i)

    def live(self):
        return [i for i in range(100) if self.g.u8(0x906 + i)]

    # --- observer ------------------------------------------------------
    def watch(self, ids, secs, hold=None, tag=""):
        ids = set(ids)
        prev = {i: self.S(i) for i in self.live()}
        t0 = time.time()
        events = []
        while time.time() - t0 < secs:
            time.sleep(0.06)
            if hold:
                hold()
            cur = {i: self.S(i) for i in self.live()}
            for i, s in cur.items():
                if i in prev and prev[i] != s:
                    st = self.g.u8(0x906 + i)
                    x, y = self.r16(0x1B6, i), self.g.u8(0x286 + i)
                    who = []
                    for j in cur:
                        if j == i or self.g.u8(0xBDE + j) != i:
                            continue
                        jx, jy = self.r16(0x1B6, j), self.g.u8(0x286 + j)
                        who.append(f"{j}(k{self.g.u8(0x906+j)&0xf},"
                                   f"f{self.g.u8(0x7CE+j)},d2={d2(jx,jy,x,y)})")
                    mark = "*" if i in ids else " "
                    print(f"{tag}{time.time()-t0:6.2f} {mark} piece {i:3d} "
                          f"{'blue' if st & 0x40 else 'red ':4s} k{st & 0xf} "
                          f"{prev[i]:3d}->{s:3d} dmg {prev[i]-s:3d}  "
                          f"tb={self.g.u8(0x836+i)} {TNAMES[terr(self.buf, x, y)]} "
                          f"({x},{y})  hit-by: {' '.join(who) or '-'}  "
                          f"tgt={self.g.u8(0xBDE+i)}")
                    events.append((i, prev[i], s, who))
            prev = cur
        return events


def pick(h, side, kind, exclude=()):
    for i in h.live():
        st = h.g.u8(0x906 + i)
        if (st & 0xC0) == side and (st & 0xF) == kind and i not in exclude:
            return i
    raise SystemExit(f"no piece side 0x{side:02x} kind {kind}")


# ----------------------------------------------------------------------
def leg_flank(h, secs, repeats, face_override=None):
    D = pick(h, BLUE, 3)
    T = pick(h, RED, 3, exclude=(D,))
    A = pick(h, RED, 2, exclude=(D, T))
    pts = [(h.r16(0x1B6, i), h.g.u8(0x286 + i)) for i in h.live()
           if i not in (D, T, A)]
    x, y = isolated_cell(NAME2ID["plain"], pts)
    print(f"FLANK  D={D} blue k3 at ({x},{y})  T={T} red k3 at ({x},{y-1})  "
          f"A={A} red k2 at ({x-2},{y})  attacker faces E, defender faces N "
          f"=> 20 x 1.5 = 30 expected")
    for r in range(repeats):
        h.place(D, x, y, tb=8, strength=100, target=T, flags=0x20)
        h.place(T, x, y - 1, tb=8, strength=100, target=0xFF, flags=0x20)
        h.place(A, x - 2, y, tb=8, strength=100, target=0xFF, flags=0x20)

        def hold():
            h.hold(D, x, y, target=T, tb=8)
            h.hold(T, x, y - 1, tb=8)
            h.hold(A, x - 2, y, tb=8)
        print(f"\n-- repeat {r+1}")
        h.watch([D, T, A], secs, hold=hold, tag="  ")
        print("   state:", "D", row(h.g.piece(D)), "\n         A", row(h.g.piece(A)),
              "\n         T", row(h.g.piece(T)))


def leg_entrench(h, secs):
    I = pick(h, RED, 3)
    T = pick(h, BLUE, 2, exclude=(I,))
    pts = [(h.r16(0x1B6, i), h.g.u8(0x286 + i)) for i in h.live() if i not in (I, T)]
    x, y = isolated_cell(NAME2ID["plain"], pts)
    print(f"ENTRENCH  I={I} red infantry  T={T} blue k2 tank  cell ({x},{y})")
    # phase 1: kind 1 (unentrenched), target pinned to the tank -> cannot entrench
    h.place(I, x + 1, y, kind=1, tb=8, strength=100, target=T, flags=0x20)
    h.place(T, x, y, tb=8, strength=100, target=0xFF, flags=0x20)
    print(f"  phase 1: kind 1, I.str=100, front (T faces E, I faces W). expect 26")

    def hold1():
        h.w8(0x906, I, (h.g.u8(0x906 + I) & 0xF0) | 1)
        h.hold(I, x + 1, y, target=T, tb=8)
        h.hold(T, x, y, tb=8)
    h.watch([I, T], secs, hold=hold1, tag="  ")
    print("  state:", row(h.g.piece(I)))
    # phase 2: strip the target and let it entrench on plain (0x1996 bit 0x20)
    h.hold(T, x + 60, y, tb=8)
    h.w8(0xBDE, I, 0xFF)
    h.w8(0xC46, I, 0x20)
    print("  phase 2: tank withdrawn, I target cleared -> wait for kind 1->3")
    t0 = time.time()
    while time.time() - t0 < 30:
        if (h.g.u8(0x906 + I) & 0xF) == 3:
            print(f"    entrenched at t+{time.time()-t0:.1f}s: status 0x{h.g.u8(0x906+I):02x}")
            break
        time.sleep(0.05)
    else:
        print("    NOT entrenched in 30s; status 0x%02x" % h.g.u8(0x906 + I))
        return
    # phase 3: same attacker back, same geometry, expect 20
    h.place(T, x, y, tb=8, strength=100, target=0xFF, flags=0x20)
    h.place(I, x + 1, y, kind=3, tb=8, strength=100, target=T, flags=0x20)
    print("  phase 3: same tank, same cell, defender now kind 3. expect 20")

    def hold3():
        h.w8(0x906, I, (h.g.u8(0x906 + I) & 0xF0) | 3)
        h.hold(I, x + 1, y, target=T, tb=8)
        h.hold(T, x, y, tb=8)
    h.watch([I, T], secs, hold=hold3, tag="  ")
    print("  state:", row(h.g.piece(I)))


def leg_cover(h, secs, repeats):
    # defender already carrying a city terrain byte (0x836 == 6) on its own site
    D = None
    for i in h.live():
        st = h.g.u8(0x906 + i)
        if (st & 0xC0) != BLUE or (st & 0xF) != 3 or h.g.u8(0x836 + i) != 6:
            continue
        x, y = h.r16(0x1B6, i), h.g.u8(0x286 + i)
        site = h.site_at(x, y)
        if site and (site[1] & 0xC0) == BLUE:
            D = i
            break
    if D is None:
        raise SystemExit("no blue k3 on an own city terrain byte")
    dx, dy = h.r16(0x1B6, D), h.g.u8(0x286 + D)
    A = pick(h, RED, 2, exclude=(D,))
    # adjacent cell with no site
    ax, ay = None, None
    for ox, oy in ((1, 0), (0, 1), (-1, 0), (0, -1)):
        if not h.site_at(dx + ox, dy + oy) and terr(h.buf, dx + ox, dy + oy) != 0:
            ax, ay = dx + ox, dy + oy
            break
    if ax is None:
        raise SystemExit("no free adjacent cell")
    print(f"COVER  D={D} blue k3 on city byte 6 at ({dx},{dy}) site {h.site_at(dx,dy)} "
          f" A={A} red k2 at ({ax},{ay})")
    for r in range(repeats):
        h.place(D, dx, dy, tb=6, strength=100, target=A, flags=0x20)
        h.place(A, ax, ay, tb=terr(h.buf, ax, ay), strength=100, target=0xFF, flags=0x20)

        def hold():
            h.hold(D, dx, dy, target=A, tb=6)
            h.hold(A, ax, ay, tb=terr(h.buf, ax, ay))
        print(f"\n-- city repeat {r+1} (expect 20 - (20+1)/3 = 13)")
        h.watch([D, A], secs, hold=hold, tag="  ")
    # control: same pairing on open plain, defender byte 8
    px, py = isolated_cell(NAME2ID["plain"],
                           [(h.r16(0x1B6, i), h.g.u8(0x286 + i)) for i in h.live()
                            if i not in (D, A)])
    print(f"\n-- open ground control at ({px},{py}) (expect 20)")
    h.place(D, px, py, tb=8, strength=100, target=A, flags=0x20)
    h.place(A, px + 1, py, tb=8, strength=100, target=0xFF, flags=0x20)

    def hold2():
        h.hold(D, px, py, target=A, tb=8)
        h.hold(A, px + 1, py, tb=8)
    h.watch([D, A], secs, hold=hold2, tag="  ")


def leg_attrition(h, terrain_name, secs, start=100):
    want = NAME2ID[terrain_name]
    P = pick(h, BLUE, 3)
    pts = [(h.r16(0x1B6, i), h.g.u8(0x286 + i)) for i in h.live() if i != P]
    x, y = isolated_cell(want, pts)
    if h.site_at(x, y):
        raise SystemExit(f"isolated {terrain_name} cell ({x},{y}) carries a site")
    h.place(P, x, y, tb=terr(h.buf, x, y), strength=start, target=0xFF, flags=0x20)
    print(f"ATTRITION {terrain_name}: P={P} blue k3 at ({x},{y}) tmap={terr(h.buf,x,y)} "
          f"0x836={terr(h.buf,x,y)} start={start} no site, no target")

    def hold():
        h.hold(P, x, y, target=0xFF, tb=terr(h.buf, x, y))
    h.watch([P], secs, hold=hold, tag="  ")


def _sites_by(h, want_owner):
    out = []
    for (s, x, y, t) in h.sites():
        if not (t & 0x3F):
            continue
        if (t & 0xC0) == want_owner:
            out.append((s, x, y, t, terr(h.buf, x, y)))
    return out


def leg_militia(h, mode, secs):
    P = pick(h, BLUE, 3)
    if mode == "enemy":
        cand = _sites_by(h, RED)
        target_owner = RED
    elif mode == "unowned":
        cand = _sites_by(h, 0)
        target_owner = 0
    else:
        cand = _sites_by(h, BLUE)
        target_owner = BLUE
    if not cand:
        raise SystemExit(f"no {mode} site")
    # prefer a land cell
    s, x, y, t, tt = cand[0]
    for c in cand:
        if terr(h.buf, c[1], c[2]) not in (0, 2):
            s, x, y, t, tt = c
            break
    h.place(P, x, y, tb=h.g.u8(0x836 + P), strength=100, target=0xFF, flags=0x20)
    print(f"MILITIA {mode}: P={P} blue k3 on site {s} ({x},{y}) type 0x{t:02x} "
          f"owner 0x{t & 0xc0:02x} tmap={TNAMES[tt]}  start strength 100")
    out = []

    def hold():
        h.hold(P, x, y, target=0xFF)
    out = h.watch([P], secs, hold=hold, tag="  ")
    print(f"  move points read: {h.r16(0x1B6,0) and h.g.u8(0x906+P)} "
          f"c46=0x{h.g.u8(0xC46+P):02x} pts16={h.r16(0x6FE, P)}")
    return out


def leg_range(h, aKind, bKind, maxDx, secs):
    A = pick(h, BLUE, aKind)
    B = pick(h, RED, bKind, exclude=(A,))
    pts = [(h.r16(0x1B6, i), h.g.u8(0x286 + i)) for i in h.live() if i not in (A, B)]
    # an open-water cell with `maxDx` water cells to its east
    spot = None
    for yy in range(4, 132):
        for xx in range(4, 316 - maxDx):
            if terr(h.buf, xx, yy) not in (0, 2):
                continue
            if h.site_at(xx, yy):
                continue
            if all(terr(h.buf, xx + d, yy) in (0, 2) and not h.site_at(xx + d, yy)
                   for d in range(1, maxDx + 1)):
                spot = (xx, yy)
                break
        if spot:
            break
    if not spot:
        raise SystemExit("no open-water lane")
    x, y = spot
    print(f"RANGE shooter {A} blue k{aKind} vs target {B} red k{bKind} at ({x},{y})")
    for dx in range(1, maxDx + 1):
        h.place(A, x, y, tb=terr(h.buf, x, y), strength=100, target=0xFF, flags=0x20)
        h.place(B, x + dx, y, tb=terr(h.buf, x + dx, y), strength=100, target=0xFF, flags=0x20)
        shot = {"a": 0, "b": 0}
        pa, pb = 100, 100

        t0 = time.time()
        while time.time() - t0 < secs:
            time.sleep(0.03)
            h.hold(A, x, y, tb=terr(h.buf, x, y))
            h.hold(B, x + dx, y, tb=terr(h.buf, x + dx, y))
            na, nb = h.S(A), h.S(B)
            if nb < pb:
                print(f"  dx={dx} d2={dx*dx}: TARGET B {pb}->{nb} (dmg {pb-nb}) "
                      f"linkA={h.g.u8(0xBDE+A)} linkB={h.g.u8(0xBDE+B)}")
                shot["b"] += 1
            if na < pa:
                print(f"  dx={dx} d2={dx*dx}: SHOOTER A {pa}->{na} (return fire {pa-na})")
                shot["a"] += 1
            pa, pb = na, nb
        print(f"  dx={dx} d2={dx*dx} result: target hits={shot['b']} return={shot['a']}")


def main():
    pid = int(sys.argv[1])
    h = H(pid)
    verb = sys.argv[2]
    if verb == "flank":
        leg_flank(h, float(sys.argv[3]), int(sys.argv[4]))
    elif verb == "entrench":
        leg_entrench(h, float(sys.argv[3]))
    elif verb == "cover":
        leg_cover(h, float(sys.argv[3]), int(sys.argv[4]))
    elif verb == "attrition":
        leg_attrition(h, sys.argv[3], float(sys.argv[4]),
                      int(sys.argv[5]) if len(sys.argv) > 5 else 100)
    elif verb == "militia":
        leg_militia(h, sys.argv[3], float(sys.argv[4]))
    elif verb == "range":
        leg_range(h, int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5]), float(sys.argv[6]))
    else:
        raise SystemExit("verb?")


if __name__ == "__main__":
    main()
