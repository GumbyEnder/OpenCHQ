# T-016 — terrain effects, the full original set

Branch `t016-terrain` off `origin/web` `c57086a`. Owner: Game. Task: [[T-016 Terrain effects, full original set]].
Sources: `FUN_194c_000e` (cover), `DS:0x011C` (path cost), `DS:0x1996` via `FUN_1c0d_00b4` (dig-in bit
`0x20`, attrition), `FUN_1c0d_0656` (site repair). Decompiled listing:
`/mnt/nas/Projects/Command HQ/modern/docs/ghidra/export/decompiled.c`.

Every value below lives in `config/game.json` under `terrain`, with a `tag`
(`measured` / `disassembly` / `unverified`), a `source` sentence and an `evidenceRef`. The runtime
reads config; no terrain table is a second copy in code (`web/test/nodes/t016_terrain.mjs` fails if
one appears).

## 1. Path cost — `DS:0x011C` (disassembly)

| terrain | byte | id | note |
|---|---|---|---|
| plain / forest / ocean / lake / shallows / city | 0 | 8, 9, 0-6 | free |
| desert | 3 | 11 | |
| jungle | 9 | 12 | |
| polar | 13 | 13 | |
| wasteland | 77 | 14 | refused by class as well as by cost |

A route whose costs sum to **100 or more is rejected** (`move.walkLine` → `{ok:false, fail:"cost"}`).
The manual's printed "Slowed" column (p.21) disagrees with this table; the bytes are the authority.
The walker reads `pathCostFor(id)` and `walkCostLimit()`; `PATH_COST` is gone from `move.mjs`.

## 2. Crawl speed — Q5, measured (DOSBox)

Harness: `docs/re/evidence/t016/t016_q5.py` (same pass-cursor/walker recipe as the T-008
`q33_cross.py`: pass cursor `DS:0x147c`, round clock `DS:0x157e`). Tank kind 2, one straight corridor
per terrain, same speed byte read back from the save.

| speed | terrain | cells | pass wraps | cells/pass | clock units/cell |
|---|---|---|---|---|---|
| 1 | plain | 3 | 4 | 0.75 | 720 |
| 1 | forest | 4 | 5 | 0.80 | 720 |
| 1 | mountain | 3 | 5 | 0.60 | 1440 |
| 6 | plain | 6 | 5 | 1.20 | 122 |
| 6 | forest | 6 | 7 | 0.86 | 122 |
| 6 | mountain | 6 | 9 | 0.67 | 163 *(one 2-beat cell in six)* |

Reading: **forest is not slower than plain.** Its clock cost per cell is identical (720 at s1, 122 at
s6) and its cells/pass is the same within one pass. The archive's 2-beat stand-in was wrong for
forest. Mountain is **2 beats** at speed 1 and about **1.33 beats** on average at speed 6.

Config: `crawlPace.beats` = forest 1 (measured), mountain 2 (measured), jungle 2 (unverified), polar 2
(unverified); `open` 1, `transport` 2, `refused` -1. `landPace(id)` returns the per-terrain beat
count when config has one, so a bad name is dropped rather than read as open ground.

Not walked: jungle and polar. Their path-cost bytes (9 and 13 of the 24-point allowance) make them
expensive to route but say nothing about time per cell, so they keep the stand-in at 2 beats and stay
tagged `unverified`. See §8.

## 3. Attrition — `DS:0x1996` low 5 bits, Q6 measured

Harness: `docs/re/evidence/t016/t016_q6.py`. One pinned piece per leg, strength 100, one delta read
per **pass-cursor wrap**, 12 wraps:

| terrain | cell | per pass | tag |
|---|---|---|---|
| lake | (194,36) | 3 | measured (T-009b, re-measured here) |
| polar | (36,10) | 5 | measured (T-009b, re-measured here) |
| desert | (200,38) | 3 | measured (Q6) |
| jungle | (89,79) | 3 | measured (Q6) |
| wasteland | — | 31 (0x1f) | disassembly, no board cell exists |
| enemy site militia | any site | 2 + pin | measured (T-009b) |
| unowned site | any site | 20 | measured (T-009b) |
| own site repair | any owned site | +10 every other `FUN_1c0d_0656` call | measured |

Q6 closes the old desert contradiction: desert is **not** inert. The three earlier "flat" desert runs
were sampled while the round clock was `0xffff` — the round was over, no pass ran, so no attrition
fired. Measured here with a live clock: exactly 3 per wrap, twelve consecutive wraps.

Wasteland keeps the byte, not the prose: the dumped `DS:0x1996` byte is **31 (0x1f)**, T-016's spec
text says 34 (that is the carrier column of the damage matrix). No era board contains a wasteland
cell, so no single-piece leg can pin the amount or the "can kill, no 20 % floor" branch; a 1986
nuclear strike could create one, which is not feasible in a pinned probe. Recorded with the conflict
in its `source` line, tagged `disassembly`.

**Not wired as the runtime rate.** These amounts are per *pass*, and passes per round are
speed-dependent (measured ~10.6 wraps/round at s1 and ~62 at s6 in the Q6/Q5 logs). Wiring 3/pass as
3/round would be a 6-60x rate change nobody gated. Runtime stays on `combat.attritionPerRound`, a
labelled per-round stand-in, until the D-017 pacing ruling. The deferral is a filed decision row,
**D-024** in `Decisions.md`, so it survives without this file being read. `config.terrain.attritionPerPass.wired`
is `false` and the node test asserts it.

