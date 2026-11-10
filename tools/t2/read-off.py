#!/usr/bin/env python3
"""T-002: read arbitrary DS-relative bytes/words out of the running CHQ.EXE.

Usage: sudo -n python3 read-off.py <pid> <off>[:<width>] ...
  width: b=byte (default), w=word (little endian), s=byte signed, d=word signed
Prints "<off>=<value>" one per argument. Needs root (/proc/<pid>/mem).

The DS base is found by anchoring on the "STARTING MONEY" string (DS:0x2EDD),
same anchor as read-globals.py; re-run after every DOSBox start.
"""
import struct
import sys

ANCHOR = b"STARTING MONEY"
ANCHOR_OFF = 0x2EDD


def ds_base(pid):
    maps = []
    with open(f"/proc/{pid}/maps") as fh:
        for line in fh:
            p = line.split()
            if "r" in p[1]:
                lo, hi = p[0].split("-")
                maps.append((int(lo, 16), int(hi, 16)))
    with open(f"/proc/{pid}/mem", "rb", 0) as m:
        for lo, hi in maps:
            if hi - lo <= 0 or hi - lo > 256 * 1024 * 1024:
                continue
            try:
                m.seek(lo)
                buf = m.read(hi - lo)
            except Exception:
                continue
            i = buf.find(ANCHOR)
            if i >= 0:
                return lo + i - ANCHOR_OFF
    return None


def main():
    pid = int(sys.argv[1])
    base = ds_base(pid)
    if base is None:
        print("ANCHOR_NOT_FOUND")
        return 2
    out = [f"base=0x{base:x}"]
    with open(f"/proc/{pid}/mem", "rb", 0) as f:
        for arg in sys.argv[2:]:
            off_s, _, width = arg.partition(":")
            width = width or "b"
            off = int(off_s, 0)
            f.seek(base + off)
            n = 2 if width in ("w", "d") else 1
            raw = f.read(n)
            if width == "b":
                v = raw[0]
            elif width == "s":
                v = struct.unpack("<b", raw)[0]
            elif width == "w":
                v = struct.unpack("<H", raw)[0]
            else:
                v = struct.unpack("<h", raw)[0]
            out.append(f"{off_s}={v}")
    print(" ".join(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
