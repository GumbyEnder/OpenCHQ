#!/usr/bin/env python3
"""T-009 harness: sits on top of the T-008 GameMem reader.

Adds the piece table the combat code reads (all offsets are DS-relative, index i 0..99):
  0x906+i  status   bits7:6 owner (0x40 blue, 0x80 red), bits3:0 kind
  0x89e+i  strength 0..100
  0x836+i  TERRAIN id under the piece (0 ocean 1 docks 2 ocean 3 lake 4 capital 5 base
           6 city 7 oilfield 8 plain 9 forest 10 mountain 11 desert 12 jungle
           13 polar 14 wasteland)
  0x1b6+i*2 packed current x (high byte) and y (low byte)
  0x286+i  current y
  0x96e+i*2 order x , 0xa3e+i order y
  0x7ce+i  facing (2 N, 3 S, 4 E, 5 W, 0 none)
  0xbde+i  target piece index, 0xff none
  0xc46+i  flags: &7 pin counter, 0x08 fired, 0x10 was hit, 0x20 fire-ready, 0x40 ordered
  0xd16+i  shot countdown
  0x6fe+i*4 move points (4-byte int at i*2 - read 4 bytes)
"""
import sys
import time

sys.path.insert(0, __import__("os").path.dirname(__import__("os").path.abspath(__file__)))
from speed_rate import GameMem, DISP  # noqa: E402

TERRAIN = {0: "ocean", 1: "docks", 2: "ocean", 3: "lake", 4: "capital", 5: "base",
           6: "city", 7: "oilfield", 8: "plain", 9: "forest", 10: "mountain",
           11: "desert", 12: "jungle", 13: "polar", 14: "wasteland"}
KIND = {1: "infantry", 2: "tank", 3: "inf(dug)", 4: "tank(?)", 5: "inf(sea)",
        6: "tank(sea)", 7: "sub", 8: "cruiser", 9: "carrier"}
OWN = {0x40: "blue", 0x80: "red", 0xC0: "??"}


class CombatMem(GameMem):
    def p32(self, off):
        self.mem.seek(self.base + off)
        b = self.mem.read(4)
        return int.from_bytes(b, "little") if len(b) == 4 else -1

    def set_u8(self, off, val):
        self.mem.seek(self.base + off)
        self.mem.write(bytes([val & 0xFF]))

    def clear_film(self):
        for off in (0x1478, 0xC8CC):
            self.set_u16(off, 0)

    def piece(self, i):
        st = self.u8(0x906 + i)
        x = self.u16(0x1B6 + i * 2)
        return {
            "i": i, "status": st, "kind": st & 0xF, "own": st & 0xC0,
            "side": OWN.get(st & 0xC0, "?"), "strength": self.u8(0x89E + i),
            "x": x & 0xFFFF, "y": self.u8(0x286 + i), "terrain": self.u8(0x836 + i),
            "facing": self.u8(0x7CE + i), "target": self.u8(0xBDE + i),
            "flags": self.u8(0xC46 + i), "cd": self.u8(0xD16 + i),
            "points": self.p32(i * 2 + 0x6FE),
        }

    def pieces(self):
        return [self.piece(i) for i in range(100) if self.u8(0x906 + i)]


def row(p):
    return (f"{p['i']:3d} {p['side']:4s} k{p['kind']} {KIND.get(p['kind'], '?'):9s} "
            f"str={p['strength']:3d} ({p['x']:3d},{p['y']:3d}) "
            f"{TERRAIN.get(p['terrain'], '?'):8s} face={p['facing']} tgt={p['target']:3d} "
            f"fl=0x{p['flags']:02x} cd={p['cd']:2d} pts={p['points']}")


if __name__ == "__main__":
    g = CombatMem(int(sys.argv[1]))
    print(f"base=0x{g.base:x} speed={g.speed} time_left={g.time_left} "
          f"cursor={g.u16(0x147C)} frame={g.u16(0x147E)} film={g.u16(0x1478)}")
    for p in g.pieces():
        print(row(p))
