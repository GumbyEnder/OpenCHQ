# OpenCHQ

OpenCHQ is a world-map strategy game for two sides. Each side starts with a land piece at its capital and a ship at sea. The side that holds every capital wins.

It follows the tradition of Danielle Bunten Berry's 1990 design. This project is independent of that game and of its rights holders, and it does not use that name or logo. The game runs in a web browser.

Licensed under the MIT License. See `LICENSE`. That license covers this project. It does not cover the original game, which is not included here.

## Branches

`web` is the game. `desktop-godot` archives the old desktop project and is not how this game runs. `main` is the earlier demo. The plan is `docs/WEB_PLAN.md`. The handoff for a new agent is `docs/WEB_HANDOFF.md`. The build loop is `docs/WEB_LOOP.md`, and the node graph is `docs/web-loop.graph.json`.

Play, from this folder:

```
node web/server/main.mjs
```

Then open `http://127.0.0.1:8094`. `OPENCHQ_WEB_PORT` changes the port. Accounts are stored in `~/.local/share/openchq/`, or in `OPENCHQ_WEB_DATA` if that is set. They are not part of the game.

## Data pack

Original art and the extracted map are not in this repository. Point the game at a local extract:

- environment variable `OPENCHQ_DATA`, or
- `local/data_root.txt` (gitignored; see `data_root.example`), or
- a `data/` directory inside this project (also gitignored)

The directory needs `data/sites.json`, `data/tmap.bin`, `data/map_res.json`, `data/game_meta.json`, `pics/WORLD_MAP.png`, and optionally `data/resources_oil.json`, `data/cities_capitals.json`, and `anims/` stills. Missing stills fall back to colored discs.

## The match

You pick an era and a side before the map appears. The eras are 1918, 1942, 1986, 2023, and a concealed start labeled ????. Blue's capital is Washington. Red's capital is Moscow. You command the side you picked. In a named era the other side is on the map and marches on your capital. In the concealed start they stay hidden until you find their capital.

Start opens the purchase screen on the map. Your land piece and your ship are already placed. You may add units before the first turn. Land and aircraft go in a friendly city. Ships go on a dock beside one. Begin starts the match.

Time starts held, so an order waits. Run starts the turns. Pause and Resume stop and continue them. Keys T and P do the same. The turn counter advances once each turn. One running speed only.

Click your piece, then a cell. Drag to pan. The map wraps east to west. The wheel zooms toward the cursor. Fit shows the whole map. Zoom to selection frames the selected site or piece. Reset restores the opening view: 1986, sites on, atlas off, oil on, labels off, pixel filter, clock held.

Ocean and lake are transport. Forest, mountain, polar, jungle, and shallows are slower. The 1990 time ratio was not recovered, and the game leaves that pace unnamed. Wasteland is refused. An enemy route draws its first three steps. A friendly route draws in full.

A tank costs twice an infantry. A nuke is listed at 10 billion. Starting money was not recovered, so that purchase is refused. Other prices, damage amounts, and oil rates stay blank. Oil is a marker from 1986 on, and also in the concealed start. The atlas is an optional overlay of modern capitals. It starts off, and those cities are separate from the original sites.

Keys, when a dropdown does not have focus: T time, P pause, L labels, F fit, R reset, O oil, A atlas. Below 760px the panel is a Controls drawer.
