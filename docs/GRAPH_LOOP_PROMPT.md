# GRAPH loop prompt — OpenCHQ (paste this into the /loop task)

Paste everything between BEGIN and END as the loop's recurring task. It is self-contained: it
names the repo, the branch, the tool, the rules, and what to do when the graph runs out.

-------8<------- BEGIN PROMPT -------8<-------

You are the OpenCHQ graph loop. Each fire does exactly one node of
/mnt/nas/projects/OpenCHQ/docs/web-loop.graph.json and stops. You are working on a browser,
server-authoritative remake of MicroProse *Command HQ* (1990): two seats, blue and red, Washington
and Moscow, holding both capitals wins. The graph and docs/WEB_LOOP.md are the authority; that doc
wins over anything you infer.

Every fire, in this order:

0. `cd /mnt/nas/projects/OpenCHQ`. `git branch --show-current` must print `web`. If it does not,
   stop and report the branch. Never work on `main` (it stays at the e2d5f86 demo) or
   `desktop-godot`. Never force-push. Never run or embed Godot.
1. `node tools/loopctl.mjs status` — read the heartbeat line.
2. `node tools/loopctl.mjs next`.
   - exit 0: it printed `NODE <id>` with that node's WORK and PROVE. Implement that one node.
   - exit 2 `CLAIMED_ALREADY`: a previous fire died mid-pass. Read the working tree and the node's
     test: either finish the node or `node tools/loopctl.mjs fail <id> "reason"`. Then stop.
   - exit 2 `CAP`: raise `cap` in docs/web-loop.graph.json by 20, in its own commit, message
     "Raise the loop cap to <n>: the backlog below is still real", push, report, stop.
   - exit 2 `COMPLETE`: go to step 2b.
2b. Graph exhausted (all nodes `done`). Extend it — do not stop the loop while the backlog is real.
    Append the next nodes from EXTENSION BACKLOG below as new objects in `nodes`, same schema as the
    others: `{id, order, status:"todo", depends, title, work, prove}` with `order` = last order + 10,
    +20, … Take only the first three unbuilt items per fire. Commit as
    "Extend the graph: <ids>" (graph file only), push, then claim the first with
    `node tools/loopctl.mjs next` and implement it in the same fire. If the backlog is empty, report
    `GRAPH COMPLETE, BACKLOG EMPTY` and stop.
3. Implement only that node, in `web/` only (server, public, or test). Do not hand-edit the graph,
   the counter, or a second test entry point. Never touch `web/server/main.mjs`, `lobby.mjs`,
   `web/test/run.mjs`'s registry beyond adding your module, `docs/web-loop.graph.json`,
   `config/game.json`, or `web/server/rules.mjs` unless the node's WORK says otherwise.
4. Add a real assertion module under `web/test/nodes/` and register it. An assertion, not a comment.
5. `bash tools/fire.sh`.
   - red (no `WEB_OK`): report the first failing line, leave the node `todo`, commit nothing.
   - green: it marks the node done, commits on `web`, pushes to origin, deploys to Railway detached.
6. Report one line and stop: `iteration N/<cap>, <node id>, WEB_OK|red: <first failing line>, next
   <id|none>`. Never start the next node in the same fire.

FIDELITY RULES (non-negotiable)

- Never invent a number. No damage figure, no sight radius, no aircraft range, no nuke radius, no
  oil rate, no movement-time ratio. Anything invented is labelled STAND-IN in config/game.json and
  in player-facing text ("Rate unknown."). The original's numbers were never recovered.
- Timings are tunable and live in config/game.json only (`roundSeconds`, `payEvery`); nothing
  hard-codes them and no module keeps its own copy.
- The board is the original's: 320×136 cells, one cell per pixel of WORLD.PIC's map area (which
  starts at y=6), palette taken from that picture — ocean `#55ffff`, plain `#00aa00`, forest
  `#55ff55`, jungle `#00aaaa`, mountain `#aaaaaa`, desert `#ffff55`, polar `#ffffff`; cities are
  black dots. Do not "improve" the palette. Provenance: docs/PLAYTEST.md, measured by
  `Command HQ/modern/tools/sample_palette.py`.
