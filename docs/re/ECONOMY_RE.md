# ECONOMY_RE — the oil budget, measured in DOSBox (RE-E5) and decoded

Written 2026-11-19 by game, for T-033 under the economy brief (room 7666-7669, 7670).
Evidence directory: `docs/re/evidence/re5/`. All figures below are from captures in that
directory; nothing here is inferred from the manual alone.

## 1. What RE-E5 measured (DOSBox, 1986 Blue)

Harness: `/mnt/nas/host-ops/openchq/re-e5/{re5-probe.py,re5-live.py,re5-era.sh}`.

### 1.1 Opening panel and globals — 1986 Blue, alt byte set (`alt_e32c = 1`)

| reading | value | where |
|---|---|---|
| reserve `DS:0x1446` | 3000 | `0_globals_1986blue.txt`, `re5_alt_1986blue.globals.txt` |
| In `DS:0x144A` | 2200 | same |
| paid `DS:0x144E` | 2200 | same |
| Out `DS:0x1452` | 1870 (setup value) | same |
| cash `DS:0x148E` | 2000 | same |
| pieces blue / red | 31 / 35 | `re5_alt_1986blue.globals.txt` |

Blue's 31 pieces by kind: `2 n=6`, `3 n=8`, `7 n=4`, `8 n=9`, `9 n=4`; Red's 35: `2 n=14`,
`3 n=8`, `7 n=7`, `8 n=6` (+4 not printed in the tail of the capture).

### 1.2 One full round live-sampled (`re5-live.py sample`, 24 s)

- Round boundary: reserve 3000 -> 3388; Out reset 1870 -> **1812**; paid **1812**.
- 3388 = 3000 + In 2200 - Out 1812, so the settlement is `held + In - Out`.
- **In = 200 x owned type-5 fields**: 11 fields = 2200. Confirmed by the capture's field count.
- **Paid 1812 = 31 x 50 + 200 + 2 x 31** — the city term plus 2 per piece.

### 1.3 Ships are charged (the manual is wrong)

Ordered Blue submarine (piece 12) from (82,50) to (82,45), all water: the 5-cell leg moved the
sub and Out went 1812 -> 1817, while the round's reserve delta fell by exactly 5. **Ships are
charged 5 per move, no kind allowance.** MANUAL p.27's "ships use none" is contradicted by the
running code; the brief says code what is measured, so ships are charged.

### 1.4 Shortage

Wrote the spend accumulator `0x1456 = 9999`. The next round opened with the reserve forced to
**0** (not the 40 floor) and paid **40**. Matches "reserve 0 on a shortage round, floor 40
unless short".

### 1.5 Era gating — closed by capture, not disassembly

`re5_alt_1918blue.png` and `re5_alt_1942blue.png` (scenario index `DS:0x19E` = 0 and 1, alt
byte set) show the oil panel slot occupied by the **YEAR** panel: no In/Out/reserve bars. The
two early scenarios carry no fuel meter, which is what `resources.fuel.freeEras` encodes.

## 2. Term table — every Out term against room 7668

`web/server/resources.mjs` `oilFlow()` is the single place these are computed.

| term (7668) | implemented | pinned by | status |
|---|---|---|---|
| `50 x producing paying-cities + 200` | `cityOut` | `t033_oil` rates leg; `economy` opening | PINNED |
| `2 per piece` per round | `perPiece x pieces` | `t033_oil`; `resources` empty-board leg | PINNED |
| `+5 per moving piece` | `moveCostByKind` base 5 in `oilCostPerCell` | `t033_oil`; RE-E5 §1.3 | PINNED (MEASURED) |
| `+ kind allowance for moving land` | infantry 17 = 5+12, tank 29 = 5+24 | `t033_oil` (5+12 / 5+24) | PINNED |
| `20 per air unit` per round | **not implemented** | — | **OPEN** |
| `In = 200 x owned type-5 fields, min 200` | `inPerWell`, `inMinWells` | `t033_oil`; §1.2 | PINNED |
| reserve starts 3000, cap 10000 | `reserve`, `reserveCap` | `t033_oil`; §1.1 | PINNED |
| floor 40 unless short; 0 on a shortage round | `reserveFloor` + `short` | `t033_oil`; §1.4 | PINNED |
| `lost = floor(deficit x cities / lastOut)`, x1.5 capped in 2023 | `oilIncome`, `meter.lastOut` | `t033_oil` | PINNED |

