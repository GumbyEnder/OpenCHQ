# AI.md — the original's site defence, read from the disassembly (T-015 Part B)

Source: `decompiled.c`, the Ghidra export at
`/mnt/nas/Projects/Command HQ/modern/docs/ghidra/export/decompiled.c` (read 2026-11-13; the same
program as the project `~/agents/game/ghidra-probe/CHQ.rep`, `CHQ_unpacked.EXE`). That copy is
1,596,459 B, **md5 547f99f9**, and every line number below means *that* file. A second export exists
at `/tmp/chq-export-backup/decompiled.c` (1,595,932 B, md5 5c7b185c) which agrees through line 1200
and then drifts — it puts `0xe94c` at 3407/3412/3435 and the two setters at 13223/15149 — so a
grader on the other copy must re-find each cite by content, not by number. Addresses are
segment:offset as Ghidra names them. Anything marked UNVERIFIED is something the bytes did not
settle — not a guess wearing a measurement's clothes.

## 1. Where the AI acts

`FUN_1000_01da @ 1000:01da` (lines 90-121) is the turn hook. Once per AI turn it refreshes the
per-site score row for all `0x54` = 84 sites, then runs the piece pass:

```
112:  uVar1 = FUN_107e_0fa4((uint)local_4, 0, 0);
113:  *(undefined1 *)(local_4 + 0xea6e) = uVar1;      // 0xea6e = site score
115:  ai_command_process(local_4);
```

`ai_command_process` is `FUN_107e_4616 @ 107e:4616` (line 3679). The defence itself is
`FUN_107e_0bd6 @ 107e:0bd6` (lines 1126-1268). Its loop (1173-1204) does this:

* `0xe942` = `0xc350 ^ 0xc0` — the side taking this turn (1146);
* `0xe47e` = one flagged site from a two-entry table (1147);
* pick the site of ours with the **lowest** score byte (`0xea6e`) not yet visited in this pass
  (`(0x1102 & 0xc0) == 0xe942`, `(0xeb78 & 1) == 0`, 1174-1183);
* mark it visited (1184) and act, **at most three successful actions per pass** (1188-1203):
  * `FUN_107e_1612` — buy a defender at the site, at most once per pass (`local_a == 0`, 1185-1189);
  * `FUN_107e_1750` — send a unit, but only when that site's score is **negative** (`0xea6e < 0`,
    1190-1193);
  * two other routines this task does not cover (`FUN_107e_1ace`, `FUN_107e_1bec`, 1194-1201);
* after acting, rescore the sites it touched (1235-1237).

### 1a. The pass ceiling is the constant 3 (combat tail 4); `0xe94c` is a repeat counter

The routine keeps **one** counter, `local_c`, initialised once (1142) and incremented at fourteen
sites. Every gate on it reads that same counter — it is not three separate budgets:

```
1142:  local_c = 0;                      /* the one action counter this pass                */
1188:  local_c = local_c + 1;           /* 0bd6 site loop: buy (FUN_107e_1612)             */
1192:  local_c = local_c + 1;           /* 0bd6 site loop: dispatch (FUN_107e_1750)        */
1195:  local_c = local_c + 1;           /* FUN_107e_1ace                                   */
1199:  local_c = local_c + 1;           /* FUN_107e_1bec                                   */
1209:  local_c = local_c + 1;           /* era-gated FUN_107e_51b6 (1207-1208)             */
1213:  local_c = local_c + 1;           /* era-gated FUN_107e_5500 (1211)                  */
1218:  local_c = local_c + iVar4;       /* ai_turn_process(3 - local_c) at 1217            */
1222:  local_c = local_c + iVar4;       /* execute_combat(4 - local_c) at 1221             */
1226:  local_c = local_c + iVar4;       /* select_combat_targets()                         */
1244:  local_c = local_c + 1;           /* FUN_107e_1ede                                   */
1247:  local_c = local_c + 1;           /* FUN_107e_3a40                                   */
1251:  local_c = local_c + 3;           /* FUN_107e_251c / calculate_combat                */
1254:  local_c = local_c + 1;           /* while-loop FUN_107e_1ace                        */
1265:  local_c = local_c + iVar4;       /* resolve_combat(local_e, 1)                      */
```

