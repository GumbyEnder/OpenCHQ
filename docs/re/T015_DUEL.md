# T-015 — the duel, measured on both sides

Two numbers this task exists to hold together: **how often the original exchanges fire** and **how
often the remake's do**. The traces themselves are workspace artifacts, not committed
(`local/` is gitignored): `local/t015/duel-original.txt` (DOSBox), `duel-original-s1.txt` (an earlier
read-only sample of the same fight), `duel-remake.txt`, and the two scripts that produced the
remake side, `duel-trace.mjs` and `duel-cadence.mjs`. This file is the committed copy of the numbers.

## The board

Blue tank (idx 13) ordered onto dug-in red infantry (idx 38) standing on Paris, site 17 at (150,34).
1942 scenario. The tank starts at (149,34) and, in both builds, never enters the cell.

## The original (DOSBox 0.74-3, speed 6, 41.152 s of wall clock)

| Event | t (s) |
|---|---|
| tank -2 | 0.642, 5.886, 10.146, 14.260, 18.113, 23.375, 27.455, 31.549, 35.668, 39.491 |
| tank -14 | 2.415, 7.680, 15.549, 24.988, 32.838 |
| garrison -13 | 10.148, 18.115, 27.457, 35.670 |
| tank destroyed | 41.152 (status 0x00, then the record is reset) |

* **Seconds per exchange: 8.51 s** of wall clock at speed 6 (spacings 7.97, 9.34, 8.21 s, 4 intervals).
* In the round clock: 2234 units in 41.152 s = 54.29 units/s wall; one exchange = 462 units =
  7.22 s of nominal game time; **16.6 exchanges per 7646-unit round** at speed 6.
* At speed 1 — **derived, not measured** (no speed-1 leg was run): the measured piece-pass rates are
  7.37/s at speed 1 and 49.11/s at speed 6 (config `measured.piecePassPerSecond`), a 6.66x ratio, so
  **~56.7 s of wall clock per exchange at speed 1**, over a 119.5 s round.
* Damage per exchange: garrison 13 exactly (100 → 87 → 74 → 61 → 48); the tank ~18 — 14 from the
  garrison's exchange plus 2 **twice** (~4.3 s apart). The tank never stands on the site cell, so
  COMBAT.md's militia rule (2 per pass while standing ON an enemy site) does not cover those two
  points. **UNVERIFIED**, not ported.
* The tank died on its **6th exchange**: 5 x 18 = 90, then the kill.

## The remake (speed 1)

* Round length: `config.speeds[1]` = 5 s. `shotEveryRounds` = 2 → **10.0 s per exchange**, over a
  5 s round.
* Exchange rounds: 1, 3, 5, 7, 9, 11, 13 — every second round, no back-to-back pair. The tank dies
  on the 7th exchange at round 13 = 65.0 s of simulated time.
* Damage per exchange: garrison 13 (same matrix cell as the original); tank 16 when `combat.resolve`
  fires (14 matrix + 2 militia) and 14 on the overrun rounds, because the overrun path in `move.mjs`
  does not pay militia.

## The gap, and what closed it

Before this task the remake fired in rounds 1 and 2 and then every second round: the overrun path
tested `match.foughtRound !== onRound`, which only stops a second shot in the *same* round, while a
held tank re-tries the overrun every round. That is the "double resolve" the PM found in
`advance()`/`resolve()`, still live in a second code path. It is fixed by gating the overrun exchange
on the same beat `combat.resolve` uses (`onRound - foughtRound >= shotEveryRounds`), and pinned by
`web/test/nodes/t015_capital.mjs` (fails with `two exchanges fired 1 round(s) apart: [1,2,4,...]` if
the guard goes back).

What is left is **7 exchanges in the remake vs 6 in the original**, and it is exactly the 2 damage
per exchange of unidentified original fire: 100/16 = 6.25 → 7 volleys versus 100/18 = 5.6 → 6. The
outcome is identical in both (tank dead, garrison alive at 14, Paris red). No number was tuned to
close it; the source of the original's extra 2 is marked UNVERIFIED in `docs/re/COMBAT.md` §5 and in
the trace file.

The remake being 5.7x faster per exchange at speed 1 (10.0 s vs ~56.7 s) is the deliberate
round-length deviation (5 s round against the original's 119.5 s), recorded in `config/game.json`
`notes.speeds` and D-017 — not a recovered number, and not changed here.
