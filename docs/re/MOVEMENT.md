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
| Speed 0 stops the per-piece pass dead, and does not stop the round clock | MEASURED |
| The speed control is the war room `+` / `-` keys, DS:0xc700 | MEASURED |
| The per-piece pass indexes DS:0x0de2, not a 16-byte record array | DISASSEMBLY |
| Per-kind allowance table at DS:0x19a6 | DISASSEMBLY + live dump |
| Cells per round per kind | UNMEASURED — needs a unit under orders |
| Terrain effect on speed | UNMEASURED |

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

`0x147c` cursor increments per second, 8 s per speed, countdown kept alive:

| Speed | Increments/s | Seconds per 100-piece pass |
|---|---|---|
| 0 | 0 (no piece steps in 8 s) | — (stopped) |
| 1 | 7.37 | 13.57 |
| 3 | 12.23 | 8.17 |
| 6 | 49.11 | 2.04 |

A unit can advance at most one cell per time its record is visited, so this is the ceiling a
per-kind allowance is spent against — not a cells/round figure. The per-kind split is still
UNMEASURED because no unit could be put under orders in the driven walk; that is the S2
measurement, and the addresses above are what it needs.

## What is deliberately not done here

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

So the pass is the movement clock, `byte[0x19a6+kind]` is the per-pass budget, and half of it
is granted per pass while the piece is under orders:

| kind | byte[0x19a6] | +points/pass under orders | steps per pass at cost 20 |
|---|---|---|---|
| 1 | 12 | 6 | 0.3 |
| 2 | 24 | 12 | 0.6 |
| 3 | 0 | 0 | 0 (transport carries cargo) |
| 4 | 0 | 0 | 0 |
| 5, 6 | 36 | 18 | 0.9 |
| 7, 8, 9 | 40 | 20 | 1.0 |

### Measured, sea/air

`notes/t008/s2_points.py` (unit 35, kind 6, carrier, open water, ordered 61 cells south,
22 s at speed 6, `DS:0x1478` forced to 0):

    cells 18   pass wraps 11   -> 1.64 cells/pass
    points 18 -> 36 -> 52 -> 32 -> 28 -> 8 -> 44 -> 4 -> 20 -> 0 -> 36 -> ...
    pass rate 11 / 22 s = 0.50 wraps/s

The `18 -> 36` step is the `+18` refill; `36 -> 52` (`+16`) is not explained by that branch —
`4813` adds points on a second path that has not been read yet, so the increments are measured
but the second path is UNVERIFIED.

At the measured 129.2 s round that is **~64 passes/round and ~105 cells/round for a kind 6**,
i.e. cells per round is not a constant across speeds — the round clock is fixed (see above)
while the pass rate scales with speed. Any config value has to be per speed.

`DS:0x6fe` write width is a confirmed trap: unit 37 read `2359296` (`0x240000`) after an
earlier probe wrote 36 as a `u16` at `i*2` — the low half was zeroed and the high half kept
the old value. Points must be read and written 4 bytes wide at `i*2`.

### Land is still UNMEASURED

Kinds < 5 are refilled to 0 and skipped by `4580`, so a land piece only banks `12`/`6`/`0`
per pass while under orders and never moves without several passes of banked points. Live
1986 land pieces (kinds 2 and 3, indices 37/39/41) sit in the base cluster where their own
terrain class has **0 clear cells in every direction**, and kind 3's allowance is 0, so no
land leg could be driven in this walk. Infantry and tank cells/round stay UNMEASURED until a
fresh game lets us buy and order a land piece in the open — that is AC1's remaining half.
