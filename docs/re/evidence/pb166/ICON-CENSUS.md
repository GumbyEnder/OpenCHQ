# PB-166 icon census — measured 2026-11-20 (ET)

Turn: game profile, room mention 7856. Everything here was measured in this turn on this host;
nothing is copied from room 7846/7847/7849.

Path note (room 7871): the PNG captures this file names - the panel crops, the manual pages and the
per-cell masks - were moved out of `docs/re/evidence/pb166/` to
`/mnt/nas/Projects/OpenCHQ/local/evidence/pb166/raw/` and `.../raw/pb166-cells/`, which is gitignored
(`.gitignore` -> `local/`, plus `docs/re/evidence/**/*.png` for any future capture). The coordinates,
bboxes and md5s below are unchanged; only the directory moved. This file and `SAVE-DECODE.md` are the
text that ships.

## 0. Frame

`dos1942-buy-panel.png` is 1024x768 and is an exact 2x blow-up of a **512x384** framebuffer: 99.96 % of
vertically adjacent pixel pairs and 99.97 % of horizontally adjacent pairs are identical
(`a[0::2,0::2] == a[1::2,0::2]` / `== a[0::2,1::2]`). Every coordinate below is in the **512x384**
frame; multiply by 2 for the PNG.

Panel interior: white x370..659, y204..471 in PNG space → x185..329, y102..235 in frame space.
The six unit rows are 10 frame-pixels apart, first row top at y140.

## 1. The six TYPE cells, extracted at native scale

Ink = any pixel inside the cell that is not white (255,255,255), not the panel frame brown
(170,85,0) and not the selection cyan (85,255,255).

| row | bbox (frame) | shape (w x h) | ink px | ink md5 | cell md5 (2x crop) |
|---|---|---|---|---|---|
| 1 | x200..208 y140..149 | 9 x 10 | 46 | `b64f45dc827cfa2e443c5fc05e1c7b35` | `434de4a631ce12be1300f8280bb3f529` |
| 2 | x199..209 y150..158 | 11 x 9 | 61 | `edab5f5cf1140b6380b4569d655fcf75` | `ec88fbb58b970cdee5c37b58bf69ebea` |
| 3 | x200..208 y164..165 | 9 x 2 | 11 | `0d722ce7594e9870bebfd4763697defc` | `daa36751eeda801c706dfbb955a833af` |
| 4 | x199..209 y173..176 | 11 x 4 | 22 | `cfa0a6c4781d69bf0caab5b1fb2c78d8` | `f28f1f447189c96a0a3786273a64fb47` |
| 5 | x199..209 y183..187 | 11 x 5 | 37 | `fe87d660f1d310c93c0aa1249b38aa95` | `05629bbd9835c90177069fae87514e30` |
| 6 | x199..209 y192..198 | 11 x 7 | 38 | `4c99f88d3a5ce247c2d38beb67b14267` | `31b7d383cd7dce7ef063143774c5e54a` |

Files: `type-cells/row<N>-ink.png` (the ink mask alone, native 1x) and `type-cells/row<N>-cell.png`
(the raw 2x cell as it appears on screen, 30x20). The md5 columns are of those two files.

Row 2 is the cyan-highlighted row; its ink mask is taken with the cyan background excluded, so the
mask is the sprite, not the highlight bar.

Geometry, stated plainly: these are **line icons**, 9x2 to 11x10, 11 to 61 ink pixels. They are not
16x16 sprites. Rows 3, 4 and 5 are all low horizontal hull silhouettes; row 6 is the only shape with
diagonal components; rows 1 and 2 are the only tall shapes.

## 2. Header band — three headers, no fourth

Scan of every non-white pixel in the band, frame rows 126..141, x191..327 (the panel's right border is
at x330 and is excluded):

- row 127..131: text x191..219 then x257..319 → `MONEY - 50 (BILLION)`
- row 133..137: text x191..213 (`TYPE`), x222..249 (`COUNT`), x257..285 (`KNOWN`)
- on those header rows, nothing at all between x286 and x327; the only text that reaches past x285
  anywhere in the band is the MONEY line's `(BILLION)` on row 127, ending at x319.

So the 1942 panel prints exactly three column heads and leaves the right-hand (cost) column unheaded.
That is now measured twice: by this scan and by the executable's own string block (§3).

## 3. The executable's own purchase-panel data block

`modern/extracted/exe/CHQ_unpacked.EXE`, 256848 B. Data segment maps to file offset 0x328B0 under the
documented mapping (`file = 0x3600 + ((seg-0x1000)<<4) + off`), so **DS:0x0000 = file 0x328B0**.
Corroboration that this base is right: DS:0x148E (start money, written at runtime) reads 0000 in the
file — it is BSS — while DS:0x2E16 (the price table) reads initialised data.

### 3a. The price table is 11 bytes, not 6

    file 0x356C6 = DS:0x2E16   (the one occurrence of this byte pattern in the image)
    0a 14 0a 0a 14 14  0a 05 0a 0a 0a
    = 10 20 10 10 20 20  10 5 10 10 10

That is the six 1942 prices **followed immediately** by the five 1986/2023 extras
(reconSat 10, killerSat 5, nuke 10, foreignAid 10, intelScan 10). All eleven match
`config/game.json` `prices` in the config's insertion order, byte for byte —
infantry, tank, submarine, cruiser, carrier, aircraft, reconSat, killerSat, nuke, foreignAid, intelScan.

Two things this pins that the card did not have:

1. The table in the original is a single 11-entry table indexed in roster order; the remake's roster
   order and price order are the same order the executable uses. No reordering was invented.
2. The row/price pairing for 1942 comes from one contiguous table, so rows 3, 4, 5 really do carry
   10, 10, 20 in that order — the ambiguity is the *name* of rows 3 and 4 only (both cost 10), exactly
   as the card says.