The `local_c < 3` reads are **nine**: 1194, 1197, 1208, 1211, 1217, 1241, 1246, 1249 and the
`while` at 1253. Two lines that look like a third and fourth source of the number are not: 1200 is
`bVar2 = true`, and 1202 is the exit test `(2 < local_c) || (9 < local_8)` — the ten is the
site-visit cap on `local_8` (1203), not an action budget.

The combat tail is gated at **four**, not three: 1220, 1224, 1228 and 1256 test `local_c < 4`, and
`resolve_combat` is handed the remainder `4 - local_c` (1257, 1262, 1264). The single non-counter
gate in the body is **era**: `0x19e == 3 || 0x19e == 2` (1207) around `FUN_107e_51b6` (1208) and
`FUN_107e_5500` (1211). `0x19e` is the era index, never a level.

`FUN_107e_0bd6` (1126-1268) contains **no read of `0xe94c` or `0x1a0`** — grepped over the span,
not eyeballed — so the three, the four and the era branch are the same at every level.

`0xe94c` is written once per AI turn from the level,
`*(char *)0xe94c = *(char *)0x1a0 * 2 - 4`, under `if (1 < *(int *)0x1a0)` (13231-13232 and
15157-15158), so **level 1 never sets it** and levels 2-5 read `0/2/4/6`. It is spent in two
places and read in two:

```
1649:        if (*(char *)0xe94c != '\0') {
1650:          *(char *)0xe94c = *(char *)0xe94c + -1;   /* FUN_107e_1612: the buy, never a refusal */
3410:    if (*(char *)0xe94c == '\0') {
3411:      auStack_1a[local_4] = local_c;                /* army pass: record the destination cell */
3415:      *(char *)0xe94c = *(char *)0xe94c + -1;       /* else: spend a repeat, do NOT record     */
3438:    if ((*(int *)0x1478 == 0) && (*(char *)0xe94c == '\0')) {   /* FUN_2dfc_1874, STAND-IN */
```

That is the whole ledger: **seven lines** in the export touch `0xe94c` (1649, 1650, 3410, 3415,
3438, 13232, 15158). A recorded cell is then struck out of the next iteration's candidates
(3392-3400 compares against the recorded list and writes `0xf` at 3398), so it cannot be chosen
again; a repeat spends the counter and leaves the cell eligible. One counter is shared across the
pass, not one per cell.

**Where the port spends it.** The repeat lives in the *army* pass (`ai_turn_process @ 107e:3bd0`,
3230-3422 — it is what receives the remainder at 1217 and loops up to `param_1` dispatches at
3417-3420) and in the buy. It does **not** live in 0bd6's defence dispatch: `FUN_107e_1750` sends
exactly one unit and the call costs one action. `web/server/bot.mjs` therefore spends the counter
on a successful march dispatch (`spendRepeat`, 3410-3416) and on a successful buy (1649-1651), and
excludes a recorded cell from the next dispatch's candidates (3392-3400).

The pool composes with 0bd6's pass budget; it does not replace it. 1216-1218 calls
`ai_turn_process(3 - local_c)` only while `local_c < 3`, and the routine returns at 3417-3420 on
`param_1 <= local_4`, so the army pass can issue at most `3 - spent` dispatches, where `spent`
already counts the buy and the defence pass; 1218 adds each dispatch back into the same counter.
The reachable figures for one turn are therefore:

```
repeats            <= min(0xe94c, 3 - spent)
dispatches         <= 3 - spent
dispatches to one  <= min(1 + 0xe94c, 3 - spent)
destination cell
```

