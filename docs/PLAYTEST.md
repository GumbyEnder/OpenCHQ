# A thousand rounds, played by two seats

`local/two-seat-play.mjs` — two accounts, two sockets, the ops a page sends (invite, answer, run,
sync, buy, order, tool), a small policy on each side (take the nearest city nobody owns, buy an
infantry when the purse allows). 1986, the real 269-site board, round length shortened to 0.12 s
for the run.

    node web/server/main.mjs        # OPENCHQ_CONFIG=/tmp/fast.json OPENCHQ_WEB_DATA=/tmp/ocq-play
    node local/two-seat-play.mjs 1000

## The result

| | |
| --- | --- |
| rounds played | **1000 in 156 s** (6.4 rounds/s; the clock asks for 8.3, the harness sends 8 orders a seat a round) |
| orders | 70,920 |
| purchases | 175 |
| tools used | 40 |
| cities at the end | blue 67, red 91, neutral 111 |
| pieces on the board | 78 |
| purse | blue 950, red comparable — nobody was spending it |
| winner | **nobody, in 1000 rounds** |

The last 275 rounds of the log are nothing but `paid 26 from 17 cities`, every 25 rounds, on both
sides. No captures, no contact, no shots.

## What that says

1. **The match deadlocks.** Two expanding seats meet a frontier they cannot cross and then simply
   pay each other forever. 1,000 rounds at the real 5 s round is 83 minutes of a game that has
   stopped changing. This is the stalemate the pacing notes predicted, now measured rather than
   argued.
2. **The frontier is water.** 8,716 refusals of `No sea lane reaches that cell.` The policy kept
   aiming at cities it could see and not reach. Transports exist and work — the log has
   `a unit boarded a transport` and `a unit landed` — but a destination with no lane at either end
   is not reachable, and the player is told nothing until they try. A hundred and eleven neutral
   cities sat untouched for four hundred rounds because of it.
3. **CONTACT NEVER HAPPENED.** Over a thousand rounds, two sides with 78 pieces between them never
   fought. The bot-vs-bot soak fights (first shot round 48) because the bot seeks the enemy; a
   player-like policy that only takes empty cities never meets anyone. Incentives again, not rules.
4. **Cash with nothing to buy.** 950 in the purse and 17 cities: the policy buys one infantry every
   two rounds because that is all it was told to do. A human would have bought armour and artillery
   and broken the deadlock. The economy is not the problem here; the player's decision space at the
   frontier is.
5. **The kit reports, and my first tally hid it.** Forty tool uses showed no events only because
   the counter looked for `capture`/`shot`/`destroyed`. Counting every kind on a short run:
   `{"satellite":2,"intel":2,"intel_seen":2}`. The acks are fine; the measuring was not — the same
   lesson as the full-frame harness two iterations ago.


## Round two: the order to attack (wakeup 26)

The deadlock had a cause, and it was not the economy. `planOrder` refused any destination whose
cell was occupied — **including an enemy's**. Two player-like sides therefore stood eight cells
apart for a thousand rounds: neither could give the order to close, and combat (which resolves
between adjacent pieces every other round) never had a pair to resolve. An order onto an
enemy-held cell is now an attack; a friendly piece in the cell is still a refusal, and `advance`
still stops one cell short and lets combat decide.

Same harness, same board, 1,000 rounds:

| | before (no attack order) | after |
| --- | --- | --- |
| cities | blue 83, red 89, neutral 97 | **blue 162, red 69, neutral 38** |
| pieces killed | — | 171 |
| refusals of "another piece holds that cell" | 8,886 | 6,043, and most now name a *friendly* piece |
| winner | none | none — the capitals are still standing |

The frontier moves now, and the map is being contested rather than shared.

### The payday is not the problem (measured, 600 rounds each)

| `payEvery` | cities at 600 | buys | purse at 600 |
| --- | --- | --- | --- |
| 25 | blue 111, red 76, neutral 82 | 220 | 709 |
| 12 | blue 88, red 78, neutral 103 | 257 | 1,468 |
| 6 | blue 94, red 75, neutral 100 | 231 | 3,013 |

