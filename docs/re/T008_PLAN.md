# T-008 measurement plan (branch `t008-measure`)

Owner: game. Started 2026-11-12. Spec: Vault `Dev Tasks/T-008 Measure speeds, round length,
Q33 and Q32.md`; brief: room 3242, go-ahead: room 3256.

## Base

`origin/web` at **2f46613** (`be28166` escort fix + its stamp), not `e43079a` as the spec's
header says. Web moved after the spec was written: `e43079a` -> `be28166` (the gated escort
fix, room 3246) -> `2f46613` (stamp). The branch therefore carries both T-004 merges and the
T-004 pin `782fb9b` is *not* in it (it sits on `t004-movement`; PM 3256 says it rides the next
deploy).

## What the harness already gives us (verified 2026-11-12, before any code)

- `local/t6-final.sh 3 1 2 t008probe` reaches the 1986 war room on Xvfb `:99` and reads the
  live DGROUP. Anchor `STARTING MONEY` at `DS:0x2EDD` still resolves; Monitor Four modes
  `e378` = 0/1/2 verified by byte, not by pixel.
- DOSBox config `/mnt/nas/projects/Command HQ/dosbox_rea_linux.conf` uses **`cycles=auto`** —
  which matters for AC2 (see the rate note).
- `DS:0x157e` is the **TIME LEFT** countdown, in 1/64 s units (panel `2:00.0` = 7680).
  `docs/re/STRUCTS.md:77` still calls it `money` — stale, fixed in the docs pass.
- **Measured on the default speed**: the byte decrements at **59.2 units/s** in this DOSBox
  (not 64), so the game clock runs ~7% slow under `cycles=auto`. A full countdown is
  therefore ~130 s of wall clock, not 120. The counter runs 7680 -> 0, then reads **0xFFFF**
  and the panel shows `0:00.0` until the player acts: the original **stops at the round
  boundary**, it does not roll into the next round. That is a phase boundary, and it is the
  shape Q32 has to be answered against.

Those numbers are a probe, not the AC2 table: the speed setting in that run is whatever the
war room opened with, and the speed control itself is still unidentified (S1 below).

## Stages

**S1 — round length by speed (AC2).** Find the original's speed control (Manual p.34-35;
grep `decompiled.c` for the speed selector and `DS:0x2e16`'s siblings). Then for speeds 1, 3
and 6: press Play (`Alt+P` resumes a paused war room), sample `0x157e` at 20 Hz, measure three
round periods each with `~/agents/game/notes/t008/measure_round.py`, and record
seconds/round. Speed 0: prove the counter does not move (byte static across 30 s). Re-run one
speed at a fixed `cycles=` value and report both, since `auto` already shows a 59.2/64 rate.
Exit: a table of seconds per round with the DOSBox cycles recorded.

**S2 — cells per round (AC1).** Locate the piece table in DGROUP (`docs/re/STRUCTS.md`,
`grep -n` the decompiled order handlers), order infantry, tank, cruiser, carrier and
submarine on open terrain, sample the piece cell once per second across two round boundaries,
2 runs each. Terrain effect: order the same unit across two terrain classes; if the original
exposes no terrain effect, write UNMEASURED and the reason. Exit: cells/round per kind, runs
named.

**S3 — Q33 (one-cell water gap).** Decisive test is a DOSBox order: put a land unit one cell
from a one-cell water pocket with land beyond, order across, read the resulting position and
domain. Disassembly of `FUN_16ee_0728` is the corroborating evidence, not a substitute.
Exit: answered with the capture path, or left open with exactly what was tried.

**S4 — Q32 (win-check timing).** Capture a last-capital capture: read the round counter and
`0x157e` at the capture, and whether the end-of-game path can run while `0x157e` still has
time on it (the 0xFFFF boundary above is the competing hypothesis). Exit: an answer from a
capture; no engine change.

**S5 — wire and pin (AC3, AC7).** Replace `config/game.json` `speeds[]` and
`move.cellsPerRound` stand-ins with the measured values, each carrying `source` (capture file
+ date). Keep UNMEASURED on anything not captured. Pin the measured values in tests so a
later edit cannot silently drift; state plainly if the original contradicts a T-004 ordering.
Suite both legs with every skip named; `load_test` at 10x or better.

**S6 — docs and record.** `docs/re/MOVEMENT.md` (method + table), the `STRUCTS.md:77` fix,
Open RE Questions Q5/Q32/Q33, Review Log row, and a dated status section in the vault T-008
doc.

Deploy only if `config/game.json` changes (AC8): `stamp_build` -> commit -> push ->
`railway up` from a mapped checkout, then live E2E and a hand-check screenshot of one unit
moving at its measured rate.

## Risks

- **`cycles=auto` distorts the clock by ~7%.** Fixed-cycles runs are the honest form; quote
  both and say which one the table uses.
- **The speed control is unidentified.** S1 is gated on it; if the game only exposes speeds
  through setup rather than the war room, measure one speed per fresh walk and record that.
- **The `????` era rolls its setup per run** — never a speed or movement source.
- Round boundaries are input-gated, so a naive timer measures one round and then hangs; the
  probe must re-arm the clock between rounds.

## Code findings, 2026-11-12 (after the first probe)

Reading `decompiled.c` against the live DGROUP narrows S1 a lot:

- `DS:0x157e` is written in only three ways: `0x1dde` (7646 units = **119.5 s**, the `2:00.0`
  panel), `0x4aab` (19115 units = **298.7 s**, ~5:00), and `0xffff` (time stopped).
  `0xEEF`/`0x27D`/`0x40` are the minute/second/tenth digit divisors in `FUN_3711_0074`,
  which is what pins 64 units per second.
- The two round lengths are selected by an unverified selector `DS:0x19e` (currently 2 in the
  1986 war room): `== 2` -> 0x1dde, `== 3` -> 0x4aab. There is no seven-entry round-length
  table in the code. The manual's speeds 0-6 are **Speed Up / Speed Down** commands
  (p.34-35), so the working hypothesis is that speed scales the tick rate that decrements
  `0x157e`, not its starting value. S1 tests that by changing speed in the war room and
  measuring the decrement rate, and only then by touching `0x1a0`, which reads 1 and is the
  other speed-shaped candidate.
- `0xc6fe != 1` forces `0x157e = 0xffff`, i.e. a run flag, not a timer. A probe that reads
  the clock while that flag is 0 measures a paused game.
- At the boundary `0x157e == -1` the war-room loop (`10229`) calls `FUN_2ffd_138e` and then
  spins on `FUN_2757_0329` waiting for a key: the original **stops and asks** at the round
  boundary. That prompt is the phase boundary Q32 must be answered against, and it also means
  a measurement script has to answer it to get a second round.
- DOSBox `cycles=auto` settled on **3000 cycles** for this game (title bar), which is the
  number to record with the AC2 table.
