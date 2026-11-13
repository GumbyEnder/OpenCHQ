# MOVEMENT.md — what the original measured, and how it was measured

Owner: game. T-008, branch `t008-measure`, 2026-11-12. This file is the evidence behind
`config/game.json` → `measured`, and the record of what is still UNMEASURED. It does not
re-pace the browser game: the runtime keeps the owner's 5 s round and speed ramp as a
DELIBERATE DEVIATION (PM ruling D-017, room 3268).

Status at this commit:

| Claim | State |
|---|---|
| Round length is one countdown of 7646 units (1/64 s), i.e. 119.5 s nominal | MEASURED |
| The countdown rate is the same at every speed 0-6 | MEASURED |
| Speed 0 stops the per-piece pass while the round clock and order entry keep running | MEASURED (AC2, amended room 3427 to Manual p.35) |
| The speed control is the war room `+` / `-` keys, DS:0xc700 | MEASURED |
| The per-piece pass indexes DS:0x0de2, not a 16-byte record array | DISASSEMBLY |
| Per-kind allowance table at DS:0x19a6 | DISASSEMBLY + live dump |
| Cells per round per kind, per speed | MEASURED for kinds 1, 2, 6 at speeds 1/3/6 (AC1, AC3); kind 1 harness-labelled and accepted as measuring the rule (PM 3481); kinds 4/5 **NOT OBTAINABLE** in 1918/1942/1986 — a closed FINDING, not a gap; 5/7/8/9 **PREDICTED** (static `0x19a6` byte, no run, PM 3495); era 4 start board UNCHECKED (Q36) |
| Terrain effect on speed | UNMEASURED |
| Q32 win timing | MEASURED (disassembly + live capture): the win word is written inside the capture handler 0.09 s after the owner byte flips, at clock 0x1CC3 — 3.7 % into a 7646-unit round, nowhere near a boundary |
| Q33 one-cell water crossing in a land leg | MEASURED (disassembly + live order): a kind-2 tank stepped onto terrain-0 water at (175,19), paid a step for it, and stepped off onto land at (175,20); the 7-cell order completed |

## Method

Everything below comes from the real 1990 executable under DOSBox, or from the Ghidra export
of that executable. No number is borrowed from the manual and no number is inferred from the
remake.

**Build and host.** DOSBox 0.74-3, config `/mnt/nas/projects/Command HQ/dosbox_rea_linux.conf`,
`cycles=auto` which settles at **3000 cycles** for this game (title bar, recorded in every run
log). Display on Xvfb `:99`, driven with `xdotool`. The game is the original `CHQ.EXE` run to
the 1986 war room by `local/t6-final.sh 3 1 2 t008probe`.

**Reading the game's own memory.** The probes read DGROUP out of the live DOSBox process
(`/proc/<pid>/mem`, run as root). The DGROUP base is found by anchoring the literal string
`STARTING MONEY` at `DS:0x2EDD`; every offset below is relative to that base. This is the same
anchor the T-006 work used, and it resolves in every war-room walk, so the base is not a guess.

**The speed control.** `DS:0xc700` is the speed byte (0-6). It is written by the war room's
`+` / `-` handler (`decompiled.c:10371-10389`) and rendered as `Speed N` by `FUN_259b_0e6a`
(`decompiled.c:19252`). Every probe sets speed the way a player does, by pressing `+`/`-` with
`xdotool` and reading the byte back, so the measurement cannot drift from the control the
player actually has.

**The round clock.** `DS:0x157e` is the countdown in 1/64 s units (`0x1dde` = 7646 = the panel's
`2:00.0`; the digit divisors in `FUN_3711_0074` fix the unit at 64/s). Probe:
`~/agents/game/notes/t008/speed_table.py <pid> 3 10` — set the speed, write `0x1dde` into the
countdown, sample the byte at 20 Hz for 10 s, three legs per speed. Writing the countdown is
the only write the probes do; they never seed the speed byte. Log:
`~/agents/game/notes/t008/speed_table-2026-11-12.log`.

**The per-piece pass.** `DS:0x147c` is the cursor the war-room pass walks 0..99. Probe:
`~/agents/game/notes/t008/pass_rate.py <pid> 8` — count cursor increments over 8 s at each
speed while keeping the countdown alive. Log:
`~/agents/game/notes/t008/pass_rate-2026-11-12.log`. Static evidence: `decompiled.c:4369-4595`
(`FUN_15f4_0002`).

**The piece and per-kind tables.** Read from the same live DGROUP with
`~/agents/game/notes/t008/unit_table.py <pid>` and cross-read against the code that fills them.
The base is not pattern-hunted: it is the address the pass itself indexes.

## Round length by speed (AC2)

1986 war room, 2026-11-12, `cycles=auto` → 3000 cycles, three 10 s legs per speed, countdown
re-seeded to `0x1dde` between legs:

| Speed | Legs (units/s) | Mean units/s | Seconds per 7646-unit round |
|---|---|---|---|
| 0 | 59.11 / 59.22 / 59.23 | 59.19 | 129.18 |
| 1 | 59.13 / 59.13 / 59.20 | 59.15 | 129.26 |
| 3 | 59.17 / 59.11 / 59.15 | 59.14 | 129.28 |
| 6 | 59.18 / 59.19 / 59.24 | 59.20 | 129.15 |

