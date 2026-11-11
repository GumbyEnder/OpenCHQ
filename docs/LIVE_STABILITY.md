# Live build stability — root causes and fixes (T-000)

The play-test on 2026-11-09 (1942, Blue vs bot, 67 rounds) could not reach combat. Three
independent faults explain what was seen. This file names each with the evidence that found it,
and the check that now holds it fixed.

## (a) The WebSocket dropped and orders were lost

### Root cause 1: frames of 64 KB or more were dropped in silence

`web/server/ws.mjs` `_frame()` wrote only the 7-bit (payload < 126) and 16-bit
(126 ≤ payload < 65536) length forms. The only other branch was:

```js
} else {
  return;            // payload >= 65536
}
```

So any frame of 64 KB or more left the function without a write and without a log line. `send()`
JSON-encodes every state message through this function, and a full room frame (pieces, sites,
routes, seat, shop, tools, log) can cross 64 KB once a match has pieces on it. The client sees
nothing — not a close, not an error — which is exactly "orders sent during a drop were silently
lost": the order went out, the answer never came back, and nothing in the protocol said so.

Evidence, in `web/test/nodes/ws_heartbeat.mjs`: a 70,000-byte payload now produces exactly one
write, length code 127, and a 64-bit length equal to the payload. Before the fix that call
produced zero writes.

Fix: the 64-bit length form (`header[1] = 127`, high/low 32-bit length), plus continuation-frame
reassembly, so a fragmented message is no longer half-parsed and discarded.

### Root cause 2: the server never pinged, so a proxy closed the idle socket

The server answered a client ping (opcode 0x9) but never sent one of its own, and a browser sends
nothing while a player is reading the board. Railway's edge closes a connection that has been
quiet for a while, so the page's "Connection lost / Reconnected" cycle repeated every few seconds
even though `curl` answered 200 in 0.4 s.

Evidence, same test: a raw upgraded socket receives a server-initiated ping frame within three
ping intervals, and an idle browser socket is still open (`readyState 1`) after 3× the interval.
Production interval is `PING_MS = 15000` ms, under the 20 s promise; the suite runs it at 300 ms
so the test stays inside a normal run.

### Root cause 3: the client reconnect loop was noisy and orders had no identity

`web/public/app.js` opened a new socket on every reconnect attempt with no order identity, so a
resend could not be recognised and a dropped order could not be replayed. Backoff also capped at
8 s and every attempt wrote a toast.

Fix:
- every buy/order carries `id`; the lobby keeps the ids it has applied and answers a duplicate
  with `{op:"ack", id, duplicate:true}` instead of applying it twice;
- the page keeps an order queue while the socket is down and flushes it on `welcome`;
- an order that is refused comes back with its id, and the toast names it;
- one "Connection lost" toast, backoff 0.5 → 1 → 2 → 4 → 8 → 15 s (capped), and "Reconnected"
  once;
- `/api/version` returns the shipped commit and the page footer prints it.

Test: `web/test/nodes/ws_order_queue.mjs` drops a socket between a Buy and its resend and asserts
exactly one unit exists on the board, then replays an order id and asserts a duplicate ack with
no second application.

## (b) Every ship order said "No sea lane reaches that cell"

Root cause: `web/server/lanes.mjs` decoded the 151 waypoints from `CHQ_unpacked.EXE` and
`tmap.bin` under `resolveDataRoot()`. The public host has no extract, so `resolveDataRoot()`
returned `""`, `laneGraph("")` returned an empty graph, and `move.planOrder` refused every sea
destination. It was not a routing rule: there was no lane table on the server at all.

Evidence: on this machine `laneGraph(root)` reports 151 waypoints / 519 edges; with `""` before
the fix it reported 0 / 0 and `seaRoute` returned null for every pair. `tools/bake_world.mjs` now
bakes the decoded waypoint and adjacency table into `web/data/world.json`, and `laneGraph("")`
plays that table. `tmap.bin`-free terrain is read from the same baked board.

