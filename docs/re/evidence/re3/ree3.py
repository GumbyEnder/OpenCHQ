#!/usr/bin/env python3
"""RE-E3: does a capture PAY the capturer, and does the captured site take a 15-round timer?

PB-155 decoded FUN_1c0d_02ce @ 1c0d:02ce (decompiled.c 9169, 9179-9182) as: on a city/base
changing hands, 0x10ae[site] = 15 and the capturing side is paid 80 raw units (= 2 b).
The sign is the open question this probe answers: 0x148e/0x1490 cash is in 40ths of a
billion, so +2 b must read as +80 on the CAPTURER's slot and -0 on the loser's.

usage (root, /proc/<pid>/mem):
  sudo -n PYTHONPATH= /usr/bin/python3 ree3.py <pid> state
  sudo -n PYTHONPATH= /usr/bin/python3 ree3.py <pid> prep
  sudo -n PYTHONPATH= /usr/bin/python3 ree3.py <pid> capture <site_id> [seconds]

Only `prep` (the two film_mode bytes the pass needs) and `capture` (teleport one blue ground
piece to a cell beside the site, then order it onto the site) write anything.
"""
import struct
import sys
import time

H = "/mnt/nas/Projects/OpenCHQ/docs/re/t009b/harness"
sys.path.insert(0, H)
from speed_rate import GameMem  # noqa: E402

TMAP = "/mnt/nas/projects/Command HQ/modern/extracted/data/tmap.bin"
STRIDE = 0xA2
LAND = {4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14}
TYPE = {0: "absent", 1: "capital", 2: "capital", 3: "base", 4: "city", 5: "oilfield"}


