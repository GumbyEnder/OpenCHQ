# OpenCHQ in the browser

The desktop Godot game stays. The forward work is a browser client and a central server. The server runs the match. The browser shows one seat.

The preserved desktop line is the Git branch `desktop-godot` on `github.com/GumbyEnder/OpenCHQ`. `main` is still the earlier demo. New work lands on `web`.

## What stays

The rules stay in `scripts/match_state.gd`. `scripts/check_rules.gd` remains the oracle. A browser change that cannot pass that check does not ship.

The map stays in `scripts/map_view.gd`. It draws the local extract: the 320 by 142 picture, sites, oil, routes, and pieces. The browser does not receive `WORLD_MAP.png`, the unit stills, or `CHQ_unpacked.EXE`. Those files are original art and an original binary. Sea lanes stay a table the server reads. The client never parses the EXE.

The Godot window still runs with `godot --path .` on this branch. It is the single-player game and the place the rules are proven.

## What a match is

One room has two sides, Blue and Red. The winner is the side that holds both capitals. A third person is another room, a spectator, or a partner on a side that already exists. A third army is a different game.

Two ways to start:

- Against a bot. You pick the era and your side. The empty seat is the opponent already inside `tick()`: that army marches on your capital, and that ship sails once when idle.
- Against a person. You register, sign in, stand in the lobby, and invite someone who is online. They accept. You are one side. They are the other. The bot orders stay off for both seats.

The server is the only process that calls `tick()`. A client sends orders for its own seat. The server answers with the view that seat may see: own pieces in full, enemy pieces inside 8 cells, enemy routes as the first three steps, a still submarine hidden, and the concealed era hidden until that capital is found. The save file is not a network message. It contains both treasuries and every piece.

The clock stays continuous. One running round is 0.14 seconds, the same interval the desktop game uses. Speed 0 holds time. The server does not wait for both players before a round, because income, fuel, and combat count rounds. A dropped connection leaves the last path in place until the room ends.

Fuel is still one reserve, and it belongs to the single desktop player. A dry reserve stops the whole match. Human games need a reserve per side before they are fair. That change is a rules change and has to pass `check_rules.gd`. It is not in the shell below.

The fight still follows the first land piece of each side. Bought tanks exist. They do not yet fight as a stack. Two humans will meet that on the first match.

## Baseline in this branch

`node web/server/main.mjs` serves `http://127.0.0.1:8094`. `OPENCHQ_WEB_PORT` changes the port.

- Register and sign in. Passwords are hashed. Sessions are cookies. Accounts live in `~/.local/share/openchq/` because the project directory is on a network share and SQLite cannot lock a file there. `OPENCHQ_WEB_DATA` overrides that folder.
- The lobby lists people who are connected.
- Play a bot. The room records your side, the era, and a held clock.
- Invite a person, and accept or decline. An accepted invite opens one human room.
- Hold and Run store the clock flag both seats can see.

The shell does not move pieces. It does not attach `MatchState`. The match page says so. A schematic marks Washington and Moscow on the cell grid. It is not the painted map.

## Next slices

1. A rules worker. One headless Godot process per room, speaking JSON lines. Bot rooms leave the opponent block in `tick()` on. Human rooms skip it. The worker loads the data pack from the machine the server runs on, not from the browser.
2. A per-seat view. The worker emits the same facts `shows_piece` and `visible_steps` already decide. The browser draws that view. Hidden pieces are absent from the message, not merely faded.
3. Orders. Click your piece, then a cell. Buy, entrench, and the other desktop orders follow, each checked against the seat.
4. Per-side fuel, then the human clock can run without one dry side freezing the other.
5. Reconnect. The room keeps the match. The seat gets a fresh view. A spectator view can wait until the two-seat game is honest.

## Public host

This shell binds to localhost and speaks plain HTTP. A public host needs HTTPS before the cookie is marked secure. It still must not publish the extract or the unpacked EXE.
