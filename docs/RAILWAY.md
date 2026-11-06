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
| Volume | `openchq-web-volume`, mounted `/data` (5 GB) |
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

Same room, same seat, clock paused by the restart. Note this is the *crash* path: a graceful
socket close still ends the room until node `reconnect` (order 220) flips it to pause-and-keep.

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
created_at, saved_at)` on create and on every clock change, deletes only when a room really
ends, and restores every stored room **paused** at boot with its humans seated again. Idle
rooms older than 24 h are pruned at boot. A restart never resumes a clock — the server owns
the clock, and a fresh process must not run rounds nobody asked for.

Proved in the harness by killing the server mid-game and booting it again on the same data
directory: the room id, the seat and a `held` clock all come back. Removing the store write
makes that assertion fail, so the proof is not vacuous.

### Scale probe (tools/bench-rooms.mjs, this host, one core)

| Measure, 1000 rooms x 8 pieces | Cost | Budget (0.14 s round) | Headroom |
| --- | --- | --- | --- |
| tick pass, all rooms | 0.15 ms | 140 ms | ~920x |
| snapshot all rooms, one transaction | 1.65 ms | 140 ms | ~85x |
| snapshot all rooms, one transaction each | 3.23 ms | 140 ms | ~43x |
| 2000 seat views built + JSON | 7.1 ms (2.6 MB) | 140 ms | ~20x |
| 5000 rooms: tick / snapshot | 0.59 / 9.24 ms | 140 ms | ~236x / ~15x |

Read: the database is not the bottleneck at 1000 concurrent games. The expensive part is
sending a full view to every seat every round (~2.6 MB per round, ~18 MB/s at 2000 players),
so the scale work that matters later is view deltas, not a bigger database. Idle games cost
nothing because a held room does not tick or write.

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
green fire, and GitHub push-to-deploy also fired on docs-only commits — 7 deploys in the first
13 minutes, each one a reboot.

- GitHub push-to-deploy is disconnected. `railway up` from `tools/fire.sh` is the only deploy path.
- `tools/fire.sh` deploys only when the pass touched `web/` or `package.json`. A graph, doc or
  loop-counter commit prints `NO_RUNTIME_CHANGE` and does not reboot the game.
- Manual deploy after a server change: `railway up -y -d --service openchq-web`.
- `railway up` uploads the tree, so it never picks up a pushed-but-untested commit by accident.

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
