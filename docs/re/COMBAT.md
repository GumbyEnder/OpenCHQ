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

The matrix is **per pairing**, not per attacker: a flat `baseDamage` per kind cannot represent it
(it is why the sub one-shots a kind-5 hull and does 0 to land). The runtime keeps one number per
kind; the pairing matrix is recorded in `config.measured.combat.damageMatrix`.

### Modifiers applied to that byte, in code order

1. **Defender's terrain cover** (7043-7062, `bVar2 = byte[target + 0x836]`):
   mountain (10): defender kind 1/3 takes −25 %, kind 2 takes −1/6.
   capital/base/city (4/5/6): defender kind 1/3 takes −(dmg+1)/3, kind 2 takes −dmg/5.
2. **Flank / rear** (7064-7071): only when attacker kind < 7, target kind < 5, and the target's own
   link is a *third* piece. Same facing as the attacker → **×2** (rear). Facing not opposite →
   **×1.5** (flank). Facing each other → ×1. Live: one rear hit measured 40 against a 20 baseline
   (×2 confirmed). Ships are never flanked (attacker kind<7 requirement) and subs never flank.
3. **Ship firing at land from beyond 2 cells** (7082-7093): `cap = targetStrength − 30`; halved when
   the cap is under 25. Only for attacker kind > 6 against target kind < 5 and dist² > 2.
4. **Subs cannot engage land at all**: the range matrix column for land is 0 for kind 7, so a sub
   never acquires a land target.

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

Effect: the entrench factor shows up as the kind-3 column of the damage matrix, so it is not one
multiplier — 20→15 against infantry (0.75), 26→20 against tanks (0.77). `entrenchDamageFactor`
0.75 is the shipped mapping; the second row is the honest caveat.

Terrain cover (§2.1) is a *separate* multiplier on top, applied to the defender's terrain class.

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
100 at 9303. Gated to every other pass by the `0xcae` bit-3 toggle.

Live leg (`notes/t009`, 2026-11-13, 1942 blue): strength 40 → 50 in two pass wraps, one +10 step,
on a blue city. Rate: +10 per 2 passes ≈ +59 strength per round at speed 1 (11.75 passes/round).

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
true only for kinds 5-7: a cruiser or carrier needs four. Flagged as a manual contradiction, not
ported silently.

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
key fails, a MEASURED row without an evidenceRef fails, and the per-exchange numbers must equal the
matrix values above. Per-round rates (attrition, repair) ship as `reference` rows beside the runtime
stand-in until Shane rules on D-017.

## 9. Contradictions with the manual

1. p.22 "every other round": the original fires every pass.
2. p.21 attrition list: only desert/jungle (3), polar (5), lake (3) and wasteland (34) are per-terrain
   losses; city/base/capital/docks only bite through the site branch (2 or 20). The 20 % floor holds.
3. p.25 "three strikes sink a ship": four for cruisers and carriers (25 per strike).
4. p.25 "halves": `(str>>1)+1`, so 100 → 49, one point under half.
5. p.22 entrenchment: real, but implemented as kind 1 → 3 and expressed in the damage matrix, so it
   is not a single multiplier; terrain cover is a second, separate modifier.
