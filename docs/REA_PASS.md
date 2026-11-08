# REA pass, 2026-11-07 — what the binary says, and what it does not

Target: `Command HQ/modern/extracted/exe/CHQ_unpacked.EXE`, sha256
`e8f1fac5a88ffc1a1875fc3b73f8446168f6fb33e9f692c0615520c4aef1e2da`, 256,848 bytes.
Tooling used in this pass, all of it local: `python3` for byte work, `objdump -b binary -m i8086`
through `Command HQ/modern/tools/disasm.py` for instruction-level reading, and the pre-analysed Ghidra
project `modern/docs/ghidra/CHQ.gpr` with its 880-function `export/decompiled.c`.

Nobody should read this as "the game has been decompiled". It has not. It says exactly which questions
the binary answered and which it has not, so a later pass does not start over.

## What this pass established

**The data segment base, which was the missing address book.** The load image starts at file offset
`0x3600`; the MZ relocation table has 3,326 entries; the most frequent stored segment value is
`0x2F2B`. That value is not a guess: the terrain name pointer table at `DS:0x5034` resolves, under
`DS = 0x2F2B`, to the strings it must point at.

    file offset of DS = 0x3600 + 0x2F2B*16 = 0x0328B0
    DS:0x5034 -> words 0x4068, 0x406E, 0x4074, 0x407A, 0x407F, 0x4087, ...
    DS:0x4068 -> "ocean", DS:0x406E -> "docks", DS:0x4074 -> "ocean", DS:0x407A -> "lake",
    DS:0x407F -> "capital", DS:0x4087 -> "base", DS:0x408C -> "city", DS:0x4091 -> "oilfield"

So for any DS-relative offset `off`, the byte is at file offset `0x0328B0 + off`. Every table address in
`docs/re/DISPOSITIONS.md` can now be read without re-running Ghidra.

**The region tables are runtime buffers, not data in the image.** `DS:0x130A` (region coords),
`DS:0x1346` (region type) and `DS:0x1382` (region controller) read as zero in the shipped image. The
inference - labelled as one - is that the loader fills them from `CBR-REGN.DT*` / `REGIONS.DAT` at
start-up. That is why the `CBR-REGN` slot meaning had to be settled from the data files rather than
from a disassembly, and why this pass's decode of those files (184 regions x 5 points in REGIONS.DAT;
region -> governing region in CBR-REGN) is the only route to it that exists.

**The unit field is confirmed as a 7-value type nibble.** `*(byte *)(unit + 0x906) & 0xf < 7` appears
throughout `decompiled.c` (199 references to `0x906`), so there are seven unit types; the high bits of
that byte carry side and flags (`& 0xc0` compared against `0xE942` / `0xC350`). The mapping from
nibble to the booklet's names is still open.

**A 7-entry byte table exists at DS:0x2E16:** `10 20 10 10 20 20 10`, followed at `0x2E1D` by
`5 10 10 10` and at `0x2E21` by `0 1 2 7 8 9`. It sits immediately after the `PANI` string and before
`Money - `, which is the purchase-menu area of the string block. What it measures is not established:
the manual says ships use no oil and aircraft use more, and this table does not have zeros for ships,
so it is not the oil column. It must not be used as one.

## What is still open, and why

From `docs/re/RULES.md` section 5, unchanged by this pass: per-unit prices, damage per shot, scan
radii, oil in/out, foreign-aid cost, entrench bonus, the slowed-terrain routine, and the nibble-to-name
map.

The reason is structural, not laziness. The strings for the purchase menu are laid out consecutively
and walked with a computed pointer: the literal offset of `Cost` (`DS:0x2E78`) appears nowhere in the
code as an immediate, so following the menu backwards to its numbers needs a debugger rather than a
disassembly. The tables these routines read are either BSS (filled at load) or reached by a pointer
this static pass cannot resolve.

## The game was run, and it corrected a design assumption