### 3b. Observation, UNVERIFIED — six bytes immediately after the price table

    file 0x356D1 = DS:0x2E21   00 01 02 07 08 09   then 00 00 00, then the string block

Six values, one per 1942 row, at the end of the panel's data. A disassembly walk finds one read of it,
`f63b: mov al, BYTE PTR [si+0x2e21]`, where `si` was just loaded out of a word table at DS:0x1A01 and
masked to a byte — so the array is used as a small lookup, not as free-standing row data. **This is
not a naming proof and nothing in `config/game.json` should move on it.** It is recorded because it is
the only per-row six-element array in the panel's data block and it is the cheapest lead for the next
pass: if those are icon indexes, the art they index is a small-icon sheet that `UNITS.PIC` is not.

### 3c. The panel's strings, and why the archive has no unit names

    file 0x356EB  "Money - "
    file 0x356F4  "(billion)"
    file 0x356FE  " Type "
    file 0x35705  "COUNT "
    file 0x3570C  "Known "
    file 0x35713  "COUNT"
    file 0x35719  "Known"
    file 0x35721  "x080Cost"
    file 0x3572C  "Satl Killer "
    file 0x35739  "Use Nukes   "
    file 0x35746  "Foreign Aid "
    file 0x35753  "Intel Scan  "

Three header words and no fourth header word in the 1942 block — the `Cost` string that exists at
0x35721 is prefixed with four characters (`x080`) and sits with the four late-era **text labels** that
follow it. The six 1942 rows have no label strings anywhere in the image. That is the mechanical
reason `exe_strings.txt` contains no Infantry/Tank/Submarine label: those rows are icons, and the only
rows that ever print names are the five late-era items.

Correction to the card's §4 wording: "`Cost` names a column the original leaves unlabelled" is right
about the 1942 panel, but the word `Cost` **is** in the original's string block, bound to the same
column area. So `Cost` is the original's own vocabulary, not a remake coinage. Still no client change
— app.js already prints `Cost` — but the §4 sentence should not read as if the word were invented here.

## 4. Bit-comparison against `UNITS.png` — run, and it does not identify the rows

Method: each cell ink mask was compared against all 120 `UNITS.png` tiles in the top 6 tile rows
(16x16 grid), each tile's ink taken as "not the tile's dominant colour", mask resized to the cell's own
size, and scored by best Jaccard over all integer shifts in -4..+4 on both axes (81 positions).
120 tiles x 81 shifts = 9720 comparisons per row.

| row | best Jaccard | 99th pct | median | best tile |
|---|---|---|---|---|
| 1 | 0.657 | 0.574 | 0.300 | r1c19 |
| 2 | 0.746 | 0.667 | 0.337 | r1c12 |
| 3 | 1.000 | 0.833 | 0.333 | r4c12 |
| 4 | 0.769 | 0.692 | 0.308 | r1c10 |
| 5 | 0.895 | 0.760 | 0.349 | r1c10 |
| 6 | 0.683 | 0.571 | 0.311 | r4c8 |

Read the columns, not the maxima. With 9720 comparisons the maximum of a junk distribution always
clears 0.65; the median is 0.30-0.35 for every row. Row 3's 1.000 is degenerate: its mask is 11 ink
pixels in 9x2, and a 2-row subset of any 16x16 tile scores 1.0 on Jaccard. Row 5's 0.895 is the only
score above its own p99 by a real margin, and it points at `r1c10`, the same tile row 4 points at —
i.e. the two rows that must be *different* ships score best against the *same* tile. The best tiles
across the six rows are not a coherent set (r1c19, r1c12, r4c12, r1c10, r1c10, r4c8).

Measured reason it cannot work: the two art sets are different classes.

- `UNITS.png` top rows: 16x16 tiles, 101-247 ink pixels each, side-tinted (blue/red) map sprites.
- Panel TYPE cells: 9x2..11x10, 11-61 ink pixels, single-colour line icons.

`UNITS.PIC` is the map sprite sheet. The purchase panel does not draw from it at this size. **The
card's step 1 needs a different source: the panel's own small-icon art, not `UNITS.png`.** That is the
finding; do not read the table above as a classification.

## 5. What is settled and what is not

Settled by measurement on this turn:

- The six cell identities (bbox, size, ink count, md5) — reproducible from the capture alone.
- Three headers, no fourth, and nothing in the header band right of x285.
- The original's price table is one contiguous 11-entry table = the remake's `prices` block in the
  remake's order (1942's six then the five extras), at DS:0x2E16.
- The 1942 rows carry no name strings; the late-era rows do.

Still not settled (unchanged):

- Which of rows 3 and 4 is the submarine and which the cruiser. Price cannot separate them (both 10),
  counting cannot separate them (the COUNT column separates them — 4 vs 5 — but only if an independent
  per-kind count exists), and the icon shapes are two low hulls that this turn could not tie to the
  sprite sheet.
- Therefore the three `UNVERIFIED` flags at `config/game.json:228-230` **stay**.

Cheapest next reads, in order:

1. OOB cross-check (card step 2). The remake has no opening order of battle — `web/server/match.mjs:58`
   says the archive's OOB was never recovered — so the count 13,5,4,5,2,7 must come from the DOS side:
   either the live 1942 game (frodo's RE-E2 rig, memory) or a save file (`COMMAND/SAVE/CHQ-0N.SG`).
   If Blue's per-kind counts come back as 13/5/4/5/2/7 in type order, rows 3 and 4 are separated by
   count alone and no icon reading is needed.
2. Find the art the six `DS:0x2E21` indexes point at (small-icon sheet), then a real bit comparison.
