# PB-166 read (1) — the .SG save container, decoded and what it does NOT contain

Measured 2026-11-20, game profile, in one turn on this host. Files read (read-only, no writes):
`/mnt/nas/Projects/Command HQ/COMMAND/SAVE/CHQ-00.SG`, `CHQ-01.SG`. Room mention 7861.

Verdict up front: the container decodes, and it gives per-kind unit counts **for the two saves that
ship in the archive**. Both are tutorials. **Neither is the 1942 campaign opening, so read (1) does
not separate rows 3 and 4 from scenario data.** The negative is measured, not a refusal.

## 1. What the archive actually ships

`COMMAND/SAVE/` holds exactly two `.SG` files (plus one `.BLO`, one `.RLO`, one `.REP`):

| file | bytes | md5 | name field |
|---|---|---|---|
| `CHQ-00.SG` | 10247 | `7ef6349ef9838068e88f10caee11f560` | `TUTORIAL ONE` |
| `CHQ-01.SG` | 10331 | `722bda1b562a740c864f925f3edc5d13` | `TUTORIAL TWO` |

There is no `CHQ-02.SG`..`CHQ-11.SG`, and no unit-order-of-battle table anywhere else in `COMMAND/`
(the per-era `CBR-TYPE.DT0..DT4` files are 84 **site** records — low nibble = site class, bits 7:6 =
owner; counted: 1942 `DT1` blue 40 sites / red 23, values 0x41/0x43/0x44/0x81/0x82/0x83/0x84. That is
sites, not pieces. `TMAP.DAT`, `REGIONS.DAT`, `CBR-SET.DAT` are map/region data.)

This is the mechanical reason `web/server/match.mjs:58` says the archive's OOB was never recovered: the
archive does not ship one. The only unit-level data on disk is inside these two tutorial saves.

## 2. The container, from the bytes

Shared layout of both files (offsets identical in both, which is itself the alignment witness):

```
0x000  eb 13 00 00 | 02 00 | 01 00 | "TUTORIAL ONE"/"TUTORIAL TWO" (16 B, NUL padded)
       0x0000 = 0x13EB (5099, uninterpreted)
       0x0004 = 2      players
       0x0006 = 1      scenario index (the word the game reads at DS:0x19E; 0=1918, 1=1942
                       per docs/re/ECONOMY_RE.md §1.5)
0x702  uint16      CHQ-00 = 7, CHQ-01 = 4   (unidentified field; differs between the two)
0x706  100 B       unit STRENGTH, one byte per slot, values 0 or 0..100
0x76E  100 B       unit STATUS, bits 7:6 owner (0x40 blue, 0x80 red), bits 3:0 kind, 0 = empty slot
0x7D2  02 00 bc 00 section marker (same four bytes in both files)
0x7D6  54 x uint16 site coordinates (first value 0x00A1 in CHQ-00, 0x0092 in CHQ-01)
```

**Correction from read (2), 2026-11-20.** The `0x7D2` marker is not universal and the `0x7D6` tail is
not a one-off table. In the 1942 setup save the four bytes at `0x7D2` are `00 00 0b 01`, and `bc 00`
does not occur anywhere in that file (see §8). The 108-byte sequence found at the tail of the tutorial
saves also recurs at `0x1C`, `0x154`, `0x28C`, `0x3C4` - stride `0x138` - so it is a repeated record
field, not 54 site coordinates. Neither correction moves the unit arrays at `0x706`/`0x76E`; §8 gives
the alignment witness that replaces the marker.

Field semantics for strength/status are the ones `docs/re/COMBAT.md` §1 and `docs/re/STRUCTS.md` give
for the live data segment (`0x89e` strength, `0x906` status); what is new here is only where they sit
inside the save file.

**Why this is a reading and not a guess.** The two 100-byte arrays are validated against each other:
a slot is occupied in the strength array (value 100) exactly when it is non-zero in the status array.
`CHQ-01` = **100/100 exact**, 35 occupied slots. `CHQ-00` = **99/100**, and the single mismatch is
index 11: status `0x83` (red, kind 3) with strength **74** — i.e. one red infantry unit is at 74 %,
which is exactly what a save taken mid-tutorial looks like. An arbitrary 200-byte window does not
produce that agreement, and the 4-byte marker sits at the same offset past the end in both files.

Raw arrays (hex, 100 bytes each):

