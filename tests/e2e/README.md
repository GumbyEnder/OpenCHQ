# OpenCHQ end-to-end suite

T-007 AC12/AC13 and the standing rule: every deploy is verified by a run of this suite against the
live URL, and a failing run blocks acceptance of the task.

    node tests/e2e/run.mjs --url=http://127.0.0.1:8094            # local
    node tests/e2e/run.mjs --url=https://openchq-web-production.up.railway.app

Options

| flag | meaning |
| --- | --- |
| `--url=` | base URL, local or live (required; `E2E_URL` also works) |
| `--headed` | watch it run |
| `--rounds=N` | rounds to play in the acted-on match (default 20) |
| `--era=1942` | era of the match that is played (default 1942) |

Credentials are never committed. The suite signs in with `E2E_USER` + `E2E_PASS` when both are
set in the environment; otherwise it registers a throwaway account named `E2E_PREFIX` (default
`e2e`) plus a timestamp, with a random password (`E2E_PASSWORD` overrides it).

## Playwright

The game has no npm dependencies on purpose; the browser suite is the one thing that needs one.
Install it here, not at the repo root:

    cd tests/e2e && npm install && npx playwright install chromium

If it is not installed, `run.mjs` falls back to `PLAYWRIGHT_MODULE`, then the machine's
agent-relay install, so a reviewer with Playwright already on the box can run the suite as is.

## What it proves

1. a throwaway user signs in (register or an existing session);
2. the lobby lists players by display name only, and no email is visible anywhere;
3. Play a bot opens a match in each era, and the starting pool equals `/api/setup` START_MONEY;
4. a Play clicked with the socket down is queued and lands when the socket returns (AC4);
5. an infantry is bought and placed through the Buy panel and a canvas click;
6. a move order is previewed and accepted by the server;
7. a ship order onto land is refused and not applied;
8. the clock runs N rounds and income arrives in billions with its source;
9. a reload rejoins the same match, at its round, saying "Paused - press Play to resume";
10. no page error during the run.

Exit code is 0 when every check passed, 1 otherwise. The summary is printed at the end and is what
a task report pastes.
