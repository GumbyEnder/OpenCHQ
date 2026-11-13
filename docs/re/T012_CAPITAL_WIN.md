# T-012: capital ownership and the win check

Status: `t012-wincheck`. Owner: game. Written 2026-11-13.

## What was already true (AC1, and why the task's premise changed)

T-010's sweep on live `5a602f9` added an owner trace to `tests/e2e/full-match.mjs` (merged as
`268ad63`/`dee678f`) that polls every site's owner from round 0. On the 1942 policy run at speed 6
(`tests/e2e/t010-full-match-1942-s6-2026-11-13T13-07-23-562Z/summary.json`) it records:

```
r19 first contact
r20 Nagoya  (type 4) red->blue  by blue:land:tank
r21 Paris   (type 1) red->blue  by blue:land:tank
r21 Tokyo   (type 2) red->blue  by blue:land:tank
r22 Berlin  (type 2) red->blue  by blue:land:tank   -> win blue
```

Speed 1 on the same build: contact r18, Paris and Tokyo r20, Berlin r21, win r21
(`...s1-2026-11-13T13-08-32-316Z/summary.json`).

Every capital owner change is a `capture` event emitted by `economy.occupy`, with a blue tank on
the cell. There is no second write path for a capital and no seeding drift: at round 0 the six
owners are exactly R-MAP-06. The "one capture (Paris) logged" in game 3698 was a harness artifact -
`firstCapture` was baselined after the flips - fixed in `268ad63`.

The 3669 "control run that ended r22 with no orders" was **not** orderless: it ran `--gate=contact`,
so phase 2 ordered every land piece at its nearest red capital. The new `--no-orders` control (no
phase-2 attack, no phase-3 re-order) reached **round 400 with no capture, no capital change and no
winner** (`...s6-2026-11-13T13-02-39-371Z/summary.json`).

The one row in the trace with no piece on the cell is Archangel (city id 0) at round 4 in both
runs: a city, not a capital, and `by: []` is the poll interval (0.14 s per round at speed 6) missing
the capturing piece, not a second write path. `grep -rn "\.owner\s*=" web/server` gives four writes:
`economy.mjs:125` (`seedOwners`, the opening), `economy.mjs:287` (an oil well, which also emits its
own capture event), `economy.mjs:340` (`occupy`, the one piece-driven write), and `late.mjs:199`
(the `aid` tool, which filters to `kind === "city"`). No write can move a capital except `occupy`.

## What was actually wrong (AC5) and what T-012 changes

The match ended for the right reason and told the player nothing about it. The end screen said
"The match is over." and the log said "you hold every capital (6 of 6)"; neither named the capital
whose fall completed the set, and the War panel had no capital list to check the claim against.

- `web/server/tick.mjs`: the win event now carries the decisive capital and the round, and the
  match stores `winReason` so a reload or a reconnect reads the same sentence. `decisiveCapture`
  walks the round's capital captures backwards, so a round that takes two capitals names the one
  that actually completed the set rather than the first in site-id order.
- `web/server/view.mjs`: `capitalListOf` (the era's capitals with the holder the site records
  carry), `resultOf` (winner, reason, decisive capital, list, round) and `resultNote` (the one
  sentence, written once on the server).
- `web/server/lobby.mjs`: the seat view and the delta carry `capitalList` and `result`; the room
  note at the end is `resultNote`; the `over` op carries the result.
- `web/server/log.mjs`: the win line names the capital - `you hold every capital (6 of 6); Berlin
  fell at round 22 last`.
- `web/public/app.js`: the end screen prints the reason and the capital list; the War panel lists
  the capitals from round 0 and marks the one that fell last; a delta now applies `over`, `winner`
  and `result` (a seat on deltas used to keep playing past the end - the harness watched one do it
  for ten minutes).
- `web/public/shell.mjs`: the strip reads `blue won (Berlin, round 22)`.

Resignation keeps its own note and has `reason: "resignation"`: there is no capital to name, and the
page says so instead of borrowing one.

## Tests

`web/test/nodes/capital_win.mjs` (new; 5 legs):

1. round-0 capital owners equal R-MAP-06 for 1918, 1942 and 1986, read off the live site list the
   match is built from;