```
CHQ-00.SG strength @0x706
00 64 00 00 00 00 00 00 00 64 00 4a 00 00 00 00 64 00 00 00 00 00 00 00 00 64 00 00 00 00 00 00
00 64 64 64 64 64 64 64 00 64 64 00 00 00 00 00 00 00 00 00 00 00 00 64 00 64 00 00 00 00 64 64
00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
00 00 00 00
CHQ-00.SG status @0x76e
00 83 00 00 00 00 00 00 00 83 00 83 00 00 00 00 83 00 00 00 00 00 00 00 00 88 00 00 00 00 00 00
00 46 43 42 46 42 43 42 00 43 43 00 00 00 00 00 00 00 00 00 00 00 00 49 00 48 00 00 00 00 43 43
00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
00 00 00 00

CHQ-01.SG strength @0x706
64 64 00 64 64 64 64 00 64 64 00 00 00 00 00 00 00 64 64 00 64 64 00 64 64 64 00 64 00 00 00 64
64 64 00 00 00 00 00 00 64 00 64 00 64 64 64 64 64 64 64 64 64 00 64 00 00 00 64 64 00 64 00 64
00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
00 00 00 64
CHQ-01.SG status @0x76e
82 00 82 82 82 82 00 82 82 00 00 00 00 00 00 00 83 82 00 82 87 00 87 87 88 00 88 00 00 00 88 87
87 00 00 00 00 00 00 45 00 46 00 46 47 49 48 48 48 49 48 00 47 00 00 00 48 48 00 47 00 45 00 00
00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
00 87
```

## 3. Per-kind counts read out of the two saves

Kind codes are the measured ones from `docs/re/COMBAT.md` §1/§3 (1 infantry, 2 tank, 3 entrenched
infantry, 5/6 AI-side hulls, 7 submarine, 8 cruiser, 9 carrier).

| file | side | pieces | per kind |
|---|---|---|---|
| `CHQ-00.SG` (TUTORIAL ONE) | Blue | 13 | kind 2 x3, kind 3 x6, kind 6 x2, kind 8 x1, kind 9 x1 |
| `CHQ-00.SG` (TUTORIAL ONE) | Red | 5 | kind 3 x4, kind 8 x1 |
| `CHQ-01.SG` (TUTORIAL TWO) | Blue | 16 | kind 5 x3, kind 6 x2, kind 7 x3, kind 8 x6, kind 9 x2 |
| `CHQ-01.SG` (TUTORIAL TWO) | Red | 19 | kind 2 x9, kind 3 x1, kind 7 x6, kind 8 x3 |

Neither side of either save is the 1942 campaign opening. The opening the panel shows is 36 pieces in
row order 13 / 5 / 4 / 5 / 2 / 7. TUTORIAL ONE's Blue is 13 pieces total, of five kinds, with no
kind 7 at all; TUTORIAL TWO's Blue is a 16-ship naval force. **There is no 4-vs-5 pair of rows to read
here, so this file cannot decide rows 3 and 4 — and the archive has no other unit data to read.**

One boundary caveat, stated so a re-checker is not surprised: in `CHQ-01.SG` the byte immediately
before the array (0x76D) is also `0x82`, so an alignment one byte earlier shifts one red unit
(red 20 / blue 16, blue unchanged). Both alignments are given by the marker+strength agreement; only
the 0x76E alignment reproduces `02 00 bc 00` at 0x7D2 in *both* files, so 0x76E is the one used above.

## 4. What this leaves for rows 3 and 4

Read (1) is closed **negative** from scenario data. The separation therefore still rests on the panel
COUNT column plus a live per-kind count, i.e. exactly the frodo-rig cross-check:

- panel COUNT column, measured from the capture: rows 1-6 = 13, 5, 4, 5, 2, 7 (sum 36);
- rig memory of the live 1942 Blue opening (`docs/re/evidence/re5/re5_alt_1942blue.globals.txt`,
  md5 `70dc8b1118a1fb57364e0fd0a9bdece5`): kinds 2=5, 3=13, 7=4, 8=5, 9=2, 29 pieces. 29 + the 7
  aircraft the piece walk does not visit = 36, matching the panel total;
- kind names from the measured range-class ladder (`COMBAT.md` §3: class 2/range 2 = submarine per
  manual p.24, class 3 = cruiser, class 4/carrier): kind 7 submarine, kind 8 cruiser.

Row 3 = 4 = kind 7 = submarine, row 4 = 5 = kind 8 = cruiser — i.e. the config's roster order for
those two rows. **Status: cross-check-supported, not scenario-data-proven.** `config/game.json:228-230`
untouched, and `DS:0x2E21` not needed, so it stays UNVERIFIED.

If a save is taken from a *fresh standard 1942 game* at setup, this same reader returns that OOB as a
file read in one call — that is the only remaining route to make it a scenario-data result.

## 8. Read (2) - the original's own 1942 setup save, decoded (room 7867)

