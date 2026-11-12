# TODO — open RE questions

Date: 2026-11-12. Hand-maintained. Each entry states what is UNVERIFIED, what evidence exists in
this repo, and what measurement would settle it. Nothing here is a T-004 blocker unless the entry
says so.

## 1. Does the original's walker let a land unit cross a 1-cell water gap without embarking? — UNVERIFIED

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
notion of a sea leg; the land/sea split is a `move.mjs` construct. Whether a class-2 land unit in
the original steps across one ocean cell as ordinary land movement, instead of boarding a
transport, has not been read anywhere.

**Impact.** None on T-004. Our routes never take that step, and refusing it can only be stricter
than the original.

**Settle it by.**
- Disassemble `FUN_16ee_0728` and read what it does with a class-2 piece whose line crosses ids
  0-2 for a single cell, or
- a DOSBox experiment: a land unit ordered across a one-cell water gap beside a coast — does it
  embark, or walk?

**Until then: UNVERIFIED.** Do not "fix" the walker to match a guess.