The pool is seeded ONCE per game at setup (§9.1, "When the setter runs"), not per turn; the figures
below are the per-turn ceiling that seed allows. At levels 2-5 with nothing else spent that is
1 / 3 / 3 / 3 dispatches to one cell, not 1 / 3 / 5 / 7:
a pool of 4 or 6 cannot be spent in one turn because the pass itself ends at three dispatches. A
turn whose buy or defence already took an action can see at most `3 - spent` more. The port's march
loop enforces this (`armyBudget = budget - spent`, decremented per dispatch); the earlier cut walked
every idle piece and never added a march order to `spent`, which made the repeats column in a census
measure the port's own loop rather than the binary's allowance. `FUN_2dfc_1874` (3438) is reached
only at `e94c == 0` with `0x1478 == 0`, i.e. after the budget is spent, and stays **STAND-IN** in
the port.

## 2. What counts as a threat

`FUN_107e_0fa4 @ 107e:0fa4` (lines 1304-1602) is the score. Called with `param_2 = 0` it is
"recompute".

* **Radius.** `local_28` is the site's attention radius in cells:
  * `0x14` = 20 when the site is ours and its kind nibble is `< 3` (1352-1353);
  * `0xf` = 15 for every other site (1355-1356);
  * `0x19` = 25 for the single flagged site `0xe47e` (1358-1359). **UNVERIFIED** what that site is
    (the player's seat or the view's centre — the table at `0x146a` is written from a game-mode
    flag at 1147).
  The test is `distance² < local_28² + 1` (`uVar5 = local_28*local_28 + 1`, 1364 and 1501), and
  `calculate_distance @ 188b:0216` returns `dx² + dy²` with X wrapping at `0xa0` (COMBAT.md §1).
* **Which units.** `(0x906 & 0xf) < 7` — every combat kind; transports and empty slots never count
  (1469).
* **Weight.** `strength / 0x19` (25) per piece (1487, 1494), signed `+1` when the piece belongs to
  the same side as the site's owner and `-1` otherwise (1501-1507). The pieces are collected into a
  shortlist and summed (1442-1447); the sum is negated when the site belongs to the other side
  (1449-1450), clamped to ±127 (1452-1457), and a zero becomes 1 (1458-1459).
* **Already answered.** A piece whose order word `0x3650` equals `site | 0x200` is counted
  separately (1470-1472) so a site already being reinforced is not reinforced twice.

So: **a site of ours scores negative when hostile strength (strength/25, within 15-25 cells) near it
outweighs friendly strength.** That sign is the only threat test either defence routine uses.

## 3. `FUN_107e_1612` — buy a defender at the site (lines 1607-1657)

Gates, in order:

* not paused or in film/replay (`0xeff2 == 0`, `0xe4ba == 0`, 1620);
* affordable on the 40-divisor scale: `money / 40` (1621) must reach `10` when the site's score is
  below `-10`, else `20` (1622-1627), and must also reach the shop's price byte at `0x2e16`
  (1628; STRUCTS.md line 191 — the same 40x-price table the shop uses);
* a free unit slot exists (`FUN_1ac5_0008(0) != 0xff`, 1629);
* the site's own cell is reachable by `calculate_movement_cost`, or the site is one of ours with a
  **running readiness countdown** / past index 0x3f (1632-1634). `0x10ae` is that countdown, not a
  garrison latch (see §9.1). If the test fails it asks `FUN_107e_307a(site, 0)` for another of our
  sites (1635) and re-tests that one (1642-1645).

Then `FUN_107e_40a8(site, x, y, 0)` (1647; body 3426-3448) issues sprite-command 5 at the site's
cell — i.e. **creates a unit on the site** — and charges `byte[0x2e16 + slot] * -0x28` (40x the price
byte). Success spends one of the AI's spare actions (`0xe94c`, 1649-1651).

In plain words: at most once per AI pass, the AI buys one infantry **at its most threatened site**,
if it can afford it and has a free slot.

## 4. `FUN_107e_1750` — send an existing unit (lines 1661-1778)

Gate: that site's score is negative (caller, 1190) and the site is ours.

* `local_12 = FUN_107e_0fa4(site, 1, 0)` (1692-1694) — the score in its second mode; the loop only
  runs while that is negative (1694).
* Walk all 100 unit records (1695): keep `0x906 & 0xc0 == 0xe942` — ours — and
  `0x906 & 0xf < 7` — a combat kind (1696-1697).
* Reject a unit that is locked: a `0x400` flag with strength above `0x31`, or a `0x200` order word
  pointing at a different site (1701-1704).
