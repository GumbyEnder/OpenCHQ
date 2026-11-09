# OpenCHQ handoff

Checked 2026-11-09. Branch `web` in `/mnt/nas/projects/OpenCHQ` (GitHub `GumbyEnder/OpenCHQ`).
This file is the brief for the next agent. The work queue is `docs/web-loop.graph.json`; the
product plan is `docs/WEB_PLAN.md`; the loop is `docs/WEB_LOOP.md`. The living plan and task
list are in the vault at `01_Projects/OpenCHQ/` — start at [[Roadmap]] and
[[OpenCHQ PM - Index]].

## Vision

OpenCHQ is a two-side world-map strategy game played in a browser. It follows the shape of
Danielle Bunten Berry's 1990 design and does not use that game's name or logo. The original art,
the unit stills, and the unpacked executable are not part of this repository and must not be sent
to a browser.

A Node server owns accounts, the lobby, the clock, and the match. The page draws the board and
sends orders for its own seat. Godot is the archived desktop project on branch `desktop-godot`.
It is not the runtime. Do not start it, embed it, or export it.

One room is Blue against Red. Washington is Blue. Moscow is Red. The side that holds both
capitals wins. Extra people are more rooms, spectators, or partners on a side that already exists.
There is no third army.

A player registers, signs in, and either plays a bot or invites someone who is online. The server
clock runs at `roundSeconds` from `config/game.json` (currently 5 s per round; change it there,
never in code). Hold stops it. A round ticks a running match: pieces advance along their paths,
fights resolve, resources burn, and payday lands every `payEvery` rounds. Each seat sees only its
own pieces, nearby enemies, and a short slice of an enemy route — hidden pieces are omitted from
the payload, never flagged.

## What already runs

`node web/server/main.mjs` serves `http://127.0.0.1:8094`. `OPENCHQ_WEB_PORT` changes the port.
`OPENCHQ_WEB_HOST` defaults to localhost. The live build is on Railway; its footer prints the
commit and `GET /api/version` returns it.

Working today:

- Register and sign in. Passwords are scrypt-hashed. The session cookie is `openchq_session`,
  HttpOnly, Path=/, SameSite=Lax, not Secure. Usernames match `/^[A-Za-z][A-Za-z0-9_]{2,19}$/`;
  passwords are at least 8 characters. A bad login is "Those credentials did not match."
- Accounts live in `~/.local/share/openchq/`, or in `OPENCHQ_WEB_DATA`. Keep the database off the
  CIFS share: SQLite returns `database is locked` there.
- Lobby presence, invites, accept/decline. One socket per username: a second connection replaces
  the first and the old close does not end the room. Two reconnects in a row leave one socket.
- Play a bot or a human. The inviter keeps the side they picked.
- Hold and Run change a shared clock flag; both seats see it.
- **Pieces move.** A round advances every piece one step along its planned path (X wraps, Y does
  not). Terrain costs differ; sea pieces follow the lane graph. A route is drawn for the owner in
  full and for the enemy as its first `enemyRouteSteps` (3) steps.
- **Fights resolve.** Pieces stop one cell short of a shared cell, shots fall on alternate rounds,
  and overrun removes a defender when the attacker has strictly more pieces on the cell. No damage
  number is stored or shown; combat strength is compared, as the archive did.
- **The economy pays.** A city pays 50 million per round (integer millions internally), wells pay
  oil and never cash, bases pay nothing. Prices, rosters and income come from `config/game.json`
  with a `sources` entry each.
- Buying places a unit on the server's mask: land and air inside your own zone, ships in coastal
  water. A refused cell answers in the server's words, including
  "not a valid place for <unit>". A nuke is refused.
- Reconnect is a return, not a new game: a dropped client pauses the match, the seat and its
  standing orders are kept, and a returning socket resumes the same room held.
- The server pings each socket every 15 s (`OPENCHQ_WS_PING_MS`), and frames over 64 KB use the
  64-bit length form. Both exist because the live build showed silent drops without them.
- The bot buys infantry, logs each buy and order, and keeps its last actions on the room for the
  owner view.

## The plan (T-001 … T-004)

The PM's task files are in `01_Projects/OpenCHQ/Dev Tasks/`; the order and acceptance live in
[[Roadmap]].

| Task | Scope | State |
| --- | --- | --- |
| T-001 | Prices, roster split, income and wells | accepted |
| T-002 | Per-era sides, capitals and sites | next after T-000 |
| T-003 | Strength-based combat depth | queued |
| T-004 | Movement — straight lines, sea lanes, speeds | queued |
| T-005 | Groundwork — portable tests, disasm mapping, Ghidra renames, handoff | in progress |
| T-006 | Starting money from the original setup spinner | open RE question |

T-000 (live build stability) is accepted with fixes and stays open until its remaining manual
checks and screenshots land. Do not start T-002 before T-000 closes.

## Tests

`npm test` runs `web/test/run.mjs`. It starts its own server on a free port with a temporary
`OPENCHQ_WEB_DATA`, runs every module in `web/test/nodes/`, and ends with
`node tests: N passed, M failed, K skipped`. Every skip is listed with a reason. It exits non-zero
on any failure.

Node 22.5 or newer (`node:sqlite`). No npm dependencies; keep it that way.

Reference-tree checks read the extract only when it exists:

- `OPENCHQ_DATA` or `OPENCHQ_EXTRACT` — the extracted data root.
- `OPENCHQ_REFERENCE` — the reference tree root (the directory holding `tools/`, `docs/`,
  `extracted/`). Defaults to the sibling of the extract.
