# OpenCHQ

Browser strategy game. Two seats, one world map, one clock. You give orders; the server
executes them; you win by holding every capital in the era's set.

## Pitch

A real-time command game in the shape of a 1990 two-player modem wargame, rebuilt as a
browser game with a central server. Washington is Blue, Moscow is Red. You never see the whole
board — only your own pieces, enemies inside eight cells, and the first three steps of an enemy
route. Terrain changes how fast you move and which routes exist. Cities fund production; oil
pays the upkeep from 1986 on. It is a game about scouting, logistics and bluffing, not about
clicking faster than your opponent.

## Core loop

1. Pick an era (1918, 1942, 1986, 2023, concealed) and a side, play a bot or invite someone.
2. Buy units in your cities and docks. Before the clock runs, placement is free; afterwards it
   costs money and the city goes unready.
3. Send orders. A piece walks one cell per running round; slow ground and water cost more; the
   incoming path is not a straight line but the sea lanes when you are at sea.
4. Watch the round tick (`config/game.json` → `roundSeconds`, 5 s today). Every city the side holds
   pays 50 million (0.05 billion) a round; `payEvery` is 1, so cash rises on every tick. Wells pay
   oil, never cash. Money is held as integer millions and shown in billions.
5. Two hostile pieces stop one cell short and trade a shot every other round. No damage number
   exists yet — that is a measured gap, not a design choice.
6. Hold every capital in the era's set to win (3 in 1918, 6 in 1942, 4 in 1986, 2 rolled for
   2023 and ????). The check runs when a capital changes hands, not every round. A dropped player
   pauses the game; the room stays and is theirs to
   resume.

## Controls

- Lobby: era + side, Play a bot, invite an online player, accept/decline.
- Match: click a piece, click a destination; Run/Hold the clock; Leave ends the match for good
  (disconnecting only pauses it).
- The match collapses the page into one 34px strip: era · side · round · clock · pool, then the
  commands Buy, Economy, Air, Kit, Map, War, Log, each opening one dialogue over the map.
- Buying: pick a unit in Buy, then click where it stands. Prices are the 1990 manual's (p.28, matching
  the executable's table at DS:0x2E16): infantry 10, tank 20, submarine 10, cruiser 10, carrier 20,
  aircraft 20, recon satellite 10, satellite killer 5, nuke 10, foreign aid 10, intel scan 10, all in
  billions. Land and air go on ground inside the seat's
  own zone (within `placement.homeZoneCells` of a site it holds, 8 by default); hulls go into coastal
  water within `placement.coastCells` of land (4). The server returns the legal cells and the page
  paints them, so the highlight is the rule.
- Air: the Air dialogue lists every aircraft with its base and how many rounds it is away, plus one
  button per mission. Aircraft are otherwise only findable by clicking a marker on a world map.
- A bought unit looks like itself: every piece on the board is one badge — an original vector
  silhouette inside a frame in the side's colour, with the frame's geometry carrying the side as
  well (blue square, red chamfered) so the two sides are told apart without hue. The interior is the
  domain (land, sea, air) and the state is drawn around the silhouette: strength bar below, dug-in
  bar above the infantry only, selected ring, movement dashes, combat burst, and a stack disc with
  the whole stack on hover. A badge never renders below 14 px, at any zoom, so the type is readable
  at the whole-world fit; a site a badge stands on keeps a corner notch of city ink so the city
  stays on the board. The Buy table and the Kit legend use the same badge.
- Strip controls: Play/Pause (the clock), Resign (concede: the other side wins, the room stays so the
  result can be read), New (abandon this game, start a fresh one in the same era and side), Quit
  (leave to the lobby). Each destructive one asks once.

## Rules that are not negotiable

- The server owns the clock, the pieces and the filtered view. The page draws and sends orders.
- Two sides only. X wraps, Y does not. Wasteland is refused.
- Numbers the 1990 game never revealed (damage, the real oil rate, the movement ratio) stay
  unnamed. `config/game.json` holds the stand-ins the owner accepted. Prices, city income and the era
  rosters are no longer stand-ins: they are the manual's, and every one carries its source in
  `config/game.json` → `sources`.
- Still labelled UNVERIFIED in config: whether a capital pays like a city (`money.capitalPays` is
  false and the code has never paid one), which p.28 icon row is the submarine, the cruiser and the
  carrier, and the concealed era's roster (it uses the 1986 set). Opening money is no longer a
  stand-in: `startPool` holds the per-era pools read off the original's Monitor Four (1918 10,
  1942 50, 1986 50, 2023 600; the concealed era is 50, UNVERIFIED), and `handicap` holds the
  opponent's starting-money spinner (p.17) - 1918 010, 1942 030, no spinner in 2023, and the
  0-999/1 range marked UNVERIFIED because no capture ever clicked a digit to its limit.
- Original art, stills and the unpacked executable never reach a browser.
- The opening is per era, not one world map. `web/data/eras.json` (baked by `tools/bake_eras.mjs`
  from the extract's type byte) says which of the 84 sites exist in a year, the subtype each carries,
  and - for 1918/1942/1986 - who holds it at the bell: 25/64/84 live sites and the original's own
  blue/red/neutral bits, including the four 1986 neutrals the loader clears (43, 46, 50, 53). 2023
  ships its subtype row with no owners (the roll is B-3), and the concealed era has no row at all.
  The subtype travels as `type` beside `kind`, never inside it. A capital is a subtype-1/2 row, so
  the era's capital set is 3 in 1918, 6 in 1942, 4 in 1986 and 2 rolled for 2023 and the concealed
  year (9999, shown as ????); the win is one side owning every one of them (B-3b, from the original's
  check at `1c0d:000c`). A capital is captured when an enemy land unit takes its centre cell, the
  check runs on that capture and not every round, and a neutral capital blocks both sides. The owner
  byte in `eras.json` is LIVE: the original's turn-0 RAM already carries it (London `0x59`, Berlin
  `0x9A`, before any order), and B-3b supersedes the interim R6 clear on the strength of that capture
  - no era opens with every capital held by one side (1918 2 blue / 1 red, 1942 3/3, 1986 3 blue /
  1 red). What that costs: blue can finish 1918 by taking Berlin and 1986 by taking Moscow, while red
  needs three in 1986. That asymmetry is in the data and in the original's own check, not in the port.

## Current milestone

The port: board, pieces, tick, orders, lanes, bot, combat, sight, economy, reconnect. Work is a
directed graph in `docs/web-loop.graph.json`; the operating model is `docs/WEB_LOOP.md`; module
boundaries are `docs/CONTRACTS.md`.

Live: https://openchq-web-production.up.railway.app (Railway `openchq-web`, `/data` volume for
accounts and rooms). The public host has no extract, so it draws the baked board from `web/data/world.json`
(`source: "bundled"`), and the match list is built from that same bake.

## After the port

`view_deltas`, `resources`, `pacing`, `scale_out` — see the graph. Timing is deliberately a
tunable: the game should feel like a campaign, and the round length is the dial that decides it.
