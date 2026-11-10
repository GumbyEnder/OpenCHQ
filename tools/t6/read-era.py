#!/usr/bin/env python3
"""Read the game's own opening-money global (DS:0x157e) plus the era/side selectors out of a
running DOSBox process, and render it exactly the way FUN_3711_0074 does.

Anchor: the DGROUP string "STARTING MONEY" sits at DS:0x2edd in the load image (REA_PASS puts
the image base at file offset 0x0328b0), so DS:0x157e is 0x195f bytes before it.
"""
import re
import struct
import sys


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
            i = buf.find(b"STARTING MONEY")
            if i >= 0:
                return lo + i - 0x2EDD
    return None


def render(raw):
    """Mirror FUN_3711_0074: mixed-radix decimal, top digit counts 3823s, last is raw/6."""
    if raw == -1:
        return "SUPPRESSED (money global == -1)"
    c = raw & 0xFFFF
    if c > 32767:
        c -= 65536
    v = c
    d1 = 0
    while 3822 < v:
        v -= 3823
        d1 += 1
    d2 = 0
    while 636 < v:
        v -= 637
        d2 += 1
    d3 = 0
    while 63 < v:
        v -= 64
        d3 += 1
    d4 = v // 6
    return f"{d1}{d2}{d3}{d4}"


def main(pid, tag):
    base = ds_base(pid)
    if base is None:
        print(f"{tag}: anchor not found")
        return
    with open(f"/proc/{pid}/mem", "rb", 0) as m:
        def rd(off):
            m.seek(base + off)
            v, = struct.unpack("<H", m.read(2))
            return v - 65536 if v > 32767 else v
        money = rd(0x157E)
        era = rd(0x19E)
        side = rd(0xDB02)
        slotA, slotB = rd(0x1446), rd(0x1448)
    print(f"{tag}: era_idx=0x19e={era} side=0xdb02={side} money[0x157e]={money} "
          f"rendered={render(money)} sideslots=({slotA},{slotB})")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "?")
