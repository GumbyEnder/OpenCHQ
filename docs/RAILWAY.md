# Hosting: Railway

Stood up 2026-11-06. The browser game runs on Railway; the loop deploys to it on every green
pass. Nothing here needs a dashboard click.

## What exists

| Thing | Value |
| --- | --- |
| Project | `OpenCHQ` — id `2e0a4835-fd71-4e5d-a4d6-f72f5fd72c2d` |
| Environment | `production` — id `a971db7b-8ac8-4917-8cfd-d0752a016e75` |
| Service | `openchq-web` — id `3d3fafe6-a580-4c77-a948-b6044433b6fa` |
| Source | GitHub `GumbyEnder/OpenCHQ`, branch `web` (deploys on push) |
| Volume | `openchq-web-volume`, mounted `/data` (50 GB = 48.8 GiB; measured `sizeMB 50000`, frodo 9124 §1) |
| Live URL | https://openchq-web-production.up.railway.app |
| Builder | Railpack, Node, start `node web/server/main.mjs` |

## Variables

| Key | Value | Why |
| --- | --- | --- |
| `OPENCHQ_WEB_HOST` | `0.0.0.0` | the default is 127.0.0.1, which is unreachable from Railway's edge |
| `OPENCHQ_WEB_DATA` | `/data` | SQLite accounts live on the volume, not the ephemeral container fs |
| `OPENCHQ_SECURE_COOKIE` | `1` | the session cookie gets `Secure`; the server can also infer it from `x-forwarded-proto` |
| `RAILPACK_START_CMD` | `node web/server/main.mjs` | Railpack ignores a `railway.json` startCommand; the variable is the one that works |

`PORT` is injected by Railway and wins over `OPENCHQ_WEB_PORT` (the server reads `PORT` first).

## Repo side

- Root `package.json` exists only so Railpack detects Node at the repo root and gets a start
  script. It declares `engines.node >= 22` (`node:sqlite` and global `WebSocket` both need it)
  and has no dependencies. The game itself stays in `web/` with zero npm packages.
  `node:sqlite` needs Node 22.5, so the floor is 22.5.
- `.railway/` is gitignored: it holds this host's project link.
- `railway service source connect --repo GumbyEnder/OpenCHQ --branch web --service openchq-web`
  is what makes a push to `web` deploy. `tools/fire.sh` also runs `railway up -y -d` as a
  belt-and-braces path; if that ever fails, the GitHub trigger still ships the commit.

## Deploy path in the loop

```
node tools/loopctl.mjs next   # claim one node
<implement + extend web/test/run.mjs>
bash tools/fire.sh            # WEB_OK -> mark done -> commit -> push origin/web -> deploy
```

`OPENCHQ_LOOP_NODEPLOY=1` skips the CLI deploy, `OPENCHQ_LOOP_NOPUSH=1` commits without pushing.

### The push is the deploy lane; the check is still a curl (history: 2026-11-11)

A push to `origin/web` created Railway deployments, but both of the 2026-11-10 evening pushes
(21:43 and 21:48) came back `REMOVED` and the live build stayed at `84eff0b` while `origin/web`
moved through `6a74a49` to `27aa2fb`. `/api/version` is the check that matters: it read
`build.json` at the time, so it named the commit actually serving, and it did not move for a push.
That was the un-repo-connected window, and it is why the loop verifies by curl and never by a
push receipt.

Since the service was repo-connected (2026-11-23) and re-verified 2026-11-27, a fast-forward push
to `refs/heads/web` IS the deploy, with no `railway up` involved (frodo's push-gate log
`/mnt/nas/host-ops/openchq/web-push-gate.log` is the record of the push; `/api/version` is the
record of the serve):

- PB-331 `2ada057..d88dbfe`, ALLOWED 22:59:37 → the live-evidence directory was created 23:00:28
  and the live E2E at 23:02:28 read `served d88dbfe source=railway`.
- PB-332 `d88dbfe..4b46935`, ALLOWED 23:25:56 → the version poll
  (`pb332/ship-4b46935/version-poll.log`) read `d88dbfe` at 23:26:22, `502 Application failed to
  respond` at 23:26:47, and `{"commit":"4b46935…","source":"railway"}` at 23:26:57 — 61 s, one
  swap window, no CLI deploy.

So: the push is the lane, `railway up` is the belt-and-braces path, expect one empty/502 read
across the container swap (that is the swap, not a failed deploy), and `/api/version` answering
the pushed sha is the proof. Treat "the push went through" as "code is in the branch" until
`/api/version` names it.

One consequence to respect: **a docs-only commit to `web` is still a deploy.** It restarts the
process and ends every live room. Land doc corrections with a ship record — piggybacked on the
next code ship, on that ship's literal — never standalone mid-queue, so the sha the queued
tickets cite as their base does not move under them.

### Build stamp: which commit an upload names (measured 2026-11-23)

`/api/version` resolves the served commit in this order: `OPENCHQ_COMMIT`, then
`RAILWAY_GIT_COMMIT_SHA` (the repo-connected builder), then `web/data/build.json`, then
`git rev-parse`. Measured live: `{"commit":"cb83906...","source":"railway"}` — so on a push the
env wins and `build.json` is inert.

