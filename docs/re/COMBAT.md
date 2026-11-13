# COMBAT.md — how the original resolves a fight (T-009, 2026-11-13)

Source: `decompiled.c` (Ghidra export, `/mnt/nas/Projects/Command HQ/modern/docs/ghidra/export/decompiled.c`)
plus a live read of the running image (DOSBox 0.74-3, machine=ega, cycles=auto, 1942 blue match,
Xvfb :99). Every array below was dumped twice — from `CHQ_unpacked.EXE` and from live DGROUP — and
agrees. Addresses are segment:offset as Ghidra names them; `tools/disasm.py dis <seg>:<off>` decodes
the real bytes.

Live capture scripts: `~/agents/game/notes/t009/` (`tables.py` static dump, `t009_probe.py`
repair/attrition/range legs, and the duel harness left by the AC2 runs). Transcripts: this file.

## 1. Where combat lives

The per-piece pass `FUN_15f4_0002 @ 15f4:0002` (decompiled.c 4369-4606) is the clock. It walks the
100-record visit order and, for each piece, calls in this order:

| Call site | Routine | What it does |
|---|---|---|
| 4542 | `FUN_194c_0832 @ 194c:0832` (7395-7549) | target acquisition: picks the enemy, writes `0xbde` |
| 4545 | `FUN_194c_000e @ 194c:000e` (7020-7133) | **one exchange**: damage matrix + modifiers, applies it |
| 4532 | `FUN_1c0d_00b4 @ 1c0d:00b4` (9030-9110) | per-pass terrain/site handler: attrition, militia fire, site capture |
| 4548 | `FUN_1c0d_02ce @ 1c0d:02ce` (9114-9265) | site capture / win bookkeeping |
| 4549 | `FUN_1c0d_0656 @ 1c0d:0656` (9269-9360) | repair, entrench, flag upkeep |
| — | `FUN_194c_03ba @ 194c:03ba` (7175-7223) | the only function that removes strength (`0x89e`) |
| — | `FUN_194c_0486 @ 194c:0486` (7224-7392) | death/removal |
| — | `FUN_1ac5_0dbe @ 1ac5:0dbe` (8679-8826) | air strike resolution |

Distance is `FUN_188b_0216 @ 188b:0216` (6496-6519): it returns **dx² + dy²** (X wraps at 0xA0 =
160 in the doubled frame; the board is 320 cells wide, so 0xA0 is the half-width). Every "range"
number below is therefore a *squared* threshold, not a cell count.

### The piece table fields that carry a fight

There is no record struct; all fields are parallel arrays indexed by the record number 0..99
(`docs/re/STRUCTS.md` §6).

| Offset | Type | Meaning |
|---|---|---|
| `0x89e + i` | byte | **strength**, 0..100 (`0x64`) |
| `0x906 + i` | byte | status: bits 7:6 owner (`0x40` blue, `0x80` red), bits 3:0 **kind**; 0 = empty slot |
| `0xbde + i` | byte | target link (unit index, `0xff` = none) |
| `0xc46 + i` | byte | flags: `0x40` has destination, `0x20` active, `0x10` took damage, `0x08` fired, low 3 bits movement state |
| `0x7ce + i` | byte | facing: 2 north, 3 south, 4 east, 5 west, 0 none |
| `0xd16 + i` | byte | settle counter |
| `0x836 + i` | byte | terrain class at the last move (stale after a teleport) |
| `0x6fe + i*2` | dword | move points (`FUN_194c_03ba` subtracts damage here too) |
| `0xcae + i` | byte | bit 3 toggles per visit: the "every other pass" gate for repair/entrench |

## 2. Damage per exchange (Q4)

`FUN_194c_000e` reads one byte and then modifies it:

```
bVar3 = byte[targetKind + attackerKind*9 + 0x18f0]      # 7044, mov al,[bx+si+0x18f0]
```