Three times the income buys about a tenth more units and settles nothing; the purse simply grows.
**Do not shorten `payEvery`.** The recommendation in `docs/BALANCE.md` to fix the slope before the
shape was wrong for this reason: the slope was never the binding constraint. What a side cannot do
is spend, because at a frontier of empty cities there is nothing worth buying.


## Round three: a match can be won (wakeup 27)

The first played match that ended: **red, round 259**, "the enemy holds both capitals" — 32 s of
play at 0.12 s rounds, which is 22 minutes at the real 5 s clock. Blue 71 cities, red 79, neutral
119, and red took Washington with troops on the ground.

Two defects stood between the game and that sentence.

1. **A ship could win the war.** `checkWin` counted *any* piece standing on a capital cell, so a
   blue destroyer that sailed onto Moscow took the red capital at round 27 — the match ended with
   7 pieces on the board and the log line "you hold both capitals". A capital is held by troops on
   the ground: land domain, not embarked. A ship also can no longer be ordered to end on land
   ("A ship cannot end on land."), which is what let it sail inland in the first place.
2. **A player who is ahead had no reason to finish.** The policy took every city it could see and
   never marched on the capital, so 1,500 rounds passed with 527 kills and no winner. A leading
   side now goes for the enemy capital, because holding both capitals is the win.

`web/test/nodes/capital.mjs` proves the endgame directly: a piece standing on a capital takes it,
holding both capitals wins, and a ship on a capital does not.

The endgame is now reachable, and it takes about 250 rounds — 21 minutes at the real 5 s clock.
Whether that is the right length is the next design question, and it is finally a question about
the game rather than about a missing rule.

## Next, in order

1. The last ten rounds: a match now ends, but nothing in the page announces a capital under
   threat. The player should be able to see the enemy closing on their capital before it falls.
2. Make the frontier legible: a target that cannot be reached should say so at the moment it is
   chosen ("no lane from here to there"), not after the order is refused. That alone turns the
   deadlock into a decision: build a lane, take a coast, or go somewhere else.
3. Give the policy an army: tanks, artillery, a stack, and a reason to attack a held city. If the
   match still cannot be won at 1,000 rounds with armour, the stalemate is a rule defect, not a
   policy defect.


## Legibility: what a player can see now (wakeups 28-30)

The engine had the rules; the page did not show them. Three additions, each one a decision the
player can now make before it is too late:

- **A capital under threat.** Enemy land troops inside 8 cells of a capital raise an alarm in that
  seat's log and a strip above the board, repeated only on a closer approach. The last ten rounds
  of a match used to be silent.
- **The result.** The seat view carries `over` and `winner` now. Before this, a page watched the
  clock stop and never learned who won, and a playing harness ran ten minutes past the end.
- **Cargo looks like cargo.** A land piece in water draws as a ring, the legend names it
  "transport (cargo)", and selecting one says it cannot fight back and an enemy ship sinks it.
- **A plane's absence is a number.** The view carries `inactive` rounds remaining, and selecting an
  aircraft says "Away on a mission: 3 rounds until it can fly again."


## The board is the earth again (after the CHQ reference)

The original Command HQ put the whole planet on one 320x200 screen — a fully revealed map, black
dots for cities, terrain colours, and a right-click zoom for detail. Ours had drifted: "Fit" never
fitted (it reset to the 8 px legible default), the first view opened on a window rather than the
world, and a view wider than the board tiled the earth two or three times across the screen.

Now:

- the default camera is the whole world fit — 320x136 centred on the canvas, 2 px per cell on a
  762 px canvas, one copy, margins either side;
- **Fit** returns to that view; zoom and pan take the camera over and a resize keeps it;
- the board is only tiled when it is genuinely larger than the view, because the seam wrap is for
  panning, not for wallpaper;
- **fog is the concealed era's rule, not the default.** The map is a map; the enemy is the secret,
  which the server's view already enforces. Only era 9999 darkens the ground.