Two facts follow, and both are in the config:

1. **The round clock does not change with speed.** 59.19 units/s at speed 0 and 59.20 at speed
   6 is the same rate inside the probe's noise. The round is ~129 s of wall clock at every
   speed. The speed byte drives the per-piece pass (§ below), not the countdown.
2. **DOSBox ran the game ~7.5 % slow.** 59.17 units/s against the nominal 64 is why a 119.5 s
   round takes ~129 s here. Both numbers are recorded: 119.5 s is the game's own time,
   129.2 s is this emulator's wall time. A different `cycles=` value gives a different wall
   figure and the same nominal one.

## Speed 0 vs Manual p.35 — a measured fact, not a remake change

The manual (printed page 35, "Other Commands") says, exactly:

> "At speed 0, game-time does not pass at all. It is similar to a pause, but units can still be
> given orders, and air strikes can still be carried out."

What the game does, measured 2026-11-12:

- **Pieces stop.** At speed 0 the per-piece pass does not advance at all — 0 cursor increments
  at `0x147c` in 8 s, against 7.37/s at speed 1 (`pass_rate-2026-11-12.log`). Nothing in the
  piece loop runs, so no unit, combat tick or piece animation progresses. That is what the
  manual calls "game-time".
- **The round clock does not stop.** `0x157e` decrements at 59.19 units/s at speed 0, the same
  rate as every other speed (`speed_table-2026-11-12.log`, three legs).

So the manual's sentence is true for world time and false for the countdown panel: the game
has two clocks and speed 0 freezes one of them. This is recorded as a measured fact. **It is
not a change to the remake**: the browser game keeps its own speed model (D-017), and whether
the browser's round clock should ever freeze at speed 0 is the owner's call, not a recovery
task. Logged as an open RE question in `docs/re/TODO.md` §2 rather than "fixed".

## The per-piece pass and the piece table (S2 groundwork)

`FUN_15f4_0002` (`decompiled.c:4369-4595`) is the war-room per-piece pass. Its shape:

```
4386  if (*(char *)0x3e91 != '\0') return;            // the speed-paced gate
...
4499  if (*(int *)0x147c < 100) {
4502    ... ; FUN_15f4_0598();                          // shuffle two slots
4506    *(uint *)0x147a = (uint)*(byte *)(*(int *)0x147c + 0xde2);
4509    iVar7 = *(int *)0x147a;                         // <-- unit record index
4511    iVar5 = *(int *)(iVar7 * 2 + 0x1b6);            // current packed coords
4512    cVar2 = *(char *)(iVar7 + 0x286);               // current y
4513    cVar3 = *(char *)(iVar7 + 0x89e);               // strength
4515    bVar6 = *(byte *)(iVar7 + 0xc46);               // flags
4516    uVar9 = uVar8 & 0xc0;                           // owner bits
4517    bVar4 = *(byte *)(iVar7 + 0x836);               // side index
...
4589    *piVar1 = *piVar1 - (byte[(status & 0xf) + 0x19a6] >> 1);   // spend
4592    *(int *)0x147c = *(int *)0x147c + 1;            // next walk slot
4593    if (99 < *(int *)0x147c) { ... FUN_15f4_0664(); } // pass complete
```

**The base the pass indexes is `DS:0x0de2`.** It is a 100-byte table of unit indices, one per
walk slot: `0x147c` (walk cursor, 0..99) → `0x0de2[slot]` → `0x147a` (unit record index 0..99).
It is a permutation of 0..99, verified live (`unit_table.py`: sorted order equals `range(100)`).
It is built by `FUN_15f4_0608` (`decompiled.c:4637-4663`): fill `0xd7e[i] = i` and
`0xde2[i] = i`, shove `0x1e4` random transpositions through `FUN_15f4_0598`, then copy `0xd7e`
into `0xde2`. `0x0d7e` is the shuffle buffer, not the pass table.

**There is no 16-byte unit record.** Every field the pass reads is a *parallel array* indexed by
the same 0..99 record number, stride 1 or 2:

| Base | Stride | Meaning in this pass | Evidence |
|---|---|---|---|
| `0xde2` | 1 | walk slot → unit record index (the table the pass indexes) | 4506, 4637-4663 |
| `0x147a` | — | current unit record index (word) | 4506, 4509 |
| `0x147c` | — | walk cursor 0..99 (word) | 4499, 4502, 4592-4593 |
| `0x1b6` | 2 | current packed coords `x<<8 \| y` | 4511 |
| `0x286` | 1 | current y | 4512 |
| `0x426` | 2 | destination packed coords | 5082 |
| `0x4f6` | 1 | destination y | 5083 |
| `0x6fe` | 2 | per-unit movement points (word, refilled each pass, max 0x50) | 4526, 4588, 4791-4813 |
| `0x836` | 1 | side index 0..3 (`byte[side + 0x1976]`) | 4517-4518 |
| `0x89e` | 1 | strength | 4513, 4566 |
| `0x906` | 1 | status: bits 7:6 owner, bits 3:0 kind | 4509-4524, 4589 |
| `0x96e` | 2 | target packed coords (compared against `0x1b6`) | 4520 |
| `0xa3e` | 1 | target y (compared against `0x286`) | 4520 |
| `0xbde` | 1 | 0xff sentinel, else a unit index | 4544, 7040 |
| `0xc46` | 1 | flags: 0x40 has-destination, 0x20, 0x10, 0x08, low 3 bits | 4515-4522, 4544 |
| `0xd16` | 1 | per-unit countdown, 1 = clear when settled | 4570-4578 |

