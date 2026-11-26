#!/usr/bin/env python3
"""RE-E4 probe: peacetime (cold war) economy in the 1986/2023 original.

usage (root, PYTHONPATH=):
  ree4.py <pid> census
  ree4.py <pid> sample <seconds> [interval_s]
  ree4.py <pid> clearfilm
  ree4.py <pid> set <off_hex> <u16>

Reads DGROUP via /proc/<pid>/mem, anchored on the STARTING MONEY string (re5-live.py method).
Fields the ticket names: 0x148e money, 0x1478 mode word, 0x147c pass cursor; plus 0x1476 round,
0x157e time left, 0x148c income modifier, 0xc34e menu-bar mode (1 peacetime / 2 wartime),
0x144a/0x144e/0x1452 oil in/paid/out per side.
"""
import struct
import sys
import time

ANCHOR = b"STARTING MONEY"
ANCHOR_OFF = 0x2EDD


def _maps(pid):
    out = []
    with open(f"/proc/{pid}/maps") as fh:
        for line in fh:
            parts = line.split()
            if "r" not in parts[1]:
                continue
            lo, hi = parts[0].split("-")
            out.append((int(lo, 16), int(hi, 16)))
    return out


def ds_base(pid):
    with open(f"/proc/{pid}/mem", "rb", 0) as f:
        for lo, hi in _maps(pid):
            if hi - lo < 0x4000:
                continue
            try:
                f.seek(lo)
                chunk = f.read(hi - lo)
            except (OSError, OverflowError):
                continue
            at = chunk.find(ANCHOR)
            if at >= 0:
                return lo + at - ANCHOR_OFF
    raise SystemExit("anchor not found: not a war-room state")


class Mem:
    def __init__(self, pid):
        self.pid = pid
        self.base = ds_base(pid)
        self.f = open(f"/proc/{pid}/mem", "r+b", 0)

    def u8(self, off):
        self.f.seek(self.base + off)
        return self.f.read(1)[0]

    def u16(self, off):
        self.f.seek(self.base + off)
        return struct.unpack("<H", self.f.read(2))[0]

    def set_u16(self, off, val):
        self.f.seek(self.base + off)
        self.f.write(struct.pack("<H", val & 0xFFFF))

    def oil(self, side):
        i = 0 if side == "blue" else 1
        return {
            "reserve": self.u16(0x1446 + i * 2),
            "in": self.u16(0x144A + i * 2),
            "paid": self.u16(0x144E + i * 2),
            "out": self.u16(0x1452 + i * 2),
        }

    def row(self):
        return {
            "round": self.u16(0x1476),
            "pass": self.u16(0x147C),
            "time": self.u16(0x157E),
            "film": self.u16(0x1478),
            "c8cc": self.u16(0xC8CC),
            "barmode": self.u16(0xC34E),
            "cash_blue": self.u16(0x148E),
            "cash_red": self.u16(0x1490),
            "modifier": self.u16(0x148C),
            "era": self.u16(0x19E),
        }


def main():
    pid = int(sys.argv[1])
    cmd = sys.argv[2]
    m = Mem(pid)
    if cmd == "census":
        print(f"base=0x{m.base:x} pid={pid}")
        r = m.row()
        print(" ".join(f"{k}={v}" for k, v in r.items()))
        for side in ("blue", "red"):
            print(side, m.oil(side))
    elif cmd == "clearfilm":
        m.set_u16(0x1478, 0)
        m.set_u16(0xC8CC, 0)
        print(f"film cleared: 1478={m.u16(0x1478)} c8cc={m.u16(0xC8CC)}")
    elif cmd == "set":
        off = int(sys.argv[3], 16)
        m.set_u16(off, int(sys.argv[4]))
        print(f"0x{off:x} = {m.u16(off)}")
    elif cmd == "sample":
        secs = float(sys.argv[3])
        interval = float(sys.argv[4]) if len(sys.argv) > 4 else 1.0
        t0 = time.time()
        keys = ["round", "pass", "time", "film", "barmode", "cash_blue", "cash_red", "modifier"]
        print("t," + ",".join(keys) + ",res_b,in_b,paid_b,out_b,res_r,in_r,paid_r,out_r")
        while time.time() - t0 < secs:
            r = m.row()
            ob, orr = m.oil("blue"), m.oil("red")
            print(f"{time.time()-t0:.2f}," + ",".join(str(r[k]) for k in keys) +
                  f",{ob['reserve']},{ob['in']},{ob['paid']},{ob['out']},"
                  f"{orr['reserve']},{orr['in']},{orr['paid']},{orr['out']}", flush=True)
            time.sleep(interval)
    else:
        raise SystemExit(f"unknown cmd {cmd}")


if __name__ == "__main__":
    main()
