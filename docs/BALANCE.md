# Balance: what a real match pays

> **STALE as of T-001 (2026-11-09).** Everything below was measured when a payday came every 25
> rounds, a city paid 1, oilfields paid cash too, and a unit cost 1–2. The rules now are the 1990
> manual's: a city pays 50 million every round, wells pay oil and no cash, and units cost 10–20
> billion (`config/game.json`). The measurements are kept because the method and the board are still
> right; the numbers are not. Re-run `node local/balance.mjs 1000` before quoting any of it.

Measured, not estimated. `node local/balance.mjs 1000` plays both seats on the same 269-site board
the lobby opens, with the same `buy` / `issueOrder` / `tickMatch` calls the server makes, and records
every payday.

Board: 269 sites — 62 cities, 2 capitals, 35 oilfields, 20 facilities, 150 docks.
Round: 5 s. Payday: every 25 rounds (2.1 min). Prices: infantry 1, tank 2, generic ship 2, nuke 10.
(Both the payday and the price list above are the pre-T-001 stand-ins; see the banner.)

## The measurement

| | blue | red |
| --- | --- | --- |
| first payday | round 25: 19 from 14 cities | round 25: 13 from 11 cities |
| last payday | round 225: 27 from 17 cities | round 225: 32 from 27 cities |
| paydays in the match | 9 | 9 |
| infantry bought | 200 | 196 |

- **Income per city per payday: 1.13–1.63, mean 1.33.** The rule is one per city — the excess is the
  oilfields, which pay too. Measured on the sites actually owned, not on all 269.
- **A payday at 14 cities buys 19 infantry or 9 tanks.** At 27 cities, 32 infantry or 16 tanks.
- **The match ends at round 244** (red), about 20 minutes at 5 s.

## Does the game make armies meet? Yes — with a driver that wants to fight

The scripted player above walks to the nearest unowned city, and two armies doing that pass each
other: 2 shots in 244 rounds. The bot concentrates on a focus cell and marches on the enemy capital.
Same board, same rules, 400 rounds (`node local/contact.mjs 400`):

| driver | first shot | shots | destroyed | captures | ends |
| --- | --- | --- | --- | --- | --- |
| bot | round 48 (4 min) | 350 | 56 | 64 | still going at 400 |
| scripted colonist | round 226 | 2 | 0 | 88 | red wins at 244 |

So contact is not a missing rule: it is a decision the player makes. The colonist numbers are a
warning about *incentives*, not about combat — a player who never wants to fight is not punished for
it, because taking empty cities pays and losing nothing costs nothing.

That run also exposed the rule behind it, and it has since been fixed: `route()` treated every
occupied cell as an obstacle — its own side and the enemy alike — so a march to the capital walked
*around* the defenders standing in front of it. Held cells are now the walker's own side only, and a
piece whose next cell is held by a friend re-routes instead of dropping its order.

Measured on the same bot match, 400 rounds, real board:

| | before | after |
| --- | --- | --- |
| shots | 350 | 507 |
| destroyed | 56 | 108 |
| winner | none at 400 | red, round 349 |
| blocked orders (soak, scripted) | 6,750 | 3,430 |

Doubling the kills is what it looks like when armies stop walking around each other.

## What this says

**The economy already has a curve, and it is linear in cities.** Income is not a constant: it is one
per city, so an empire of 27 funds 1.7x the army of one with 17. That is a curve, and it is the
archive's shape — what people mean by "it needs a curve, not a constant" is already true.

The real problem is the **slope**, not the shape:

- Winning 10 more cities buys **10 more infantry per payday** — one infantry per city per 2.1 minutes.
  Against a piece that walks a cell a round and dies to six hits, a city is worth a *very* thin
  trickle. Land is nearly free to hold and nearly worthless to own, which is why the match takes 244
  rounds to resolve: nobody's economy runs away with it.
- The starting position is already the whole economy. A side begins with 11–14 cities, so its first
  payday (19 units) is roughly its fortieth — the first 25 rounds are spent marching, not building.
  That is the "dead time" the log was built to fill, and the log now fills it, but the clock still
  pays nothing for two minutes.
- `startPool` (9 early, 40 in 2023) is the only thing that lets a player build before the first
  payday. It is a stand-in, and it is doing more work than anyone intended.

## What to change, and in what order

1. **Do not touch the price table.** Two relations are the archive's (a tank is twice an infantry, a
   nuke is 10) and the rest are stand-ins; moving them now would hide the real problem under a
   second stand-in.
2. **Shorten `payEvery` before raising `perCity`.** 25 rounds is 2.1 minutes of nothing. At 12 rounds
   a payday lands every minute and a side of 14 cities still gets 19 units — same rate per minute,
   half the dead air. This is a pure clock change, and the log already prints it.
3. **Then measure again, with the same script.** The number to hold is *seconds per payday at the
   opening*, not money per minute: a player should never wait more than a minute to be given a
   reason to act.
4. **Only then consider upkeep** (a cost per piece or per city). It is the lever that makes land
   worth taking *and* expensive to keep, which is what the original's pressure felt like. It is also
   a new rule, so it needs the owner's agreement and another measurement — not a quiet constant in
   the config.

Items 1–2 above are superseded by T-001: the price table is the manual's, and `payEvery` is 1 with a
city paying 50 million. Items 3–4 still stand. Every measurement in this file is reproducible with
one command, but it will not resemble the current rules until `local/balance.mjs` is re-run.
