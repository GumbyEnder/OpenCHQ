# OPENCHQ_WEB_LOOP (hands-free)

The loop runs itself. Nobody pastes a fire. A scheduled Hermes job in the `game` profile
fires on a timer, does one node, and stops. The job's prompt is fixed and short; the graph
and this file are the authority.

The game is the browser game in `/mnt/nas/projects/OpenCHQ` on branch `web`. Godot is the
archive on branch `desktop-godot`. Do not start, embed, or export Godot.

## What a fire does

```
node tools/loopctl.mjs next
```

That claims the single ready node with the smallest `order` and bumps the iteration. It
prints `NODE <id>` plus that node's `WORK` and `PROVE` text. Then the fire implements only
that node, extends `web/test/run.mjs` in the same pass, and runs the mechanical half:

```
bash tools/fire.sh
```

`tools/fire.sh` runs `node web/test/run.mjs`, and:

- **red** — no `WEB_OK`: the node is recorded as `todo`, nothing is committed, the failing
  line is printed, exit 1.
- **green** — `WEB_OK`: the node is marked `done` in `docs/web-loop.graph.json`, the pass is
  committed on `web`, pushed to `origin/web`, and deployed to Railway (`railway up`, detached).

There is nothing else to remember. Do not hand-edit the graph, do not hand-edit the counter,
do not add a second test entry point, and do not claim two nodes in one fire.

## State

`docs/loop-state.json` is committed, so the counter survives reboots:

```json
{ "iteration": 0, "cap": 40, "current": null, "lastNodeId": null,
  "lastResult": "", "lastRunAt": "", "history": [] }
```

`node tools/loopctl.mjs status` prints one line: iteration, done/total, ready node, current
claim, last result. That line is the loop's heartbeat.

Exit codes from `loopctl.mjs`: `0` ok, `2` nothing to claim (`COMPLETE`, `CAP`, `BLOCKED`,
`CLAIMED_ALREADY`), `1` misuse. A fire that gets `2` implements nothing, reports the reason,
and stops.

## Fire shape (what the scheduled job is told)

1. `cd /mnt/nas/projects/OpenCHQ`, confirm branch is `web`.
2. `node tools/loopctl.mjs next`.
   - Exit 2: report the printed line (`COMPLETE` / `CAP` / `BLOCKED`) and stop. No code.
3. Read `docs/WEB_PLAN.md` and, as reference only, the `.gd` scripts. Implement the one
   claimed node in `web/`. Extend `web/test/run.mjs` with a real assertion, not a comment.
4. `bash tools/fire.sh`.
5. Report one line: `iteration N/40, <node id>, WEB_OK|red + failing line, next ready node`.
6. Stop. Never start the next node in the same fire.

## Hosting

Railway project `OpenCHQ`, service `openchq-web`. Every green fire deploys. See
`docs/RAILWAY.md` for the exact variables, the volume, and the live URL.

The public host has no game extract. `GET /api/board` answers `source: "missing"` there and
the page must fall back to the schematic. That is by design: the extract, `WORLD_MAP.png`,
the stills, and `CHQ_unpacked.EXE` never leave this machine.

## Rules a node must keep

- Two sides only. Blue and Red. Washington and Moscow are the seats. Holding every capital in
  the era's set (`match.capitalSet`) wins, and the check runs when a capital changes hands.
- The server owns the clock and the pieces. The page sends orders for its own seat.
- One running round is 0.14 seconds. Hold stops the clock. Tests call the tick function
  directly and never sleep.
- A human room never runs bot orders. A bot room marches on the player capital, sails once.
- Sight 8 cells, Chebyshev, X wraps. Enemy routes in a view are the first three steps. Hidden
  pieces are omitted from the JSON, not flagged.
- Income 1 billion per city and per owned well every 25th round. Capitals are not cities.
  Each side has its own fuel reserve (10000, burn 1 off a well). A dry side stops; the other
  does not.
- A tank costs twice an infantry. A nuke is refused. No damage number, no oil production
  rate, no movement-time ratio — they were never recovered and inventing them is the failure.
- Player-facing match text must not contain `$`, the 1990 product name, `production`, `beats`,
  or `one extra`. The oil card says "Rate unknown."
- Zero npm dependencies in `web/`.

## Guardrails

- Branch is `web`. Never `main` (stays at the `e2d5f86` demo), never `desktop-godot`.
  No force-push, ever. `tools/fire.sh` refuses to run off-branch.
- Live server port 8094 locally. Port 8787 belongs to another program. Tests bind a free port
  on 127.0.0.1 with a throwaway `OPENCHQ_WEB_DATA`; never `~/.local/share/openchq`.
- SQLite returns `database is locked` on the CIFS share, so accounts never live in the repo
  tree. Local default: `~/.local/share/openchq`. On Railway: the `/data` volume.
