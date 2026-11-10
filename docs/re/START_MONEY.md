# START_MONEY — starting cash and Monitor Four, read from the original

Date: 2026-11-09. Runs: DOSBox 0.74-3 on Xvfb `:99`, `dosbox_rea_linux.conf`,
`CHQ.EXE` from `/mnt/nas/projects/Command HQ/COMMAND`.
Image under test: `modern/extracted/exe/CHQ_unpacked.EXE`, sha256
`e8f1fac5a88ffc1a1875fc3b73f8446168f6fb33e9f692c0615520c4aef1e2da`.

Status: **interim — Part A, one era fully closed (1918), three more era rows measured,
`????` unverified. Part B wired the measured values into `config/game.json`** (2026-11-10).

Status line for the code: `startPool` (player's own pool, per era) and `handicap` (opponent's
starting-money spinner, p.17) are both in `config/game.json` with a source per value; the spinner is
in the lobby with the per-era default; `web/test/nodes/start_money.mjs` pins all of it.

## Part B — what is wired, and where

| Era | `startPool` (player) | Source | `handicap.default` (opponent spinner) | Source |
|---|---|---|---|---|
| 1918 | 10b | `startmoney-1918-blue-monitor4-own.png`, `DS:0x148e = 400` | 010 | `startmoney-1918-blue-sgtstan-default.png` |
| 1942 | 50b | `startmoney-1942-blue-monitor4-own.png`, `DS:0x148e = 2000` | 030 | `startmoney-1942-blue-sgtstan-spinner.png` |
| 1986 | 50b | `startmoney-1986-blue-monitor4-own.png`, `0x148e = 2000` both sides | 050 | **UNVERIFIED stand-in**: inferred from `0x148e = 2000`; no dialog capture |
| 2023 | 600b | `startmoney-2023-blue-monitor4-own.png`, `BALANCE: 600` | *none* | Manual p.16: no spinner, setup goes straight to the war room |
| `????` | 50b | **UNVERIFIED**: `0x148e = 2000` from memory only; the war room was never reached | 150 | **UNVERIFIED stand-in**: the dialog showed `150` (`0_spinner_9999blue.png`) |

- Server: `web/server/rules.mjs` `startPool(era)`, `handicapSpec()`, `handicapDefault(era)`,
  `opponentPool(era, spinner)`. `web/server/match.mjs` `openMatch(era, sites, { handicapSide,
  opponentPool })` gives the spinner value to the side that is not the player.
- The spinner is a handicap on the **opponent only** (p.17), and 1942 proves the two numbers are
  different: player 50b, spinner 030 → opponent 30b. Setting it to 000 empties the bot's pool and
  leaves the player's alone (`start_money` node).
- Range: **0-999, step 1, billion** — an inference from the three digit columns, **UNVERIFIED**. No
  capture has clicked a digit to either end, and wrap behaviour is unknown. `sources.handicap.range`
  says so.
- Red side: no capture of its own, so Red is given the **Blue** pool on purpose (a recorded
  stand-in), not a number of its own. Opponent starting money comes from the spinner, so a Red
  *player* still opens on the era's Blue pool and handicaps Blue's bot.
- Live check: `GET /api/setup` serves the same numbers the lobby draws.
- Screenshot note: `Pool` in the purchase line, the Economy dialog and the buy shop now reads in
  whole billions **truncated** (`3711:16f3`, `0x148e / 0x28`), so `Pool 0b`, never `Pool 0.3b`
  (F4). Sub-1b balances are UNVERIFIED against a capture.

## Headline result (1918, Blue, SGT. STAN STIL, spinner left at its default)

Monitor Four's Alternate Function, captured from the running original:

| Press | DS:0xe378 | Screen |
|---|---|---|
| 1 | 1 | `MONEY (BIL$)` / `INCOME: .650` / `BALANCE: 10` |
| 2 | 2 | `MONEY (BIL$)` / `INCOME: .400` / `BALANCE: ???` |

Captures: `docs/captures/startmoney-1918-blue-monitor4-own.png`,
`...-monitor4-opponent.png`, `...-monitor4-terrain.png`.

That is the manual's behaviour on p.18/p.27 exactly: own income unrounded, own cash in
whole billions, opponent income shown, opponent cash never shown.

**It is not the pair 3000 / 850.** Those two numbers are real globals, but neither is what
Monitor Four prints (see "The 3000 and the 850" below). The 1918 start is **10 billion cash,
0.65 billion per round**, and the opponent is **0.40 billion per round** with cash hidden.

