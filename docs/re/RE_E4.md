# RE_E4 — peacetime (cold war) economy, measured in DOSBox

Written 2026-11-25 by game, for T-035. Nothing here is inferred from the manual; every number is
from a capture in `evidence/re4/` or from the decompiled listing at a named line.

Harness: `/mnt/nas/host-ops/openchq/re-e4/{ree4.py,ree4-walk.sh}` (root, `PYTHONPATH=` `/usr/bin/python3`).
`ree4-walk.sh <era> <side> <opp> <tag>` starts Xvfb `:99` + DOSBox and walks to a fresh war room;
`ree4.py <pid> census|sample <secs> [interval]|clearfilm|set` reads DGROUP through `/proc/<pid>/mem`,
anchored on `STARTING MONEY` at DS:0x2EDD (same method as `re-e5/re5-live.py`).

## 1. What was measured

Two captures, both Blue, opponent = menu item 2 (SGT. STAN STIL), modal dismissed with Return, war
room resumed with `alt+p`.

| run | era (DS:0x19E) | file | duration | round counter | film (0x1478) |
|---|---|---|---|---|---|
| A peacetime | 2 (1986) | `evidence/re4/sample-1986blue-peacetime-150s.csv` | 150 s @ 1 s | stayed **0** for all 150 rows | stayed **2** |
| B control | 1 (1942) | `evidence/re4/sample-1942blue-control-60s.csv` | 60 s @ 1 s | 0 -> 5 | stayed **0** |

### A. 1986 cold war — cash accrues with no round at all

- `cash 0x148e`: 2170 -> 5110 over 149 s. The step histogram is 145 steps of **+20** and 4 of +10:
  money rises on a fixed money tick, not on a round boundary. Both sides moved identically
  (blue 2170 -> 5110, red 2170 -> 5110).
- `round 0x1476` stayed 0 and the piece-pass cursor `0x147c` stayed 0 for the whole window: **no
  round runs in the cold war**, so there is no per-round income to compare against.
- `0x157e` (the clock) ran 7122 -> 20 -> 65535 and the money tick continued at the same rate after
  it wrapped, so the cold-war economy is not gated on that countdown.
- Oil, the whole window, both sides, unchanged: reserve `0x1446` **3000**, In `0x144a` **2200**,
  Out `0x1452` **1870**, paid `0x144e` **2200** (blue) / reserve 3000, In 1600, Out 820, paid 1600
  (red). **Listed, never charged.**

### B. 1942 wartime control — one payday per round, oil charged

- `round` advanced 0 -> 5 in 50 s; `cash` 2000 -> 2310, i.e. **+62 per round**, stepping only at
  round boundaries.
- At the first boundary the reserve moved 3000 -> 8392 and Out/paid went 1890 -> 1808. The reserve
  figure is quoted raw and **not interpreted** here; what matters is that it moved, which it did not
  in A.

The two runs are not a speed-controlled comparison (different eras, speed not pinned), so the
honest rate statement is per-tick vs per-round, not "N x faster". At the speeds these two sessions
ran, A accrued ~20 money units/s and B ~6.2/s (+62 per ~10 s round).

## 2. What the code says (decompiled.c, `modern/docs/ghidra/export/`)

- **`film` word.** `0x1478 = 0xc8cc & 0x7f` (11450). Values observed: 0 in a running wartime game,
  2 in the cold war, 3 while the OPPONENT'S STARTING MONEY modal is up. It is a mode word, not a
  boolean.
- **Oil is only charged in mode 0.** `FUN_15f4_0d7e @ 15f4:0d7e`: Out is accumulated
  unconditionally (`0x1452 += cost`), then `if (0x1478 == 0)` deducts from the reserve and adds to
  paid. In every other mode the budget is listed and not spent — exactly the ticket's wording, and
  the code reason capture A shows a constant reserve.
- **Peacetime income.** `FUN_15f4_0cdc @ 15f4:0cdc`, per side, only while `money < 20000`:
  - `if (0x1478 == 1)` -> `income = FUN_2dfc_1246(side, 0) >> 1` (half the computed income, floored
    at 1 when non-zero) — 4950-4951;
  - `else` -> a **flat 10** money units per call.
  Capture A ran at mode 2 and stepped +20/s, i.e. two flat-10 calls per second. **There is no peace
  multiplier in the original.** The `0x1478 == 1` halving is a different mode's rule and is not
  measured by capture A.
- **Money clamp.** `FUN_23aa_0cba @ 23aa:0cba`: `money += delta`, clamped to 0..60000.
- **Menu bar.** `0xc34e = 1` when `0x1478 < 3`, `= 2` otherwise (23063-23069) — the peacetime menu
  is the one shown in the cold war. That confirms mode < 3 = cold war, mode >= 3 = wartime, which is
  consistent with film 3 being the setup modal.
- **Round increment** happens only in mode 0 (`0x1476 += 1` inside the `if (0x1478 == 0)` block at
  4888-4889), which is why capture A's round counter is frozen.

## 3. What is still UNVERIFIED

1. **The transition.** Nothing in capture A started the war: the clock expired and the economy kept
   accruing. The peace -> war trigger is therefore **not** the countdown; it is a command/menu action
   (the 0xc34e menu bar is the entry point) or an event. Rule unrecovered.
2. **"Purchases mark no site unready" (T-035 AC3).** Not measured: the war-room cursor cannot be moved
   synthetically on this host (documented), so the Buy panel cannot be driven from a script yet.
   Code side: `0x10ae` readiness writes come from the purchase path, gated in part on `0x1478`
   (1632-1633, 3340), so the exemption is plausible but unproven.
3. **Mode 1.** `0x1478 == 1` halves computed income; no capture has been taken in that mode, so what
   it is (war declared? ceasefire? first-round state?) is open.

## 4. What this means for T-035

The port should model the cold war as: income on a money tick while a peace flag is on, oil budget
displayed but never charged, readiness untouched, and no round loop. The multiplier must not be
invented — the original pays a flat 10 per tick (plus the separate mode-1 halving rule), and the
tick is not a round. The 1986 cold war in the port should therefore key off a peace flag that
suppresses `oilFlow()` charging and the readiness write, and pays the configured per-tick amount,
rather than scaling wartime income by a peace factor.