Measured 2026-11-20 in this turn. This is a FILE read of a save the game itself wrote from a standard
1942 single-player board at setup, before any orders.

Artifact (deliberately NOT in git - the repo is public, room 7868):

| file | bytes | md5 | where |
|---|---|---|---|
| `CHQ-02.SG` | 10205 | `6544bf6f07196d3bf62492c31b82727b` | `/mnt/nas/Projects/OpenCHQ/local/evidence/pb166/` (`local/` is gitignored) |

Container header: `eb 13 00 00 | 01 00 players | 01 00 scenario_index` (= 1, 1942), name `UNTITLED`.
`COMMAND\SAVE` is back to as-shipped; only `CHQ-00.SG` and `CHQ-01.SG` remain there, both md5s unchanged.

### 8.1 The file is two copies, and the unit arrays agree in both

`0x0000` = `0x13EB` = 5099 is the copy stride: the file is two 5099-byte copies plus 7 trailing bytes
(`2 x 5099 + 7 = 10205`). The copies differ in 14 bytes only - the 8-byte name field (empty in the
second copy), `0x12DE`, three bytes at `0x12EB`, `0x13B4`, `0x13E8` and the 7-byte tail. The unit
arrays are **byte-identical** in both halves:

- strength `@0x706` == strength `@0x706+5099` (`0x1AF1`), true;
- status `@0x76E` == status `@0x76E+5099` (`0x1B59`), true.

So the decode below is witnessed twice inside one file the executable wrote, not once at an assumed
offset.

### 8.2 Alignment, without the `0x7D2` marker

The marker does not transfer to this file (`bc 00` does not occur in it at all). What replaces it:

1. same offsets as the two saves written by the same executable (`0x706` strength / `0x76E` status, 104
   bytes apart);
2. the strength run is exactly 58 x `0x64` from `0x706` to `0x73F` with `0x00` at `0x740`, and the
   status run is exactly 58 non-zero bytes from `0x76E` to `0x7A7` with `0x00` at `0x7A8` - equal run
   lengths, no gaps, every occupied strength 100;
3. the same pair repeats identically at `+5099` (8.1);
4. the reader still reproduces the tutorial sanity checks exactly: TUTORIAL ONE Blue 13 / Red 5,
   TUTORIAL TWO Blue 16 / Red 19.

A brute-force sweep of every offset pair `(i, i+104)` in the file returns only two 58/58 runs with
strength 100: `0x706` and `0x1AF1` - the two copies of the same array.

### 8.3 Per-kind counts, and why they settle rows 3/4/5

```
Blue 27 pieces: k2=5  k3=11 k7=4 k8=5 k9=2
Red  31 pieces: k2=6  k3=12 k7=5 k8=6 k9=2
58 occupied, strength 100 on all 58, no damage => pre-combat setup board
```

Against the buy panel's COUNT column `13, 5, 4, 5, 2, 7` (`dos1942-buy-panel.png`, re-read this turn):
row 2 = 5 matches Blue tank = 5 exactly, row 6 = 7 is the aircraft count the piece walk never visits,
so rows 3-5 are the three sea kinds by elimination. Their counts are **distinct** - 4, 5, 2 - and the
save's sea counts are 4, 5, 2, so the bijection is forced:

| row | COUNT | kind | unit |
|---|---|---|---|
| 3 | 4 | 7 | submarine |
| 4 | 5 | 8 | cruiser |
| 5 | 2 | 9 | carrier |

That is the config's `rosters["1942"]` order. Price cannot do this (rows 3 and 4 both cost 10, ticket
§3); the counts can, because no two of the three are equal. PM ruled rows 3, 4 and 5 SAVE-FILE-BACKED
in room 7868; `config/game.json:228-230` now cite this decode instead of the p.28 icons.

### 8.4 The one number that is not stable across the save boundary

Blue infantry reads **11** here against **13** on the panel and in the `:99` live board read
(`re5_alt_1942blue.globals.txt`: kinds 2=5, 3=13, 7=4, 8=5, 9=2, 29 blue pieces). Occupied is 58 in the
save vs 60 live; the two extra live entries are blue in memory, and on frodo's reading they land on red
slots at save time (his inference, not proved here). Blue
totals therefore 27 in the save vs 29 live, and 34 vs 36 once the 7 aircraft are added. Infantry counts
come from the panel and sea classes from the save until that is explained; filed as Q68, no code.

### 8.5 What this does NOT establish

Not the 1918/1986/2023 openings (no saves), not the aircraft slot encoding (the piece walk does not
visit them), and not the meaning of the 14 differing bytes between the two copies. The infantry
delta of 8.4 is measured and unexplained, not smoothed.