def tmap_cell(x, y):
    with open(TMAP, "rb") as f:
        f.seek(y * STRIDE + x // 2)
        b = f.read(1)[0]
    return (b >> 4) if (x & 1) else (b & 0xF)


class ReE3(GameMem):
    def s16(self, off):
        self.mem.seek(self.base + off)
        return struct.unpack("<h", self.mem.read(2))[0]

    def w8(self, off, val):
        self.mem.seek(self.base + off)
        self.mem.write(bytes([val & 0xFF]))

    def cash(self, side):
        return self.s16(0x148E + (0 if side == "blue" else 1) * 2)

    def site(self, i):
        b = self.u8(0x1102 + i)
        return {
            "id": i,
            "x": self.u16(0x0F5E + i * 2),
            "y": self.u8(0x1006 + i),
            "type": b & 7,
            "owner": "blue" if b & 0x40 else "red" if b & 0x80 else None,
            "byte": b,
            "timer": self.u8(0x10AE + i),
        }

    def sites(self):
        return [self.site(i) for i in range(84)]

    def piece(self, i):
        st = self.u8(0x906 + i)
        return {
            "i": i, "status": st, "kind": st & 0xF,
            "side": {0x40: "blue", 0x80: "red"}.get(st & 0xC0),
            "x": self.u16(0x1B6 + i * 2), "y": self.u8(0x286 + i),
        }

    def pieces(self):
        return [self.piece(i) for i in range(100) if self.u8(0x906 + i)]

    def set_piece(self, i, x, y):
        self.set_u16(0x1B6 + i * 2, x)
        self.w8(0x286 + i, y)
        self.set_u16(0x2EE + i * 2, x)
        self.w8(0x3BE + i, y)

    def order(self, i, x, y):
        self.set_u16(0x96E + i * 2, x)
        self.w8(0xA3E + i, y)
        self.set_u16(0x426 + i * 2, x)
        self.w8(0x4F6 + i, y)
        # A standing order keeps its OLD destination live: pin those fields too, then set bit 0x40.
        self.w8(0xC46 + i, self.u8(0xC46 + i) | 0x40)

    def clear_film(self):
        for off in (0x1478, 0xC8CC):
            self.set_u16(off, 0)


def main():
    pid = int(sys.argv[1])
    cmd = sys.argv[2]
    g = ReE3(pid)

    if cmd == "state":
        print(f"base=0x{g.base:x} scenario={g.u16(0x19E)} film={g.u16(0x1478)} "
              f"cursor={g.u16(0x147C)} round={g.u16(0x1476)}")
        print(f"cash blue={g.cash('blue')} red={g.cash('red')} (40ths of a billion)")
        for s in g.sites():
            if s["type"] == 0:
                continue
            print(f"site {s['id']:2d} ({s['x']:3d},{s['y']:2d}) {TYPE.get(s['type'],'?'):8s} "
                  f"owner={str(s['owner']):5s} byte=0x{s['byte']:02x} timer={s['timer']}")
        for p in g.pieces():
            print(f"piece {p['i']:2d} {p['side']} k{p['kind']} ({p['x']},{p['y']})")
        return

    if cmd == "prep":
        g.clear_film()
        time.sleep(1.0)
        c0 = g.u16(0x147C)
        time.sleep(2.0)
        c1 = g.u16(0x147C)
        print(f"prep: film={g.u16(0x1478)} c8cc={g.u16(0xC8CC)} cursor {c0} -> {c1} "
              f"({'RUNNING' if c1 != c0 else 'NOT RUNNING'})")
        return

    if cmd == "capture":
        sid = int(sys.argv[3])
        seconds = float(sys.argv[4]) if len(sys.argv) > 4 else 150.0
        target = g.site(sid)
        print(f"target site {sid} {TYPE.get(target['type'])} ({target['x']},{target['y']}) "
              f"owner={target['owner']} timer={target['timer']} byte=0x{target['byte']:02x}")
        if target["owner"] == "blue":
            raise SystemExit("target already blue: pick a red or neutral city")
        if target["type"] not in (3, 4):
            raise SystemExit("target is not a type-3 base or type-4 city")

        # One blue ground piece, teleported to a free land cell beside the site.
        male = None
        for p in g.pieces():
            if p["side"] == "blue" and p["kind"] in (1, 2):
                male = p
                break
        if male is None:
            raise SystemExit("no blue ground piece in the table")

        sx, sy = target["x"], target["y"]
        cell = None
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (-1, -1), (1, -1), (-1, 1)):
            x, y = sx + dx, sy + dy
            if 0 <= x < 320 and 0 <= y < 200 and tmap_cell(x, y) in LAND:
                cell = (x, y)
                break
        if cell is None:
            raise SystemExit("no land cell beside the site")

        cash_before = {s: g.cash(s) for s in ("blue", "red")}
        timer_before = {s["id"]: s["timer"] for s in g.sites()}
        print(f"cash before: {cash_before}; moving piece {male['i']} to {cell} and ordering onto "
              f"({sx},{sy})")
        g.clear_film()
        g.set_piece(male["i"], cell[0], cell[1])
        g.order(male["i"], sx, sy)

        t0 = time.time()
        last = None
        while time.time() - t0 < seconds:
            time.sleep(1.0)
            now = g.site(sid)
            if now["owner"] != target["owner"]:
                cash_after = {s: g.cash(s) for s in ("blue", "red")}
                timer_after = {s["id"]: s["timer"] for s in g.sites()}
                print(f"CAPTURED after {time.time() - t0:.1f} s: owner -> {now['owner']} "
                      f"byte=0x{now['byte']:02x}")
                print(f"cash after: {cash_after}")
                print(f"delta: blue {cash_after['blue'] - cash_before['blue']:+d} "
                      f"red {cash_after['red'] - cash_before['red']:+d} (40ths of a billion; "
                      f"+80 = +2 b)")
                print(f"timer at site {sid}: {timer_before[sid]} -> {timer_after[sid]}")
                changed = {k: (timer_before[k], v) for k, v in timer_after.items() if v != timer_before[k]}
                print(f"timers changed elsewhere: {changed}")
                return
            if now["timer"] != last:
                last = now["timer"]
        print(f"NO CAPTURE in {seconds:.0f} s; site owner still {g.site(sid)['owner']}; "
              f"cash {g.cash('blue')}/{g.cash('red')}")
        return

    if cmd == "sample":
        # The reward is one +80-unit step on the capturer's slot. Income also credits cash, at a
        # round boundary, so the flip sample is identified by: cash moved while 0x1476 (round) did
        # not. That is the only way to separate the 2 b reward from the payday.
        sid = int(sys.argv[3])
        seconds = float(sys.argv[4]) if len(sys.argv) > 4 else 150.0
        target = g.site(sid)
        print(f"target site {sid} {TYPE.get(target['type'])} ({target['x']},{target['y']}) "
              f"owner={target['owner']} timer={target['timer']} byte=0x{target['byte']:02x}")
        if target["owner"] == "blue" or target["type"] not in (3, 4):
            raise SystemExit("pick a red or neutral type-3/type-4 site")
        male = next((p for p in g.pieces() if p["side"] == "blue" and p["kind"] in (1, 2)), None)
        if male is None:
            raise SystemExit("no blue ground piece in the table")
        sx, sy = target["x"], target["y"]
        cell = next(((sx + dx, sy + dy) for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (-1, -1), (1, -1), (-1, 1))
                     if 0 <= sx + dx < 320 and 0 <= sy + dy < 200 and tmap_cell(sx + dx, sy + dy) in LAND), None)
        if cell is None:
            raise SystemExit("no land cell beside the site")
        g.clear_film()
        g.set_piece(male["i"], cell[0], cell[1])
        g.order(male["i"], sx, sy)
        print(f"piece {male['i']} at {cell} ordered onto ({sx},{sy}); sampling at 0.1 s")
        rows = []
        t0 = time.time()
        while time.time() - t0 < seconds:
            rows.append((round(time.time() - t0, 2), g.site(sid)["owner"], g.u16(0x1476),
                         g.cash("blue"), g.cash("red")))
            if rows[-1][1] != target["owner"]:
                break
            time.sleep(0.1)
        flip = len(rows) - 1
        lo = max(0, flip - 6)
        print("  t     owner   round  blue  red")
        for row in rows[lo:flip + 1]:
            print(f"{row[0]:6.2f}  {str(row[1]):5s}  {row[2]:5d}  {row[3]:4d}  {row[4]:4d}")
        if flip > 0:
            db = rows[flip][3] - rows[flip - 1][3]
            dr = rows[flip][4] - rows[flip - 1][4]
            same_round = rows[flip][2] == rows[flip - 1][2]
            print(f"step at the flip: blue {db:+d} red {dr:+d} round {rows[flip-1][2]} -> "
                  f"{rows[flip][2]} ({'SAME round: not income' if same_round else 'round changed: income in this step'})")
        print(f"timer at site {sid} now {g.site(sid)['timer']}, owner {g.site(sid)['owner']}")
        return

    raise SystemExit(f"unknown command {cmd}")


if __name__ == "__main__":
    main()
