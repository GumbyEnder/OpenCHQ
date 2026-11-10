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

## Live checks, 2026-11-09 23:55 – 00:10 ET (build 2d4f372)

Three manual checks from the task, run against the deployed host, each with the machine-readable
record kept beside the run (`tools/live_offline_buy.mjs`, `tools/live_ship_capture.mjs`).

**15 minutes, clock running, one tab.** 901 s, round 2 → 182, page never reloaded
(`performance.timeOrigin` unchanged), **0 "Connection lost" toasts**. The only toast in the window
is the buy confirmation from the test itself. The transport-level check agrees: `local/live_ws_idle.mjs`
held one socket for 900 s, 59 server pings answered, `RESULT STILL_OPEN`.

**Network off for 10 s, then a Buy.** The cut was real — an `iptables DROP` on the host's address for
10 s, removed afterwards; Chrome's own offline emulation leaves an established WebSocket up, so it
never reaches the client. A cruiser was armed in Buy, the cut started, the highlighted cell was
clicked, the cut ended. The order landed **exactly once** (`bought an submarine at 86,61`,
one `bought` frame, no error, no duplicate).

What did **not** happen in that window: the "your order is queued" line. The socket never reported a
close, because TCP retransmitted the frame when the route came back. `sendOrder` only queues when
`readyState !== OPEN`, so a silent partition shorter than the 15 s ping does not produce the toast —
the order survives, the feedback does not. Worth a follow-up: treat "no pong / no frame" as down, or
show the queued line optimistically.

**Ship from Washington to a European port.** Bought a cruiser at the 84,44 berth (the capital itself
is inland; the server refuses a hull on land), ordered 106,32 mid-Atlantic (5 rounds), then 157,27
Hamburg's berth. Captures `docs/captures/t000-ship-{1-washington,2-mid-atlantic,3-arrival}.png` were
taken only when the server's own room frame put the hull at those cells: round 2 held at 84,44,
round 20 running at 106,32, round 40 at 157,27.

**Two clients on one session loop.** Opening the same account in two tabs produces a takeover
ping-pong: each `join` closes the other socket with code 1000, each client reconnects with a 0.5 s
backoff, and both tabs alternate "Connection lost. Reconnecting…" / "Reconnected." every ~2 s. A
single tab is clean, so this does not affect the criterion above, but it is a real defect in the
reconnect policy (the loser of a takeover should stand down, not fight back).
