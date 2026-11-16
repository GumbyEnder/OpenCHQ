# REGIONS.DAT and CBR-REGN: the territory model (T-018)

Decoded from the 1990 release's own files on this machine (`COMMAND/REGIONS.DAT`,
`COMMAND/CBR-REGN.DT0`..`DT4`, `COMMAND/CBR-TYPE.DT0`..`DT4`, `COMMAND/CBR-SET.DAT`). Nothing here
is a guess that a capture could not check: every claim below was scored against
`docs/captures/era-1942-blue-ownership.png`, whose map viewport is exactly 320×136 cells drawn at
2×, offset (192,196) in the 1024×768 frame.

## The region record

`REGIONS.DAT` is **3680 bytes = 184 records × 20 bytes**. Each record is ten big-endian `uint16`,
read as five `(x, y)` points on the 320×136 cell grid:

| offset | size | meaning |
|---|---|---|
| 0 | 2 × uint16 | point 0: the region's label point (a point inside the region) |
| 4..19 | 8 × uint16 | points 1..4: the four corners of the quad that covers the region |

Coordinates are cell indices, not pixels: `x` runs 1..318, `y` runs 0..135. No coordinate in the
file falls off the board.

The four corners are **not stored in winding order** (region 0 is `(175,0) (185,0) (186,18)
(175,18)` in the shuffled order the file uses), so the fill test is an even-odd crossing test on cell
centres, not a winding rule.

What it reproduces: rasterising all 184 quads yields **18 725 cells**, of which 12 200 are land.
The quads **do not overlap on land at all** (zero cells claimed twice), which is the check that the
record layout is right - a wrong stride or a wrong corner order produces overlaps immediately.

### Gaps

2 412 of the board's 14 612 land cells fall outside every quad: coasts, islands, and the polar
edges the 1990 four corners do not reach. `tools/bake_territory.mjs` hands those cells to the
nearest region that has one (multi-source BFS, 4-neighbour, X wraps). The BFS reaches **2 403** of
them; **9** cannot be entered and keep "no region" — measured, not asserted, and baked into
`territory.json`'s `_meta` so the arithmetic closes inside the artifact:

    18 725 quad cells + 2 403 gap cells = 21 128 filled
    2 412 gap candidates - 2 403 filled = 9 unreachable

The nine, as `(x, y)` on the 320×136 board (`_meta.gapUnreachableCells`):

    (319, 14) (319, 27) (153, 43) (81, 58) (223, 72)
    (223, 73) (69, 81) (262, 87) (319, 87)

Seven of them are single land cells with no land neighbour in any of the eight directions; the pair
(223, 72)/(223, 73) touches only itself. An 8-neighbour fill would therefore reach 2 405, not 2 412
— the remaining seven are surrounded by water on every side, so no neighbour radius that refuses to
cross water can claim them. What the 1990 release does with these nine is **Q58** (open): the fill
rule here stays 4-neighbour until that is ruled on. `isFriendly()` answers false on their ground,
which is a knowable consequence, not an accident.

Ocean cells keep "no region" under either rule, so `isFriendly(x, y)` answers false at sea, which is
what placement (p.31) and foreign aid (T-023) need. The gap fill is ours, not the file's, and it is
the only invented geometry here. `web/test/nodes/territory.mjs` pins the three numbers and the nine
cells, so a changed fill goes red instead of drifting.

## The era rows

`CBR-REGN.DT0`..`DT4` are **C source text**, not binary: a `/*----- cbr assigned by region -----*/`
header and 184 comma-separated `0xNN` bytes. Each row is **region → site id**:

```
region 0..183  ->  site id 0..83, or 0xFF when the era leaves the region unassigned
```

It is **not** a nation id, and the 184 vs 84 argument is settled by arithmetic, not by taste: era
1's row joins to `CBR-TYPE.DT1`, which has exactly **84** entries, one per site, carrying the
subtype in the low three bits and the owner in `0x40` (blue) / `0x80` (red). Scoring that join
against the 1942 capture gives **167 of 167 coloured regions correct, 0 wrong** (the 17 left over
are the uncoloured/ice/sea ones the ink test skips). A region → nation reading has no such join and
scores 113/167.

`CBR-TYPE.DT0`..`DT4` are therefore the per-era site table already used by `web/data/eras.json`
(`tools/bake_eras.mjs`), and this file adds nothing to them.