## The monitor, from the disassembly

`FUN_3711_16a8 @ 3711:16a8` (file offset `0x2bdb8`) is the Monitor Four Alternate Function
renderer. Disassembled at `3711:16a8`:

- **Mode byte** `DS:0xe378`: `0` = terrain/unit panel, `1` = own money, `2` = opponent.
  `1` sets the side index from `DS:0xdb02`; `2` sets it to `1 - DS:0xdb02`
  (bytes `3711:16c4`–`3711:16e1`).
- **Balance** = `DS:0x148e[side] / 0x28` (divide by 40, integer) — `3711:16f3`–`3711:16fe`.
  Whole billions, no decimals. 400 → `10`, exactly as captured.
- **Income** = `cities * 0x32` (50) then
  `income -= ((DS:0x148c / 5) * income) >> 2` — `3711:1608`–`3711:162d`.
  `cities` comes from `FUN_1dfc_1246(side, 1)`. No constant is added: there is **no +100 in
  the income path**.
- **Opponent cash**: the `"   ???"` string at `DS:0x569b` replaces the number
  (`3711:1f52`, `3711:1f56`). Labels are `"Money"` `DS:0x567d`, `"(bil$)"` `DS:0x5683`,
  `"Income:"` `DS:0x568a`, `"Balance:"` `DS:0x5692`.
- The panel **auto-reverts**: pressing the key arms `DS:0x3eb2 = 400`; the main loop counts it
  down and at 1 sets `DS:0xe378 = 0` and repaints. Measured on the running build: 5 s
  (400 ticks ≈ 80/s). So it is a five-second peek, and the second press has to come inside
  that window to show the opponent.

### Which key

The key handler is `FUN_1cdd_0850 @ 1cdd:0850`. It compares the polled key against
`0x443 / 0x456 / 0x458 / 0x45a` (`1cdd:0c4f`–`1cdd:0c61`):

| Key code | Set at | `DS:0xe184` | Effect |
|---|---|---|---|
| `0x456` (Ctrl+V) | `1cdd:0cf9` | 5 | increments `DS:0xe378` (`1cdd:0f03`) and calls `FUN_3711_16a8` — **Monitor Four money/income** |
| `0x45a` (Ctrl+Z) | `1cdd:0c8c` | 2 | increments `DS:0xe32c` (`1cdd:0dc2`, `0xdd8`), arms `DS:0x3eb0 = 400` — the other monitor's alternate byte |
| `0x458` (Ctrl+X) | `1cdd:0c9c` | 3 | `0xe318`/`0xe330` path |
| `0x443` (Ctrl+C) | `1cdd:0ca4` | 4 | `0xc3ac` toggle |

Correction to the earlier note: **Ctrl+Z is not the money panel.** Ctrl+Z drives `DS:0xe32c`,
read by `FUN_3711_031a @ 3711:031a`, which draws the oil columns from `DS:0x144a` (reserve),
`DS:0x144e` (in) and `DS:0x1452` (out), each divided by 125. Verified live: Ctrl+Z moved
`DS:0xe32c` 0 → 2. **Ctrl+V is the Monitor Four Alternate Function.**

### Hidden menu bar (p.32)

`DS:0xc34e` = 1 (peacetime) / 2 (wartime) is set when the cursor row `DS:0xdafc < 6` and no
button is down, in `FUN_2bad_034e @ 2bad:034e` (decompiled.c ~23063). That is the menu bar
appearing when the controller enters the Mode Bar. Once set, `FUN_1cdd_0850` routes every key
through `0x1dfc:0082` (`1cdd:0c40`) before the war-room commands.

## The 3000 and the 850

Both are written by the new-game setup, `FUN_20b1_01b6 @ 20b1:01b6` (decompiled.c
13140–13145), once per side:

    0x1446[side] = 3000
    0x144a[side] = oilfields * 200
    0x1452[side] = (cities + bases) * 0x32 + 100

- **`DS:0x1446 = 3000` is not the balance.** Monitor Four reads `DS:0x148e`, not `0x1446`.
  Measured 1918: `0x1446 = 3000` while the panel printed `BALANCE: 10`
  (`0x148e = 400`). What `0x1446` is, is **open** — it is per-side, written 3000 by setup
  and 10000 by `FUN_23aa_0b46 @ 23aa:0b46`, and the only code seen touching it is the
  oil-spend path `FUN_15f4_0d9c`. Do not use it as cash.
