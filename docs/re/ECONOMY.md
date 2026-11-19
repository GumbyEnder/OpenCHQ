# ECONOMY.md — money, oil and the per-round budget (T-033)

Sources are the Ghidra export at
`/mnt/nas/Projects/Command HQ/modern/docs/ghidra/export/decompiled.c` (line numbers below are
that file) and the manual page numbers the PM cites. Anything the code does not settle is marked
**UNVERIFIED** rather than filled in.

## Where the numbers live (DS slots, per side, word-sized)

| Slot | Meaning | Written by |
|---|---|---|
| `DS:0x1446[side]` | oil **reserve** (what is held) | setup `3000` (`20b1:0b46`, 13140); recompute `10000` for scenario < 2 (4700); clamped `0..10000` (4876-4883) |
| `DS:0x144a[side]` | **In** — production | `max(1, wells) * 200` (4704-4710, and `FUN_15f4_0e7a` 5068-5072) |
| `DS:0x1452[side]` | **Out** — consumption | `cities * 50 + 200` (4723); setup form `(cities + bases) * 50 + 100` (`20b1:0b46`, 13145) |
| `DS:0x144e[side]` | In **paid this round** (what the monitor's third column draws) | 4759-4763, 5099 |
| `DS:0x1456[side]` | spend accumulator between passes | 4712-4720 |

`FUN_3711_031a` (monitor, 30843-30909) draws In, Out and paid-In as **value / 125**, with the
reserve drawn as **value / 250** (one bar per 250, rounded up past 125 remainder) and caps the
columns at 30 (`0x1e`). The monitor draws these columns **only for scenario index >= 2** (30855:
`if (local_4 < 2)` takes a different, text-only screen). Scenario index is `DS:0x19e`, set from
the menu at 13103 and defaulted to 2 at 13106.

## Era gating — 1918 and 1942 do not run short

`FUN_15f4_0664` opens its per-side loop with

```
if (*(uint *)0x19e < 2) *(undefined2 *)(local_1c * 2 + 0x1446) = 10000;   /* 4699-4701 */
```

so for the first two scenarios the reserve is rewritten to the 10,000 cap **at the top of every
round**, before anything is charged. Together with the monitor's `local_4 < 2` branch that is why
1918 and 1942 display no oil columns and never stall on oil.

- Code reading: **1918 and 1942 do not use oil as a constraint.** MEASURED by disassembly only.
- DOSBox confirmation of the two-era behaviour: **UNVERIFIED** — no capture of the era<2 monitor
  screen was taken in this pass. The `DS:0x19e` value and the branch are both read from the code;
  a live `Ctrl+Z`/`Ctrl+V` screenshot on 1918/1942 would close it.

## Per-round order of events (the shortage order)

`FUN_15f4_0664 @ 15f4:0664` (4669-4896), in file order:

1. **In** = `max(1, wells) * 200`; **Out** = `cities * 50 + 200` (4698-4723).
2. Available = `reserve + In - spend` (4711-4720, `DS:0x1456` is the spend carried in from the
   passes of the previous round).
3. **Income penalty first.** If Out cannot be paid out of available, the unpaid share is taken off
   the *city count* (`local_e`), by 32-bit division at 4735-4740, scaled `3/2` and clipped to the
   city count for scenario > 3 (2023) at 4737-4739. The penalty percentage is stored for the
   monitor at 4744 and a warning is sounded at 4746-4755. **Cities stop producing income.**
4. **Then the per-unit spend** is applied by the pass loop and by `FUN_15f4_0d7e`:
   - `5` per moving piece per pass (4798),
   - plus the per-kind allowance `DS:0x19a6[kind]` for kinds `< 5` (4803): `0,12,24,0,0` for
     kinds 0-4, i.e. **entrenchment/transport 5, infantry 17, tank 29** per pass,
   - `20` per air mission / air record (4839, the 30-slot loop at 4819-4844),
   - `2` for the kind-8-ish row at 4850.
   When a charge cannot be paid the routine returns 1, the side is flagged, and that piece gets no
   movement budget: **units stop moving**, and **planes cannot fly**.
5. `Out` is recomputed with the reduced city count, clamped down to what was available, and the
   reserve becomes `available - Out` (4759-4764).
6. A side that could pay exactly nothing is flagged; at 4864-4870 a flagged side's reserve is
   **forced to 0**. Otherwise the reserve floor is `0x28` (4770) and the ceiling 10,000 (4879).
7. `FUN_15f4_0d7e @ 15f4:0d7e` (4989-5016) is the charge itself: it adds the amount to **Out**,
   and unless the game is replaying, subtracts it from the reserve and adds it to paid-In.

So the order is **income → movement → aircraft**, and the effects are cumulative in the same round.

## Ships

The manual (p.36) says ships use no oil. In the code every moving piece pays the `5` base through
`0d7e(5)` at 4798, and sea kinds (5/6 in the allowance table, `DS:0x19a2` for their pace) take no
per-kind allowance on top. Whether a live sea move order actually reaches that charge is
**UNVERIFIED** — no sea leg was driven. The remake follows the manual and charges ships nothing;
this is recorded in `config/game.json` as `shipKinds` and named as the one code-vs-manual conflict
in this doc.

## What the remake runs

`config/game.json` `resources.fuel`: `reserve 3000`, `reserveCap 10000`, `inPerWell 200`,
`inMinWells 1`, `outPerCity 50`, `outBase 200`, `moveCostPerKind {infantry 17, tank 29,
transport 5}`, `airMission 20`, `shipKinds [submarine, cruiser, carrier]`, `freeEras [1918, 1942]`,
`incomePenaltyEraScale {2023: 1.5}`.

**DELIBERATE DEVIATION:** the original charges per *pass* (`DS:0x147c` cursor, 11 passes/round at
speed 1). The remake has no pass cursor, so one cell entered costs one pass's charge. Per-round
totals therefore scale with distance walked, not with the clock.

Implementation: `web/server/resources.mjs` (`oilFlow`, `oilReadout`, `chargeOil`, `spendOil`,
`settleOil`, `oilIncome`), `web/server/move.mjs` (per-cell charge and the `oil_hold` stall),
`web/server/air.mjs` (20 before a mission leaves), `web/server/economy.mjs` (`oilIncome` applied to
the payday), `web/server/view.mjs` (`oil` and `foeOil` on the seat), `web/public/command.mjs` +
`app.js` + `app.css` (In/Out/reserve chip, red `oilshort` warning, Ctrl+V Alternate Function).

## Open

- Live 1918/1942 monitor capture (DOSBox) — the only UNVERIFIED item in the era gating.
- Live sea move-order oil charge — the code's 5-per-pass base against the manual's "none".
- `DS:0x1446` was listed as Q29 "3000, unknown" before this task; it is the oil reserve, and the
  3000 is the setup value, not money.
