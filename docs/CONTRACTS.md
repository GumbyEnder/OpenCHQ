# OPENCHQ module contracts (parallel sprint)

Read this before writing a line. Eight agents work in one repo at the same time. The only
thing keeping that safe is strict file ownership and these signatures: **you may only edit the
files you own**, and the shapes below are fixed. If a signature is wrong for your node, do not
change it and do not edit someone else's file — write the problem in your report.

Repo: `/mnt/nas/projects/OpenCHQ`, branch `web`. Tests: `node web/test/run.mjs` must print
`WEB_OK`. Node 24+, zero npm dependencies.

## The one rule that protects everyone

- Edit only your own file(s) and your own test module. Never touch `web/server/main.mjs`,
  `web/server/lobby.mjs`, `web/test/run.mjs`, `docs/web-loop.graph.json`, `config/game.json`,
  `web/server/rules.mjs`, or another agent's module. The integrator owns those.
- Do not run `git add`, `git commit`, `git push`, `railway`, or `node tools/loopctl.mjs`.
- Do not install packages. Do not start Godot.
- Numbers that were never recovered stay unnamed. Read them from `web/server/rules.mjs` or
  `config/game.json`; never hard-code a price, a round length, a sight radius, or a terrain
  cost.

## Match state (owned by `web/server/match.mjs`, read by everyone)

```js
match = {
  era: "1918"|"1942"|"1986"|"2023"|"9999",
  round: 0,
  clock: "held"|"running",
  pieces: [ {
    id: "blue:land" | "red:sea" | <generated>,
    side: "blue"|"red",
    domain: "land"|"sea",
    kind: "infantry"|"tank"|"cruiser"|"carrier"|"submarine"|"aircraft"|null, // null = archive opening piece; saved "ship" loads as "cruiser"
    x, y,                                  // integers, 0..319 and 0..135
    path: [{x,y,pace}],                    // remaining steps, [] when idle
    pace: 1|2,                             // ticks this piece still owes on its current step
    facing: "e"|"w"|"n"|"s"|null,
    fighting: <pieceId>|null,              // the enemy it traded shots with
    shots: 0,                              // shots taken in the current continuous fight
    transport: true|false,                 // a land piece standing in water is cargo:
                                           // it does not fire and the first exchange sinks it
    movedRound: <round>|undefined          // last round it moved; combat reads it to tell
                                           // the attacker (mover) from the defender
  } ],
  foughtRound: -1,                         // last round a shot was resolved
  winner: null|"blue"|"red",
  over: false,
  capitals: { blue:{x,y}, red:{x,y} },
  sides: {
    blue: { cash, fuel, dry:false, wells:[siteId], cities:[siteId], bought: 0 },
    red:  { ... }
  },
  sites: [ { id, name, x, y, kind, owner:"blue"|"red"|null } ]  // from board payload, owners set at oil node
}
```

## Wire frames: a round is a difference, not a room

A seat's board arrives either as `{op:"room", room}` (the whole view) or as
`{op:"delta", roomId, delta:{round, clock, note, pieces, gone, routes, sites, seat?, capitals?}}`.
A delta names only what changed since the frame that seat was last sent, and `gone` lists ids that
left the view (a sunk ship, a piece that slipped out of sight).

A page that sees a round it cannot follow on from (a drop, a reload in the middle) sends
`{op:"sync"}` and gets a whole room back. `{op:"fullframes", on:true}` asks for whole frames every
round: tests read a board by waiting for the frame that shows it, and a debugger wants the same.

A full frame is about 27 kB for a 1986 board and a delta about 4.7 kB, measured with
`local/delta-cost.mjs` over ten rounds of the same room: 5.7x less on the wire.

## Modules, owners, and signatures

Every module is pure JavaScript over `match`. No disk, no network, no sockets, no timers.

### `web/server/tick.mjs` — owner A1
```js
export function tickMatch(match) -> { match, events: [] }   // one running round
export function checkWin(match) -> null | "blue" | "red"
```
One call = one round: advance pieces through `move.advance`, resolve fights through
`combat.resolve`, run `economy.upkeep` and `economy.pay`, then - only when a capital in
`match.capitalSet.list` changed hands that round - `checkWin`. A held match
(`clock !== "running"`) or a finished match (`over`) must return without changing anything.
Tests call this directly; never `setTimeout` in a test.