- **`DS:0x1452 = 850` is oil out, not income.** `FUN_3711_031a` draws it as the `Out` column
  and divides by 125. The arithmetic checks out on the same match: 1918 France 13 cities +
  2 bases → `15 * 50 + 100 = 850`; opponent 8 cities + 2 bases → `10 * 50 + 100 = 600`.
  Both measured. Monitor Four's income for those same two sides was `.650` and `.400`
  (`13 * 50`, `8 * 50`).
- **The `+100` therefore lives in the oil initialiser**, not in money income. It is a flat
  baseline added once to the oil-out total. Whether it is a genuine fixed overhead or a
  stand-in for something the 50-per-site term does not cover is **not settled** — the
  per-round recompute in `FUN_15f4_0664 @ 15f4:0664` (`decompiled.c` 4723) writes
  `cities * 50 + 200`, i.e. the same total once the two bases are counted. It must not be
  carried into the money model.

## Cash and the spinner

`DS:0x148e[side]` is the money slot: `FUN_23aa_0cba @ 23aa:0cba` adds to it (floor 0, cap
60000), `FUN_15f4_0cdc` tops a side up when it is under 20000, and `FUN_3711_16a8` divides it
by 40 for the panel. So **one displayed billion = 40 units**.

The opponent's spinner writes that slot at 40 per point (`030` → `1200` → `30`).

| Era (Blue, SGT. STAN STIL) | Spinner default | Player cash | Opponent cash | Own income | Capture |
|---|---|---|---|---|---|
| 1918 | `010` (REA capture) | **10** | 10 | **.650** | `startmoney-1918-blue-sgtstan-default.png`, `...-monitor4-own.png` |
| 1942 | **`030`** (new capture) | **50** | **30** | **1.550** | `startmoney-1942-blue-sgtstan-spinner.png`, `...-monitor4-own.png` |
| 1986 | not photographed; `0x148e = 2000` on both sides ⇒ `050` | **50** | 50 | **1.550** | `startmoney-1986-blue-monitor4-own.png` |
| 2023 | **no spinner at all** — setup goes straight to the war room | **600** | 600 | **-250** | `startmoney-2023-blue-monitor4-own.png` |
| `????` | `150` seen on the dialog | 50 in memory, **war room not reached** | — | — | `0_spinner_9999blue.png` (not copied) |

- 2023 confirms the manual p.16 "large pool": **600 billion** for both sides, no handicap
  spinner.
- The spinner default is **not the same across eras** (010 / 030), and the player's cash is
  **not the spinner value** (1942: spinner 030, player 50). So the spinner is the opponent's
  handicap, as p.17 says, and the player's opening cash is a per-era constant.
- **Negative income is real and unexplained.** 2023 prints `-250`, and the 1942 opponent
  prints `- 900`. The renderer can only print negative if `DS:0x148c / 5` is large, so
  `0x148c` is live at render time even though it read 0 in the dump a second later. What
  `0x148c` is (an oil-shortage penalty? war severity?) is **open**.

## Not verified

- `????` (era 5): the run reached the money dialog but not the war room, so its cash and
  income are **UNVERIFIED**. Its spinner showed `150`.
- Red side, and every opponent other than SGT. STAN STIL.
- 1986's spinner digits were not photographed; `050` is inferred from `0x148e = 2000`.
- Whether the spinner can go to 000 / 999, its step, and whether it wraps.
- What `DS:0x1446 = 3000` is.
- What `DS:0x148c` is.

## Scripts (`tools/t6/`, in the repo)

The capture rig is committed so a later pass (red side, era 5, spinner limits) starts from the same
walk instead of being rebuilt from a transcript.

- `rea-run.sh` — Xvfb + DOSBox verbs (`start/kill/shoot/key/click/move`). Mount conf:
  `/mnt/nas/projects/Command HQ/dosbox_rea_linux.conf`; `dosbox-rea.conf` is the in-repo copy.
- `t6-final.sh <era 1..5> <side 1|2> <opp 1..6> <tag>` — walks setup, dumps globals,
  captures Monitor Four at `0xe378` = 1 and 2 with the mode byte read beside each shot.
- `t6-dump.py <pid> [side]` — reads `0x148e/0x1490/0x1446/0x144a/0x144e/0x1452/0x148c/
  0xe378/0x3eb2/0xe32c` out of the live DOSBox process (needs root, `/proc/<pid>/mem`).
- `read-globals.py` — older dump; **its labels are wrong for `0x157e` (time left, not money)**
  and for `0x1452` (oil out, not income). Kept for the DS base anchor only.
