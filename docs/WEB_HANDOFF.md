# OpenCHQ handoff

Checked 2026-11-06. Branch `web` at `e057a02` on `https://github.com/GumbyEnder/OpenCHQ`. This file is the brief for the next agent. The graph in `docs/web-loop.graph.json` is the work queue. The product plan is `docs/WEB_PLAN.md`. The one-node loop is `docs/WEB_LOOP.md`.

## Vision

OpenCHQ is a two-side world-map strategy game played in a browser. It follows the shape of Danielle Bunten Berry's 1990 design and does not use that game's name or logo. The original art, the unit stills, and the unpacked executable are not part of this repository and must not be sent to a browser.

A Node server owns accounts, the lobby, the clock, and the match. The page draws the board and sends orders for its own seat. Godot is the archived desktop project on branch `desktop-godot`. It is not the runtime. Do not start it, embed it, or export it. The Godot scripts on `web` are reference notes for behavior that still has to be ported to JavaScript.

One room is Blue against Red. Washington is Blue. Moscow is Red. The side that holds both capitals wins. Extra people are more rooms, spectators, or partners on a side that already exists. There is no third army.

A player registers, signs in, and either plays a bot or invites someone who is online. The server clock runs continuously at 0.14 seconds per round. Hold stops it. The server does not wait for both seats before a round. Each seat sees only its own pieces, nearby enemies, and a short slice of an enemy route. A human seat sends its own orders. A bot seat marches on the player's capital and sails once. Each side has its own fuel, so one dry side does not freeze the other.

## What already runs

`node web/server/main.mjs` serves `http://127.0.0.1:8094`. `OPENCHQ_WEB_PORT` changes the port. `OPENCHQ_WEB_HOST` defaults to localhost.

Working today:

- Register and sign in. Passwords are hashed with scrypt. The session cookie is `openchq_session`, HttpOnly, Path=/, SameSite=Lax, not Secure. Usernames match `/^[A-Za-z][A-Za-z0-9_]{2,19}$/`. Passwords are at least 8 characters. A bad login is always "Those credentials did not match." A duplicate name is "That name is taken."
- Accounts live in `~/.local/share/openchq/`, or in `OPENCHQ_WEB_DATA` when that is set. The project directory is a CIFS mount. SQLite returns `database is locked` if the database file is on that share.
- The lobby lists connected users. One socket per username. A second connection replaces the first, and the old close must not end the room.
- Play a bot. The player sits on the chosen side. The other seat is Bot.
- Invite, decline, and accept. The inviter keeps the side they picked. The other human gets the opposite side.
- Hold and Run change a shared clock flag. Both seats see it.

Pieces do not move. The clock does not call a tick. The match page is a schematic, 640 by 284, with Washington at (79, 44) and Moscow at (183, 25). Disconnect ends the room at once with "NAME left the match." Reconnect is a later node. Do not build it early.

Proof of the scaffold: `node web/test/run.mjs` prints `WEB_OK` and exits 0. That run is iteration 1 of 40. The counter on this machine is `/tmp/openchq-web-iteration` and is not in git.

## What is outstanding

Six nodes are done: `accounts`, `lobby`, `bot_room`, `human_room`, `clock`, `harness`. Seventeen nodes are still `todo`. The only ready node is `board_data`.

| Order | Id | Depends | Work left |
| --- | --- | --- | --- |
| 70 | board_data | harness | `GET /api/board`: 320 by 136 cells, stride 162, sites, both capitals, no image and no executable path |
| 80 | board_paint | board_data | Canvas paints cell ids. Distinct colors for ocean, shallows, city, and capital. Schematic only when the extract is missing |
| 90 | pieces | board_paint | 1986 and the other early eras place four pieces. 2023 places none. The room view includes the caller's pieces |
| 100 | tick | pieces | Direct `tick()` moves a running room one round. Held does not move. Tests do not sleep 0.14 seconds |
| 110 | orders | tick | Own land piece, one cell per round. X wraps. Y does not. Wasteland refused. Slow terrain is slower, and the ratio stays unnamed |
| 120 | lanes | orders | Ships follow the lane graph. Server may read the executable locally. The browser never receives it |
| 130 | bot | lanes | Bot army paths toward the player capital. Bot ship sails once and is not repathed every round |
| 140 | human_orders | orders | A human room never receives bot orders. A forged side is refused |
| 150 | combat | tick | Pieces stop one cell short. A shot every other round of one fight. No damage number |
| 160 | sight | bot, human_orders | Own pieces, Chebyshev 8, first three enemy steps. Still submarine hidden. Concealed era hidden until the enemy capital is found |
| 170 | buy | pieces | City for land and aircraft, dock for ships. Pre-run purchases are free. In-match prices are stand-ins. A nuke is refused |
| 180 | oil | pieces, tick | Wells start with their country. Capture by standing there. Do not copy production ratings |
| 190 | income | oil, tick | 1 billion per city and 1 billion per owned well, paid every 25th round. Capitals are not cities. A shortage pays nothing. A finished match stops paying |
| 200 | fuel | oil, tick | Each side starts at 10000 and burns 1 off a well. Zero stops that side only |
| 210 | win | tick, pieces | Both capitals ends the match. Later ticks do not move, pay, or burn |
| 220 | reconnect | sight, human_orders | A dropped socket can return and see the same room. Today a drop ends the room. Change that only in this node |
| 230 | drop_godot | win, buy, oil, income, fuel, sight, combat, lanes, bot | Delete Godot files from `web` only. Leave `origin/desktop-godot` and `main` alone |

