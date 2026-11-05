# OpenCHQ is a browser game

The game we are building runs in a web browser. A Node server keeps the accounts, the lobby, and the match. The page draws the board and sends orders. Godot is not part of that game. The server does not start it, embed it, or export it.

`desktop-godot` on `github.com/GumbyEnder/OpenCHQ` is the archive of the old desktop project. `main` is the earlier demo. New work lands on `web`. The Godot scripts on this branch are reference notes for the behaviors below. They are not the runtime.

## The match

One room has two sides, Blue and Red. The side that holds both capitals wins. Washington is Blue. Moscow is Red. A third person is another room, a spectator, or a partner on a side that already exists.

A player registers, signs in, and either:

- starts against a bot, or
- stands in the lobby, invites someone who is online, and plays when they accept.

The server is the only clock. One running round is 0.14 seconds. Hold stops the clock. The server does not wait for both players before a round. A dropped connection leaves that side's last orders in place.

Each seat sees its own pieces, enemy pieces within 8 cells, and the first three steps of an enemy route. A still submarine stays hidden. In the concealed era the other side stays hidden until their capital is found. The browser never receives the other seat's hidden pieces.

## Rules the browser game carries

These are the rules of the match. The web game implements them in JavaScript.

- The board is 320 by 136 cells. X wraps. Y does not.
- Ocean and lake are transport. Forest, mountain, polar, jungle, and shallows are slower. Wasteland is refused.
- Eras are 1918, 1942, 1986, 2023, and the concealed start.
- Each side starts with a land piece on its capital and a ship at sea, except 2023, which starts with no pieces.
- Land and aircraft are bought in a friendly city. Ships are bought on a dock. A tank costs twice an infantry. A nuke stays refused.
- City income is one billion for each city a side holds. Oil income is one billion for each well that side holds. Every 25 rounds those levels are added to that side's pool. A named country's well pays nobody until a unit takes it.
- Each side has its own fuel reserve. Standing on a well refills that side. Running dry stops that side only.
- Pieces stop short of a shared cell. A shot falls every other round of a fight. The damage figure is still unknown.
- The bot marches its army on your capital and sails its ship once when idle. A human seat sends its own orders. The bot code does not run for a human seat.

Prices other than the tank ratio, damage, the real oil rate, and scan radii stay stand-ins. The oil file's production ratings are not used. The original picture, the unit stills, and the unpacked executable are not sent to the browser.

## The board

The page draws the board on a canvas from cells and sites. Terrain and site positions are read by the server from the local extract when that folder is present. The client gets cell ids and site records. It does not get the original map picture.

Until that board is wired, the match page shows a schematic with Washington and Moscow on the cell grid.

## What already runs

`node web/server/main.mjs` serves `http://127.0.0.1:8094`. `OPENCHQ_WEB_PORT` changes the port.

- Register and sign in. Passwords are hashed. Sessions are cookies. Accounts live in `~/.local/share/openchq/` because this project directory is on a network share. `OPENCHQ_WEB_DATA` overrides that folder.
- The lobby lists people who are connected.
- Play a bot, or invite a person. Accepting opens one human room.
- Hold and Run are shared clock flags.

Pieces do not move yet. The match object that will move them lives in this server, in JavaScript.

## Build order

1. Load terrain and sites on the server and paint the real cell grid in the page.
2. Place the opening pieces. Accept an order. Advance one cell per running round.
3. Bot orders for the empty seat. Human orders for a filled seat.
4. Filter each seat's view before it leaves the server.
5. Buying, oil capture, income, and a fuel reserve per side.
6. Delete the Godot project from this branch once a browser match can open, march, and finish.

## Public host

The shell binds to localhost and speaks plain HTTP. A public host needs HTTPS before the session cookie is marked secure. The extract and the unpacked executable stay off the public host.
