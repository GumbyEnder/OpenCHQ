#!/usr/bin/env python3
"""Write CHQ runtime globals in a running DOSBox process (probe only).

Used to learn how the game *renders* a value: set DS:0x157e to a known number, force the
Monitor Four alternate mode (DS:0xe32c = 0xff), screenshot, and read the digits off the
screen. That tells us the unit, not a guess. Requires root (/proc/<pid>/mem).
"""
import sys, struct
sys.path.insert(0, "/mnt/nas/projects/OpenCHQ/local")
import importlib.util

spec = importlib.util.spec_from_file_location("gl", "/mnt/nas/projects/OpenCHQ/tools/t6/read-globals.py")
gl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gl)

pid = sys.argv[1]
base = gl.ds_base(pid)
writes = []
for pair in sys.argv[2:]:
    off, val = pair.split("=")
    writes.append((int(off, 0), int(val, 0)))

with open(f"/proc/{pid}/mem", "r+b", 0) as f:
    for off, val in writes:
        f.seek(base + off)
        f.write(struct.pack("<h", val if val < 32768 else val - 65536))
        print(f"wrote DS:0x{off:04x} = {val}")
