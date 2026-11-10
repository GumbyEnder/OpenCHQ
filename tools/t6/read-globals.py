#!/usr/bin/env python3
"""Dump CHQ runtime globals out of a running DOSBox process.

Locates the guest DGROUP by anchoring on the "STARTING MONEY" string, then reads the
globals used by the setup and war-room screens. Requires root (/proc/<pid>/mem).

Usage: sudo python3 local/read-globals.py [pid]
"""
import re
import struct
import sys

ANCHOR = b"STARTING MONEY"
ANCHOR_DS = 0x2EDD

GLOBALS = [
    ("era_idx     0x19e", 0x19E, "u16"),
    ("side        0xdb02", 0xDB02, "u16"),
    ("cursor_row  0xdafc", 0xDAFC, "u16"),
    ("cursor_col  0xda28", 0xDA28, "u16"),
    ("menubar     0xc34e", 0xC34E, "u8"),
    ("cmd         0xe184", 0xE184, "u16"),
    ("m4mode      0xe32c", 0xE32C, "s8"),
    ("money       0x157e", 0x157E, "s16"),
    ("slot0       0x1446", 0x1446, "s16"),
    ("slot1       0x1448", 0x1448, "s16"),
    ("oil0        0x144a", 0x144A, "s16"),
    ("oil1        0x144c", 0x144C, "s16"),
    ("un0         0x144e", 0x144E, "s16"),
    ("un1         0x1450", 0x1450, "s16"),
    ("inc0        0x1452", 0x1452, "s16"),
    ("inc1        0x1454", 0x1454, "s16"),
]


def ds_base(pid):
    maps = []
    with open(f"/proc/{pid}/maps") as fh:
        for line in fh:
            parts = line.split()
            if "r" not in parts[1]:
                continue
            lo, hi = parts[0].split("-")
            maps.append((int(lo, 16), int(hi, 16)))
    with open(f"/proc/{pid}/mem", "rb", 0) as mem:
        for lo, hi in maps:
            size = hi - lo
            if size <= 0 or size > 256 * 1024 * 1024:
                continue
            try:
                mem.seek(lo)
                buf = mem.read(size)
            except (OSError, OverflowError):
                continue
            i = buf.find(ANCHOR)
            if i >= 0:
                return lo + i - ANCHOR_DS
    return None


def main(pid):
    base = ds_base(pid)
    if base is None:
        print("anchor 'STARTING MONEY' not found")
        return 1
    with open(f"/proc/{pid}/mem", "rb", 0) as mem:
        def read(off, kind):
            mem.seek(base + off)
            raw = mem.read(2)
            if kind == "u8":
                return raw[0]
            if kind == "s8":
                return struct.unpack("<b", raw[:1])[0]
            v, = struct.unpack("<H", raw)
            if kind == "s16" and v > 32767:
                v -= 65536
            return v
        for name, off, kind in GLOBALS:
            print(f"{name} = {read(off, kind)}")
    return 0


if __name__ == "__main__":
    sys.exit(main(int(sys.argv[1]) if len(sys.argv) > 1 else 0) or 0)