DOSBox 0.74-3 (`/usr/bin/dosbox`) on a virtual display (`Xvfb :99`), mounting `Command HQ/COMMAND` and
running `CHQ.EXE`. Screenshots were taken of the target's own output with `ffmpeg -f x11grab`; three
are kept at `modern/docs/captures/` in the archive.

The path through the game, read off the screens:

    MAIN OPTIONS: START A NEW WAR / RESUME SAVED WAR / LAY OUT ARMIES / LOAD A FILM / WATCH A FILM /
                  SAVE A FILM / FILE UTILITY
    OPPONENT OPTIONS: ANOTHER HUMAN / SGT. STAN STIL / CAP. LUKE WARM / COL. BUCK ZEAL /
                      GEN. WIN MOORE / MARS GOD OF WAR / (RESTART)
    CONNECT OPTIONS: MODEM/PHONE / DIRECT SERIAL / NETWORK/LAN / (RESTART)
    CRISIS OPTIONS: 1918 / 1942 / 1986 / 2023 / ????
    1918 SIDE OPTIONS: BLUE / RED
    OPPONENT'S STARTING MONEY: a three-digit spinner
    then the war room, paused: "GAME PAUSED... (ALT-P TO RESUME)"

**The finding that matters: in 1918 the blue side is FRANCE.** Monitor two of the war room shows the
French tricolour with the word FRANCE under it, and monitor four shows PARIS as the selected place.
The colour carries the alliance, not the superpower - which is exactly what the manual says when it
calls red the Axis in 1918 and 1942 and the Warsaw Pact in 1986. Our remake has been fixing Washington
and Moscow in every era, so 1918 is an American-Soviet war wearing a 1918 map. That is a design
decision for the owner, not something to change silently.

The four monitors, in the running game, left to right: the year (1918) with a small icon; the flag and
country name; a regional minimap with a five-digit counter; the selected unit's artwork with the name
of the place under the cursor. The map above them is the same 320x136 world we ship, with unit markers
and the terrain colours already measured from it.

Also observed, and worth copying rather than inventing: the computer opponent is a named character
(SGT. STAN STIL, CAP. LUKE WARM, COL. BUCK ZEAL, GEN. WIN MOORE, MARS GOD OF WAR), not a generic bot.

## What the run did not settle, and the next step

The purchase menu was not reached. `B` and `F10` do nothing in the war room; the original's commands
live behind the Mode Bar at the top of the screen, and moving the controller into that strip is the
step still missing. Until the Buy Units screen is captured, per-unit prices, damage per shot, scan
radii, oil in/out, foreign-aid cost and the entrench bonus stay open - and stay labelled STAND-IN in
`config/game.json`. No number should be inferred from table shapes in the image.

## The run, scripted and repeated

`local/rea-capture.sh` launches DOSBox on a private display, walks the setup with synthetic keys and
takes the capture. Reaching the war room is now reproducible rather than a one-off. After `ALT+P` the
five-digit counter in monitor three advanced 0000 -> 0003, so the clock really runs and the capture is
of a live game, not a frozen screen.

The Mode Bar resisted synthetic input: pointer to the top strip, a right click, and DOSBox's mouse lock
(`Ctrl-F10`) all left the bar closed. The one click that landed produced the "UNIT PATH" mode message,
which means it hit the map rather than the strip. So the purchase menu is still unreached, and the
numbers behind it are still unmeasured; nothing was inferred to fill them.

The manual, read while the game was up, prints these and they are therefore sources rather than
stand-ins:

- a nuclear strike costs 10 billion (which is the 10 already in `config/game.json`)
- most games last 200-300 rounds; a city pays 50 million a round, and the manual prices a city at about
  15 billion across a game
- a paradrop costs the infantry 25 per cent of its strength
- three nukes fired and three absorbed makes a side immune to nukes for the rest of the game
- a "carrier engaged" warning means an unspotted submarine has been detected in the area