- `OPENCHQ_LOAD_HEADROOM` — the headroom multiple the load test must clear (default 10).

With no extract, board-dependent modules report as skipped, not passed. `node tools/check_renames.mjs`
checks the 23 Ghidra rename rows against `functions.txt` (`107e:3bd0` = `ai_turn_process`).

## How to take the next step

1. Work only on branch `web`. Claim a graph node with `node tools/loopctl.mjs next`; finish with
   `bash tools/fire.sh` on green. Commit only on `web`, never on `main`, never force-push.
2. Read the task file in the vault and the specs it cites before touching code.
3. Read tunables from `config/game.json`. If a number was never recovered, label it in `sources`
   or `notes` as a stand-in; do not bury a guess in a module.
4. Add a proof to `web/test/nodes/` for the behavior. A comment is not a proof.
5. Run `npm test`; require the summary line and exit 0, and read the skip list.
6. Mark the node done in `docs/web-loop.graph.json` only after that run.

## Rules the port must keep

- Board: 320 by 136. X wraps, Y does not. The terrain grid is 136 rows; the old picture is often
  described as 320 by 142. Do not mix them up.
- Terrain ids in order: ocean, docks, shallows, lake, capital, base, city, oilfield, plain, forest,
  mountain, desert, jungle, polar, wasteland, facility. Slow cells are shallows, forest, mountain,
  jungle, polar. Wasteland is refused. Facility is a mark, not a unit type.
- Eras: 1918, 1942, 1986, 2023, concealed `9999`. Rosters are in `config/game.json` (`rosters`)
  and follow Manual p.16; `9999` is labelled UNVERIFIED and uses the 1986 set.
- Opening pieces except 2023: one land army on the capital and one ship at sea — Blue (0, 15),
  Red (300, 70). 2023 starts with no pieces and a stand-in pool.
- Prices are the manual's, in billions: infantry 10, tank 20 (twice infantry), submarine 10,
  cruiser 10, carrier 20, aircraft 20, reconSat 10, killerSat 5, nuke 10, foreignAid 10,
  intelScan 10. The server stores integer millions via `money.perBillion`.
- Income: a city pays 50 million every `payEvery` round (1); a well pays oil, never cash; a base
  pays nothing; `capitalPays` is false and UNVERIFIED. A finished match stops paying.
- Resources are per side and data-driven (`config/game.json` → `resources`). Fuel is a stand-in
  (reserve 10000, burn 1, blocks movement, refilled at a well/oilfield). Steel is a non-original
  owner choice (D-003): 40 held, 1 a round, does not block movement, 1942/1986 only. The UI must
  label the steel readout as non-original.
- Sight 8, Chebyshev, X wraps; enemy routes show 3 steps. `HITS` stays 6.
- A fight stops pieces one cell short; shots fall every other round; no damage number is invented.
- Sea lanes: 151 waypoints decoded from `CHQ_unpacked.EXE`. The server may read that file locally;
  the client must never parse the executable.
- Player-facing text: no dollar sign, no 1990 product name, no "production", no "beats". "billion"
  may appear in a cash line. The oil card says "Rate unknown." The board says shallows are slower
  and that the time ratio was not recovered.
- A save payload is too revealing to send to a client. Hidden pieces are omitted, not flagged.

Reference for behavior, not for import: `modern/docs/re/RULES.md` and
`modern/docs/SUCCESSOR_PLAN.md`. The RE docs carry a low-confidence header: their function names
were re-applied on 2026-11-09, but any claim that depends on a name still needs re-checking.

## Where the code lives

| Path | Role |
| --- | --- |
| `web/server/main.mjs` | HTTP, cookies, static files, WebSocket upgrade, `/api/version` |
| `web/server/db.mjs` | SQLite accounts and sessions |
| `web/server/lobby.mjs` | Presence, invites, rooms, socket registry, orders |
| `web/server/tick.mjs` | Round loop: movement, fights, resources, payday |
| `web/server/economy.mjs`, `shop.mjs` | Prices, income, buying |
| `web/server/placement.mjs` | Where a purchase may stand (the mask the page paints) |
| `web/server/match.mjs`, `view.mjs` | Match state and the per-seat filtered view |
| `web/server/ws.mjs` | WebSocket frames and keepalive, no npm dependency |
| `web/public/` | `index.html`, `app.js`, modules for paint, dialogs, glyphs, shell |
| `web/test/run.mjs` | Harness: summary line, per-module pass/fail/skip |
| `web/test/nodes/` | One module per behavior, `{ name, run(ctx) }` with `ctx.skip(reason)` |
| `docs/web-loop.graph.json` | Node status; edit status only after a green run |
| `config/game.json` | Every tunable, with `sources` and `notes` |

## Do not

- Do not start, embed, or export Godot for this game. A custom Godot 4.7 build has no stock web
  template.
- Do not use port 8787. Another program listens there. The game default is 8094.
- Do not point a test at `~/.local/share/openchq`.
- Do not commit the extract, `WORLD_MAP.png`, stills, or `CHQ_unpacked.EXE`.
- Do not invent a third side, a damage number, an oil production rate, or a movement-time ratio.
- Do not delete `origin/desktop-godot` or change `main`.
- Do not copy guessed formulas. If a number is not in `config/game.json` with a source, it is a
  stand-in and must say so.