`human_orders` can start once `orders` is done. It does not wait for `bot`. `buy` can start once `pieces` is done. The graph file is the authority if this table and the file disagree.

## How to take the next step

The loop is hands-free as of 2026-11-06. A scheduled Hermes job in the `game` profile fires
`docs/WEB_LOOP.md` on a timer; nobody pastes a fire and the fire commits, pushes and deploys
on green. `board_data` (order 70) is done. The next ready node is `board_paint`.

1. Work only in `/mnt/nas/projects/OpenCHQ` on branch `web`. Claim the node with
   `node tools/loopctl.mjs next` and finish the pass with `bash tools/fire.sh`.
2. Read the extract the way the desktop archive did: `OPENCHQ_DATA`, then `local/data_root.txt`, then `data/`. On this machine `local/data_root.txt` points at the extract beside the old research tree. That folder is gitignored.
3. Load `data/tmap.bin` as 320 by 136 nibbles with row stride 162, and `data/sites.json`.
4. Add `GET /api/board`. Return width, height, cell ids, and sites. Washington and Moscow are the capitals.
5. The JSON has no image bytes and no path to `WORLD_MAP.png`, the stills, or the unpacked executable.
6. Extend `web/test/run.mjs` so the new proof runs with the existing account, lobby, bot, invite, and clock proofs. A comment is not a proof.
7. Run `node web/test/run.mjs`. Require the line `WEB_OK` and exit 0. The test binds `127.0.0.1` on a free port and sets `OPENCHQ_WEB_DATA` to a temporary directory.
8. Mark `board_data` as `done` in `docs/web-loop.graph.json` only after that run. If the run fails, leave the node `todo`.

A green pass is committed, pushed and deployed by `tools/fire.sh`; that is the standing rule now,
not a per-session permission. Commit only on `web`, never on `main`, never force-push.
The iteration counter moved into the repo at `docs/loop-state.json` (cap 40); the old
`/tmp/openchq-web-iteration` file is retired and `/tmp/openchq-polish-iteration` is not touched.
The scheduler exists by design now — see `docs/WEB_LOOP.md`.

## Rules the port must keep

These are stand-ins the user accepted. They are not recovered booklet figures. Do not replace them with guesses from `docs/re/ECONOMY.md`, `docs/re/COMBAT.md`, or `resources_oil.json`.

