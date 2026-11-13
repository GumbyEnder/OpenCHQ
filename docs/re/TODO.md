# TODO — open RE questions

Date: 2026-11-12. Hand-maintained. Each entry states what is UNVERIFIED, what evidence exists in
this repo, and what measurement would settle it. Nothing here is a T-004 blocker unless the entry
says so.

## 1. Does the original's walker let a land unit cross a water gap without embarking? — MEASURED for a 1-cell gap; WIDTH UNVERIFIED (Q37)

**Source.** Frodo's T-004 verdict on `6c1c396` (room 3203) counted 209 of the 60,874 planned
1986 site-pair land orders with a single wet cell inside a land leg. First example: Archangel ->
Dock 178,38, route index 24, cell (178,38) terrain id 1.

**State in this tree.** 0. `aa458de` made a short sea hop walk real water (`move.mjs` `seaLeg` ->
`lanes.mjs` `waterStepRoute`), so no land leg stands on water any more. Re-measured on 72,092
ordered 1986 site pairs at `30b821d`: 60,874 planned / 11,218 refused / 0 wet cells outside the
sea leg. The same probe on a `6c1c396` worktree returns 209 with the same first example, so the
count is the same one and the fix is what removed it. This is not a defect in the served game.

**Why it is still open.** The question is about the original, not about us. The walker there is a
straight Bresenham line graded by the class table (`FUN_16ee_0728`, RULES.md section 2) — it has no
notion of a sea leg; the land/sea split is a `move.mjs` construct.

**Answered 2026-11-13 (T-008 AC4, `docs/re/MOVEMENT.md` §Q33), for one width only.** A blue kind-2
tank ordered 7 cells south through `(175,17)…(175,24)` on the 1986 board, where a single terrain-0
cell sits at `(175,19)`, stepped onto the water cell and off again at the land pace (1.00
cell/pass, identical to the dry control leg), status byte unchanged `0x42`, order completed, at
speeds 6 and 3. **So the original lets a land unit cross a ONE-cell water gap without embarking,
and the remake's refusal to do so is a DELIBERATE DEVIATION (PM 3495 item 2), which stands pending
more evidence.**

**What is still UNVERIFIED is the width of that allowance.** Only a one-cell gap was measured. A
two-cell gap and a three-or-more-cell gap may be walked as cheaply, walked more slowly, or refused
— nothing in this repo says. That is **Q37** in `Open RE Questions`.

**Impact.** None on T-004 and none on served behaviour: our routes never take that step, and
refusing it can only be stricter than the original. No code changes.

**Settle Q37 by.** A DOSBox experiment: the same kind-2 tank ordered across a **two-cell** water gap
and across a **three-plus-cell** water gap beside a coast, recording pace (cells/pass) and arrival
(bool/timing) for each, beside the one-cell leg above as the control. Not run in T-008 — it is not
cheap and does not gate this task.

**Until then: the 1-cell rule is the deviation, the width is UNVERIFIED.** Do not "fix" the walker
to match a guess.


## 2. Speed 0: the manual says game-time stops, the round clock does not — MEASURED, not yet a ruling

**The manual line**, printed page 35, "Other Commands", exact text:

> "At speed 0, game-time does not pass at all. It is similar to a pause, but units can still be
> given orders, and air strikes can still be carried out."

**What the game does**, measured 2026-11-12 in DOSBox 0.74-3 at 3000 cycles, 1986 war room
(`docs/re/MOVEMENT.md` "Speed 0 vs Manual p.35"; logs `notes/t008/speed_table-2026-11-12.log`
and `pass_rate-2026-11-12.log`):

- the per-piece pass does not advance at all at speed 0 — 0 cursor increments at `DS:0x147c`
  in 8 s, against 7.37/s at speed 1 — so no piece, combat tick or piece animation progresses;
- `DS:0x157e` (the round countdown) still decrements at 59.19 units/s, the same rate as speeds
  1, 3 and 6.

So the manual's "game-time" is true for world time and false for the countdown panel: the
original has two clocks and speed 0 freezes one of them. The piece freeze matches the manual;
the running panel does not.

**Status.** This is a measured fact, not a defect and not a workload item. It changes nothing
in the browser game under D-017 (the runtime keeps its own 5 s round and speed ramp).

**Open question for the owner, not for RE.** Should the browser's round clock also stop at
speed 0? The remake currently does not model the original's two-clock split. Do not "fix"
`rules.mjs` toward either behaviour until that is decided; the only thing already pinned is
that pieces stop at speed 0 while the round clock does not.

## 3. Where is the purchase-placement validator that prints the 3f2b strings? — OPEN (Q39)

T-011 AC5 corrected `FUN_107e_4140`: it is the arrival/berth search (five rings, terrain class,
`DS:0x1996` low five bits, no site row), not a placement validator, and the old ECONOMY.md
summary's signature and branch list were a paraphrase (see `docs/re/PLACEMENT.md`).

The five restriction strings (\"Must be placed in city\", \"Must be placed on dock\", \"Must be on
mainland\", \"Friendly waters only\", \"Ships must stay at sea\") are real and live at `3f2b:411b`,
`3f2b:4132`, `3f2b:4b6d`, `3f2b:4bab` in the extract's string dump, but the Ghidra export carries
**no cross-references into segment 3f2b** — they are reached through a message table, so the
routine that prints them is not identified. Next probe: walk references *into* 3f2b (message-table
entries) or find the readiness write site, then read the branch order off the decompile.

Does not gate T-011: the shipped rule cites Manual p.27, the dock definition is DERIVED from
`world.json` (150/150), and the readiness constants are UNMEASURED stand-ins. Vault row: Q39 in
`Open RE Questions.md`.