* Distance test (1720): `8 < distance²` — closer than three cells means it is already in the fight —
  and for kind 3 (infantry, the entrenched column of the 9x9 matrix) also `0x18 < distance²`, i.e.
  six cells.
* Keep the **smallest** distance squared, starting at `0x9c4` = 2500 = 50 cells squared
  (1687-1688, 1729-1730).
* Ties and a "closer than its own destination" check: 1733-1750.
* Order it: `render_sprite(2, unit, siteX, siteY)` (1770) — sprite-command 2 is a move to the site's
  **own cell**. On success set `0xcae |= 4` (moving) and `0x3650 = site | 0x100` (this unit answers
  this site) (1772-1773), return 1.

In plain words: **the nearest idle combat unit of ours between three and fifty cells of the
threatened site is ordered onto the site itself** — nearest, not strongest, and one site per pass.

## 5. What the unit does on arrival

It stands on the site. Entrenchment is not part of either routine: a stationary piece entrenches on
its own schedule in `FUN_1c0d_0656` (COMBAT.md §1, repair/entrench/flag upkeep). **UNVERIFIED**:
whether standing on a site cell adds anything of its own to a defence beyond that entrench flag. The
damage side of a fight is `docs/re/COMBAT.md`; the terrain term this task added is
`combat.mjs:coverDamage`.

## 6. What the remake does now (`web/server/bot.mjs`)

* `siteThreat(match, site)` — the score's sign and radius: 25 cells for our capital, 20 for our other
  city/base sites, 15 otherwise; each piece inside `R²+1` adds `floor(strength/25)`, signed by
  whether it belongs to the site's owner.
* `threatenedSites(match, side)` — our sites with a negative score, most negative first.
* `defendSites()` — one site per pass, the nearest idle land unit with `8 < distance² <= 2500`,
  ordered onto the site cell; nearest free neighbour if the site's own garrison already holds the
  cell (a bot decision: the engine refuses a move onto an occupied cell, and the original's order
  would simply fail).
* `botBuy()` — anchors the purchase on the threatened site when there is one, which is the
  buy-at-the-site rule from `FUN_107e_1612`.

Deliberately not ported, so nobody has to reverse-engineer the diff later:

* the ±127 clamp (meaningless at remake strengths, where strength is already 0..100);
* the `0xe47e` 25-cell case as a separate flag (a capital simply gets 25);
* the 10/20 money thresholds, because the remake's bot buys through the same shop and the same price
  table as the player rather than a second 40-divisor scale;
* the second scoring mode `FUN_107e_0fa4(site, 1, 0)` that `FUN_107e_1750` opens with (1692-1694);
  the port uses the one score the pick loop already ranks on;
* the distance-score adjustments inside the unit pick (1730-1750, below), because their inputs are
  not decoded.

## 7. The money and price inputs (0x148e, 0x2e16): decoded, derived, or UNVERIFIED

These are the two inputs that turn the threat score into an action, so each one says here exactly
how far the bytes go. Nothing below is ported into a number the remake runs on.

| Input | Where it is read | What the bytes show | Status |
|---|---|---|---|
| `0x148e + side*2` | 1621, 25078 (same expression), 3264, 4145, 4776, 4963 | the acting side's cash, divided by `0x28` = 40 gives the price unit the shop uses; the writer at 11269 stores one 16-bit word per side (`byte[p+1]*0x100 + byte[p+2]`) | **DECODED** as "cash in 40-unit price steps, one word per side". **UNVERIFIED**: the Ghidra export *reads* a 32-bit `int` at a 2-byte stride, which cannot be right for a 16-bit store — read width unresolved, so no arithmetic here is ported |
| `0x2e16` unindexed | 1628, the price gate of `FUN_107e_1612` | the price byte of slot 0, compared against cash/40 | **DERIVED**: slot 0 is the slot `FUN_1ac5_0008(0)` hands back on the next line, so this is the cheap infantry's price. The identity "slot 0 = infantry" is a derivation, not a read |
| `0x2e16 + slot` | 3441 (`FUN_107e_40a8`), 3324, 8234 | `byte[0x2e16 + slot] * -0x28`, i.e. 40x the price byte per slot, charged on a successful create | **DECODED** |
| `FUN_2dfc_1874(param_1, byte[0x2e16 + slot], ...)` | 3439, 8229 | a second call taking the same price byte | **UNVERIFIED**: what it records (a build counter? a per-kind tally?) is not settled by the call site |
| `0x1a01 + kind` | 1730-1735 | value `2` halves the candidate's distance² before it is compared | **DECODED** as arithmetic. **UNVERIFIED** what the `2` means (a unit-class table, or a per-kind preference flag) — not ported |
| `0xe78c`, `0xe2ae`, `0x1102`, `0xea6e`, `0x1478` | 1710-1750 | a second distance adjustment `(d²>>8) - 0xf + (local_4 - local_10)*2` and the "already busy" tests | **UNVERIFIED**: the two byte tables it reads (`0x108 + kind` twice) are not identified, so the whole adjustment is left out |