## The board in the original's colours (reverse-engineered, not invented)

The palette in `web/public/paint.mjs` is no longer ours. It was recovered from the shipped game
rather than guessed:

- `WORLD.PIC` decodes to a 320x200 EGA image whose map area starts at **y = 6** (rows 0-5 are
  black), and `TMAP.DAT` is one nibble per cell at 320x136 — so cell (x, y) is pixel (x, y+6).
- At that offset the terrain table and the art agree on **85% of cells**. Slide the picture up or
  down and the agreement falls away (0.708 at 0, 0.851 at 6, 0.575 at 38), which is what pins the
  offset rather than assuming it.
- The dominant colour per terrain type, out of the 16-colour EGA default the game sets:

  | terrain | colour | share |
  |---|---|---|
  | ocean | `#55ffff` | 65% |
  | plain | `#00aa00` | 51% |
  | forest | `#55ff55` | 43% |
  | jungle | `#00aaaa` | 58% |
  | mountain | `#aaaaaa` | 37% |
  | desert | `#ffff55` | 73% |
  | polar | `#ffffff` | 90% |

The 84 cities the board draws are `CBR-SET.DAT` — the original's own site table — so the dots are
the original's dots, at the original's coordinates. The picture itself carries no dots: the game
projected them at runtime, exactly as this page does.

Measurement script: `Command HQ/modern/tools/sample_palette.py`; output
`extracted/data/terrain_palette.json`. Side-by-side capture: `docs/compare-original.png`.

One deliberate difference: the capital's ground is yellow so the legend can name it, while the
marker that identifies a capital remains the ring and the label.

## Where the unit markers are not (wakeup 14)

The unit sprites were the next fidelity item, and looking for them turned into a negative result
worth writing down so nobody repeats it.

- `UNITS.PIC` decodes to 320x200 in the original's 16 EGA colours. Its top 24 rows are two bands of
  ten 12x12 tiles: the same figures repeated on white, blue and cyan plates. That is a palette
  variant sheet for UI sprites, not a marker set. Below the bands is window chrome (bevelled boxes,
  borders) and large art.
- `ANIMS/*.PAN` are already decoded by the reference tree's `tools/pan_decode.py` into
  `extracted/anims/<NAME>/` — 60x18 and larger battle sprites. A map marker is 1 to 3 pixels at one
  pixel per cell, so these are not it either.
- The only place the mapping "unit type and side -> marker" can live is the draw routine in
  `CHQ_unpacked.EXE`. That needs a working 16-bit disassembly, which this session does not have.

So the graph gained `chq_disassembly` as an explicit prerequisite, and `unit_icons` now depends on
it rather than being re-claimed every fire against the same wall. The board keeps its shapes until
the table is read out; shapes are honest, invented sprites would not be.

## The disassembler runs (wakeup 15)

`chq_disassembly` existed as a blocker, and it turns out the work was already done a month ago and
never connected: `Command HQ/modern/docs/ghidra/CHQ.gpr` is an analysed project whose full
decompilation sits in `export/decompiled.c` — 880 functions, 23 of them renamed with evidence in
`rename-log.md`. What was missing was a way to reach it from a script.

Two tools now:

- `tools/disasm.py index` parses the export into `extracted/data/disasm_index.json`: name,
  segment:offset, linear address, size and the line in the C. 880 functions, ordered by address.
- `tools/disasm.py dis 1eb5:000c` disassembles the unpacked image with `objdump -b binary -m i8086`.
  The image is flat — file offset == (segment << 4) + offset — so objdump's addresses are the ones
  Ghidra names, and no Ghidra run is needed to read machine code.

The finding that matters for the next node: **`render_sprite` is not a sprite blitter.** Its body
pushes five bytes into a ring at `0xefbc` and returns. `docs/re/SYSTEMS.md` calls it "a sprite
blitter" with HIGH confidence, and that mislabel is why the unit-marker hunt was looking at
`UNITS.PIC` instead of at the code that drains that ring.