- A game is a database row, not a Map entry. `web/server/rooms.mjs` writes on create and on
  every clock change, restores rooms paused at boot, and prunes rooms idle over 24 h. Any node
  that changes room state must call `saveRoom` before it tells the seats, and must never
  assume in-memory state survived a restart.
- A dropped client pauses the game, it does not end it: `holdRoom` keeps the seat, stops the
  clock and stores the room. Only an explicit `leave` deletes a room. Do not "fix" a
  disconnect back into an end-of-match.
- Cap 40 iterations. At the cap the loop reports `CAP` and stops; raise `cap` in the graph
  file deliberately, in its own commit, if more passes are wanted.
- When every node is `done` the loop reports `COMPLETE` and stops. `drop_godot` is last and
  deletes the Godot tree from `web` only.

## If something is wrong

- Red twice on the same node: the fire reports the failing line and leaves the node `todo`.
  A third pass on the same node with no new information is a defect — change approach or
  escalate, do not re-run the same attempt.
- Push fails: the commit stands locally, `LOOP_PUSH_FAILED` is printed, the deploy is marked
  failed, and the next green fire pushes both commits.
- Deploy fails: `LOOP_DEPLOY_FAILED` with the tail of the Railway output. The commit still
  stands; hosting catches up on the next green fire.
- Stale claim (`CLAIMED_ALREADY`): the previous fire died mid-pass. Inspect the working tree
  and the node's test, then either finish it or `node tools/loopctl.mjs fail <id> "reason"`.

## Closing block

When the graph is complete, report: nodes done, files changed since the first fire, the last
`WEB_OK`, and the live URL. Then the loop is finished and the host job should be paused.

---

# Standing order (long-lived)

This file is the operating model for however long the project runs. Two ways to work; both end
in the same place — `node web/test/run.mjs` printing `WEB_OK`, one node marked done, one commit.

## Mode A — one fire at a time (the default)

The scheduled job, or a human, runs the fire shape above. That is the safe default and it is
what runs overnight.

## Mode B — a parallel sprint (accelerated)

When several nodes are wanted at once, a sprint replaces the fire, not the rules:

1. The integrator (the agent holding the session, not a subagent) writes the contracts first:
   module boundaries and signatures in `docs/CONTRACTS.md`, plus neutral stubs for every module
   the sprint will touch, so the suite stays green while work is in flight.
2. One agent, one node, one module, one test file. File ownership is absolute — an agent edits
   its own module and its own `web/test/nodes/<node>.mjs` and nothing else. Never
   `web/test/run.mjs`, `main.mjs`, `lobby.mjs`, `config/game.json`, `rules.mjs`, the graph, or
   another agent's module.
3. Agents never run git, railway, `loopctl`, or package installs. The integrator commits.
4. Each test lives in `web/test/nodes/*.mjs` exporting `{ name, run(ctx) }`; the harness loads
   every file in that directory. Parallel tests never collide in one file.
5. When a sprint starts, pause the cron job; when it ends, run the suite, mark nodes done,
   commit once, resume the job. A sprint that leaves the tree red is a failed sprint.

## Ownership map

| Path | Owner |
| --- | --- |
| `web/server/main.mjs`, `lobby.mjs`, `rooms.mjs`, `match.mjs`, `board.mjs`, `rules.mjs`, `db.mjs` | integrator |
| `web/server/tick.mjs` | tick / win nodes |
| `web/server/move.mjs` | orders node |
| `web/server/lanes.mjs` | lanes node |
| `web/server/combat.mjs` | combat node |
| `web/server/view.mjs` | sight node |
| `web/server/economy.mjs` | buy / oil / income / fuel nodes |
| `web/server/bot.mjs` | bot node |
| `web/public/render.mjs`, `app.js` | client |
| `web/test/run.mjs` | integrator only |
| `web/test/nodes/*.mjs` | one file per node, owned by that node's implementer |

## Adding work

A node needs an `id`, an `order`, `depends`, `work` (what to build, in behaviour terms) and
`prove` (the assertion that fails if it is missing). Add it to the graph, then say what it
depends on. Do not add a node whose "prove" is a comment or a screenshot nobody re-takes.

## What "done" means

`WEB_OK` on the whole suite, the node marked `done` in the graph in the same commit, and the
proof able to fail — break the feature, watch the assertion go red, restore it. A node whose
test passes with the feature removed is not done; it is decoration.

## Non-negotiables that survive every mode

- The server owns the clock, the pieces and the filtered view.
- Unknown 1990 numbers stay unnamed. Stand-ins live in `config/game.json` and are labelled.
- A dropped client pauses a game; only an explicit leave deletes one.
- Two sides only; X wraps, Y does not; wasteland is refused; every capital in the era's set wins.
- No original art, stills, or executable bytes in a browser response.
- `web/` has zero npm dependencies.