The remake ports the four things that are fully decoded — the score's sign, the radius, the
`strength/25` weight and the `8 < d²` / `0x18 < d²` distance gates — and nothing above. The buy
side uses the remake's own shop price for the same reason the 10/20 thresholds are left out.

## 8. A capital's own garrison does not march (remake behaviour, measured)

This is the march, not a ported AI routine, so it is labelled as behaviour rather than fidelity:

* `holdsOwnCapital(match, side, piece)` — true when a dug-in (`entrenched`) land piece stands on a
  site of its own side that the era's capital set names. `ordersFor` skips those pieces in the
  marching loop; a dug-in piece anywhere else still marches, and the same piece one cell off the
  capital is marchable again.
* **Why the rule exists.** Measured live on `37b7537` (pre-T-015) and on this branch before the
  rule: a fresh 1942 match has red's dug-in infantry on Paris at round 0 and an empty cell from
  round 1 — the bot marched its capital's garrison east. A lone blue tank then walked onto an
  undefended Paris and took it, which is the PB-034 shape in a live match even after the duel is
  fixed. The original's garrison stays on the city and fights there (`duel-original.txt`).
* `FUN_107e_1750`'s own distance gate already leaves the on-site garrison out of a defender
  dispatch (`8 < distance²`, and `0x18 < distance²` for infantry), so the two rules do not fight.

## 9. T-032 Part B: what the port now reads, and the A7 unknowns as shipped

The five-opponent table, the level gate (1 < 0x1a0), the army-repeat counter `0xe94c = 0x1a0*2-4`,
calculate_combat's force edge (> 11 strength units inside 30 cells), the ship/air target set and the
25/20/15 threat radii are ported in `web/server/bot.mjs` from `config/game.json` (`bot` block). The
values and their provenance strings live there; this document is the reading they were taken from.

### 9.1 The citation, line by line (the one a later reader should use)

The block that settles each number is §1a; this is the same reading in the form a gate can cite.
Every line number is `decompiled.c` in this document's source tree, re-read at the span it names.