Owner is **bits 7:6** (`& 0xc0`), values 0x40 / 0x80 / 0xc0 for sides 0 / 1 / 2 — see
`FUN_15f4_0e7a` (`decompiled.c:5076-5086`), where the compare is `(status & 0xc0) == side*0x40
+ 0x40`, and `FUN_1ac5_008e` (`8183`) which writes `kind | side*0x40 + 0x40` at creation. Bit 7
is therefore not an "active" bit: a 0x40 unit is an ordinary active Blue unit. `STRUCTS.md` §6
said bits 6:5 and a 16-byte record; both are corrected here.

**Per-kind table: `DS:0x19a6`.** The pass spends `byte[(status & 0xf) + 0x19a6] >> 1` from the
unit's `0x6fe` points (`4589`), and `FUN_15f4_0664` refills `0x6fe` from the same table when the
walk wraps (`4782-4813`, `local_6 = byte[kind + 0x19a6]`). `FUN_15f4_0e7a` requests the same
byte per unit when a side's allowance is recomputed (`5081`). Live dump, 1986, 2026-11-12:

| Kind (`status & 0xf`) | `byte[0x19a6 + kind]` | inferred reading |
|---|---|---|
| 0 | 0 | unused / none |
| 1 | 12 | infantry |
| 2 | 24 | tank |
| 3 | 0 | transport (moves as cargo) — UNVERIFIED |
| 4 | 0 | coastal gun (immobile) — UNVERIFIED |
| 5 | 36 | warship |
| 6 | 36 | carrier |
| 7 | 40 | aircraft |
| 8 | 40 | air unit |
| 9 | 40 | air/satellite class |

Ten bytes, `0x19a6..0x19af`; the next byte `0x19b0` is the `'P'` of the "Press key to assign to
button" string, so the table's extent is not a guess. The kind names are the manual's unit
order read against the values (tank exactly 2× infantry, ships above land, air above ships),
**UNVERIFIED as names** — the numbers are the measured part. Live 1986 pieces carry kinds
2, 3, 5, 7, 8 and 9 (`unit_table.py`), which is consistent with the ten-entry extent and rules
out a shorter table.

Neighbouring live values, for the next pass: `DS:0x1976` = `20 20 20 20` (per-side movement
allowance, `4518`), `DS:0x19a2` = `35 5 31 0 0 12 24 0` (the alternate kind table used at
`4811` for AI-owned kinds 5-6), and `DS:0x2e22` = `1 2 7 8 9` (kind written at purchase for
unit slots 0-4, `8183`) with `DS:0x2e16` as the matching price/40 row.

## Pass rate by speed

Two independent measurements, and they do not agree at speed 1. The 8 s sampler
(`pass_rate.py`, cursor increments at `0x147c`, countdown kept alive) gives:

| Speed | Increments/s | Seconds per 100-piece pass (8 s window) |
|---|---|---|
| 0 | 0 (no piece steps in 8 s) | — (stopped) |
| 1 | 7.37 | 13.57 |
| 3 | 12.23 | 8.17 |
| 6 | 49.11 | 2.04 |

The full-round runs count **pass wraps over one complete 129.2 s round**, and every harness that
did so (carrier, tank, kind 1) read the same three numbers:

| Speed | Pass wraps per round | Seconds per pass | Against the 8 s window |
|---|---|---|---|
| 0 | 0 | — (stopped) | same |
| 1 | 11 | 11.75 | 8 s sampler is low by 14 % |
| 3 | 16 | 8.07 | agrees (8.17) |
| 6 | 63-64 | 2.03 | agrees (2.04) |

At speed 1 one pass is ~11.7 s, so an 8 s window is shorter than the pass it is trying to time
and cannot measure it; speeds 3 and 6 are inside the window and land where the round runs do.
**Passes per round is the round-run figure** (11 / 16 / 63-64), and the 8 s column is kept only
as the sampler it is. This supersedes the earlier sentence that called the per-kind split
unmeasured: the per-kind tables below are full rounds with two runs per speed.

## What is deliberately not done here

- **No buy-menu driver.** Kind 4/5 are not obtainable in 1918/1942/1986 (the slot list is the fixed
  literal `1 2 7 8 9` written by `8183`), and kind 1's movement rule is measured with
  `KIND_OVERRIDE`, so a purchase-flow driver adds no AC1 row (PM 3481 items 1-2).