`checkWin` reads the era's whole capital set (`match.capitalSet`, the file's subtype-1/2 rows
joined to the live sites), not the two seats: every capital owned by one side is a win, one neutral
capital blocks both sides, and a set the site list only partly carries decides nothing.

### `web/server/move.mjs` — owner A2
```js
export function issueOrder(match, side, pieceId, toX, toY) -> { ok:true, path } | { error }
export function advance(match) -> events[]
export function blockedCells(match) -> Set<"x,y">
```
Land pieces walk one cell per round on open ground; slow ground and transport cost more, using
`rules.landPace`. Wasteland is refused. X wraps, Y does not. A piece may not stop on a cell
another piece holds; it stops one short and the fight belongs to `combat`. A `2023` match
starts with no pieces, so `issueOrder` against an empty roster is an error, not a crash.

### `web/server/combat.mjs` — owner A4
```js
export function resolve(match) -> events[]
export function adjacent(a, b) -> boolean      // Chebyshev 1, X wraps
```
Two opposing pieces on adjacent cells fight: they stay where they are, and a shot lands every
other round of one continuous fight. **No damage number is stored, shown, or invented.**
`HITS` (6) lives in `config/game.json` and is not to be raised.

### `web/server/view.mjs` — owner A5
```js
export function forSeat(match, side) -> { pieces, routes, sites, capitals, notes }
```
Own pieces always; enemy pieces only within `rules.sightCells` Chebyshev cells with X wrapping;
an enemy route appears only as its first `rules.enemyRouteSteps` steps. A submarine that did not
move this round is omitted entirely. In era `9999` the other side is omitted until its capital
is seen. Hidden pieces are **absent**, never flagged.

### `web/server/economy.mjs` — owner A6
```js
export function buy(match, side, kind, x, y) -> { ok:true, piece } | { error }
export function pay(match) -> events[]        // on rounds where round % payEvery === 0
export function upkeep(match) -> events[]     // per-side fuel burn and capture
export function capture(match, side, x, y) -> events[]
```
Land and aircraft buy on a friendly city or base cell; ships buy on a friendly dock (D-019,
Manual p.27; docs/re/PLACEMENT.md). Before the clock has ever run a purchase does not spend;
afterwards it spends `rules.priceOf(kind)` and production tires the city and the friendly cities
within `rules.readinessRules().radius` until a round the refusal names ("ready at round N").
A nuke is always refused. Income is 1 per city and 1 per owned well on every
`payEvery`-th round; capitals are not cities; a finished match pays nothing. Each side starts
with `rules.rules().fuel.reserve` and burns `burn` per round it has no unit on a well; a dry
side stops, the other side does not.

### `web/server/bot.mjs` — owner A7
```js
export function ordersFor(match, side) -> events[]
```
In a bot room the empty seat marches its army toward the player's capital and sails its ship
once. It must not repath the ship every round. A human seat never calls this — the caller
decides, not this module.

### `web/server/lanes.mjs` — owner A3
```js
export function laneGraph(dataRoot) -> { waypoints, edges }   // cached per root
export function seaRoute(dataRoot, from, to) -> [{x,y}] | null
```
151 waypoints live in `CHQ_unpacked.EXE` at file base `0x328B0`. The **server** may read that
file; the browser must never receive it. Land-to-land orders never become sea routes.

### `web/public/render.mjs` + `web/public/app.js` — owner A8
Draws the real cell grid when `/api/board` has cells, else the schematic; draws pieces from the
room view, capital markers, and a legend. No original art, no image bytes from the server.

## Tests: one module per agent

`web/test/run.mjs` imports every `web/test/nodes/*.mjs` and calls its `run(ctx)`. Write
`web/test/nodes/<your-node>.mjs`:

```js
export const name = "tick";              // your graph node id
export async function run(ctx) {
  const { base, sqlite, socket, register, waitFor, fail, config } = ctx;
  // ...assertions. Throw via fail("what was wrong: " + JSON.stringify(actual)) on failure.
}
```

`ctx` gives you: `base` (http URL of the running server), `sqlite()` (a read handle on the
throwaway DB), `register(name)` -> `{token}`, `socket(token)` -> `{ws, box, send, wait, close}`,
`waitFor(box, from, pred, label)`, `fail(msg)`, `config` (the parsed config/game.json).

Prefer testing modules directly (`import { tickMatch } from "../../server/tick.mjs"`) for pure
behaviour, and the socket path for anything a player can observe. A test must be able to fail:
state what breaks if the feature is removed.
