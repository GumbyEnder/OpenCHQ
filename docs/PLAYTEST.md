# A thousand rounds, played by two seats

`local/two-seat-play.mjs` — two accounts, two sockets, the ops a page sends (invite, answer, run,
sync, buy, order, tool), a small policy on each side (take the nearest city nobody owns, buy an
infantry when the purse allows). 1986, the real 269-site board, round length shortened to 0.12 s
for the run.

    node web/server/main.mjs        # OPENCHQ_CONFIG=/tmp/fast.json OPENCHQ_WEB_DATA=/tmp/ocq-play
    node local/two-seat-play.mjs 1000

## The result

| | |
| --- | --- |
| rounds played | **1000 in 156 s** (6.4 rounds/s; the clock asks for 8.3, the harness sends 8 orders a seat a round) |
| orders | 70,920 |
| purchases | 175 |
| tools used | 40 |
| cities at the end | blue 67, red 91, neutral 111 |
| pieces on the board | 78 |
| purse | blue 950, red comparable — nobody was spending it |
| winner | **nobody, in 1000 rounds** |

The last 275 rounds of the log are nothing but `paid 26 from 17 cities`, every 25 rounds, on both
sides. No captures, no contact, no shots.

## What that says

1. **The match deadlocks.** Two expanding seats meet a frontier they cannot cross and then simply
   pay each other forever. 1,000 rounds at the real 5 s round is 83 minutes of a game that has
   stopped changing. This is the stalemate the pacing notes predicted, now measured rather than
   argued.
2. **The frontier is water.** 8,716 refusals of `No sea lane reaches that cell.` The policy kept
   aiming at cities it could see and not reach. Transports exist and work — the log has
   `a unit boarded a transport` and `a unit landed` — but a destination with no lane at either end
   is not reachable, and the player is told nothing until they try. A hundred and eleven neutral
   cities sat untouched for four hundred rounds because of it.
3. **CONTACT NEVER HAPPENED.** Over a thousand rounds, two sides with 78 pieces between them never
   fought. The bot-vs-bot soak fights (first shot round 48) because the bot seeks the enemy; a
   player-like policy that only takes empty cities never meets anyone. Incentives again, not rules.
4. **Cash with nothing to buy.** 950 in the purse and 17 cities: the policy buys one infantry every
   two rounds because that is all it was told to do. A human would have bought armour and artillery
   and broken the deadlock. The economy is not the problem here; the player's decision space at the
   frontier is.
5. **The kit reports, and my first tally hid it.** Forty tool uses showed no events only because
   the counter looked for `capture`/`shot`/`destroyed`. Counting every kind on a short run:
   `{"satellite":2,"intel":2,"intel_seen":2}`. The acks are fine; the measuring was not — the same
   lesson as the full-frame harness two iterations ago.


## Round two: the order to attack (wakeup 26)

The deadlock had a cause, and it was not the economy. `planOrder` refused any destination whose
cell was occupied — **including an enemy's**. Two player-like sides therefore stood eight cells
apart for a thousand rounds: neither could give the order to close, and combat (which resolves
between adjacent pieces every other round) never had a pair to resolve. An order onto an
enemy-held cell is now an attack; a friendly piece in the cell is still a refusal, and `advance`
still stops one cell short and lets combat decide.

Same harness, same board, 1,000 rounds:

| | before (no attack order) | after |
| --- | --- | --- |
| cities | blue 83, red 89, neutral 97 | **blue 162, red 69, neutral 38** |
| pieces killed | — | 171 |
| refusals of "another piece holds that cell" | 8,886 | 6,043, and most now name a *friendly* piece |
| winner | none | none — the capitals are still standing |

The frontier moves now, and the map is being contested rather than shared.

### The payday is not the problem (measured, 600 rounds each)

| `payEvery` | cities at 600 | buys | purse at 600 |
| --- | --- | --- | --- |
| 25 | blue 111, red 76, neutral 82 | 220 | 709 |
| 12 | blue 88, red 78, neutral 103 | 257 | 1,468 |
| 6 | blue 94, red 75, neutral 100 | 231 | 3,013 |

Three times the income buys about a tenth more units and settles nothing; the purse simply grows.
**Do not shorten `payEvery`.** The recommendation in `docs/BALANCE.md` to fix the slope before the
shape was wrong for this reason: the slope was never the binding constraint. What a side cannot do
is spend, because at a frontier of empty cities there is nothing worth buying.

## Next, in order

1. The endgame: nobody can win. 162 cities against 69, 171 kills, and the capitals never fall. Find
   out what the win condition actually requires (probing the capital's ring and its garrison), then
   make the last ten rounds of a match legible to the player.
2. Make the frontier legible: a target that cannot be reached should say so at the moment it is
   chosen ("no lane from here to there"), not after the order is refused. That alone turns the
   deadlock into a decision: build a lane, take a coast, or go somewhere else.
3. Give the policy an army: tanks, artillery, a stack, and a reason to attack a held city. If the
   match still cannot be won at 1,000 rounds with armour, the stalemate is a rule defect, not a
   policy defect.