`CBR-SET.DAT` is also C source text: a `cbr_x` array of 252 numbers. Its first 184 entries look like
the regions' label x values and agree with `REGIONS.DAT`'s point 0 on 82 of 184. That disagreement
makes it a **separate** table of label positions; which one the game draws its labels from is
**UNVERIFIED** and nothing in this task depends on it.

## What the ownership view actually paints

Measured off the 1942 blue-side capture, restricted to the 320×136 map viewport:

| ink | measured | meaning |
|---|---|---|
| `#5555ff` | 48 984 px | blue-held ground |
| `#ff5555` | 4 924 px | red-held ground |
| `#55ffff` | 107 808 px | sea |
| `#ffffff` | 1 792 px | ground nobody holds (Spain and Greenland, the only two unheld regions) |
| `#0000aa` | 868 px | the outlined edge inside blue ground |
| `#aa0000` | 252 px | the outlined edge inside red ground |
| `#555555`, `#000000` | 1 628 / 144 px | unit and city markers, not territory |

Counts are pixels in the 640×260 map-viewport crop (192,196)–(832,456) of
`docs/captures/era-1942-blue-ownership.png`, i.e. the 320×136 cell grid at 2×; the whole frame adds
the legend swatches and panels, which is why a full-frame histogram is not used here.

So the live view's palette is **not** the one `OMAP.PIC` uses on the briefing picture (`#aa0000`
fill, `#aaaaaa` unheld). The manual's colours describe OMAP; the running view fills light and
outlines dark. The remake follows the capture, which is the thing the player sees.

Filled ground is land cells only: the quads' interiors contain 6 254 sea cells and the capture
leaves every one of them cyan. Shallows belong to the coast and are filled; polar ground is ground
like any other (the original does not give ice its own colour).

## Checks

`tools/t18/compare_ownership.py 1942` writes `local/t018-shots/overlay-1942.png` and prints:

- 43 520 cells compared, 40 639 agree (93.38%)
- land cells 14 776: 13 253 agree (89.69%)
- disagreements by class: sea↔blue 1 048 + 1 108, sea↔red 239 + 244, blue↔red 13 + 15,
  neutral↔sea 71 + 108, everything else under 30

The sea↔fill pairs are coastline cells: our land mask (from `TMAP.DAT`) and the original picture's
coast differ by about one cell along the shore, in both directions, in roughly equal numbers.
**Ownership itself agrees: 28 cells of blue↔red confusion out of 14 776 land cells (0.19%).**

`web/test/nodes/territory.mjs` pins the numbers a change would have to notice: 184 regions, the
1942 tally (blue 146 / red 36 / neutral 2), named sites (Washington, Moscow, London blue; Berlin,
Paris, Tokyo red; Madrid and Greenland unheld), the sea answering false to `isFriendly`, and Cam
Ranh's six regions all changing hands when that city does.

## Open, marked UNVERIFIED

1. Point 0's meaning beyond "a point inside the region". It is used only as a label anchor.
2. Which label table the original draws region labels from (`REGIONS.DAT` point 0 vs `CBR-SET.DAT`
   `cbr_x`); they agree on 82 of 184 x values.
3. ~~The mid-game recolour rule (Q44)~~ **SETTLED 2026-11-15 by the DOSBox experiment**: capturing
   one city recolours only that city's own region(s). 1942 blue, Show Ownership on, Shanghai
   (site 46, China) taken: the site byte went `0x9c` -> `0x7c` (red -> blue) and the only ground
   that changed was region 46's quad, 129 cells red -> blue; Beijing and Hong Kong, the nation's
   other two cities, stayed red (their bytes unchanged). So the game's own granularity is the
   file's: a region follows the site its era row names. Captures and the pixel diff are in the
   T-018 report and `local/t018-shots/q44/` (uncommitted, original overlay).
4. Whether the 184 quads are the whole land on eras other than 1942. 1942 is the only era with a
   reference capture in the tree; 1918 and 1986 share the same geometry file and the same join, but
   their fills have not been diffed against a capture.
5. Which label table the original draws region labels from is now only a naming question: point 0
   is used as the label anchor, and `CBR-SET.DAT`'s `cbr_x` (82/184 agreement) is filed as an open
   RE question that needs the label draw disassembled. Nothing in the view depends on it.
