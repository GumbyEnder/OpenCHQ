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

---

# T-032 Part A — the AI turn, decoded (2026-11-19)

Source: the same Ghidra export, `decompiled.c` (`/mnt/nas/Projects/Command HQ/modern/docs/ghidra/export/decompiled.c`,
49,686 lines, md5 read in the committing call). This section answers the T-032 question — how the
original picks targets, defends capitals and buys units, and what the five opponent levels change.
It also corrects one global that earlier docs got wrong, because the port would be built on it.

## A0. Two globals: `0x19e` is the ERA, `0x1a0` is the OPPONENT

`SYSTEMS.md` §9 calls `0x19e` "player count". The bytes say otherwise, and so does the setup menu:

* `FUN_20b1_2134(0x16f0, 0x2dfc)` returns a menu index; the **crisis** menu is built at
  `FUN_2dfc_152a(0x4ffe, 0, *(uint *)0x500e, 5)` (`decompiled.c:13098`) and its table at
  `DS:0x500e` is ` 1918 / 1942 / 1986 / 2023 / ????` (read from `CHQ_unpacked.EXE`, DS base
  `0x328b0`, five words `0x401a 0x4020 0x4026 0x402c 0x4032`). The selected index is stored at
  `0x19e` (`:13103`) and loaded by `FUN_298d_0af2(*(uint *)0x19e)`.
* The **opponent** menu is `FUN_2dfc_152a(0x4fd8, 1, *(uint *)0x4fea, 7)` (`:13408`) and its table
  at `DS:0x4fea` is seven words: `ANOTHER HUMAN`, `SGT. STAN STIL`, `CAP. LUKE WARM`,
  `COL. BUCK ZEAL`, `GEN. WIN MOORE`, `MARS GOD OF WAR`, `(RESTART)`. `if (bVar5 < 6)` and
  `bVar5 != 0` stores it at **`0x1a0`** (`:13415`); `0x1a0 == 0` is "another human / none".
  Confirmed on the running game under DOSBox: the OPPONENT OPTIONS list renders exactly that
  seven-entry order (screenshot `/tmp/chq-opp/opp1.png`, 2026-11-19), so level **1..5 = STAN,
  LUKE, ZEAL, MOORE, MARS** — five computer opponents, not four. `SGT. STAN STIL` is level 1 and
  `MARS GOD OF WAR` is level 5.

`0x19c` is the human side; `0xdb02` the side the human commands; `0xc350` = `side*0x40 + 0x40` and
`0xe942` = its `^0x40` twin are the two owner masks (`:13120-13123`). `0xe94c` is the AI's
**spare-action counter**, set at setup from the level: `e94c = level*2 - 4` when `level > 1`
(`:13232`, again `:15158`).

## A1. Call graph of one AI pass

`FUN_1000_01da` (`1000:01da`, `:93-130`) is the tick hook:

```
105:  if ((param_1 & 1) && 1 < *(int *)0x1a0 && *(int *)0x3e87 == 0 && film/pause gates)
115:      ai_command_process(local_4);        // per unit, 0..99
        ...
        FUN_107e_0bd6();                    // the AI turn itself
```

* **Level 1 never enters this block.** The gate is `1 < 0x1a0`, so `SGT. STAN STIL` issues no AI
  orders at all — the name is the behaviour ("stand still"). Everything below is level 2..5.
* `ai_command_process` = `FUN_107e_4616 @ 107e:4616` (`:3683`): per-piece housekeeping — finish a
  half-move, re-order a piece whose order word lost its target, garrison a unit that arrived.
* `FUN_107e_0bd6 @ 107e:0bd6` (`:1127`) is the turn: pick the lowest-score site and act, then
  hand the rest of the budget to combat and purchasing (see A4).

## A2. Buying units

### A2.1 The site defender — `FUN_107e_1612 @ 107e:1612`

Already in §3 above. One correction/addition from the level map: the "buy at a garrisoned site"
shortcut is gated `*(int *)0x1a0 < 5` (`:1632`), so **MARS (level 5) is the one level that cannot
use that shortcut** and must pass the movement-cost test. **UNVERIFIED** why; the branch is real
and one byte wide.

