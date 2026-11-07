# Balance: what a real match pays

Measured, not estimated. `node local/balance.mjs 1000` plays both seats on the same 269-site board
the lobby opens, with the same `buy` / `issueOrder` / `tickMatch` calls the server makes, and records
every payday.

Board: 269 sites — 62 cities, 2 capitals, 35 oilfields, 20 facilities, 150 docks.
Round: 5 s. Payday: every 25 rounds (2.1 min). Prices: infantry 1, tank 2, ship 2, nuke 10.

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

The bot also emitted 13,075 "No route. Wasteland is refused and a held cell is not entered." in 400
rounds. That is the same symptom the soak showed from the other side (6,750 blocked orders): a piece
whose next cell is held has no alternative, so an army in contact goes stiff. This is the next rule
to look at, and it is in the player's hands every round, unlike a payday.

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

Nothing above is applied. `incomeCurve` is `flat`, `payEvery` is still 25, and every number in this
file is reproducible with one command.
