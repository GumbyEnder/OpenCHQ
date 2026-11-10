#!/usr/bin/env python3
"""T-006 Part A: dump the war-room money globals and the Monitor Four mode bytes.

Reads the live CHQ process via /proc/<pid>/mem. Requires root.

  cash        DS:0x148e[side]  <- what FUN_3711_16a8 divides by 0x28 (40) for "Balance:"
  money1446   DS:0x1446[side]  <- the 3000 the setup writes per side
  oilres      DS:0x144a[side]
  oilout      DS:0x1452[side]
  oilin       DS:0x144e[side]
  mod148c     DS:0x148c         <- the only modifier in the income expression
  m4mode      DS:0xe378         <- 0 terrain, 1 own money, 2 opponent income
  m4arm       DS:0x3eb2         <- countdown that applies the mode
  alt         DS:0xe32c         <- other monitor's alternate byte
"""
import importlib.util
import struct
import sys

spec = importlib.util.spec_from_file_location(
    "gl", "/mnt/nas/projects/OpenCHQ/tools/t6/read-globals.py")
gl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gl)

pid = int(sys.argv[1])
base = gl.ds_base(pid)
side = int(sys.argv[2]) if len(sys.argv) > 2 else None

with open(f"/proc/{pid}/mem", "rb", 0) as f:
    def u16(off):
        f.seek(base + off)
        return struct.unpack("<H", f.read(2))[0]
    def s16(off):
        f.seek(base + off)
        return struct.unpack("<h", f.read(2))[0]
    def s8(off):
        f.seek(base + off)
        return struct.unpack("<b", f.read(1))[0]

    if side is None:
        side = s16(0xDB02)
    print(f"player_side      = {side}")
    for i in (0, 1):
        print(f"side{i}.cash148e  = {s16(0x148E + i * 2)}")
        print(f"side{i}.money1446 = {s16(0x1446 + i * 2)}")
        print(f"side{i}.oilres    = {s16(0x144A + i * 2)}")
        print(f"side{i}.oilin     = {s16(0x144E + i * 2)}")
        print(f"side{i}.oilout    = {s16(0x1452 + i * 2)}")
    print(f"raw148e          = {s16(0x148E)}  /40 = {s16(0x148E) / 40}")
    print(f"raw1490          = {s16(0x1490)}  /40 = {s16(0x1490) / 40}")
    print(f"mod148c          = {s16(0x148C)}")
    print(f"m4mode_e378      = {s8(0xE378)}")
    print(f"m4arm_3eb2       = {u16(0x3EB2)}")
    print(f"alt_e32c         = {s8(0xE32C)}")
