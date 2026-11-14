# AI.md — the original's site defence, read from the disassembly (T-015 Part B)

Source: `decompiled.c`, the Ghidra export at
`/mnt/nas/Projects/Command HQ/modern/docs/ghidra/export/decompiled.c` (read 2026-11-13; the same
program as the project `~/agents/game/ghidra-probe/CHQ.rep`, `CHQ_unpacked.EXE`). Line numbers below
are that file's. Addresses are segment:offset as Ghidra names them. Anything marked UNVERIFIED is
something the bytes did not settle — not a guess wearing a measurement's clothes.

## 1. Where the AI acts

`FUN_1000_01da @ 1000:01da` (lines 90-121) is the turn hook. Once per AI turn it refreshes the
per-site score row for all `0x54` = 84 sites, then runs the piece pass:

```
112:  uVar1 = FUN_107e_0fa4((uint)local_4, 0, 0);
113:  *(undefined1 *)(local_4 + 0xea6e) = uVar1;      // 0xea6e = site score
115:  ai_command_process(local_4);
```

`ai_command_process` is `FUN_107e_4616 @ 107e:4616` (line 3679). The defence itself is
`FUN_107e_0bd6 @ 107e:0bd6` (lines 1124-1302). Its loop (1173-1204) does this:

* `0xe942` = `0xc350 ^ 0xc0` — the side taking this turn (1146);
* `0xe47e` = one flagged site from a two-entry table (1147);
* pick the site of ours with the **lowest** score byte (`0xea6e`) not yet visited in this pass
  (`(0x1102 & 0xc0) == 0xe942`, `(0xeb78 & 1) == 0`, 1174-1183);
* mark it visited (1184) and act, **at most three actions per pass** (1194-1202):
  * `FUN_107e_1612` — buy a defender at the site, at most once per pass (`local_a == 0`, 1185-1189);
  * `FUN_107e_1750` — send a unit, but only when that site's score is **negative** (`0xea6e < 0`,
    1190-1193);
  * two other routines this task does not cover (`FUN_107e_1ace`, `FUN_107e_1bec`, 1194-1201);
* after acting, rescore the sites it touched (1235-1237).

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
  garrison flag / past index 0x3f (1632-1634). If not, it asks `FUN_107e_307a(site, 0)` for another
  of our sites (1635) and re-tests that one (1642-1645).

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
  the port uses the one score the pick loop already ranks on.