## 4. Defence cover — `FUN_194c_000e` (measured, wired in T-015)

Read off the defender's terrain byte, applied to the matrix cell before flank/rear. No attacker
terrain bonus exists in the original.

| defender | terrain | arithmetic | hand check |
|---|---|---|---|
| infantry / dug-in (kinds 1,3) | city, capital, base | `dmg - (dmg+1)/3` | 20 → 13 |
| tank (kind 2) | city, capital, base | `dmg - dmg/5` | 20 → 16, 26 → 21 |
| infantry / dug-in | mountain | `dmg - (dmg>>2)` | 20 → 15 |
| tank | mountain | `dmg - dmg/6` | 20 → 17, 26 → 22 |
| any | plain, lake, desert | none | 20 → 20 |

Only the terrain **id sets** are config (`cover.value.cityLike`, `cover.value.mountain`); the
integers stay in `combat.coverFor` and the node leg pins them as literal arithmetic, because a
factor-keyed assertion stays green with the branch deleted.

## 5. Shore fire cap — disassembly, wired and labelled

Fire **beyond 2 cells** by a sea attacker at a land target caps damage at `(target strength - 30)`;
under 25 strength the shot is halved instead. `config.terrain.shoreFire` = `{range: 2, cap: 30,
halveBelow: 25, wired: true, tag: "disassembly"}`. `combat.damageFor` applies it as the last step and
reports `shoreFire: true` on the hit.

The two clauses overlap on a target at 25-30 strength, where `strength - 30` is zero or negative
(at 30 the cap is `max(0, 0) = 0`). The implementation reads the halving clause as operative under 25
and the cap as "a long shot cannot take a target below 30" otherwise, so **25-30 is an immunity
band**. PM ruling 2026-11-14 (room 4572), interim: that reading is kept with no behaviour change and
the label stays `disassembly`. The cruiser pin at `00f78a2` (`web/test/nodes/t016_terrain.mjs`)
asserts the arithmetic the implementation produces — s=20 and s=24 → 6 (halved), s=25-30 → 0,
s=31 → 1, s=45+ → 12 — so every number in that row is a test assertion, not a probe readout. It runs
the remake's code and is not a live leg of the original. Q47 stays "ruled (interim), measure later";
the DOSBox leg is pending, not blocked: placement unverified (Q45, room 4615/4616).

## 6. Dig-in terrain bits — `DS:0x1996` bit `0x20` (disassembly)

Bit `0x20` is set on plain, forest, mountain, oilfield, desert and jungle (ids 7-12), and not on
ocean, shallows, lake, city, capital, base, polar or wasteland. `tickEntrench` and the entrench order
now refuse ground without the bit, so auto dig-in no longer happens on a city or capital cell.
Spawned garrisons are `entrenched: true` from dispositions and are unaffected, so the accepted T-015
AC6 hand-check behaviour is unchanged.

## 7. Walker classes and known deviations

Class / terrain-entry rules are unchanged and live in `docs/re/RULES.md` section 2: transports on
water only, land units on land, wasteland refused, no land unit entering ocean. D-018 (the deliberate
one-cell water gap in lane routing) stays a deviation; T-016 does not reopen it.

## 8. Still unverified / open questions

- **Q5 (jungle, polar).** Not walked. Both keep the 2-beat stand-in, tagged `unverified`. A leg needs
  a straight jungle corridor and a straight polar corridor with a controllable neighbour set; the
  polar terrain in the 1986 extract is a rim strip, so the corridor has to be chosen carefully.
- **Q6 (wasteland).** No wasteland cell exists on any era board. The amount is the dumped byte 31 and
  the spec prose says 34; no leg can settle which is right without creating a wasteland cell (1986
  nuclear strike). Both the byte and the conflict are recorded.
- **Q47 (ruled interim 2026-11-14, room 4572).** Shore fire: which clause wins for a 25-30 strength
  target, and whether the cap is a floor on damage or on remaining strength. Ruled: the cap is a
  floor on remaining strength, `max(0, s-30)`, and the shot is halved under 25, making 25-30 an
  immunity band. Behaviour unchanged, label stays `disassembly`; the DOSBox leg is pending.
- **D-017 / D-024.** Per-pass attrition cannot become a per-round rate while passes per round depend
  on speed. Runtime stays on the labelled per-round stand-in; the deferral is decision **D-024**.

## 9. Evidence

All paths are in-repo (AC6):

- `config/game.json` — `terrain.pathCost`, `terrain.crawlPace`, `terrain.cover`, `terrain.digIn`,
  `terrain.attritionPerPass`, `terrain.shoreFire`
- `web/test/nodes/t016_terrain.mjs` — AC1/AC2 node leg
- `docs/re/evidence/t016/t016_q5.py`, `q5-plain-s1.txt`, `q5-forest-s1.txt`, `q5-mountain-s1.txt`,
  `q5-plain-s6.txt`, `q5-forest-s6.txt`, `q5-mountain-s6.txt`
- `docs/re/evidence/t016/t016_q6.py`, `q6-desert.txt`, `q6-jungle.txt`, `q6-polar.txt`,
  `q6-lake.txt`
- `docs/re/COMBAT.md` (`FUN_194c_000e`), `docs/re/RULES.md` §2, `docs/re/MOVEMENT.md`