Two honest gaps:

1. **`20 per air unit` is not pinned and not coded.** `FUN_15f4_0664` at decompiled.c 4723
   shows only `0x1452 = paying x 0x32 + 200`; the per-piece term and the air term must come
   from `0x1456`/the 0x0d7e path, and the brief's "20 per air unit" is not visible in the
   lines read so far. Do not claim it until the line is named.
2. **Red's paying-city count disagrees with the original.** Our 1986 board pays Red for 10
   cities; the DOSBox opening shows paid 1150, i.e. 19 cities (`19 x 50 + 200`). Blue's 31
   matches exactly. The difference is a territory/era-table fact, not an oil formula, and it
   predates T-033; it needs its own ticket rather than a silent widening of this one.

## 3. The remake's opening versus the original's

`openMatch("1986", matchSites("1986"))` + `seedOwners`:

| side | fields | paying cities | pieces | In | Out |
|---|---|---|---|---|---|
| blue | 11 | 31 | 2 | 2200 | 1754 |
| red | 8 | 10 | 2 | 1600 | 704 |

- **In matches the original on both sides** (2200 / 1600) — the type-5 field count is right.
- **Blue's paying count matches** (31); the Out difference is entirely the piece term: the
  remake's opening roster places **2 pieces a side**, the original scenario has **31 / 35**.
  With 31 pieces the formula reproduces the measured 1812 exactly (1750 + 62).
- The roster gap is T-013b's subject, not T-033's; T-033's own AC ("opening In and Out match
  RE-E5 within 1 display unit") therefore cannot be met on Out until the roster is full. The
  In leg can be, and is.

## 4. Captures (bytes and md5; CIFS mtime is not a witness)

In `docs/re/evidence/re5/`:

```
5878575358f235861d601ed642d27247  re5_after_return.png
c2e1c8ab01bf38a480589b519e2e7a69  re5_alt_1918blue.png
13bab3b38c5cfa546434ae146e79bf8f  re5_alt_1942blue.png
cd0c1ff10442fea07b65f7d782b3dc71  re5_alt_1986blue.png
7780328d6cea683becbe7f929d26870f  re5_oil_1986blue_open.png
511f604cb46731b051e186ecc46dea3e  re5_alt_1918blue.globals.txt
70dc8b1118a1fb57364e0fd0a9bdece5  re5_alt_1942blue.globals.txt
7e2ad39201444c067dd69062a112c4fc  re5_alt_1986blue.globals.txt
870ca50b15c00ef0dd3981a52cf1a1ce  0_globals_1918blue.txt
9d1d19691db6158e20535457e5e27f0d  0_globals_1942blue.txt
a5cd8a53730f3ceaa2ae358d5a3d115d  0_globals_1986blue.txt
```

## 5. Load bench — the pin that moved, and why

`node tests: 107 passed, 1 failed` on this branch; the one red is `load_test`
(tick 17.0-17.8 ms, headroom 7.9-8.6x against the 10x floor).

Not overhead. With the floor of 40 the faithful settlement never leaves a side dry, so bench
pieces keep moving all window; the old code let the reserve drain to 0, a side went dry, and
the bench stopped exercising movement. Measured over 155,000 ticks, same fixture:

| | move events | attrition | capture | blocked | tick |
|---|---|---|---|---|---|
| branch | 332,810 | 198,832 | 558 | 172 | 17.0 ms |
| pre-change | 144,161 | 90,950 | 44 | 83 | 11.9 ms |

2.3x the movement work at the same tick count. The pin compares 1000 rooms x 8 rounds and the
workload changed; this needs a PM ruling (fix the fixture's activity, or accept 8x), not a
quiet floor edit.

Snapshot cost, as 7670/7696 asked: full snapshot 20.3-21.5 ms and 11.2 KB per dry room in the
bench run above; recorded as a known cost, not a regression.
