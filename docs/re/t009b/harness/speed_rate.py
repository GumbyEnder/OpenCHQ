#!/usr/bin/env python3
"""T-008 S1: measure the original Command HQ game-clock rate at speed 0..6.

Reads two DGROUP bytes out of the live DOSBox process:
  0xc700 = speed (0..6), the byte FUN_259b_0e6a renders as "Speed N"
  0x157e = TIME LEFT countdown, 1/64 s units (panel 2:00.0 = 7680)
'BASE' is found by the 'STARTING MONEY' anchor at DS:0x2EDD.

Speed is set the way the game does it: the war room '+' / '-' keys
(FUN_1cdd line 10371: '+' adds 1, clamps at 6; '-' subtracts 1, clamps at 0).

usage: sudo -n python3 speed_rate.py <pid> [dwell_seconds]
Run as root (reads /proc/<pid>/mem). Needs DISPLAY for xdotool.
"""
import re
import subprocess
import sys
import time

DISP = ":99"
ANCHOR = b"STARTING MONEY"
ANCHOR_OFF = 0x2EDD


class GameMem:
    def __init__(self, pid):
        self.pid = pid
        self.mem = open(f"/proc/{pid}/mem", "r+b", buffering=0)
        self.base = self._find_base()

    def _find_base(self):
        for line in open(f"/proc/{self.pid}/maps"):
            m = re.match(r"([0-9a-f]+)-([0-9a-f]+) (....)", line)
            if not m or "r" not in m.group(3):
                continue
            lo, hi = int(m.group(1), 16), int(m.group(2), 16)
            try:
                self.mem.seek(lo)
                c = self.mem.read(hi - lo)
            except OSError:
                continue
            i = c.find(ANCHOR)
            if i >= 0:
                return lo + i - ANCHOR_OFF
        raise SystemExit("anchor not found: DOSBox is not in the war room")

    def u16(self, off):
        self.mem.seek(self.base + off)
        return int.from_bytes(self.mem.read(2), "little")

    def u8(self, off):
        self.mem.seek(self.base + off)
        return self.mem.read(1)[0]

    def set_u16(self, off, val):
        self.mem.seek(self.base + off)
        self.mem.write(val.to_bytes(2, "little"))

    @property
    def speed(self):
        return self.u16(0xC700)

    @property
    def time_left(self):
        return self.u16(0x157E)


def key(sym):
    subprocess.run(["xdotool", "key", "--clearmodifiers", sym],
                   env={"DISPLAY": DISP, "PATH": "/usr/bin:/bin"})
    time.sleep(0.12)


def set_speed(g, target):
    """Drive the game's own +/- keys until 0xc700 reads `target`."""
    for _ in range(12):
        cur = g.speed
        if cur == target:
            return cur
        key("plus" if cur < target else "minus")
    got = g.speed
    if got != target:
        raise SystemExit(f"could not set speed {target} (read {got})")
    return got


def rate(g, dwell):
    """Units of 0x157e per second at the current speed."""
    v0, t0 = g.time_left, time.monotonic()
    samples = 0
    last = v0
    while True:
        time.sleep(0.1)
        samples += 1
        v = g.time_left
        if v > last + 1000:          # round boundary: counter re-armed
            return None, time.monotonic() - t0, v0, v
        last = v
        if time.monotonic() - t0 >= dwell:
            break
    dt = time.monotonic() - t0
    return (v0 - g.time_left) / dt, dt, v0, g.time_left


def main():
    pid = sys.argv[1]
    dwell = float(sys.argv[2]) if len(sys.argv) > 2 else 12.0
    g = GameMem(pid)
    print(f"pid={pid} base=0x{g.base:x} speed={g.speed} time_left={g.time_left}")
    rows = []
    for target in (0, 1, 2, 3, 4, 5, 6):
        got = set_speed(g, target)
        r, dt, v0, v1 = rate(g, dwell)
        if r is None:
            print(f"speed {got}: round boundary inside {dt:.1f}s "
                  f"({v0} -> {v1}); no rate taken")
            rows.append((got, None, dt, v0, v1))
            continue
        per_round = 7680.0 / r if r else float("inf")
        print(f"speed {got}: {r:8.2f} units/s over {dt:5.1f}s "
              f"({v0} -> {v1})  -> {per_round:7.2f} s/round", flush=True)
        rows.append((got, r, dt, v0, v1))
    print()
    print("speed  units/s   seconds/round")
    for s, r, dt, v0, v1 in rows:
        if r is None:
            print(f"{s:5d}  (boundary in window)")
        elif r == 0:
            print(f"{s:5d}  {0.0:8.2f}   (no movement: full stop)")
        else:
            print(f"{s:5d}  {r:8.2f}   {7680.0 / r:10.2f}")


if __name__ == "__main__":
    main()