2. a driven 1942 match (three ordered tanks, engine path order -> walk -> occupy): every capital
   owner change has a matching capture event in that round, with the same side, and the match ends
   by capitals;
3. win tests: Paris alone is no win; Berlin, Paris and Tokyo win it for blue on the third capture;
   London, Washington and Moscow win it for red; 1918 is won by Berlin; a neutral capital blocks;
4. the result names the decisive capital and the round, and its capital list equals the site
   records;
5. the result, the seat view, the end-screen sentence and the log line agree, and a resignation
   invents no capital.

In-place tests still pin the existing rule: `capital.mjs`, `capital_open.mjs`, `capitals_table.mjs`,
`tick.mjs`, `log.mjs`, `sight.mjs` (the seat view's shape now includes `capitalList` and `result`).

## Live evidence (see the report)

- `tests/e2e/t012-ac1-2026-11-13/ac1-capital-trace.txt` - the AC1 trace from the T-010 sweep.
- `tests/e2e/t012-full-match-1942-s6-*`, `...-s1-*`, `...-s6-*` (no-orders) - the T-012 re-runs on
  the deployed build, with `00-capitals-round0.png`, `04-end-screen.png`, `05-end-capitals.png` and
  `summary.json` (result, chosen capital, end note).

## PB-025: the 63 s reconnect (AC2 of the re-scoped task)

Measured by `tests/e2e/drop-buy.mjs` against live `5a602f9`: `reconnectedAfterMs: 63004` after a 10 s
`iptables` DROP. Two independent faults stacked, and either one alone costs more than the 15 s budget:

1. **The wait climbed to 15 s.** `Math.min(15000, 500 * 2 ** (tries - 1))` — 0.5, 1, 2, 4, 8, 15, 15…
   so a drop landing just after a retry could wait 8 s before even trying, then another 15 s.
2. **A hung attempt had no deadline.** A `WebSocket` whose SYN is inside the DROP raises no `error`
   and no `close`; the page sat inside that one attempt while the network was already back, and the
   retry counter never advanced. This is the part that produced a minute, not seconds: the page was
   not backing off, it was blocked.

The harness compounded it: the wait was on the flash text `/Bought an|reconnect|refused/`, and the
cruiser leg says "Bought a cruiser", so the wait always burned its full 60 s timeout and the number
recorded was the timeout, not the reconnect. `reconnectedAfterMs` is now read from the page's own
socket timeline (`__wsLog`, installed by `addInitScript`) — the first socket that `open`s after the
DROP is lifted.

**After** (`web/public/reconnect.mjs`, one policy for both a close and a never-opened socket):

| | before | after |
|---|---|---|
| wait schedule | 0.5, 1, 2, 4, 8, then 15 s capped | 0.5, 1, 2, then 4 s capped |
| attempt deadline | none (a hung connect blocks for ever) | `CONNECT_TIMEOUT_MS` = 6 s |
| worst case after the network returns | unbounded (observed 63 s) | 6 + 4 = **10 s** |
| tries before "reload the page" | 8 | 30 (≈2.9 min of dead wifi) |
| accepts a reply for a resent order | `ack` only, no payload | the first reply, flagged `duplicate` |

**The queued order.** Two losses were possible and both are closed:

- The page used to drop an order from `orderQueue` the moment it was written, so an order written
  into a socket that was already dying was never resent. An order now stays in the queue until a
  reply for its id arrives (`settleOrder`), and the queue is scoped to the room it belongs to so a
  reconnect into a new match cannot replay a stale purchase.
- The server answered a resent id with a bare `{op:"ack",duplicate:true}`, so a page that lost the
  original `bought` frame learned only "duplicate" and showed no confirmation. `lobby.mjs` now
  remembers the first reply per `(username, id)` (1000-entry bound) and replays it with
  `duplicate: true`. The purchase is still applied exactly once — `web/test/nodes/ws_order_queue.mjs`
  asserts one piece on the board after a resend.

Tests: `web/test/nodes/reconnect.mjs` pins the schedule, both bounds, a simulated 10 s drop, and
checks that `app.js` actually drives `backoffMs`/`CONNECT_TIMEOUT_MS` (a comment cannot regress).
`tests/e2e/drop-buy.mjs --drop-socket` kills the page's socket mid-cut so the reconnect path — not
the surviving socket — is what gets exercised.