- `roundSeconds: 5` and the seven-slot `speeds[]` ramp are untouched. They are the owner's
  playability deviation and are labelled DELIBERATE DEVIATION in `config/game.json`
  (`sources.speeds`, `notes.speeds`) with these measured numbers beside them.
- No browser change follows from speed 0. The measured fact is recorded; the decision about
  whether the browser's round clock should model it belongs to the owner (D-017).

## Cells per pass: the move-point budget (S2, 2026-11-12)

`DS:0x6fe + i*2` is a **4-byte int** per unit, and it is the only thing that paces a piece in
`FUN_15f4_0002`. The three writes that matter, all in `decompiled.c`:

- `4520` — when the committed target differs from the current position, the piece gets
  `flags |= 0x40` (under orders). Nothing moves a piece that is not under orders.
- `4526-4530` — one step is taken only if
  `byte[side + 0x1976] <= points[i]` **and** `FUN_16ee_0008(i, 0)` returns odd; the cost is
  `byte[side + 0x1976]`. The price of a step is therefore the **per-side** allowance
  (`DS:0x1976` = `20 20 20 20`), not the per-kind byte.
- `4785-4813` — at the end of a 100-piece pass every piece is topped up: with `flags & 0x40`
  clear the word is set to `kind < 5 ? 0 : byte[0x19a6 + kind]`; with `flags & 0x40` set it
  gains `byte[0x19a6 + kind] >> 1` per pass while it is below `0x50`.
- `4580-4589` — a piece whose `points < 0x14` (20) is skipped before any of the movement
  logic in `FUN_15f4_0002`, and the same branch skips `kind < 5` outright.

So the pass is the movement clock, `byte[0x19a6+kind]` is the per-pass budget and a step costs
20, which predicts `byte[0x19a6+kind] / 20` steps per pass. Measured (see below) that prediction
holds for every kind we could drive — kind 6 predicted 1.8, measured 1.64 / 1.81 / 1.77 at
speeds 1 / 3 / 6; kind 2 predicted 1.2, measured 1.00 / 0.80 / 0.90 (a piece is visited once per
pass, so a land piece cannot spend a two-step surplus).

| kind | byte[0x19a6] | steps/pass predicted | steps/pass measured |
|---|---|---|---|
| 1 | 12 | 0.6 | 0.45 / 0.62 / 0.59 @ speeds 1 / 3 / 6, full rounds, kind nibble harness-written (no kind 1 on this board) |
| 2 | 24 | 1.2 (capped at 1/visit) | 1.00 / 1.00 / 1.00 @ speeds 1 / 3 / 6, full rounds |
| 3 | 0 | 0 (transport carries cargo) | 0 |
| 4 | 0 | 0 | — (no kind 4) |
| 5 | 36 | 1.8 | PREDICTED — static byte only, no run |
| 6 | 36 | 1.8 | 1.64-1.73 / 1.81 / 1.77-1.81 @ speeds 1 / 3 / 6, two full rounds each |
| 7, 8, 9 | 40 | 2.0 | PREDICTED — static byte only, no run |

**The grant is the full byte, not half of it.** An earlier draft of this section read `4788` and
concluded `+byte>>1`; the measured points sequences on a kind 2 piece (`24 -> 28 -> 32 -> 16 ->
40 -> 24 ...`) only fit `+24` per pass against `-20` per step, i.e. two add sites (`4794` and
`4813`) fire on the same wrap. The `>>1` is one of them, not the whole grant. `4813`'s exact
condition is still UNVERIFIED.

### Measured, open water — kind 6 carrier (unit 35)

`notes/t008/s2_points.py`, ordered along the longest clear water run, `DS:0x1478` forced to 0.
Each row is a **complete round** — the run ends when the countdown reaches 0 (129.2 s wall,
the same length S1 measured at every speed):

| speed | cells (run 1 / run 2) | pass wraps | cells/pass | cells/round |
|---|---|---|---|---|
| 1 | 18 / 19 | 11 / 11 | 1.64 / 1.73 | 18-19 |
| 3 | 29 / 29 | 16 / 16 | 1.81 / 1.81 | 29 |
| 6 | 113 / 114 | 64 / 63 | 1.77 / 1.81 | 113-114 |

Two runs per speed, both complete rounds, and the run-to-run spread is one cell at the round
boundary. That is the reproducibility AC1 asks for.

### Measured, open land — kind 2 tank (unit 39)

Every land piece in the 1986 walk sits in the base cluster with 0 clear cells of its own
terrain class in any direction, so the harness teleports one tank to the 33-cell class-8
corridor at `(62,36)`. The piece, its kind, its flags and its points are the game's; only the
start cell is a harness write.

A single 20-cell order finishes inside a round at speeds 3 and 6, so a **full** land round needs
an order-refresh loop: on arrival at the far cell the harness writes the opposite end as the new
target (`0x96e` / `0xa3e`), moves the walker's own start pair (`0x2ee` / `0x3be`) to the current
cell, and clears `flags & 0x40` so `4520` re-arms the order itself. `notes/t008/s2_land_round.py`
does this and stops when the countdown reaches 0. Two runs per speed, complete rounds:

