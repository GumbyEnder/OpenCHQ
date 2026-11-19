# Q67 — a destination cell held by a stationary friend (measured in the 1990 original)

Rule of record (openchq-pm room 7431, accepting game's row 7428):

> A unit ordered onto a cell held by a stationary friend **parks on the last free adjacent cell,
> keeps the order live, and gives no notice. It takes the cell when the friend leaves.**

That is the original's behaviour, measured — not read off the manual. It is also the interim rule
already in `web/server/move.mjs`, so PB-131's code change is the *permanence* leg (a parked unit
arrives on the first round its friend leaves, with no re-issued order), not a new notice. PB-131
AC1 stands with **no notice**: a "blocked by friendly unit" toast would be a deliberate deviation,
which the PM is not taking.

All this is left in-tree as the citation, because `docs/re` is the copy that survives; the
instrument and its raw logs are on the NAS.

## Where the evidence lives

`/mnt/nas/host-ops/openchq/q67/` (md5s re-hashed 2026-11-19 at the time this file was written):

| file | md5 | what it is |
| --- | --- | --- |
| `q67.py` | `4a21891ab72916fe7c5ffa934be08b52` | guest DGROUP reader + injector (the harness) |
| `q67-run2.py` | `1a49d34658d62177e37b821ae63b55db` | run 2 driver |
| `q67-control.py` | `5f859a743e156fab7c9afe0ad96b17a3` | negative control: destination cell empty |
| `q67-detour.py` | `db0d73a4a62e354e3ea1d85629012d86` | Q67b: friend on the path, destination free |
| `q67-P3-repeat.log` | `f30ef81bff3d8870213e47f12e01075d` | clean repeat: parks at (79,36), order stays live |
| `q67-C1-free-cell.log` | `1d52ce7929338f9e17b8d25496f67201` | control: same injection, arrives, order clears |
| `q67-D1-detour.log` | `f42f5637da92fcaaf84cd15edc488834` | Q67b: arrives via the blocked path |
| `q67-P1-friend-holds.log` | `d58e4e9c1cc8d18c07d7c96aa0664114` | **void run** — kept only as the pitfall record below |
| `q67-P2-friend-holds.log` | `ed69d96d0ca286a3514b5f8eb27d9c2c` | first two-wraps hold (superseded by P3) |
| `q67-parked-held.png` | `5f4338975886c3f68352a3f3da73db61` | screen at the hold: no toast, no log line, HUD only |

Setup for every run: DOSBox 0.74-3, original CHQ on the 1986 map, blue vs red, speed 6, guest
DGROUP read out of `/proc/<pid>/mem` — unit table `0x1b6/0x286` current and `0x2ee/0x3be` start,
order fields `0x96e/0xa3e` and `0x426/0x4f6`, flags `0xc46`. Prove the pass cursor advances
(`film_mode` `0x1478` and `0xc8cc` zeroed, cursor `0x147c` moving) before believing any coordinate.

## Harness pitfall that voided a run (read this before reusing the injector)

**Teleporting a piece without rewriting its own order fields leaves the old order live, so your
"stationary friend" walks home through the test.**

The first run (`q67-P1`) teleported the friendly tank onto the destination cell and never touched
its `0x96e/0xa3e` or `0x426/0x4f6`. Its pre-existing order was still there and still set on the
`0x40` ordered bit of `0xc46`, so the vehicle kept driving to where it had been going — and the
probe read that as "the parked unit was blocked but the blocker moved", i.e. as noise.

The fix, applied in `q67-run2.py` and every run after it:

1. pin the piece (position written every pass — it cannot resume a route you overwrite),
2. clear its own order fields **and** the `0x40` ordered bit at `0xc46`,
3. control-check the pinned piece on **every** sample (`B_moved_at=None` must hold for the whole
   run, not just at the start).

A run whose log does not print a per-sample control column for the friend is not evidence.

## Honest limit

At 0.8 s sampling on a ~1.2 s step (speed 6) the Q67b row cannot distinguish a pass-through from a
short detour via row 35/37 (both plain cells). "Detour vs pass-through" stays **UNVERIFIED**. It
does not change the rule: the original reaches a free destination through a parked friend either
way, which is what PB-122 AC6 needed.

## Not answered here

Whether a **mid-game** Pause in the original required both players to resume is UNVERIFIED and
cannot be measured on this harness (blue vs the computer on a 1986 board, no link/modem path). It
is recorded in PB-134 as a deliberate remake rule with the manual's p.11-12 citation, never as
"restoring the original".