- Board: 320 by 136. X wraps. Y does not. The old picture is often described as 320 by 142. The terrain grid is 136 rows. Do not mix those up.
- Terrain ids, in order: ocean, docks, shallows, lake, capital, base, city, oilfield, plain, forest, mountain, desert, jungle, polar, wasteland, facility. Slow cells are shallows, forest, mountain, jungle, and polar. Wasteland is refused. Facility terrain id 15 stays a mark, not a unit-type nibble and not a link to executable byte `0x1102`.
- Eras: 1918, 1942, 1986, 2023, and concealed `9999`.
- Opening pieces, except 2023: one land army on the capital and one ship at sea. Blue ship (0, 15). Red ship (300, 70). 2023 starts with no pieces and a stand-in pool of 40. Early pools are 9.
- Prices: infantry 1, tank 2, ship 2, submarine 2, aircraft 2, nuke 10. A nuke is always refused. A tank stays twice an infantry. Pre-run placement does not spend. In-match buying spends and marks the city unready, with no recovered duration.
- Income: `PAY_EVERY` 25, `CITY_PAY` 1, `WELL_PAY` 1. Cities are sites whose kind is city. Capitals do not pay as cities. A well pays only when its owner is the side. A named country that is not Blue or Red pays nobody. "Russia" matches the red side. Other names, such as "Iran", stay that name. Empty or unknown wells start neutral.
- Fuel on the web game is per side. `OIL_RESERVE` 10000. `OIL_BURN` 1. Standing on any oil cell refills that side. Do not lower those two numbers. The desktop archive still has one shared reserve. Do not "fix" the desktop game while porting.
- Sight 8, Chebyshev, X wraps. Enemy routes in a view are the first three steps. Contacts in the desktop archive last 8 rounds. Do not lower `SIGHT_CELLS`.
- `HITS` is 6 in `scripts/assumptions.gd`. Leave it. The desktop Washington-to-Moscow march meets one cell short, and Red holds both capitals. Raising it changes that result.
- Fight: pieces stop short of a shared cell. A shot falls every other round. No damage number is stored or shown. The desktop fight voice is "Stand-in fight. The shot has no damage yet."
- Sea lanes: 151 waypoints in `CHQ_unpacked.EXE` at file base `0x328B0`. The server may read that file on the machine that hosts it and cache the graph. The client must never parse the executable.
- Player-facing match text must contain "shallows are slower" and "ratio was not recovered" where the board states the rules. It must not contain a dollar sign, the 1990 product name, "production", "beats", or "one extra". "billion" may appear in a cash line. The oil card says "Rate unknown."
- A save payload is too revealing to send to a client. Hidden pieces are omitted, not flagged.

Reference for behavior, not for import: `scripts/match_state.gd`, `scripts/terrain_map.gd`, `scripts/assumptions.gd`, `scripts/sea_lanes.gd`. Shapes also live in `/mnt/nas/projects/Command HQ/modern/docs/SUCCESSOR_PLAN.md` and `docs/re/RULES.md`. Do not build in `/mnt/nas/projects/Command HQ/modern/game/`.

A 1000-tick desktop sim of 1986 as Blue, after the income change, is already recorded. Red wins on tick 173 by holding Washington. Ticks 174 through 1000 stay frozen. Deposits fall on 25, 50, 75, 100, 125, and 150. At tick 1000 the cash is Blue 118 and Red 97 billion, with no purchases and no wells captured. The oil reserve ends at 9827. Do not chase that run unless asked. Do not start Godot to re-prove it.

## Where the code lives

| Path | Role |
| --- | --- |
| `web/server/main.mjs` | HTTP, cookies, static files, WebSocket upgrade |
| `web/server/db.mjs` | SQLite accounts |
| `web/server/lobby.mjs` | Presence, invites, rooms, clock flag |
| `web/server/ws.mjs` | WebSocket frames, no npm dependency |
| `web/public/` | `index.html`, `app.js`, `app.css` |
| `web/test/run.mjs` | The only proof. Prints `WEB_OK` |
| `docs/web-loop.graph.json` | Node status. Edit status only after `WEB_OK` |
| `scripts/*.gd` | Desktop archive and behavior reference |

Node on this machine is v25 and has `node:sqlite` plus a global `WebSocket`. The web package has zero dependencies. Keep it that way.

Lobby socket ops today: `bot`, `invite`, `answer`, `run`, `hold`, `leave`. Server messages include `welcome`, `presence`, `room`, `invite`, and `declined`.

## Do not

- Do not start, embed, or export Godot for this game. A custom Godot 4.7 build has no stock web template.
- Do not use port 8787. Another program listens there. The game default is 8094.
- Do not point a test at `~/.local/share/openchq`. That directory is the real account database.
- Do not commit the extract, `WORLD_MAP.png`, stills, or `CHQ_unpacked.EXE`.
- Do not invent a third side, a damage number, an oil production rate, or a movement-time ratio.
- Do not fake piece movement in the page before the `pieces` and `tick` nodes.
- Do not delete `origin/desktop-godot` or change `main`. `main` stays at the earlier demo (`e2d5f86`).
- Do not run the Linux Godot editor and the Windows editor on this folder at the same time. The `.godot` cache is shared. Windows sees this tree as `K:\projects\OpenCHQ`.
- Do not copy guessed formulas. If a number is not in `scripts/assumptions.gd` or set by the user in `docs/WEB_PLAN.md`, leave it unnamed.
