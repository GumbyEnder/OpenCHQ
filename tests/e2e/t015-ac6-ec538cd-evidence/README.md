# T-015 AC6 live hand-check evidence

Test-only. Not merged to `web`, no stamp: a test commit on `web` would make the tip
differ from the tip-parent that `build.json.commit` must name (the AC5 invariant that
accepted `ec538cd`).

- `../t015-garrison-handcheck.mjs` — the hand-check: opens the deployed build, registers a
  throwaway seat, buys one tank beside an enemy-held capital, orders it onto the capital's
  own cell, runs the clock, and reads the result out of `window.__chq.room()`. No debug
  endpoint, no server state.
- `ac6-handcheck.json` — the run of record against live `ec538cd` (2026-11-14 03:10 ET):
  garrison entrenched on Paris's own cell every round, contact at r20, tank fought down to
  strength 4 by r37, destroyed r38, capital red throughout, no capture event.
- `rerun-0337.json` — same check re-run against live at 03:37 ET; same outcome.
- `ac6-paris-contact.png` / `ac6-paris-after.png` — the two frames: at contact (round 20,
  tank beside a red Paris) and after (round 38, Paris still red, blue tank gone).

Re-run it:

    node tests/e2e/t015-garrison-handcheck.mjs \
      --url=https://openchq-web-production.up.railway.app --era=1942 --rounds=60 --speed=6

Exit 0 and `HANDCHECK_OK rows=9` is the pass. Each run registers its own throwaway account
with a random password; no credentials are stored in this tree.