| speed | cells (run 1 / run 2) | pass wraps | cells/pass | turnarounds |
|---|---|---|---|---|
| 1 | 11 / 10 | 11 / 11 | 1.00 / 0.91 | 0 (order completes after the round) |
| 3 | 16 / 16 | 16 / 16 | 1.00 / 1.00 | 0 |
| 6 | 63 / 64 | 63 / 63 | 1.00 / 1.02 | 3 / 3 |

**The refresh loop only holds with all three writes.** Writing the target alone leaves the piece
stopped at the corridor end with `flags 0x40` and 100 points and no step taken; the tell is a
piece under orders with a full budget that never moves, which is the same signature the base
cluster produced before the terrain was understood. Without the walker-start write, the *first*
turnaround succeeds and the second one stalls — so a loop that turns once is not a loop.

A land piece is visited once per 100-piece pass, so it cannot spend a two-step surplus: kind 2's
predicted 1.2 steps/pass is capped at 1.00 measured at every speed. That is why the tank's
cells/round (10-11 / 16 / 63-64) is the pass count almost exactly.

Cells per pass is constant across speeds for both kinds and the pass rate is not — so **cells
per round is a function of speed, not a constant**:

| kind | speed 1 | speed 3 | speed 6 |
|---|---|---|---|
| 2 tank | 10-11 (round) | 16 (round) | 63-64 (round) |
| 6 carrier | 18 (round) | 29 (round) | 113 (round) |

Both rows are now complete rounds with two runs each — no extrapolation left in the table.

### AC3 — the table, by speed and by kind

Passes per round are the round-run counts above; cells/pass per kind are the two-run full-round
figures; cells/round is their product and is printed beside the measured count so a mismatch is
visible rather than smoothed.

| Speed | Passes / 129.2 s round | kind 1 inf (12) | kind 2 tank (24) | kind 6 carrier (36) |
|---|---|---|---|---|
| 0 | 0 | 0 | 0 | 0 |
| 1 | 11 | 0.45 -> 5 cells | 1.00 -> 11 cells | 1.64-1.73 -> 18-19 cells |
| 3 | 16 | 0.62 -> 10 cells | 1.00 -> 16 cells | 1.81 -> 29 cells |
| 6 | 63-64 | 0.59 -> 37 cells | 1.00 -> 63-64 cells | 1.77-1.81 -> 113-114 cells |

Allowance byte in parentheses. Product and measured cell count agree to one cell at every row,
which is the round-boundary quantisation. Two shapes to keep: **kind 2 is capped at 1.00** (one
visit per pass cannot spend a 1.2-step surplus), and the 36-allowance kind is **not** 1.8 flat —
it reads 1.64-1.81 across speeds because the budget is a 4-byte int refilled at the wrap, so a
step's remainder carries.

Kinds 5, 7, 8 and 9 have no run and are **PREDICTED** rows, keyed on the static byte and printed
as a band rather than a single number. PM 3495 item 1: they ship labelled, not blank and not
waiting for a purchase. Their cells/round is the measured passes per round times the predicted
steps per pass, so it inherits the measured pass counts exactly:

| kind | `byte[0x19a6+kind]` | steps/pass (predicted / capped) | cells/round s1 (11 passes) | s3 (16) | s6 (63-64) | status |
|---|---|---|---|---|---|---|
| 5 | 36 | 1.8 / 1.00 | 11-20 | 16-29 | 64-114 | PREDICTED — static byte only, no run |
| 7 | 40 | 2.0 / 1.00 | 11-22 | 16-32 | 64-127 | PREDICTED — static byte only, no run |
| 8 | 40 | 2.0 / 1.00 | 11-22 | 16-32 | 64-127 | PREDICTED — static byte only, no run |
| 9 | 40 | 2.0 / 1.00 | 11-22 | 16-32 | 64-127 | PREDICTED — static byte only, no run |

The band's upper end assumes a piece can spend two steps in one visit; the lower end is the
one-step-per-visit cap that pinned kind 2 at exactly 1.00. Kind 6 is the reason the upper end is
real for a 36 (measured 1.64-1.81), and it is also the reason not to read 2.0 for a 40 as a
number: a 40 has never been driven. **A PREDICTED row is not evidence** — it exists so the table
has no blank cells and so the config shape is complete, and the status column says which is
which.

**`config/game.json` now carries this table** (`measured.passRatePerRound` and
`measured.cellsPerRoundByKind`, PM 3495 item 1), one row per kind 0-9 keyed on the static
per-kind allowance byte `byte[0x19a6 + kind]` — **not** on a piece identity read from `0x906`
(PM 3481 item 3, because Q35 is still open). Every row carries `status` (MEASURED /
MEASURED-HARNESS / PREDICTED) and, where a run exists, an `evidenceRef` naming the section of this
file. `web/test/nodes/measured_round.mjs` pins the shape: ten rows, allowance matching
`pieceTable.kindAllowance` for every kind, 5/7/8/9 PREDICTED, and every non-PREDICTED row carrying
an evidenceRef. The cross-check is measured cells/pass per allowance: **24 → 1.00, 12 → ~0.6,
36 → ~1.7**; a config row for a kind is accepted only if its allowance lands on the measured band
for that allowance. **These are reference rows, not the runtime:** `move.cellsPerRound` above is
still what the server runs, and with the owner's 5 s round and speed ramp it remains a DELIBERATE
DEVIATION.