Also fixed: a route no longer stops at a waypoint that the terrain map paints as ground (the
archive's lane table is coarser than its coastline). Route steps are restricted to water cells;
a lake is refused outright as the cut-off case.

Test: `web/test/nodes/ship_routes.mjs`, on the real board — Washington berth to mid-Atlantic (8
steps, 7 waypoints) and to a French/British dock (8 steps, 6 waypoints), every step water; all
7,419 ship-placeable cells reach the fixed mid-Atlantic cell (0 failures); a lake is refused;
three running rounds move the hull onto a later cell of its route.

## (c) Steel ran out at round 40 and the log blamed fuel

`config/game.json` burned steel 1 a round from 40 with no yield, and `log.mjs` printed
"out of fuel: units are not moving" for any `dry` event regardless of `kind`.

Decision, recorded in `config/game.json` as
`"choice": "non-original (owner choice, pending Shane; D-003)"`: **steel does not block movement
at all** (`"blocksMovement": false`). Steel is not in the original (Manual p.27: oil is the only
resource), so a non-original meter must never stall a normal match. Fuel keeps
`"blocksMovement": true`, and only a dry blocking resource stops a piece. The log now names the
resource: "out of steel" (no movement claim) and "out of fuel: units are not moving".

Test: `web/test/nodes/resources_stall.mjs` runs 200 rounds: steel reaches 0, the army ordered at
round 1 is still stepping at round 41 and round 100 (positions change across both windows), both
stall lines are checked for the right name and the wrong one, and a manually emptied fuel meter
does stop a unit.

## (d) Placement highlights were invisible

The server already returned a correct mask; the page painted it at 30 % alpha and one pixel per
cell at the whole-world fit, which read as "no highlights". The overlay is now 62 % alpha and
never smaller than one pixel, and `paintPlacement` is asserted at 1, 2, 5 and 12 px per cell.
Test `web/test/nodes/placement_highlights.mjs` also asserts the 1942 mask is non-empty for
infantry and for a hull at Washington, and that the first highlighted cell buys while an
unhighlighted one is refused.

## (e) Dialogs closed on every state refresh

The panel body is rebuilt on each room/delta update. The open id is now owned by a pure
state machine (`web/public/dialogstate.mjs`): a `refresh` never changes the id, only close, Esc,
leaving, or an action meant to close it does. The redraw restores the body's scroll position and
the focused control. Test `web/test/nodes/dialog_persistence.mjs` keeps Buy open through 30
refreshes with scroll 137 and focus intact.

## (f) Login did not survive a reload

The session cookie is `HttpOnly; Path=/; SameSite=Lax; Max-Age=14 days`, with `Secure` when the
request arrived over TLS (`x-forwarded-proto`). `/api/me` restores the user from that cookie alone
and now also refreshes its `Max-Age`. Test `web/test/nodes/session_reload.mjs` asserts the cookie
flags, that `/api/me` with only the cookie returns the same user, that a reloaded socket rejoins
the same room and seat while the clock runs, and that sign-out still ends the session.

## (g) The bot was invisible

The bot ordered its opening pieces but never bought, and neither buys nor orders were logged. It
now buys infantry when it can afford one (cap 6 pieces), prefers a cell near a site it holds, and
emits `bot_buy` / `bot_order` events. The lobby writes `bot <room> r<round> buy|order ...` to the
server log for every decision and keeps the last ten in `room.botActions`, which only the owner
account (`OPENCHQ_OWNER`, default `shane`) receives in its room view. The Debug panel renders
them. Test `web/test/nodes/bot_activity.mjs`: within 50 headless rounds the bot bought 7 units,
issued 10 orders and moved pieces 247 times; the debug rows show the buy and the order.

## Live checks, 2026-11-10 00:40–00:58 ET (build 2d4f372)

Every check below was run against the deployed host (`GET /api/version` = `2d4f372`, footer
`build 2d4f372`), and each writes a machine-readable record beside the screenshots. None of these
frames are hand-picked: the harness refuses to publish a capture unless the client's own round
counter equals the server's frame for that moment.

### 15 minutes, clock running, one tab: zero "Connection lost" toasts

Tool: `tools/live_soak_ui.mjs` (run `soak-9yrnob`, account `soakw9yrnqm`). Record:
`docs/captures/t000-soak-15min.json`.

- 901 s with the clock running, round **0 → 180**. Start and end counters are read from the
  status strip, not inferred from time.
- **0 toasts of any kind** and therefore **0 "Connection lost"** toasts (`toastCount: 0`,
  `disconnectToasts: 0`). The page's `#flash` is watched by a `MutationObserver`, so a toast that
  appeared between one-second samples would still be recorded.
- One WebSocket for the whole run: 1 open, **0 closes**, 396 frames received. `performance.timeOrigin`
  never changed, one page in the context at the start and at the end, cookie value hash unchanged,
  and `/api/me` returned the same account after 901 s.
- Screenshots (sha256 in the JSON):
  `t000-soak-15-start.png` (round 0), `t000-soak-15-mark.png` (901 s, round 180, clock running),
  `t000-soak-15-end.png` (round 180, clock stopped so the counter is fixed).
- The transport soak (`local/live_ws_idle.mjs`) agrees, but this is the client-side measurement the
  criterion names: the player's toast area stayed empty for the whole quarter-hour.

### Network off for 10 s, then a Buy: fresh coordinates, applied exactly once

Tool: `tools/live_offline_buy.mjs` (run 00:57, account `t000w9zcn2j`). Record:
`docs/captures/t000-offline-buy.json`; screenshots `docs/captures/t000-offline-buy-{armed,after}.png`.

The cut is a real `iptables -I OUTPUT -p tcp --dport 443 -j DROP` on the host's resolved Railway
edge address for 10 s, removed afterwards (verified: no rule left in `iptables -S OUTPUT`). The
Buy was armed first; the click point was recomputed **at click time**, after the cut began:

- mask cell: `86,61`; canvas at click time `1280x544`, CSS `1372x583`; click at `(385,336)`.
- result: **one** `bought` frame, no `error` frame, and the server's own sentence puts the
  submarine at **86,61** — the same cell the mask marked (`cellMatch: true`). One order, one unit,
  no duplicate.
- The socket never reported a close: TCP retransmitted the frame when the route came back, so the
  page did not enter its queued path and the "queued and will be sent" line did not appear. The
  order was not lost; the *feedback* during the silent partition is still missing. That remains an
  open polish item (treat "no frame for >2 ping intervals" as down, or show the queued line
  optimistically). It is not a lost or double-applied order.

### One ship run, departure to arrival, same hull, increasing rounds

Tool: `tools/live_ship_capture.mjs` (run `shiprun-9ytgri`, account `shipw9ytgts`). Manifest:
`docs/captures/t000-ship-run.json`.

| frame | file | round | clock | server cell |
|---|---|---|---|---|
| departure | `t000-ship-1-washington.png` | 2 | held | 84,44 (Washington berth) |
| mid-Atlantic | `t000-ship-2-mid-atlantic.png` | 7 | running | 106,32 (ordered waypoint) |
| arrival | `t000-ship-3-arrival.png` | 12 | held | 157,27 (Hamburg berth) |

One account, one hull id (`blue:cruiser:1`), rounds strictly increasing. Each PNG has a
burned-in strip: run id, hull id, round, server cell, and the client's status-strip line, so the
three frames cannot be mixed up after the fact. The harness publishes all three atomically: if
any invariant fails, nothing in `docs/captures/` is replaced.

**Provenance note on the earlier set.** The three PNGs shipped before this run were also from one
run — the record now kept at `docs/captures/t000-ship-run-before-atomic-publish.json`
(2026-11-10T00:00:51Z) says round 2 at 84,44, round 20 at 106,32, round 40 at 157,27, hull
`blue:cruiser:1`. But the old script wrote each file as it went,
so a failed run could leave a mixture of headers on disk, and an earlier attempt
(`proc_11b8a9756571`, 23:57) had latched onto a non-hull piece (`blue:sea`) before failing. A
frame quoting round 29 is not from the run recorded at 00:00:51Z; the published set is now the
single run above. The atomic publish and the in-image stamp are the fix for that ambiguity, not
just a new set of files.

### "The tab died twice and the cookie was dropped": automation, with one real app defect exposed

Tool: `tools/live_tab_diagnosis.mjs` (run `tabdiag-9yrr7f`, account `tabdiagw9yrr8z`). Record:
`docs/captures/t000-tab-diagnosis.json`.

The two candidates were separated on the live build:

- **Two page targets in one browser context** (the automation case): both pages stayed signed in —
  `/api/me` returned the same account in page 1 and page 2 — and the shared cookie stayed in the
  jar. The server closed the older socket each time the second page joined, always with code
  **1000** (8 closes on page 1, 7 on page 2 in 12 s). Each close produced "Connection lost.
  Reconnecting…" on the page that lost the socket (8 and 7 toasts respectively) and the loser
  reconnected and took the socket back: a ping-pong, not a session loss.
- **Closing the second target** ended it: one page, no further disconnect toasts, one
  "Reconnected. The match is where you left it.", and the round kept advancing.
- **Reload**: `/api/me` returned the same account and the same cookie value hash (14 days,
  HttpOnly, Secure, SameSite=Lax).
- **Close the last tab, open a new one in the same context**: still signed in, gate hidden.
- **A fresh browser context**: no cookie and `/api/me` null — a different cookie jar, which is
  exactly what a logged-out tab looks like. The app never navigates a page to `about:blank`, and
  the only code that ends a session is `/api/logout` (`signOut`); nothing else clears the cookie.

Verdict: the dead/logged-out tab was the automation browser's second target, which was in a
different cookie jar or had never navigated to the app — not the page and not the server. In the
single-tab run above the page stayed on the same document for 901 s with one WebSocket and no
reload, so criterion (f) holds as written. The real defect the episode exposed is the takeover
policy: two clients on one account fight for the socket instead of the loser standing down. That
is not criterion (a) for one client and not a session/cookie failure, but it is on the list: the
client that loses a takeover should not reconnect until the player acts, or `lobby.join` should
close with a reason the page can show instead of a bare 1000.

## T-000 follow-ups F1–F3 (fixed 2026-11-10, before T-002)

The PM accepted T-000 at room 2613 and logged three non-blocking follow-ups. All three are
fixed here, each with a node test that fails on the old behaviour.

### F1 — two tabs on one session fought over the socket

**Root cause:** `lobby.join` replaced the session's peer with `previous.close()`, which writes
close code **1000**. A page cannot tell 1000 apart from a deploy or a dropped wifi, so the
close handler did the only correct thing it knew: reconnect with backoff. The older tab took
the socket back, the newer tab was closed with 1000 in turn, and the two alternated about every
2 s — the 8-vs-7 toast counts in `docs/captures/t000-tab-diagnosis.json`.

**Fix:** a takeover is now one way.
- `web/server/ws.mjs` exports `TAKEOVER_CLOSE_CODE = 4001`.
- `lobby.join` sends `{op:"replaced", reason:"This session was opened in another tab."}` to the
  older peer, then closes it with 4001.
- `web/public/app.js` treats either the message or the close code as final for that tab:
  `standDown()` shows the sentence once and sets `socketState = "replaced"`; the close handler
  returns before any reconnect scheduling. A deliberate reconnect (reload, sign-in) clears the
  flag, so the newer tab can still be replaced by reloading the older one.

**Test:** `web/test/nodes/ws_takeover.mjs` opens two clients on one session, asserts the older
got exactly one `replaced` notice naming another tab, that its close code is 4001 (not 1000),
and that over four ping intervals the newer socket survives, presence lists the account once,
and the surviving socket still opens a room. That last part is what a reconnect cycle would
break.

### F2 — a silent cut shorter than the ping interval showed no feedback

**Root cause:** the page only spoke about an order when the socket *closed*. A cut shorter than
the 15 s ping leaves TCP retransmitting on an open socket: the order reached the server (the
10 s offline Buy in `docs/captures/t000-offline-buy.json`) and the page said nothing until the
reply arrived. If the reply was lost with the cut, the player saw neither a purchase nor a
refusal.

**Fix:** `web/public/orderwatch.mjs` — every order id is watched for 2 s (`ACK_WAIT_MS`). No
ack/bought/reject inside the wait, and the page says "No answer yet for your <kind>. It is
queued and will be applied when the server answers." Any answer settles the timer. The order is
still in `orderQueue` and still resent, so this changes the feedback, not the delivery.

**Test:** `web/test/nodes/order_ack_feedback.mjs` holds the ack back and asserts the queued line
appears exactly once, names the order, and that a settled order produces nothing. It also pins
`ACK_WAIT_MS` to the 1–3 s band so "about 2 s" cannot drift.

### F3 — "Bought an submarine at 86,61. Pool 300"

Two defects in one line, both in the client's `bought` branch:
1. the article was the literal string "an" for every kind;
2. `cash` came off the wire in **millions** (the server's unit) and was printed raw, so 300
   million read as "Pool 300" — 300 billion to a player, and a violation of T-001's
   "cash in billions" display rule.

**Fix:** `web/public/command.mjs` exports `articleFor(noun)` and `purchaseText(kind, at, cash)`.
The purchase noun table gives `infantry -> "infantry section"` (a collective cannot take "an
infantry"), the article follows the noun's first sound, and the pool is `formatBillions(cash) +
"b"`. The line now reads **"Bought a submarine at 86,61. Pool 0.3b."** — the pool is the same
unit as the Economy dialog and the purse line, which already went through `formatBillions`.

**Test:** `web/test/nodes/buy_message_text.mjs` asserts the submarine sentence exactly, asserts
no `Pool <raw millions>` form survives, and walks every shop kind for the article and the
billions suffix.

Suite after the three: **54 passed, 0 failed, 0 skipped, WEB_OK**.

## T-007 Part 2 — the two connections the 2026-11-10 play-test lost (AC3)

The play-test of `ae3539f` (2026-11-10, ~9:30 PM ET, account `pmtest1110`, 1942 vs bot) lost the
socket at round 90 and recovered at round 96, and the first "Play a bot" in the 2023 lobby answered
"The lobby is not connected" until it was clicked a second time. Both are the same class of defect:
the page treated "not connected right now" as a refusal instead of a wait.

### (a) "Connection lost. Reconnecting..." at round 90

**Root cause — server side.** The deployment's drain sends an `op: "bye"` frame and then closes
each peer's socket. That is a *planned* restart, but the frame carried nothing the page could tell
apart from a network failure: every `close` went down the same path, so the page said "Connection
lost. Reconnecting..." and entered its exponential backoff (1 s, 2 s, 4 s...). Round 90 was inside a
deploy window: `railway up` replaces the process, so every live room was ended by the restart, and
the six rounds between the toast and the recovery are the backoff, not a network fault. Round 96
recovered because the container was back by then.

**Fix.** `op: "bye"` now sets a planned-restart flag on the session. The close that follows retries
in 250 ms — no backoff for a server the page knows is coming back — and the message reads "The
server is restarting" instead of "Connection lost". A real cut still backs off and still says
"Connection lost. Reconnecting...", which is what that sentence is for.

**Note for the deploy lane.** Any deploy ends every live match, planned or not. The soak in
`tests/e2e/soak.mjs` is the instrument that proves no toast appears on an *undeployed* build;
deploying during a match and then counting the toast as a defect would measure the deploy, not the
game.

### (b) the first "Play a bot" said "The lobby is not connected"

**Root cause — client side.** The launch button called `send()` directly. On a fresh page load the
socket is still connecting (and after a drop it is still backing off), so `socket.readyState` was
not `OPEN`, and the branch for that case wrote "The lobby is not connected" and dropped the request.
The retry worked because by then the socket was open. Nothing on the server was wrong: the launch
request never arrived.

**Fix.** `send()` queues the request in `outbox` (20 deep) whenever the socket is not `OPEN` and
says "Connecting to the lobby - your request is queued and will be sent as soon as it answers." The
queue is flushed on `open` and again on `welcome`, in order, once. No launch, order or dialog action
can be thrown away by a socket that is merely late.

**Test.** `tests/e2e/run.mjs` closes the page's socket, sets the context offline, clicks "Play a
bot", asserts the queued sentence (and that "not connected" is gone), goes back online and asserts
the 2023 match opens. Local and live both pass.
