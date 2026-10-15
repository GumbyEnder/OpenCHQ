# OpenCHQ

A world-map strategy game in the tradition of Danielle Bunten Berry's 1990 design. OpenCHQ is not that game, and it is not affiliated with the rights holders. The original name and logo are not the name of this project.

This is a Godot 4 project (GDScript, Compatibility renderer). The browser shell in the research tree is unchanged.

No license is chosen yet. Do not treat the code as public domain, MIT, or any other license until a `LICENSE` file exists.

## Run

Godot 4.7 or a compatible 4.x editor:

```
godot --path .
```

Or open this folder in the Godot project manager. The main scene is `scenes/main.tscn`.

Headless rule check:

```
godot --headless --path . --script res://scripts/check_rules.gd
```

### Windows

This folder is on the share the Linux host mounts at `/mnt/nas` and Windows has as `K:`.

Open `K:\projects\OpenCHQ\project.godot` in Godot 4.7, then Play. `run-windows.bat` does the same thing when `godot` is on `PATH`.

The extract is the next folder over, `K:\projects\Command HQ\modern\extracted`. A project-relative line in `local/data_root.txt` finds it. A `/mnt/nas/...` line is read from `K:` on Windows. Do not run the Linux editor and the Windows editor on this folder at the same time. The `.godot` cache is shared.

## Data pack

Original art and the extracted map are not in this repository. Point the game at a local extract:

- environment variable `OPENCHQ_DATA`, or
- `local/data_root.txt` (gitignored; see `data_root.example`), or
- a `data/` directory inside this project (also gitignored)

The directory needs `data/sites.json`, `data/tmap.bin`, `data/map_res.json`, `data/game_meta.json`, `pics/WORLD_MAP.png`, and optionally `data/resources_oil.json`, `data/cities_capitals.json`, and `anims/` stills. Missing stills fall back to colored discs.

## Play

You are Blue. Time starts held: orders are accepted, and the clock does not move until Run (key T). One running speed only. Red marches on Washington. Owning both capitals wins.

Drag to pan. The map wraps east to west. The wheel zooms toward the cursor. Click your piece, then a cell. Fit shows the whole map. Zoom to selection frames the selected site or piece. Reset restores the opening view: 1986, sites on, atlas off, oil on, labels off, pixel filter, clock held.

Ocean is crossed as a transport. Forest, mountain, polar, jungle, and shallows are slower. The 1990 time ratio was not recovered, so the game does not state one. Wasteland is refused. An enemy route draws its first three steps. A friendly route draws in full.

Prices, damage amounts, and oil rates are unknown and are not invented here. Oil is a marker from 1986 on, with no production total. The atlas is an optional modern-capital overlay, off by default, and those cities are not the original sites.

Keys, when a dropdown does not have focus: T time, L labels, F fit, R reset, O oil, A atlas. Below 760px the panel is a Controls drawer.