Kind 1's row above is harness-labelled (`KIND_OVERRIDE`, §Measured open land — kind 1) and the PM
has accepted it as measuring the movement rule: a purchased kind-1 run is **not required** for
T-008 (room 3481 item 2). The provenance caveat stays as provenance, not as an open row.

Kinds 4 and 5 are a closed **FINDING**, not a gap: `DS:0x2e22` = `1 2 7 8 9` is the kind the game
writes for purchase slots 0-4 (`8183`), the same literal in 1918, 1942 and 1986, and no start
board in those three eras fields kind 4 or 5. So **no shop sells them and no checked board starts
with them** — they are not obtainable in the eras checked, and no buy-menu driver is being built
(PM 3481 item 1). Kind 4 has a 0 allowance byte; kind 5 (36) has only an AI-side path
(`DS:0x19a2`, `4811`). The remaining unchecked thing is era 4, tracked as its own open RE question
(Q36), not as an AC1 row.

`DS:0x6fe` write width is a confirmed trap: unit 37 read `2359296` (`0x240000`) after an
earlier probe wrote 36 as a `u16` at `i*2` — the low half was zeroed and the high half kept
the old value. Points must be read and written 4 bytes wide at `i*2`.

### Measured, open land — kind 1 (infantry), harness-labelled

The 1986 board carries no kind 1, so `KIND_OVERRIDE=1` rewrites the kind nibble of one existing
land piece (owner bits kept, `0x906+idx` high nibble untouched) and the run is labelled
accordingly. **This is not a purchased unit**; it measures the movement rule for kind 1, not the
engine's own creation of one. **PM 3481 item 2 accepts these rows on exactly that basis** — a
purchased kind-1 run is not required for T-008. Full rounds, 150 s windows that all ended at the
round boundary:

| speed | cells | pass wraps | cells/pass | predicted (`12/20`) |
|---|---|---|---|---|
| 1 | 5 | 11 | 0.45 | 0.6 |
| 3 | 10 | 16 | 0.62 | 0.6 |
| 6 | 37 | 63 | 0.59 | 0.6 |

The prediction holds at speeds 3 and 6; speed 1 has only 11 passes in a round, so one pass of
quantisation is 0.09 cells/pass and 0.45 is inside that.

**A blocked cell is a cell.** The first kind-1 attempts stopped at `x=81` with `flags 0x40` and a
full budget, twice, and the cause was unit 39 — the tank from the previous legs — parked at
`(82,36)`, the target cell. Occupancy blocks the step, so any corridor run has to clear the
corridor first (the tank now sits at `(151,32)`). A stopped piece under orders is not always a
harness fault.

**`0x906+idx` is not a stable unit identity.** After these rounds, the same record indexes read
different kinds than they did during the measurement: idx 35 was 6 (carrier) and now reads 2,
idx 37 was 2 and now reads 3, while 38/57/59 are unchanged (6/9/8). Nothing in the harness wrote
those bytes except the deliberate kind-1 override. So either records are re-derived between
rounds or a second writer touches the field — **UNVERIFIED**, and it matters because every
per-kind label in this document reads its kind from that byte. What is not in doubt is the
behaviour: each run's cells/pass matched the allowance byte of the kind it read at the time
(1.00 for a 24, 1.64-1.81 for a 36, 0.59-0.62 for a 12), so the table is labelled by measured
behaviour and by the byte observed during the run, not by identity.

## Which kinds an era can field (start boards, 2026-11-13)

Booted the 1918, 1942 and 1986 start boards with the `tools/t6` harness and read the purchase
slot table and the piece kinds before the first round:

| era | `DS:0x2e22` (kinds for slots 0-4) | kinds on the board |
|---|---|---|
| 1918 | `1 2 7 8 9` | 3 (28), 7 (3), 8 (13) |
| 1942 | `1 2 7 8 9` | 2 (11), 3 (25), 7 (9), 8 (11), 9 (4) |
| 1986 | `1 2 7 8 9` | 2, 3, 6, 8, 9 |

The slot table is a fixed literal written by `8183`, so **no era's shop sells kind 4 or kind 5** —
a buy-menu driver cannot produce them. No start board checked so far places kind 1, 4 or 5 either.
That is recorded as a **finding, closed for AC1** (PM 3481 item 1): kinds 4 and 5 are not
obtainable in 1918, 1942 or 1986, and the driver is not being built. Kind 1's harness-labelled
rows are accepted for the movement rule (PM 3481 item 2), so AC1 has no open row in the three
checked eras.

Era 4 did not reach a war room in this pass (zero piece records), so that row is UNCHECKED, not
empty, and it is now its own open item (Q36 in Open RE Questions) rather than an AC1 gap. Read
against Q35: the kind field's stability is itself open, so treat the board-kinds column as the
byte as it read at setup, not as a verified order of battle.

