from collections import Counter

buf = open('/mnt/nas/Projects/Command HQ/modern/extracted/data/tmap.bin', 'rb').read()
c = Counter()
for y in range(136):
    for x in range(320):
        b = buf[y * 0xA2 + (x >> 1)]
        c[(b >> 4) if x % 2 == 0 else (b & 0xF)] += 1
names = ["ocean", "docks", "ocean2", "lake", "capital", "base", "city", "oilfield", "plain",
         "forest", "mountain", "desert", "jungle", "polar", "wasteland"]
print("T-009b AC4/wasteland: full nibble scan of data/tmap.bin (320x136, nibble-packed, stride 0xA2)")
print("Counts by terrain id:")
for k, v in sorted(c.items()):
    print(f"  {k:2d} {names[k] if k < len(names) else '?':10s} {v}")
print("wasteland (14) cells:", c.get(14, 0))
print("city (6) cells:", c.get(6, 0), "- cities exist as a site record, not a terrain cell")