### A2.2 The purchase pass — `FUN_107e_3bd0 @ 107e:3bd0` (`ai_turn_process`, `:3234`)

Called from `:1217` as `ai_turn_process(3 - local_c)`: at most `3 - actions_used` purchases per
turn, and it returns early on the first unaffordable/failed one.

Copy of the money it works in (`:3264`):

```
uVar2 = money[side] / 0x28;                 // 40-unit price steps, 0x148e + side*2 (`:3264`)
```

Base threshold `local_a` (`:3255-3263`): `0x1e` = 30. For **era 0 (1918)** and **era 4 (????)** it drops
to `10` while the round counter `0x1476 < 0x1e` (30), else `20` (`:3256-3263`); `uVar2 < local_a`
returns without buying.

Then, for eras **2 (1986) and 3 (2023)** only (`:3287`), a second decision picks the unit class
`local_6`:

```
local_26 = byte[0xc3b6]; local_8 = local_26 + byte[0xc3b7];
share    = local_26*100 / local_8;          // 0xc3b6 share of 0xc3b7
if (byte[0xe934] < share || byte[0xc3b7]*4/3 < byte[0xc3ba]) {
    r = rand() & 0xff;
    local_6 = (r < 0x20) + (r < 0x80) + 2;   // 2, 3 or 4
    if (local_6 > 3 && era == 0) local_6 = 3;
    if (uVar2 < price[local_6]) return;      // 0x2e16 + class
}
```

`0xc3b6/0xc3b7/0xc3ba/0xe934` are a strength/ownership score (four byte counters); **UNVERIFIED**
which count is which. What is decoded is the shape: **the AI buys a heavier class (2/3/4, price
bytes 10/10/20) when its share score is below a stored bar or when `0xc3ba` says the other side is
ahead; the random roll weights it 2 (1/2), 3 (3/8), 4 (1/8).**

Site choice, still era 2/3 (`:3288-3312`): it walks a 10-entry table at `0xf54`.

* It counts own sites (`local_c`) and enemy sites (`local_e`) among those 10 entries; if
  `local_c < local_8/20`, where `local_8` is the same `0xc3b6+0xc3b7` sum (under one twentieth of it), it calls `FUN_107e_54b0` — a random own site with
  a free unit slot — buys **class 6** there.
* Else, if `film_mode==0 && local_e != 0 && local_c <= local_e && rand() < 0x10`, it buys **class
  7** and takes its coordinates from `byte[0xf36+slot]<<1` / `byte[0xf40+slot]<<1`. **UNVERIFIED**
  what those two 10-byte arrays are (candidate: forward staging coordinates); class 7 is created
  off-site, which looks like a paradrop/air insertion rather than a shop buy.

The create call for every class is the same engine primitive as the defender:
`render_sprite(5, class, 0, x, y)` (`:3322`), charged
`price[class] * -0x28` through `FUN_23aa_0cba` (`:3324`). If the queue is used instead (classes
0..5), it builds a mission queue over own unit slots (`0x1102 & 0xc0 == e942`, order word `0xcb46
< 0xfd`, garrison flag `0x10ae`) and `select_next_mission` (`:3353`) returns the destination; the
unit is created with `FUN_107e_40a8` (`:3406`).

### A2.3 What the level changes here

`0xe94c` (spare actions) is the only direct level input in this function: a successful buy either
records its cell (when `e94c == 0`) or decrements `e94c` (`:3410-3415`). With `e94c = level*2 - 4`,
the budget is **0 / 2 / 4 / 6 extra purchases** for levels 2 / 3 / 4 / 5. Level 1 does not run the
pass at all. There is **no per-level price or unit-class table** — the class mix is era-driven, not
difficulty-driven.

## A3. Picking targets

The AI has two attack passes and one auto-acquire helper. Only the first two run for `e942`.

### A3.1 The staged attack — `calculate_combat @ 107e:4266` (`:3518`)

For each own site with a **positive** score (`0x27 < score`, `:3572`):