## Q33: does the walker let a land unit cross one water cell (disassembly, 2026-11-13)

Read `FUN_16ee_0728` (`decompiled.c:5425-5570`), its caller `FUN_107e_543a` (`4218-4239`) and the
nearest-cell search `FUN_16ee_15d4` (`6087-6230`). Terrain classes are indexed by
`get_terrain_type(x,y)`; the class semantics needed here are pinned by two measurements already in
this file: class 0 is open water (the carrier sailed at `(92,135)`, terrain 0) and class 8 is land
(the tank corridor at `(62,36)`), so **classes 0-2 are water, 3+ land, 14 impassable** (14 is the
one class `15d4` returns `0xfe` for outright).

What 0728 does with a cell, for mode `param_5`:

- `param_5 < 3`: `if (local_18 < uVar2) return 0` with `local_18 = 2 - param_5` — a **class
  ceiling**, so this mode accepts water classes only. That is naval plotting.
- `param_5 >= 3`: no class ceiling. It accumulates `byte[class + 0x11c]` into `0xe2ae` (capped at
  100) and counts the cell in `0xe7fa` (class <= 2) or `0xe7fb` (class > 2). The only hard rejection
  is class `0xe` when `param_5 < 5`.

So in the mode the movement-order path uses (`FUN_107e_543a` calls it with the player's order and
`FUN_16ee_0728(...,5)` appears in the plot path at `5775`), a water cell inside a land leg is
**costed, not refused**. The truncation people see comes from the caller, not the walker:
`543a` only falls back to the nearest reachable cell (`FUN_107e_2cbe(x,y,10,1)`) when the plan
returns `0xff` *and* water cells were counted *and* the piece's kind is `< 7`.

**Read as: the original permits a one-cell water crossing inside a land leg, at extra cost.** That
agrees with the 209 one-wet-step routes the remake planned at `6c1c396`.

### The live leg (2026-11-13, closed)

The remaining doubt was "a claim about the planner, not about what a unit does when it reaches the
water cell at step time". Driven in the original, 1986 blue, speed 6 and speed 3, with a real order
(`~/agents/game/notes/t008/q33_cross.py`):

```
=== WATER LEG 2: (175,17) -> (175,24) speed 6
intended leg: (175,17):8 (175,18):8 (175,19):0 (175,20):8 (175,21):8 (175,22):8 (175,23):8 (175,24):8
water cells on the straight leg: 1 at [(175, 19)]
idx 0 kind 2 owner 0x40 speed 6
   t=2.14 pass=1 pos=(175, 18) terr=8 pts=4  clock=7520
   t=4.19 pass=2 pos=(175, 19) terr=0 pts=8  clock=7399   <- on open water
   t=6.26 pass=3 pos=(175, 20) terr=8 pts=32 clock=7276   <- back on land
   ... one cell per pass, order completes at (175,24) t=18.22, 7 cells / 7 passes
```

The gap is a genuine one-cell water strip: terrain class **0** at `(175,19)` — the same class the
carrier sailed on — with plains immediately above and below it (`tmap.bin` row 19 reads `175:0`,
and column 175 reads `17,18,20,21 = 8`). The tank was teleported to the start cell — the only
harness write — and the target was an ordinary order; kind, points and movement are the game's.

What the two legs settle (speed 3 repeats it: on the water at t=13.88, off at t=13.89, one cell per
pass, `q33_cross.py` run 3):

- The piece **stands on an ocean cell** between two passes; it is not refused and it does not wait.
- The step costs the usual 20 points, and the pace is the **land** pace (exactly 1.00 cell/pass,
  the same as the pure-land control leg at `(62,36)`, which ran 5 cells in 5 passes), not the
  carrier's 1.64-1.81.
- The status byte stays `0x42` (kind 2, blue) across the crossing — no kind change. This is *not*
  a check of an embark flag: no transport/cargo field was located or read, so "it walked on foot"
  rests on the pace and the unchanged kind, not on an embark bit.
- A 5-cell order that stopped at `(175,20)` in the first attempt was an artifact of that attempt:
  its target word had been written while the session was still in the boot setup modal, and the
  walker rewrote target = current on arrival. The 7-cell orders on both speeds ran through the
  water and finished. Do not read that stop as a truncation rule.

So Q33 is answered in both directions: the planner costs it (disassembly) and the unit walks it
(measurement). The remake's T-004 rule — a land unit never walks on water, it boards a transport and
follows the lanes — is therefore a **deliberate deviation from the original**, not a port of it.

**PM 3495 item 2 (2026-11-13) rules that deviation deliberate and pending more evidence.** T-004
and the code stay exactly as they are; nothing in this task changed the walker. What was measured
is a **one-cell** gap, and only that: whether the original also lets a land unit cross a **two-cell**
or **three-or-more-cell** water gap, and at what pace, is UNVERIFIED. That is opened as **Q37** in
`Open RE Questions` (the DOSBox experiment: the same tank ordered across a two-cell gap and a
three-plus-cell gap, pace plus arrival time). The port-vs-keep decision waits on Q37, not on this
section. *(Numbering: the era-4 start-board question already holds Q36 from PM 3481 item 1, so the
water-width experiment landed as Q37 rather than overwrite a live row.)*