`build.json` is therefore only the truth on the `railway up` path, where the builder keeps no
`.git`. That makes a stale stamp a lie with nothing to correct it:

    node tools/stamp_build.mjs           # write the stamp for this tree
    node tools/stamp_build.mjs --check   # exit 1, naming the ships behind, if it disagrees

The committed file is expected to be behind HEAD — it is restored after every fire, on purpose.
The rule is about uploads, not trees: `tools/fire.sh` re-stamps immediately before `railway up`,
runs `--check`, and exits 5 (`LOOP_EXIT_STAMP_STALE`) without uploading if the two disagree. Any
hand upload that is not a fire must run the stamp first, or set `OPENCHQ_COMMIT`; there is no
runtime check that can catch it later, because the bundle has neither git nor env.

## First deploy, in order (what actually worked)

1. `railway init --name OpenCHQ --json`
2. `railway add -s openchq-web --json`
3. `railway service source connect --repo GumbyEnder/OpenCHQ --branch web --service openchq-web`
4. `railway service link openchq-web` — **required before volumes**; `railway volume add -s ...`
   panics with `Option::unwrap()` on a None if no service is linked.
5. `railway volume add -m /data --json`
6. `railway variable set <K>=<V> --skip-deploys --service openchq-web` (one call per key)
7. `railway domain --service openchq-web --json` → the public HTTPS URL
8. push: the first build from `origin/web` failed at Railpack detection ("could not determine
   how to build") because that commit had no root `package.json`. The commit that added it
   built and went Online in ~2 minutes.

## Verified live (2026-11-06, after the first successful build)

```
health:   200 {"ok":true}
index:    200 text/html; charset=utf-8
board:    200 bytes=400  source=missing cells=null paint=schematic
register: 200 {"user":{"id":1,...}}
set-cookie: openchq_session=...; HttpOnly; Path=/; SameSite=Lax; Max-Age=1209600; Secure
me:       {"user":{...}}
logout:   {"ok":true}
```

Container log: `OpenCHQ web shell http://0.0.0.0:8080`. Volume contents:
`/data/openchq.sqlite` (20 KB, created by the first registration).

Reproduce with `bash local/verify-live.sh` (gitignored, machine-local).

Live durability check (2026-11-06): a bot room on the live host was put on a running clock with
its socket held open, the container was killed with `railway redeploy`, and the same account
reconnected through `local/ws-room.mjs check`:

```
{"survived":true,"roomId":"e48ea51193e023a7","expected":"e48ea51193e023a7","clock":"held","you":"blue"}
```

Same room, same seat, clock paused by the restart.

A graceful socket close behaves the same way: the lobby holds the room, stops the clock, keeps
the seat reserved for that account, and the connected seat can run it again. Proven in the
harness — drop one seat, the other sees `Gus disconnected. The match is paused and still
yours.` with the clock held, the store row keeps both seats, and `run` resumes the same room.
Swapping `holdRoom` back to `endRoom` makes that assertion fail.

Two throwaway accounts now exist on the live database (`Verifier*`) from the auth check.
There is no delete-account route yet; they are harmless.

## Storage: what persists, what does not

| Data | Where | Survives a deploy | Survives a lost container |
| --- | --- | --- | --- |
| Accounts (`users`) | SQLite `users` table | yes | yes — `/data` is a volume |
| Sessions (`sessions`) | SQLite `sessions` table | yes | yes |
| Rooms, seats, clock, match blob | SQLite `rooms` table | yes | yes |
| Invite offers (unaccepted) | process memory | n/a (transient by nature) | n/a |
| Terrain / sites | not on this host at all | n/a | n/a |

SQLite is a real database, not a stand-in: `node:sqlite`, one file, WAL mode, on a mounted
volume. Credentials are scrypt hashes with per-user salts; session tokens are 24 random bytes
in a table. Measured on the live container after a redeploy: `journal_mode = wal`,
`users = 3` (unchanged across the restart), file `20 KB`.

Pragmas set in `web/server/db.mjs`: `journal_mode = WAL`, `synchronous = NORMAL`,
`busy_timeout = 5000`, `foreign_keys = ON`. WAL is safe here because a Railway volume is a
local mount — it would not be safe on the CIFS share.

### Room persistence (added 2026-11-06)

A game is a row. `web/server/rooms.mjs` writes `rooms(id, mode, era, clock, note, state,
created_at, saved_at)` on create and on every player action (order, run, hold, leave, a win),
deletes only when a room really ends, and restores every stored room **paused** at boot with
its humans seated again. Idle rooms older than 24 h are pruned at boot. A restart never
resumes a clock — the server owns the clock, and a fresh process must not run rounds nobody
asked for.

A running round marks its room dirty and the store takes a slice of the dirty rooms each
round (`rooms.flushRooms`), inside one transaction. The slice is sized so no room waits more
than `FLUSH_SECONDS` (2 s) of rounds: at a 5 s round every dirty room is written each round,
at 0.14 s it is about a fifteenth per round. Player actions are still saved immediately.

The row does not repeat the board's static site table — only which side owns which site and
which site is unready; the full site list is rebuilt from `board.mjs` on load. Routes are
stored in full. A round-trip probe in `tools/bench-rooms.mjs` restores a room and compares
every route step and site owner.

Proved in the harness by killing the server mid-game and booting it again on the same data
directory: the room id, the seat and a `held` clock all come back. Removing the store write
makes that assertion fail, so the proof is not vacuous.

### Scale probe (tools/bench-rooms.mjs, this host, one core)

These are the numbers after the store was measured honestly: real `tickMatch`, real
`saveRoom`, board sites, and routes of 60 steps per land piece.

| Measure, 1000 rooms x 8 pieces | Cost | Budget (0.14 s round) | Headroom |
| --- | --- | --- | --- |
| tick pass, all rooms | 4.3 ms | 140 ms | ~33x |
| round passed (tick + store slice, 1/15 of dirty rooms) | 7.2 ms | 140 ms | ~19x |
| full snapshot, every room in one transaction (pause/shutdown, not a round) | 25–37 ms | 140 ms | ~4–5x |
| held pass, 1000 held rooms | 0.04 ms, 0 writes, 0 rows changed | — | — |

The earlier table (0.15 ms tick, 1.65 ms snapshot) was measured against a stand-in bench
whose tick had already drained every route before the snapshot, so it stored empty rooms.
With real routes and the real store, writing every running room every round is 3–5x the
budget, not 85x. That is why the round's store work is a slice with a bounded durability
window instead of a full write: the tick has 33x headroom, and the round including its store
work has 19x. The one-off full snapshot is not on the round path; it happens when the clock
stops.

### Why not Postgres yet

A managed Postgres would buy: multiple app replicas, concurrent writers, point-in-time
recovery, and no volume pinning. It would cost: a `pg` dependency (the repo's standing rule is
zero npm dependencies in `web/`), a migration, and a second service. None of that is needed by
a two-seat, one-room-per-pair game whose write load is "register, login, session". The volume
also caps the service at one instance, which is exactly what the in-memory room model already
requires.

Move to Postgres when one of these becomes true: more than one app instance is needed for
uptime or load, writes start contending under WAL's single writer, or room state has to
outlive the process. The trigger to watch is node `reconnect` (order 220) — that is the node
where per-seat room state stops being disposable, and the decision belongs there, not now.

### Deploy policy (this is the part that was actually hurting)

A deploy restarts the process, which ends every live room. The loop used to deploy on every
green fire, and in the un-repo-connected window GitHub push-to-deploy also fired on docs-only
commits — 7 deploys in the first 13 minutes, each one a reboot.

- GitHub push-to-deploy is connected (2026-11-23 onward, re-measured 2026-11-27): a fast-forward
  push to `refs/heads/web` is the deploy, and `openchq-web` has no Railway watch pattern, so
  **every** push builds — a docs-only commit included. The gate is therefore the ship record and
  not the file set: only a literal that passed a gate is pushed to `web`, and doc corrections ride
  a code ship (see the deploy-path section above).
- `tools/fire.sh` pushes first and reports `PUSH_DEPLOY_QUEUED`; it prints `NO_RUNTIME_CHANGE` when
  nothing under `web/` changed but notes the push still triggers a git build, and it falls back to
  `railway up` only when the fire never reached origin (`OPENCHQ_LOOP_NOPUSH=1` or a failed push).
- Manual deploy after a server change: `railway up -y -d --service openchq-web` — belt-and-braces;
  the push is the lane.
- `railway up` uploads the tree, so it never picks up a pushed-but-untested commit by accident.
- **Badge deploy checklist (T-014, frodo note 6 / PM room 4039).** `web/test/run.mjs` asserts no badge
  behaviour, so a green `run.mjs` says nothing about how a unit looks. Before any deploy that touches
  `web/public/badges.mjs`, `render.mjs`, `app.js` or `app.css`, run:

  ```
  node tests/e2e/badge-board.mjs --url=<deployed base> --out=/mnt/nas/projects/OpenCHQ/local/t014-shots
  ```

  after the deploy, against the production URL. It prints `distinctBlue` / `distinctRed` (12/12 is the
  pass), plus `BADGE_MIN_PX` at each zoom, and writes `badge-sheet-*.png` a human can look at.

## What the public host deliberately does not have

The game extract. No `data/tmap.bin`, no `WORLD_MAP.png`, no unit stills, no
`CHQ_unpacked.EXE`. `/api/board` therefore answers `source: "missing"` with `cells: null` and
the page must draw its schematic. Wiring the real grid to the public host is a decision for
the user alone — it means shipping original game assets, which the handoff forbids.

## Open items

- Custom domain: not requested. `openchq.com`-class naming is a user decision.
- The Ops Job Tracker registry has no deployed instance right now (`railway list` shows no
  tracker project, no local process), so the loop job could not be registered there. Its
  authoritative record is this file plus `docs/loop-state.json` and the vault `Run Log.md`.
- Railway's GitHub trigger means the repository's `web` branch is now the deploy artifact.
  Never push an experiment to `web` without running `node web/test/run.mjs` first.
