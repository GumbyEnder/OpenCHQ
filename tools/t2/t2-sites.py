#!/usr/bin/env python3
"""T-002: dump the 84-site table out of the running CHQ.EXE, as the game holds it.

The site arrays are indexed by site number, not fields of a struct (see FUN_20b1_1a24):

  DS:0x0f5e  word  X per site    (84 entries)
  DS:0x1006  byte  Y per site    (84 entries)
  DS:0x1102  byte  type+owner per site (84 entries); low 3 bits = subtype
                   0 none / 1,2 capital / 3 base / 4 city / 5 oilfield
                   bits 0x40 and 0x80 = owner side (which bit is which side is UNVERIFIED
                   until the capture shows the colour)

Usage: sudo -n python3 t2-sites.py <pid> [--json]
Requires root (/proc/<pid>/mem).
"""
import json
import struct
import sys

ANCHOR = b"STARTING MONEY"
ANCHOR_OFF = 0x2EDD
N = 84


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
    as_json = "--json" in sys.argv
    base = ds_base(pid)
    if base is None:
        print("ANCHOR_NOT_FOUND")
        return 2
    with open(f"/proc/{pid}/mem", "rb", 0) as f:
        def rd(off, n):
            f.seek(base + off)
            return f.read(n)
        xs = struct.unpack(f"<{N}H", rd(0xF5E, N * 2))
        ys = rd(0x1006, N)
        types = rd(0x1102, N)
        era = struct.unpack("<H", rd(0x19E, 2))[0]
        side = struct.unpack("<H", rd(0xDB02, 2))[0]
    rows = []
    for i in range(N):
        b = types[i]
        rows.append(dict(id=i, x=xs[i], y=ys[i], byte=b, subtype=b & 7,
                         owner=(b >> 6) & 3))
    out = dict(era_index=era, player_side=side, sites=rows)
    if as_json:
        print(json.dumps(out, indent=1))
    else:
        print(f"era_index={era} player_side={side}")
        for r in rows:
            print(f"{r['id']:3d} x={r['x']:3d} y={r['y']:3d} byte=0x{r['byte']:02x} "
                  f"sub={r['subtype']} owner={(r['owner'] + 1) if r['owner'] else 0}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