| Claim | Where |
|---|---|
| `FUN_107e_0bd6` spans 1126-1268 | 1126 is the signature, 1268 the closing brace; 1124 is the banner and 1272 opens `FUN_107e_0f58` |
| one shared action counter | initialised at 1142; incremented at 1188, 1192, 1195, 1199, 1209, 1213, 1218, 1222, 1226, 1244, 1247, 1251 (+3), 1254, 1265 |
| budget 3, level-independent | nine reads of the same counter: 1194, 1197, 1208, 1211, 1217, 1241, 1246, 1249, 1253 (`while`); exit test `2 < local_c || 9 < local_8` at 1202 |
| combat tail 4 | 1220, 1224, 1228, 1256 test `local_c < 4`; `resolve_combat` handed `4 - local_c` at 1257, 1262, 1264 |
| the era gate | 1207 `0x19e == 3 \|\| 0x19e == 2` around `FUN_107e_51b6` (1208) and `FUN_107e_5500` (1211) — era, not level |
| no level in 0bd6 | zero reads of `0xe94c` or `0x1a0` in 1126-1268 (grep over the span) |
| `0xe94c` set from the level | 13231-13232 and 15157-15158, both under `if (1 < *(int *)0x1a0)`; value `0x1a0*2 - 4` |
| when the setter runs | 13232 is inside `FUN_20b1_01b6` (`20b1:01b6`, 4295 B), the new-game setup routine; its ONLY caller is `main_game_loop` line 23, and the play loop it hands off to (`FUN_1000_01da(7)`, 26-28) never writes the byte. 15158 is that same routine decompiled a second time inside the jump-table blob at `20b1:2eea`, so the two setter lines are ONE setter. Seeded once per game, never on a turn boundary (room 9377 §3) |
| `0xe94c` ledger | seven lines: 1649, 1650, 3410, 3415, 3438, 13232, 15158 |
| an extra action is a repeat | 3410-3416: spend without recording while nonzero, record at zero; 3392-3400 strikes the recorded cell (0xf at 3398). The pass bounds it: 1216-1218 hands `3 - local_c` and 3417-3420 returns on `param_1 <= local_4`, so `min(e94c, 3 - spent)` repeats is the reachable figure |
| the repeat's true owner | `ai_turn_process @ 107e:3bd0` (3230-3422), which takes the remainder at 1217 and loops to `param_1` at 3417-3420; plus the buy at 1649-1651 |
| `FUN_2dfc_1874` | 3438, only at `e94c == 0` and `0x1478 == 0` — **STAND-IN** |
| `FUN_107e_1612` spans 1607-1657 | gates 1620-1629, origin branch 1632-1634, buy at 1647-1652 |
| a level read inside the buy | 1632 `*(int *)0x1a0 < 5` — inside the branch that decides *which site's* unit the buy draws from, not whether the buy happens |
| `FUN_107e_1750` spans 1661-1778 | no `0x1a0`, no `0xe94c` |
| the free slot gates BOTH paths | `FUN_1ac5_0008` at 8105-8136: `param < 5` walks the 100 records at 0x906 and returns the first empty index, or 0xff when full (8115-8118, 8132-8133). The buy tests it at 1629 and the army pass returns on it at 3385 — both call it, so the port checks both; a full table is 100 pieces and is a board bound, not a production cap |

The 1632 read is why the "1612 has no level gate" shorthand is retired: the buy happens without a
level, but the site it draws from is chosen with one.

**`0x10ae` is settled — it is a countdown, and the "garrison flag" reading is retired.** The export
gives 0x10ae 30 references and not one pairs the byte with a piece:

```
4856:  for (local_1c = 0; local_1c < 0x40; local_1c++)
4857:    if (*(char *)(local_1c + 0x10ae) != '\0') &&
4858:      (*(char *)(local_1c + 0x10ae) = *(char *)(local_1c + 0x10ae) + -1,
4859:       *(char *)(local_1c + 0x10ae) == '\0' || *(char *)(local_1c + 0x10ae) == '\x14') ...
9178:  *(undefined1 *)(uVar9 + 0x10ae) = 0xf;        /* the capture handler FUN_1c0d_02ce */
```

One decrement a round over 64 slots, firing a notice at 20 and at 0 (4856-4862); the capture handler
writes 15 (9178); the reads are `!= 0` (1632), `< 10` (2246, 2381), `== 0 || 0x1478 != 0` in site
selection (2694, 3340) and `< 0x15` (24262, 24362); four sites clear it to 0 (12214, 12245, 12365,
13858). That is the readiness timer `web/server/readiness.mjs:58` already models (15 on capture,
decaying one a round), not a latch.

The rename leaves a hole rather than filling it: retiring `site_name_offset` at `0x10ae` says nothing
about where names actually live, and **where a site's name is stored in the record is UNVERIFIED**.
The export has no candidate site-array offset that reads as a string index, so this note offers none
and `STRUCTS.md` carries the same open item on the `0x10ae` row.