One harness fact worth keeping, because it produced a false "the harness is broken" reading in AC5:
a DOSBox session left in the **`OPPONENT'S STARTING MONEY` setup modal** has `film_mode`
(`DS:0x1478`) = 2, and the per-piece pass returns before walking anything. Every unit record then
reads stale/zero coords and no order moves. The `GAME PAUSED (ALT-P TO RESUME)` state is a second,
separate stop. Resume with `alt+p`, zero **both** `0x1478` and `0xc8cc`, verify the pass cursor
`0x147c` is advancing, and only then trust a coordinate read.

## Q32: when does the win fire (disassembly, 2026-11-13)

The win check is `FUN_1c0d_000c` (`1c0d:000c`, file `0xF6DC`, 71 bytes). It walks the 84 site
bytes `DS:0x1102+i`, skips absent sites (`0`) and every `subtype >= 3`, and returns 1 only when
**every** capital's owner bits equal the side passed in. It has exactly **two call sites**, both
inside the site-capture handler `FUN_1c0d_02ce`: `0xFC34` and `0xFC92`, each immediately after the
handler writes the new owner byte and each guarded by `cmpw $3,-0x2(%bp)` — i.e. only when the
captured site's subtype is `< 3` (a capital; a city never triggers it).

What the handler does with the answer (`decompiled.c:9223-9266`):

```
if (uVar6 == *(uint *)0xc350) {                  // capturing side == side to move
  if ((2 < uVar11) || (iVar5 = FUN_1c0d_000c(uVar6), iVar5 == 0)) {
    ... capture message/sound, owner byte already written ...
  }
  FUN_259b_055e(0xf0,0,0,10,0,1);
  *(undefined2 *)0x1550 = 2;                     // WIN — written here, synchronously
} else {
  ... FUN_1c0d_000c(...) != 0 -> *(undefined2 *)0x1550 = 3;   // LOSS
}
FUN_259b_02fa();
if (*(int *)0x1550 != 0) { FUN_35a3_1446(); *(undefined2 *)0xe296 = 1; FUN_1eb5_0cc4(); }
```

So the game-over word `DS:0x1550` (0 playing, 2 win, 3 loss) and the `0xe296` flag are written
**inside the capture handler**, and nothing in that path reads the round clock `DS:0x157e`. The
handler is called from three places, all arrival-driven: the per-piece pass at `decompiled.c:4548`
(the piece the pass has just walked), `7724` and `8654` (both after a site lookup for a piece that
has arrived). No caller is the round-end, turn-change or phase code.

**Answer: the original ends the match on the capture, not at a round or phase boundary.** The
`0xFFFF` clock stop measured in S1 is a round-boundary stop for the player's pacing; it is not the
win trigger and the win does not wait for it.

### The live leg (2026-11-13, closed)

Driven in the original: 1986 blue, speed 6, a blue kind-2 tank teleported to `(182,25)` — the cell
adjacent to Moscow — and ordered onto the site cell `(183,25)`, so the capture comes from a real
walker arrival rather than from writing coords onto the site (`~/agents/game/notes/t008/q32_arrival.py`):

```
site 63 at (183,25) byte 0x9a
  t=4.68 clock=7369 pos=(183, 25) site=0x9a win=0 e296=0 onsite=63   <- arrival, owner still red
  t=4.69 clock=7369 pos=(183, 25) site=0x7a win=0 e296=0 onsite=63   <- owner byte flips to blue
  t=4.78 clock=7363 pos=(183, 25) site=0x7a win=2 e296=0 onsite=63   <- DS:0x1550 = 2 (win)
```

- The owner byte goes `0x9A` -> `0x7A` (red 0x80 -> blue 0x40, subtype bits unchanged) and the win
  word follows **0.09 s later in the same handler**, exactly as the disassembly says.
- The clock reads **0x1CC3** at the win against a round start of 0x1DDE: 283 of 7646 units elapsed,
  i.e. **3.7 % into a 129.2 s round**. The win is nowhere near a round boundary, and no boundary
  write preceded it — this is the measurement that the Q32 answer needed.
- `DS:0xe296` still read 0 at the poll where 0x1550 first read 2; the handler writes 0x1550 first,
  so the flag is a later write and this leg does not pin its timing.

**Why the earlier attempt looked impossible.** The prior session was not in a live war room: it was
parked in the `OPPONENT'S STARTING MONEY` setup modal with `film_mode` (`DS:0x1478`) = 2 and the
main loop's frame counter at 0, so the per-piece pass never ran. Every unit record therefore read
stale coordinates (`x=0` in `0x1b6`), and no order could be acted on because no pass ran — the
`0x40` flag had nothing to consume it. Resume the game (`alt+p`, then zero both `0x1478` and
`0xc8cc`), verify the pass cursor `0x147c` is advancing, and the same offsets read sane coords.
That is harness state, not a finding about the game, and it is now the first check in the run
recipe.

So AC5 is closed on both halves: the disassembly names the two call sites, and the live capture
fires the win mid-round on the arrival.