- The whole earth is on screen by default (fit, ~2 px/cell), a single copy, no tiling unless the
  view is larger than the board. Zoom and pan are the player's; a resize preserves their camera.
- Fog is the 9999 concealed era's rule only. The map is a map; hidden pieces are omitted from the
  seat's view by the server, not darkened on the page.
- Reference art and data live in `/mnt/nas/Projects/Command HQ` (COMMAND/ = original files,
  modern/extracted/ = decoded PNG/JSON, modern/tools/ = decoders). The extract, WORLD_MAP.png, the
  stills and CHQ_unpacked.EXE never ship to the public host: /api/board there answers
  `source:"missing"` and the page falls back to the schematic. That is by design.
- Two sides only. A human room never runs bot orders. Sight 8 cells, Chebyshev, X wraps. Enemy
  routes in a view are the first three steps. Zero npm dependencies in `web/`.
- A dropped client pauses the game (`holdRoom`); only an explicit leave deletes a room.

MEASUREMENT RULES (whenever a node measures something)

- A harness opens the same board the lobby opens (`matchSites(era)`, not `boardPayload().sites`) and
  must not change the load it is measuring (no full frame per round).
- Count every event kind, not only the ones expected; read the round from `room` *and* `delta`
  frames; stop at `delta.over`.
- Before/after, same policy, same seed, same round count. Write the table into docs/PLAYTEST.md with
  the change it caused. A number with no before is not a measurement.
- Verify by running: launch it, read the actual log, capture the actual frame. Never report a
  benchmark, screenshot or "it works" you did not produce. Local fast runs use a config copy such as
  /tmp/fast25.json (`roundSeconds: 0.12`) on port 8170 with a throwaway `OPENCHQ_WEB_DATA`; never
  `~/.local/share/openchq`, never port 8787.

EXTENSION BACKLOG (append in this order when the graph is COMPLETE)

1. `unit_icons` — draw the original's unit sprites from UNITS.PIC (infantry, tank, ship, sub,
   aircraft) at 2 px/cell instead of squares/circles/triangles; side shown by the sprite's own
   blue/red variant. depends: [board_paint].
2. `bottom_chrome` — rebuild the original's bottom bar in HTML/CSS: TIME LEFT box with its bar, the
   side banner, the selected-base panel. Art decoded from WORLD.PIC / UNITS.PIC, not redrawn from
   memory. depends: [hud].
3. `fonts` — decode FONTS.CHQ and use it for map labels and the log, at whole-pixel sizes only.
   depends: [board_paint].
4. `city_labels` — city names on the map once the camera is zoomed past 4 px/cell, drawn with the
   original font, clipped to the viewport. depends: [fonts].
5. `political_map` — a topographical/political toggle (OMAP.PIC + CBR-REGN per-era region owners),
   so the map can show terrain or who holds what, as the original did.
6. `transport_escort` — an escort/convoy order: a warship ordered to accompany a transport, and the
   player told when a transport is crossing unscreened. The sink rule already exists; this is the
   decision around it. depends: [transports].
7. `air_missions` — CAP scramble and carrier reach as visible choices: the seat picks a mission, the
   view shows rounds remaining, and the log names a scrambled intercept. depends: [air].
8. `late_kit_visible` — the 1986 kit (intel scan, satellite, foreign aid, cease-fire, nuke) with the
   exclusion radius and first-user penalty surfaced as text, every unascertained number marked
   STAND-IN. depends: [late_kit].

Report format, one line, then stop:
`iteration N/<cap> · <node id> · WEB_OK (deployed) | red: <first failing line> · next <id|none>`

-------8<------- END PROMPT -------8<-------

## Notes for the operator

- The graph is 47/47 done right now, so the first fire will take step 2b and extend it with
  `unit_icons`, `bottom_chrome`, `fonts`.
- `node tools/loopctl.mjs status` currently prints `iteration 10/40 | done 47/47 | ready none`.
- Cron: the existing job `d0206c0195a5` ("OpenCHQ web loop", every 40m, deliver local) can carry
  this prompt. It runs in the `game` profile.
- If you want the loop to also deploy less, remove step 5's deploy by editing tools/fire.sh — not by
  telling the prompt to skip it.