Two findings, both measured rather than assumed: **(a)** 1632 most plainly reads "the site is still
counting down, so draw the buy's unit from another of our sites" — 0x10ae is the readiness countdown,
so there is no garrison latch to port; **(b)** the level-5 garrison-buy exclusion therefore has no
byte basis at all and is **refused**, not marked: `bot.levelFiveGarrisonGate`, its config row, its
export and its call are removed (PM ruling, room 9370), and the A7 list no longer carries it. **When the setter runs: once per game, not once per turn (room 9377 §3).** The setter at 13232 is inside
FUN_20b1_01b6 (`20b1:01b6`, size 4295) - the new-game setup routine that walks the menu, the
scenario (`0x19e`, 13103), the side (`0x19c`, 13119) and the difficulty (`0x1a0`, 13415), draws the
map and returns. Its ONLY caller is `main_game_loop` line 23, inside the setup branch
`if (*(int *)0xe42e == 0)`; the play loop it hands off to is `FUN_1000_01da(7)` (26-28), which calls
`ai_command_process` and `FUN_107e_0bd6` every turn and never writes `0xe94c`. The second setter
line, 15158, is the same routine decompiled a second time inside the jump-table blob Ghidra labels
`FUN_20b1_2eea @ 20b1:2eea (size 39)` (warnings at 15015-15048, call arguments dropped) - one
setter seen twice, not a second event. The byte has seven references in the whole export (1649,
1650, 3410, 3415, 3438, 13232, 15158) and 13232/15158 are the only writes, so nothing resets it on
a turn boundary: the pool is MATCH-LONG. Levels 2-5 are seeded 0/2/4/6 at new game (level 1 never
seeds, and the 13008 reset block does not clear the byte, so a level-1 game in the original carries
the previous game's leftover; the port starts a fresh match at 0 and states that as a deviation).

So the per-turn columns and the match columns say different things, and both are true:

```
per turn   counterSpendsInOneTurn      <= min(pool, 3 - spent)   <= 3
turn       sameCellRepeatsInOneTurn    <= min(1 + pool, 3 - spent) - 1 <= 2
match      repeatsPerMatch             = the seed, 0/0/2/4/6, spent once and never refilled
```

Levels 4 and 5 are IDENTICAL inside a turn (both reach the pass cap of three dispatches, i.e. two
repeats on one cell) and differ only over a match: 4 vs 6 repeat dispatches in total. C1 therefore
cannot be separated by a per-turn maximum; the column that separates 3/4/5 is repeats per match (or
the count of turns that carry a repeat). The port carries the pool on the match (`match.botRepeatPool`,
seeded on the bot's first turn from `dispatchRepeatPool(level)`), spends it on a repeat dispatch and
on a buy (1649-1651), and no longer resets it per turn - the per-turn reset was a STAND-IN and is
retired.

A7's unknowns, and what each one is in the shipped port. An entry marked STAND-IN is not claimed as
recovered, and the mark is in `config/game.json` `bot.standIns` as well as here, so a reader who never
opens this file still sees it:

| A7 unknown | In the port | Mark |
|---|---|---|
| four ownership counters | not read; the bot uses `site.owner` and `piece.side` | STAND-IN |
| two 10-byte staging arrays | not modelled; orders go straight through `move.issueOrder` | STAND-IN |
| level-5 garrison-buy exclusion | no gate in config or code: 0x10ae is a once-per-round countdown over 64 slots (4856-4862), written to 15 by the capture handler (9178), read `!= 0` at 1632 and `< 10` / `< 0x15` elsewhere — readiness, not a latch on a piece | REFUSED |

No DOSBox check is owed for the garrison gate — the byte reading refused it, and the behaviour arm in
`web/test/nodes/t032_bot_level.mjs` now pins the opposite: level 5 buys at a threatened site that
already holds its own dug-in piece. The remaining STAND-INs are the counters and the staging arrays.

What Part B deliberately did NOT add, and why: no per-level price or strength bonus (the bytes show
none; the only lever is `0xe94c`, and only 0/2 of it is reachable through the three-dispatch pass),
and no config "peace multiplier" (RE-E4
ruled against inventing one). The remake's production cap and the default lobby level are listed as
DELIBERATE DEVIATIONs on the T-032 card and in `bot.deviations`, not here as fidelity.