1. `FUN_107e_45a8(site, 0x1e)` (`:3573`) finds the nearest enemy site with attack-matrix value
   `< 30` (`0x1e`) and records that value at `0xc3b4`.
2. It caps the attack radius score at `min(0xf, value*3/2)` (`:3575-3576`) and requires
   `0xb < (0xe78c - garrison)` as a pre-gate (`:3582`).
3. It reads the site's modifier byte `0xe6da` (the per-site combat modifier, `COMBAT.md`), scales it
   `*2/3` (floor 2), then walks **our** pieces at that site (`:3584-3596`): a piece below `0x50`
   strength or carrying order flags `0x300` subtracts `strength/25` from that pool as a penalty,
   a ready piece adds `strength/25` to `local_e`. The attack only proceeds when
   `0xb < local_e - local_14` (`:3600`) — i.e. **ready strength must exceed modifier + weak-piece
   penalty by more than 11 strength-units**.
4. It queues every enemy site whose attack-matrix value is `<= local_c` and whose modifier
   difference `2*(enemy_mod - friendly_mod) <= local_e`, priority
   `value + local_e*-2 + diff*4` (`:3601-3612`).

Then `select_next_mission` (`:3546`) returns an (own site, enemy site) pair and
`execute_movement` (`:3564`) orders **the strong ready pieces at that own site** toward the enemy
site with mode `2` (`0x16` when both sites are hostile-flagged). In plain words: the AI masses at a
front site and only attacks when the ready force there clears the site modifier by >11; it is a
force-ratio attack, not a nearest-enemy attack.

### A3.2 The per-piece opportunistic attack — `execute_combat @ 107e:380e` (`:3045`)

Called from `:1219` with `execute_combat(4 - actions_used)`, and it is the rule the AI actually uses
for every arm (`e942`, `:3069`):

```
for each own piece with kind < 7 and combat-eligible order bit 0x800:
    for each enemy site with garrison/queue byte 0xcb46 < 0x54:
        priority = byte[site + 0xea6e] + (attack_matrix[own_site][site] & 0x7f)
        queue (site, max(priority,0), piece)
```

`select_next_mission` (`:3106`) picks the best pair and the piece is moved onto that enemy site
with mode `2` (`0x16` if both are hostile-flagged). So **the AI's target is the enemy site with the
best `site score + class-specific attack-matrix value`**, with a random tiebreak when a site already
holds `0x54` units (`:3074-3076`). Kind `< 5` pieces also refuse a site that already holds 5+ of
theirs unless a `rand()<8` roll passes — an anti-overstack rule.

### A3.3 The player-side auto-acquire — `select_combat_targets @ 107e:4c1c` (`:3911`)

This one runs for **`0xc350`**, the human seat, not `e942`: it is not an AI routine. Each own piece
with kind `> 4` and flag `0xc46 & 7 != 0` is paired with every enemy piece of kind `> 6` that
`calculate_damage(enemy, own, 10000)` can reach (`!= 0xff`), queued, and the best pair is ordered
onto the target cell with order `target | 0x1080` (`:3948`) — move + attack. In the remake this is
the player's "idle ship/air acquires a target" helper, and its rule is worth porting for that, but
it must not be cited as AI targeting.

`calculate_damage @ 107e:4b94` (`:3876`) is the range/type gate documented in `COMBAT.md`; the
`0xff` return is "out of range".

### A3.4 Invasion and merge passes

`FUN_107e_251c @ 107e:251c` (`:2223`) queues **undefended enemy sites** (`e814 & 0xf2 == 0`, no
garrison unit `0xcb46 > 0xfc`) that sit within `0xc704` of one of our 30 mission records
(`0x1364`), scoring them with `FUN_107e_0fa4(site, 2, force_delta)` and issuing
`FUN_107e_2696(..., 1)` (load/embark) for the best. The amphibious expansion pass; it only runs
while `0x157e` (the round clock) is below 2000 (`:1243`).

`FUN_107e_1ace @ 107e:1ace` (`:1785`) merges a stationary friendly piece onto an adjacent friendly
piece of the same class when the neighbour is at `>= 0x50` strength or carries the `0x80` flag —
the stack/merge rule.