Live dump of `0x18f0` (2026-11-13, `notes/t009/tables.py`). Row = attacker kind, column = target
kind. Row 0 is **not table data** — it overlaps the tail of the string `"ly = %d."`, which is why the
first nine bytes read `108 121 32 61 32 37 100 46 0`; kind 0 is an empty slot (allowance 0, cannot
move), so row 0 is never used. Column 0 holds stale bytes for the same reason.

```
        tgt 0   1   2   3   4   5   6   7   8
atk 1      0  20  17  15   0  25  25  35  35
atk 2     35  26  20  20   0  25  25  35  35
atk 3     35  20  17  15   0  25  25  35  35
atk 4      0   0   0   0   0   0   0   0   0
atk 5      0  18  16  14   0  10  10   5   5
atk 6      5   9   8   7   0  10  10   5   5
atk 7      5   0   0   0   0 100 100  25  34
atk 8     34  12  10   6   0  50  50  34  25
atk 9     25  10   8   5   0  50  50  25  20
```

Kind names used below (numeric byte is measured, name is the manual's hardware): **1 infantry,
2 tank, 3 entrenched infantry** (1 + 2, see §4), 7 submarine, 8 cruiser, 9 carrier. Kinds 5/6 are
AI-side hulls, kind 4 unused.

Pairings the eras actually field (matrix cell → live leg):

| Pairing | Damage | Source |
|---|---|---|
| tank (2) → entrenched infantry (3) | 20 | matrix 2→3; live, 3 repeats (AC2 leg 1) |
| entrenched infantry (3) → tank (2) | 17 | matrix 3→2; live, 3 repeats (AC2 leg 2) |
| tank (2) ↔ tank (2) | 20 each way | matrix 2→2; live, 3 repeats each way (AC2 leg 3) |
| cruiser (8) ↔ cruiser (8) | 25 each way | matrix 8→8; live, 3 repeats (AC2 leg 4) |
| infantry (1) → tank (2) | 17 | matrix |
| tank (2) → infantry (1) | 26 | matrix |
| sub (7) → cruiser (8) / carrier (9) | 34 | matrix |
| cruiser (8) → sub (7) | 25 | matrix |

The matrix is **per pairing**, not per attacker, and the runtime now reads it directly:
`combatRules()` builds a 9×9 from `measured.combat.damageMatrix.rows` and `baseDamageFor()` indexes
`attackerKind*9 + targetKind` (gate 3557 item 2). `baseDamage` survives only as the fallback for a
kind with no row.

Three things about the table's shape matter when wiring it:

- **Column 0 is data, not padding.** When the TARGET is kind 9 (carrier) the original's index is
  `a*9 + 9`, which is the *next row's* column 0. Those bytes are `kindNineColumn` in config:
  infantry/tank/entrenched → 35, kind 5/6 → 5, sub/cruiser → 34, carrier → 25. A cruiser therefore
  hits a carrier for 34, not the 25 of a cruiser-vs-cruiser cell.
- **Kind 3 is a defender column.** Entrenchment is a kind change, so the discount is
  `matrix[a][3]` (20→15, 26→20), not a multiplier. `entrenchDamageFactor` is 1 so it is not
  counted twice.
- **Kind 4 is unused** (all zeros except the stale column-0 byte); kinds 5/6 are AI-side hulls.

### Modifiers applied to that byte, in code order

1. **Defender's terrain cover** (7043-7062, `bVar2 = byte[target + 0x836]`):
   mountain (10): defender kind 1/3 takes −25 %, kind 2 takes −1/6.
   capital/base/city (4/5/6): defender kind 1/3 takes −(dmg+1)/3, kind 2 takes −dmg/5.
   **Not wired**: the remake has no per-cell terrain class on a piece, so this is T-009b.
2. **Flank / rear** (7064-7071): only when attacker kind < 7, target kind < 5, and the target's own
   link is a *third* piece (not `0xff`, not the attacker). Compare the **attacker's facing** with
   the defender's: same facing → **×2** (rear); otherwise, if the attacker's facing is not the
   defender's opposite, **×1.5** (flank); facing each other → ×1. Ships are never flanked and subs
   never flank. Live: one rear hit measured 40 against a 20 baseline (×2 confirmed).
   Wired in `damageFor()` with `rearMultiplier`; a piece with no facing byte is read as facing the
   defender, and the bonus requires `defender.fighting` to name someone else.
3. **Ship firing at land from beyond 2 cells** (7082-7093): `cap = targetStrength − 30`; halved when
   the cap is under 25. Only for attacker kind > 6 against target kind < 5 and dist² > 2.
   **Not wired** (T-009b).
4. **Subs cannot engage land at all**: the range matrix column for land is 0 for kind 7, so a sub
   never acquires a land target — and the damage cell 7→land is 0, so a pairing that slips through
   deals nothing.

## 3. Ranges (Q7, Q26)

`FUN_194c_0832` converts a kind into a range class (`0x194c`, live `0 0 0 0 0 1 1 2 3 4 5 5` for
kinds 0-11: 0-4 → class 0, 5-6 → 1, 7 → 2, 8 → 3, 9 → 4, 10-11 → 5) and reads the 6×6 matrix at
`0x1956`, row = attacker class, column = target class, values are **dist² thresholds**. Column 5 is
reused as the piece's own contact range (`byte[class*6 + 0x195b]`, read at 7463, 7494, 9151).

```
        tgt c0  c1  c2  c3  c4 | own
cls 0       5   5   2   2   2 |  26
cls 1       5   5   2   2   2 |  10
cls 2       0   5   5   5   5 |  17
cls 3      10  10  10  10  10 |  26
cls 4      17  17  17  17  17 |  37
cls 5       0   0  20  20  20 |  20
```

Reading: two pieces engage at `dist² ≤ matrix[own][target]`; they "notice" each other at
`dist² ≤ own` (column 5) and set the contact movement state.

| Unit | Class | Engage threshold | Cells (max Δx,Δy) | Manual |
|---|---|---|---|---|
| land (kinds 0-4) | 0 | 5 vs land | 2 (2,1) | p.22 icons overlap → 1; **2 measured** |
| submarine (7) | 2 | 5 vs ships, **0 vs land** | 2 (2,1) | p.24 range 2 ✓ |
| cruiser (8) | 3 | 10 vs everything | 3 (3,1) | sub < cruiser ✓ |
| carrier (9) | 4 | 17 vs everything | 4 (4,1) | cruiser < carrier ✓ |

Land combat start distance is **2 cells** (dist² ≤ 5 allows (2,1), not (2,2)), which is what the
remake's `landEngageCells: 2` inferred from overlapping icons. Sea ladder 2 < 3 < 4 matches p.42,
and the sub's 2 matches p.24.

## 4. Entrenchment (Q4)

Entrenchment is a **kind change, not a timer**: `FUN_1c0d_0656` at 9287-9290 turns infantry kind 1
into kind 3 when the piece has no target (`0xbde == 0xff`), did not move, and stands on a terrain
whose `0x1996` byte has bit `0x20` set (plain, forest, mountain, oilfield, desert, jungle).
Ordering a move reverts it (`status -= 2` at 4523-4525). There is no round count in the original:
it flips on the first eligible pass, and every unit placed at setup on such ground opens as kind 3
— measured, and the reason all five AC2 live legs used kind 3 for "infantry".

Effect: the entrench factor shows up as the kind-3 column of the damage matrix — 20→15 against
infantry, 26→20 against tanks. The runtime gives an entrenched infantry defender code 3 and reads
that column; `entrenchDamageFactor` is 1.0 exactly so the discount is not applied twice.

Terrain cover (§2.1) is a *separate* multiplier on top, applied to the defender's terrain class; it
is not wired yet (T-009b).

## 5. Attrition and repair (Q6)

Both run **per pass**, not per round. The pass rate is speed-dependent (T-008: 11.75 s/pass at
speed 1), so a per-round rate only exists once a speed is chosen — that is D-017's problem, and the
reason these two stay reference rows in config.

**Attrition** — `FUN_1c0d_00b4`, table `0x1996` indexed by terrain (`0 244 0 3 244 244 244 224 96
96 32 35 35 5 31` for terrains 0-14 = ocean, docks, ocean2, lake, capital, base, city, oilfield,
plain, forest, mountain, desert, jungle, polar, wasteland). Bits: `0x80` = apply through the combat
path (sound/event), `0x20` = dig-in terrain, low 5 bits = the amount.

| Terrain | Amount | Note |
|---|---|---|
| desert (11), jungle (12) | 3 / pass | |
| polar (13) | 5 / pass | |
| wasteland (14) | 34 / pass, **destroys** at ≤ 0 | separate branch at 9044-9051 |
| lake (3) | 3 / pass | land can stand there (Q33) |
| docks/base/city/capital with no site row | 20 / pass | `0xf4` through the combat path |
| ocean, plain, forest, mountain, oilfield | 0 | mountain/oilfield carry `0x20` only |

The **20 % floor** in p.21 is the `strength − 20` term at 9089-9093 (`min(amount, strength−20)`): a
unit stops losing strength to terrain at 20, and nothing but wasteland can kill it. 20 is 20 % of
the 100 bar, so the manual and the code agree on the floor and disagree on the terrain list.

**Repair** — `FUN_1c0d_0656` at 9291-9297: `strength += 10` when all of: no destination, no fight
this or the previous pass (`0xc46 & 0x58` clear both), `strength < 100`, the piece stands on its own
site, and `0x1986[terrain] != 0` (docks 2, capital/base/city/oilfield 1, everything else 0). Clamp
100 at 9303. Gated by the `0xcae` bit-3 toggle, which **flips on every call** of the routine
(`0xcae ^= 8` at 9283) and repairs only when the bit comes up clear — so it is +10 on every *other*
call, not once per round.

Units, stated explicitly (gate 3557 item 3):

| Unit | Value | How it was measured |
|---|---|---|
| per eligible call | **+10** | live leg: strength 40 → 50 across two pass wraps on a blue city, one +10 step |
| per pass, averaged | **+5** | the bit-3 skip halves the call rate; arithmetic, not a second measurement |
| per round, speed 1 | **≈ +59** | 5 × 11.75 passes/round (T-008 pass rate). Moves with speed, so reference only |

The runtime's `repairPerRound` stays the STAND-IN 5 until D-017 picks a per-round interpretation; the
measured figures live in `measured.combat.repairPerPass` as reference rows.

**Militia** (`FUN_1c0d_00b4` 9056-9077): standing on an **enemy-owned** site costs 2 strength per
pass and zeroes the piece's move points (−10) — pinned against the town. Standing on an **unowned**
site costs 20 per pass until the capture lands. City militia damage is therefore 2 (enemy city) or
20 (neutral city), not one number; the runtime's single `militiaDamage` is a stand-in for both.

## 6. Air strikes (p.25)

`FUN_1ac5_0dbe` at 8795-8814, after the aircraft survives the run in:

| Target | Damage | Leaves |
|---|---|---|
| land (kind < 5) | `(strength >> 1) + 1` | 100 → 49 (halves, minus one) |
| kind 5, 6, 7 | 34 | 100 → 66, 32, 0 (three strikes) |
| kind 8, 9 (cruiser, carrier) | 25 | 100 → 75, 50, 25, 0 (**four** strikes) |

So "halves remaining strength" is confirmed to within one point, and "three strikes sink a ship" is
true only for kinds 5-7: a cruiser or carrier needs four. **MANUAL-CONTRADICTED, Manual p.25** —
code governs the port, `FUN_1ac5_0dbe @ 1ac5:0dbe`, not ported silently.

## 7. Pinning and the exchange rate

- **No pin duration exists.** Contact is recomputed every pass: while an enemy is in engage range
  the piece's movement state (low 3 bits of `0xc46`) is set to "in contact" and an ordered move is
  refused; when the enemy dies or leaves, the state clears. `pinRounds` in config is a remake
  invention with no original counterpart — keep it labelled STAND-IN.
- **The original fires every pass in contact**, not every other round. `shotEveryRounds: 2` is the
  manual's p.22 sentence and the remake's pacing choice (D-017), not a measurement. Per-round
  damage therefore scales with the speed setting.

## 8. What the remake now runs on (config)

`config/game.json` `combat` block: every key carries a `source` label plus, for measured values, an
`evidenceRef` (capture path and date). `web/test/nodes/measured_combat.mjs` pins the block: a missing
key fails, a MEASURED row without an evidenceRef fails, the per-exchange numbers must equal the
matrix values above, and the pairing calls (`baseDamageFor`, `damageFor`) are asserted cell by cell
including the kind-9 alias and the ×2 rear / ×1.5 flank / ×1 front orientation. Per-round rates
(attrition, repair) ship as `reference` rows beside the runtime stand-in until Shane rules on D-017.

## 9. Contradictions with the manual

Ruling (room 3544 item 1): where the code and the manual disagree, **the code governs the port**.
Each case is labelled MANUAL-CONTRADICTED here and in the config `source` string, with the page and
the function.

1. **MANUAL-CONTRADICTED, Manual p.25: "three strikes sink a ship".** True only for kinds 5-7
   (34 per strike: 100 → 66 → 32 → 0). Cruisers and carriers (kinds 8/9) lose 25 per strike and
   need **four**: 100 → 75 → 50 → 25 → 0. `FUN_1ac5_0dbe @ 1ac5:0dbe`, 8795-8814. Config:
   `combat.airStrikeSeaAmount` and `measured.combat.airStrike.manualContradiction`.
2. p.22 "every other round": the original fires every pass while in contact. `shotEveryRounds: 2`
   is the remake's pacing choice (D-017), labelled DELIBERATE DEVIATION, not a measurement.
3. p.25 "halves": `(str>>1)+1`, so 100 → 49, one point under half.
4. p.22 entrenchment: real, but implemented as kind 1 → 3 and expressed in the damage matrix, so it
   is not a single multiplier; terrain cover is a second, separate modifier.
5. **No p.21 contradiction.** The interim 3543 note ("only wasteland") was the destroy branch, not
   the table. `0x1996` carries desert/jungle 3, polar 5, lake 3, city/base/capital/dock 20 and the
   20 % floor, exactly the terrains p.21 lists; only the amounts (and wasteland's 34) are new.
   Corrected by PM 3557, and the Original Rules entry is being fixed there.

## 10. Open, and what T-009b owns

**Q38 — the unexplained 2-5 point crowded-board effect.** On boards with three or more shooters a
secondary loss of 2-5 strength sometimes appeared on a piece that no sampled exchange had fired at.
Sampling: `watch.py` polled all 100 records' `0x89e` strength every 30 ms during the 1942 duels and
printed every delta; the effect never appeared in the isolated duels (nearest other piece ≥ 60 cells)
and only on crowded boards, so it is not the exchange itself. It is **not in config**; Q38 in the
vault Open RE Questions carries the observation and the sampling method. T-009b ran the scan for
60 s on the crowded 1942 board (§11) and saw **0 deltas, 0 unattributed**: the board was idle, so the
loss did not reproduce. Q38 stays open with the experiment it names: the crowded trio plus the pass
counter and per-pass deltas, sampled at a turn resolution rather than after it.

**T-009b (follow-up, not a blocker).** The legs the T-009 harness could not reach are closed in §11
except the air strike. Items 1-4 below are historical; the outcome is §11.

1. Flank ×1.5 live leg — closed: 30 on two clean repeats (§11 table).
2. The ordered-infantry entrench pair (kind 1 vs kind 3) — closed: 26 then 20 (§11 table).
3. City cover live leg — closed by placing the defender on a city terrain byte it already carried:
   13 vs 20 on plain (§11 table).
4. The air-strike / wasteland-attrition / sea-range ladder live legs — sea ladder closed (§11 table);
   attrition part-closed, desert **did not fire** (§11 table); air strike still UNMEASURED, event path
   exercised (§11 table).
5. Runtime wiring still absent: terrain cover (§2.1) and the ship-vs-land cap at >2 cells (§2.3).

## 11. T-009b live legs (2026-11-13)

DOSBox 0.74-3, `CHQ.EXE`, 1942 board. Evidence: `docs/re/t009b/` (README indexes every file, the
harness is self-contained in `docs/re/t009b/harness/`). No runtime value changed: only the `source`,
`status` and `evidenceRef` strings moved, so there is no redeploy and no user-visible delta.

| value | live reading | runs | evidence |
| --- | --- | --- | --- |
| flank ×1.5 | 30 against the 20 cell (2→3) with a third piece present and the attacker perpendicular; repeat 1 read 20 with the facing byte re-pinned, logged | 3 | `flank-2026-11-13.txt` |
| entrench pair | 26 as kind 1 (cell 2→1), then 20 as kind 3 (cell 2→3), same tank, same cell | 1+1 | `entrench-2026-11-13.txt` |
| city cover | 13 on a city terrain byte vs 20 on plain; cover is a separate modifier, `20 - (20+1)/3 = 13` | 2+2 | `cover-2026-11-13.txt`, `cover-open-2026-11-13.txt` |
| attrition lake / polar | 3 and 5 per pass, no shooter | 1 each | `attrition-lake-polar-2026-11-13.txt` |
| attrition floor | lake 22 → 20, then flat for 30 s | 1 | `attr-lake-floor-2026-11-13.txt` |
| attrition desert | **did not fire**: 100 flat, 22 flat, and move points held at 16 — all on isolated desert cells | 3 | `attrition-desert-2026-11-13.txt` |
| wasteland 34 | **UNMEASURED**: the 1942 board has 0 wasteland cells; a forced `0x836`=14 lost nothing in 25 s, plain control also nothing | 2 | `terrain-scan-1942-2026-11-13.txt`, `wasteland-2026-11-13.txt`, `wasteland-control-2026-11-13.txt` |
| militia | enemy site 2, unowned site 20, own site 0 | 1 each | `militia-2026-11-13.txt` |
| sea range ladder | sub fires at d2=4 not d2=9; cruiser at d2=9 (34) not d2=16; carrier at d2=16 (25 twice) not d2=25 | 2/2/2 | `range-sub-cruiser-carrier-2026-11-13.txt` |
| air strike (land and ship) | **UNMEASURED**: code-7 events consumed (wp/rp advanced), target unchanged at 100; 200-event burst landed nothing | 2+2 and 200 | `air-2026-11-13.txt`, `air-ship-2026-11-13.txt`, `air-burst-2026-11-13.txt` |
| Q38 | 60 s full-board scan: 0 deltas, 0 unattributed | 1 | `q38-2026-11-13.txt` |

**Desert is a live contradiction, reported not changed.** The `0x1996` byte for desert is 35 = 0x23
(amount 3, dig-in bit 0x20). Its neighbours without the 0x20 bit (lake 3, polar 5) fire per pass;
desert did not damage a stationary piece at 100 or at 22, nor a piece carrying move points. The
pattern: the two entries that fired carry no flag bits, both that did not (desert `0x23`, wasteland
`0x1F`) carry `0x20`/`0x10`. The config now says PART MEASURED and names the runs; the table value is
untouched.

**Wasteland 34 is UNMEASURED.** The 1942 board has no wasteland cell at all (0 of 43,520 terrain
nibbles), so there is nothing to stand on. Forcing `0x836`=14 on an isolated cell lost nothing in
25 s, and the plain control lost nothing either. Next step: a 1986 board, a nuke to paint the cell,
then the same leg on the painted cell.

**Air strike.** The dispatch is real: `FUN_1ac5_0dbe`, 5-byte records in the ring at `DS:0xEFBC`,
pointers `0xE940`/`0xE42A`. Injected events drain and the target never loses strength, so an injected
event cannot reach the damage call; the gate is upstream (`FUN_1ac5_1206`, enemy aircraft within 3
cells, then the random at `0x148a`). Next step: drive the real UI command (`FUN_1ac5_0390`) or stage
an enemy aircraft record that survives the pass loop.

