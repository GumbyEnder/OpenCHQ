# Pacing: measured, not tuned

Two bot-vs-bot runs on the real board, the real modules, at the configured round length. The
harness is `local/pacing.mjs` (march AI by default, the server's own bot with `--bot`).

## The numbers (1986, 5 s/round, pay every 25 rounds)

| | script march | shipped bot (`--bot`) |
|---|---|---|
| first contact | round 187 (15.6 min) | round 85 (7.1 min) |
| first kill | round 197 (16.4 min) | round 129 (10.8 min) |
| first capture | round 13 (1.1 min) | round 20 (1.7 min) |
| captures | 6 | 33 |
| kills | 73 | 24 |
| units bought | 189 | 140 |
| income units | 1,187 | 1,564 |
| winner inside 1200 rounds | none | none |

Wall clock at other round lengths for the same 1200 rounds: 3 s → 60 min, 2 s → 40 min,
1 s → 20 min. Income lands every 25 rounds, so 5 s pays every 2.1 min and 1 s every 25 s.

## What this says

1. **The clock is not the problem; the front is.** Neither run finishes, at any round length.
   Armies mass to the cap, meet, and grind: 24 kills in 1200 rounds with the bot on both sides.
   Shortening the round makes a stalemate faster, not a game.
2. **Contact is late for a player.** 7.1 min of marching before the first shot at 5 s/round.
   The map is 104 cells between capitals at one cell per round; that is the geometry, not a bug.
3. **Money is not scarce after the opening.** ~30 cities owned pay ~30 units of income per
   payment, while the only unit anyone buys costs 1. The purchase loop stops being a decision
   after the first few payments.
4. **Captures outrun kills** (33 captured vs 24 destroyed with the bot): territory changes hands
   because pieces walk over sites, not because armies win. That inverts the intended feel — land
   is taken by presence, not by force.

## What to change, in order

- **Make a mass of force decisive** (node `front_break`): the archive's own rule is "the
  defender is gone after HITS shots", which has no notion of odds. Three honest options, all
  needing the owner's call because each adds a rule rather than a number:
  a. overrun: an attacker with more adjacent friendly pieces than the defender's removes it
     instead of grinding (a rule, no hidden number);
  b. exchange odds in config, explicitly labelled a stand-in;
  c. supply: a piece far from a friendly city fights worse, which also gives the map meaning.
- **Keep 5 s** for now. Round length is a wall-clock knob, and it is cheap to expose the
  archive's speed words (Held / Slow / Normal / Fast at indexes 0, 1, 3, 6) once the front can
  break. A 7-minute march between decisions argues for a fast setting, not a shorter round.
- **Curve the income once contact is decisive**: 1 per city per 25 rounds is fine while a unit
  costs 1, but the purchase loop needs prices that scale with what is on the board.

Nothing here has been tuned by feel: the config still holds the owner's 5 s, `payEvery` 25 and
the stand-in prices, and the shop still costs 1 for infantry.