## A4. Defending the capital

* **The capital is the AI's 25-cell site.** At setup the two starting capitals are written from a
  per-era table `0x1bbe + era + side*3` into `0x146a[side]` (`:13168-13171`), with their
  coordinates at `0x1462`/`0x1466`. At the top of every AI turn
  `0xe47e = byte[0x146a + (human_side==0)*2]` (`:1147`) — **the AI's own capital**.
* The score routine `FUN_107e_0fa4` gives that one flagged site a radius of **25** cells, versus
  **20** for other own cities/bases and **15** for everything else (`:1352-1359`, already §2). So a
  hostile piece is seen as a threat to the capital from 5-10 cells farther away than to any other
  site.
* The response is the same sign test: a negative score at the capital makes `FUN_107e_1612` buy a
  defender there (if affordable and there is a free slot) and `FUN_107e_1750` send the **nearest**
  idle combat unit within `8 < d^2 <= 2500` (`:1687-1778`). Neither routine has a capital-specific
  branch; the radius is the whole capital rule. If no unit is within 50 cells, nothing is sent.
* Extra capital hardening with level: levels 2..4 can buy at a garrisoned site (`0x1a0 < 5`), and
  level 1 never acts. **UNVERIFIED**: whether the `0xe47e` flag does anything else (it is only read
  by the score routine in this export).

## A5. The five opponents, side by side

| Level | Name | AI pass (`1 < 0x1a0`) | Spare purchases `0xe94c` | Other decoded differences |
|---|---|---|---|---|
| 1 | SGT. STAN STIL | no — never acts | n/a | none; passive |
| 2 | CAP. LUKE WARM | yes | 0 | baseline |
| 3 | COL. BUCK ZEAL | yes | 2 | no unique branch found — budget only |
| 4 | GEN. WIN MOORE | yes | 4 | no unique branch found — budget only |
| 5 | MARS GOD OF WAR | yes | 6 | the one unique level gate: excluded from the garrison-shortcut buy (`:1632`) |

Everything else the AI does — the score, the threat radius, the force-ratio attack, the merge, the
amphibious pass — is **identical across levels 2-5**. The difficulty axis is *how many actions it
gets*, not a different strategy table. That is the finding the port has to respect: a port that
gives all four opponents the same action budget and calls them different levels is not faithful.

`0x1a0` also gates presentation/non-AI code (turn banners, the `0x157e` clock for level 1, the
`3e87` delay), so do not port `0x1a0` as "difficulty" into anything but the action budget without
reading the site.

## A6. Starting money (manual p.17)

Manual p.17, "Starting Money": *"For all scenarios, you are allowed to adjust the amount of money
with which your opponent begins the game. This can be useful as a handicapping device."* It is a
**player-set spinner, not a per-level table** — there is no bytes-side opponent cash table in the
setup code. The per-side money word is `0x148e + side*2` (40-unit price steps, `:3264`), and the
setup passes the chosen amount through `FUN_1eb5_000c(0x11, side, hi, lo, 0)` (`:13309-13317`); the spinner's value is
in 40-unit steps (`index * 0x28`, `:13311`), so the handicap is bounded the same way the shop is. The port
therefore adds a lobby control that writes the opponent's starting money; difficulty must not
silently change it.

## A7. Status

* **DECODED**: the global identity (`0x19e`=era, `0x1a0`=level), the menu order and the five
  names, the AI-pass gate, the spare-action formula, the purchase money gate and class roll, the
  force-ratio attack threshold, the per-piece site-score + attack-matrix target rule, the capital radius, the merge and the
  amphibious passes.
* **UNVERIFIED**: the four ownership counters `0xc3b6/b7/ba/e934`; the two 10-byte arrays
  `0xf36/0xf40`; why level 5 is excluded from the garrison buy; whether `0xe47e` is used elsewhere.
* Part B ports the decoded logic; Part C measures it. Any value we tune is recorded as a
  deliberate deviation in the ticket, not in this file.
