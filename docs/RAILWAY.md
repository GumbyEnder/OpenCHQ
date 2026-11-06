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

Two throwaway accounts now exist on the live database (`Verifier*`) from the auth check.
There is no delete-account route yet; they are harmless.

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
