#!/usr/bin/env python3
"""T-002: drive the original's Controller (cursor) to a game cell with the mouse.

The game holds the cursor at DS:0xda28 (col) / DS:0xdafc (row) and only moves it from
relative mouse motion; DOSBox must own the pointer first (a click inside its window).
Measured scale on this host: 5 screen px per game cell (both axes), 1024x768 Xvfb,
DOSBox window 640x400 at 192,184 for a 320x200 game frame.

Usage: sudo -n python3 t2-nudge.py <pid> <col> <row> [max_steps]
Prints the final cursor position; exit 2 if it never arrived.
"""
import importlib.util
import subprocess
import struct
import sys
import time

spec = importlib.util.spec_from_file_location(
    "ro", "/mnt/nas/projects/OpenCHQ/tools/t2/read-off.py")
ro = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ro)

PX_PER_CELL = 5
DISPLAY = ":99"


def pos(pid, base):
    with open(f"/proc/{pid}/mem", "rb", 0) as f:
        f.seek(base + 0xDA28)
        col = struct.unpack("<H", f.read(2))[0]
        f.seek(base + 0xDAFC)
        row = struct.unpack("<H", f.read(2))[0]
    return col, row


def main():
    pid = int(sys.argv[1])
    tcol, trow = int(sys.argv[2]), int(sys.argv[3])
    steps = int(sys.argv[4]) if len(sys.argv) > 4 else 60
    base = ro.ds_base(pid)
    if base is None:
        print("ANCHOR_NOT_FOUND")
        return 2
    env = {"DISPLAY": DISPLAY, "PATH": "/usr/bin:/bin"}
    for i in range(steps):
        col, row = pos(pid, base)
        dx = tcol - col
        dy = trow - row
        if dx == 0 and dy == 0:
            print(f"ARRIVED col={col} row={row} in {i} steps")
            return 0
        mx = max(-80, min(80, dx * PX_PER_CELL))
        my = max(-80, min(80, dy * PX_PER_CELL))
        subprocess.run(["xdotool", "mousemove_relative", "--", str(mx), str(my)],
                       env=env, check=False)
        time.sleep(0.12)
    col, row = pos(pid, base)
    print(f"NOT_ARRIVED col={col} row={row} wanted={tcol},{trow}")
    return 2


if __name__ == "__main__":
    sys.exit(main())
