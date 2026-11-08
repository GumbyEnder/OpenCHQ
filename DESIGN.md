# OpenCHQ

Browser strategy game. Two seats, one world map, one clock. You give orders; the server
executes them; you win by holding both capitals.

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
4. Watch the round tick (`config/game.json` → `roundSeconds`, 5 s today). Income lands every
   `payEvery` rounds. Fuel burns per side unless a unit stands on a well.
5. Two hostile pieces stop one cell short and trade a shot every other round. No damage number
   exists yet — that is a measured gap, not a design choice.
6. Hold both capitals to win. A dropped player pauses the game; the room stays and is theirs to
   resume.

## Controls

- Lobby: era + side, Play a bot, invite an online player, accept/decline.
- Match: click a piece, click a destination; Run/Hold the clock; Leave ends the match for good
  (disconnecting only pauses it).
- The match collapses the page into one 34px strip: era · side · round · clock · pool, then the
  commands Buy, Economy, Air, Kit, Map, War, Log, each opening one dialogue over the map.
- Buying: pick a unit in Buy, then click where it stands. Land and air go on ground inside the seat's
  own zone (within `placement.homeZoneCells` of a site it holds, 8 by default); hulls go into coastal
  water within `placement.coastCells` of land (4). The server returns the legal cells and the page
  paints them, so the highlight is the rule.
- Air: the Air dialogue lists every aircraft with its base and how many rounds it is away, plus one
  button per mission. Aircraft are otherwise only findable by clicking a marker on a world map.

## Rules that are not negotiable

- The server owns the clock, the pieces and the filtered view. The page draws and sends orders.
- Two sides only. X wraps, Y does not. Wasteland is refused.
- Numbers the 1990 game never revealed (damage, the real oil rate, the movement ratio, most
  prices) stay unnamed. `config/game.json` holds the stand-ins the owner accepted.
- Original art, stills and the unpacked executable never reach a browser.

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
