# OpenCHQ polish loop

One fire does one slice, proves it, and stops. The next fire takes the next slice.

This is a feel pass. The stand-ins it adds are not recovered binary facts. Put every new number in `scripts/assumptions.gd` with a comment that says so. Do not describe a stand-in as something the executable contained.

## Where to work

Work only in `/mnt/nas/projects/OpenCHQ`. Do not commit or push. Do not build in `/mnt/nas/projects/Command HQ/modern/game/`. Godot 4.7 is on PATH. The data pack is `local/data_root.txt`.

Read shapes from `/mnt/nas/projects/Command HQ/modern/docs/SUCCESSOR_PLAN.md` and `docs/re/RULES.md`. Do not copy guessed formulas from `docs/re/ECONOMY.md` or `docs/re/COMBAT.md`. Do not copy ratings from `extracted/data/resources_oil.json`. Do not invent a CBR-TYPE to byte `0x1102` link. Do not map unit-type nibbles.

## Each fire

Create `/tmp/openchq-polish-iteration` if it is missing, with contents `0`. Read it, add 1, and write the new number back. If that number is greater than 100, report `CAP 100 reached` and the closing status block, then `scheduler_list`, find the task whose prompt contains `OPENCHQ_POLISH_LOOP`, call `scheduler_delete` on that task id, and stop.

Walk the slice list in order. Skip a slice that is already in the game. Name the skip. Stop at the first slice that still needs work. Implement only that slice. Prove it. Stop. Do not start the next slice in the same fire.

On the slice you implement, extend `scripts/play_once.gd` so the harness plays the new step by clicking, the way a player would. Keep every earlier play step passing. A function assertion is not enough. Then run both checks.

Headless must print `CHECK_OK`:

```
godot --headless --path "/mnt/nas/projects/OpenCHQ" --script res://scripts/check_rules.gd
```

Play must print `PLAY_OK`:

```
timeout 180 xvfb-run -s "-screen 0 2200x1200x24" godot --display-driver x11 --path "/mnt/nas/projects/OpenCHQ" --script res://scripts/play_once.gd
```

If play exits because the 180 second timer fired and there is no `FAIL` line, shorten only the waits this slice added and run play once more. If it still does not print `PLAY_OK`, stop. That is a red check.

If a check fails, report the failing line, then `scheduler_delete` the `OPENCHQ_POLISH_LOOP` task, and stop. Do not start another slice on a red check.

When every slice is in the game and both checks pass, report the closing status block, delete that task, and stop.

If work remains and both checks passed, report one line and stop. That line contains: iteration N/100, the slice number just finished or skipped and why, `CHECK_OK`, `PLAY_OK`, and the next slice number.

The closing status block contains: slices done; slices skipped and why; files changed; `CHECK_OK` or the failing line; `PLAY_OK` or the failing line.

## Already in the game

Do not redo these, and do not weaken their results:

- Era and side, then buy, then Begin. Time starts held. Run, Pause, and Resume. Keys T and P. The HUD shows Turn N. Hold every capital.
- A second land piece at Norfolk can hold Washington while the first marches to Moscow. The ungarrisoned rule check still ends with the pieces meeting short of one cell and Red holding both capitals.
- 2023 starts with no army. The stand-in cash pool is 40 billion and is displayed. Cities and oil use the stand-in shuffle. Capitals stay listed. Another era restores the listed layout. The 2023 note has no `$`.
- Concealed era: map cities are city-states. Capitals and facilities keep the file owner. The opponent stays hidden until their capital is found. Finding that capital shows them.
- A land piece already on water, ordered to water, forms a transport and follows the existing sea lanes. A land-to-land order stays on the land route.
- Intel in 1986 and 2023 reveals every unit and tells the opponent. The intel note must not contain the word `radius`. Other eras refuse intel.
- During a match a unit can be placed. That city becomes unready. No wait is stored. A purchase before Begin does not tire the city.
- Only infantry can entrench. The bonus stays blank. A move order clears entrench.
- Stills open as a catalog in extracted file order. `PLAYBACK_KNOWN` stays false. Next frame advances in that file order. The note says this is an assumption.
- The facility at (18, 18) is terrain id 15, center only, chip `facility · open`. Picture cells stay ids 1, 4, and 6. Painted counts stay 2 capitals, 150 docks, 407 city cells.
- A menu pick releases focus so the shortcut keys work.
- Sight is Chebyshev 8 with x wrapping. Own pieces stay visible. A still submarine stays hidden inside that range. Intel sets `revealed` and the piece shows. Do not raise `SIGHT_CELLS` in this loop.
- Oil reserve starts at 10000 and burns 1 in oil eras when the ordered side is not on an oil cell. Zero sets `oil_short`. Standing on oil refills and clears the flag. A manually set `oil_short` stays set unless that refill happens. 1918 and 1942 ignore the flag. The oil card still says `Rate unknown`. Do not lower `OIL_RESERVE` in this loop. The ungarrisoned march ticks far enough that a smaller reserve would stop it.
- Speeds 0 through 6 share the one existing tick. Speed 0 holds time and still accepts orders.

The long HUD rules string stays as it is. It must still contain `shallows are slower` and `ratio was not recovered`. It must not contain `Command HQ`, `production`, `$`, `beats`, or `one extra`. New player text obeys the same ban. `billion` may appear in a cash line. Do not put `$` in any note.

Booklet counts that are already stored stay counts of rounds or events: air mission inactive 8 rounds; scramble 4 rounds; bombing an empty site locks building 5 rounds; after three nukes fired or three absorbed without reply, further launches stop.

## How stand-ins are allowed

This loop may add labeled stand-ins for the slices below. Each constant lives in `scripts/assumptions.gd`. A comment on the constant says it was not recovered. Player-facing text that depends on one says `Stand-in` in the sentence the player reads, or the control is a gauge of that constant.

When a slice changes a sentence that `check_rules.gd` or `play_once.gd` already requires, update that assertion in the same slice. Leave `game.note` exact for any check you do not retarget. Prefer a separate `player_note` for new wording, and point the HUD at `player_note` when it is non-empty.

`R` stays an immediate reset. The play harness presses `R` throughout. A confirm belongs on the pause-menu Restart, not on `R`.

## Slices

1. Player voice. Add `player_note`. The HUD and the map stamp show it when it is non-empty, and show `game.note` otherwise. The oil-shortage player line is `Stand-in shortage. Movement is stopped.` The fight player line, when the old note contains `Damage amount unknown`, is `Stand-in fight. The shot has no damage yet.` `game.note` stays the old sentence so existing checks keep passing. Play reads the new line on the HUD after the existing oil click has tripped the shortage.

2. Fights can remove a piece. Add `HITS` in `assumptions.gd`, starting at 4. A shot is still every other round. After that many shots in one continuous fight, the defender is removed and the player line says `Stand-in fight. The defender is gone.` Pieces still cannot stop on the same cell. Read the ungarrisoned Washington–Moscow check before tuning `HITS`. That check must still end with the pieces meeting short of one cell and Red holding both capitals. If 4 would remove a piece during that march, raise `HITS` until the march passes, and record the value you kept. Prove removal with a separate pair of pieces placed next to each other, ticked only for that proof. Play clicks into that small fight, waits until the defender is gone, and reads the player line.

3. The other side acts. Keep the empty-capital march: if the player's capital has no friendly land piece, the enemy land piece still marches on it, and the Norfolk garrison win still holds. When the enemy ship has an empty path, give it one sea order toward a dock beside the player's capital, once per time it is idle. Do not repath it every tick. When the enemy capital has no enemy land piece and the player is not already on it, a free enemy land piece can march back to it. Play starts a running match and sees the enemy ship take a path. The ungarrisoned result stays Red holding both capitals.

4. Contact memory. When an enemy piece is shown and then leaves sight, remember the cell and show a fading marker for 8 rounds. Then drop it. `SIGHT_CELLS` stays 8. A still submarine that was never shown leaves no marker. Play brings Red beside Blue, moves Red far away, sees the marker, ticks 8 rounds, and sees it gone.

5. Follow the selection. A Follow control keeps the camera on the selected friendly piece while time runs. Play turns it on, presses `T`, and after the piece moves the view still contains it. Fit still frames the whole map and clears follow.

6. Held is obvious. At a held clock the map shows `Held` and the Run control is the labeled next step. After `T` the stamp says `Running`. Play reads both. The turn chip can stay.

7. First-match coach. Three lines: select your piece, click a destination, press Run. The panel does not block map clicks. Dismiss hides it for the rest of the match. Play reads the three lines, dismisses the panel, and the later clicks still land.

8. Era cards. On the start screen, the selected era shows one sentence. 1918 is infantry and ships. 1942 adds tanks and planes. 1986 adds oil, nukes, satellites, aid, and intel. 2023 is the 1986 tools with no army, the stand-in pool, and the stand-in shuffle. The concealed start hides the opponent until their capital is found. No `$`. Play opens the start screen and reads the 1986 sentence and the concealed sentence.

9. Pause menu. Esc opens Resume, Restart, and Quit to the era screen. Restart asks, then does what `R` does. Quit returns to the era screen. The HUD era menu no longer rewrites a live match. Move era choice, Stills, and the speed menu into the pause menu, and retarget every play step that used them so those steps still pass. A menu pick still releases focus. `R` stays immediate.

10. Era tools. The command bar shows Buy, Entrench, and the tools the current era actually has. 1918 and 1942 hide nuke, satellites, foreign aid, intel, cease-fire, and oil. 1986 and 2023 show them. The concealed start shows oil and hides the 1986 tools it already refuses. Play checks that Intel is visible in 1986 and absent in 1918, and that oil is hidden in 1918.

11. Speed words. The pause-menu speed control shows Held, Slow, Normal, and Fast for indexes 0, 1, 3, and 6. They still share the one tick. The board string stays. Update the checks that required the digits `0` through `6` as item text. Play selects Fast and returns to Held.

12. Unit list and selected card. List every friendly piece with type and state: moving, digging, repairing, inactive, idle. Clicking a row selects that piece and frames it. The card shows name, terrain, destination, and steps left on the path. Play buys a second land piece and selects it from the list.

13. Route quote and cancel. The hover path shows `N steps` and names slower ground when the path uses it. Cancel clears the selected piece's path. Play orders a move, reads the step count, cancels, and sees an empty path. The quote does not invent a time ratio.

14. Minimap. Draw both capitals, friendly pieces, and contact markers. Clicking the enemy capital centers the map there. Play clicks it and sees Moscow in view. Labels and wrap stay as they are.

15. Spend the pool. Add stand-in prices in `assumptions.gd`: infantry 1 billion, tank twice that, ship 2, submarine 2, aircraft 2, nuke 10. Give 1918, 1942, and 1986 a pool large enough that every purchase the current checks already make still succeeds. Keep the nuke above that pool so 1986 still returns `Not enough money.` 2023 keeps spending from its pool. If 40 is too small for a 2023 purchase the suite already makes, raise `CASH_2023` and update the `40 billion` assertions in the same slice. A match purchase lowers the pool and still tires the city. A short pool refuses the buy. The price line the player reads says `Stand-in` and contains no `$`. Play buys one infantry during a match and reads the lower pool.

16. Oil gauge. In an oil era the HUD shows the reserve and `Short` when the flag is on. Do not change `OIL_RESERVE` or `OIL_BURN`. The oil card still says `Rate unknown`. Play sets the reserve to 1, presses `T`, and reads `Short` on the gauge.

17. 2023 ground matches the shuffle. After the 2023 shuffle, and after a non-2023 restore, repaint site centers. Run the full neighbor paint only when the counts stay 2 capitals, 150 docks, and 407 city cells. If a moved city would change those counts, paint centers only and say so in the report. Play reads the terrain chip on one shuffled city and sees `city`.

18. Aircraft badge. A selected aircraft shows `Inactive` and the rounds left after a mission or a scramble. Play sends one land strike and reads `Inactive` and `8`. The 8 and the 4 stay the booklet counts.

19. Tool feedback, with the old effects. Intel draws a one-shot pulse and still reveals every unit. The intel note still has no `radius`. Foreign aid flashes the city whose owner changed. A nuke flashes the target cell and still paints no wasteland, flips no city, and deals no damage. A satellite draws an icon and still does not fall. Cease-fire yes shows `Cease fire accepted` and still does not change movement, damage, or income. Play clicks Intel and sees the pulse. One tool is enough for the play step if the headless check covers the other four.

20. Toasts. Show a short toast for contact, a city taken, oil short, a capital threatened, and a defender removed. The log still keeps the history. The toast does not replace `player_note`. Play takes a city and reads the toast.

21. Sounds. Play a short tone for an accepted order, a refused click, contact, a city taken, oil short, win, and loss. If no audio device is present, the call does nothing and the process still exits 0. Play accepts one order and the headless check constructs the players without quitting.

22. End screen. A win or a loss shows the side, the turn count, and the capital owners, plus Rematch. Rematch opens buy for the same era and side. Play wins with the Norfolk garrison, reads the turn count, and presses Rematch. The existing winner shot still saves.

23. Save and load. Save the match to `user://openchq-save.json` and load it back. Store era, side, turn, pieces, owners, and the stand-in pools. `R` still resets immediately and does not load. Play saves, presses `R`, loads, and sees the saved piece back. Quit from the pause menu does not delete the file.

## Not a slice

Hotseat waits. Do not add it in this loop.

## Done

When slice 23 is in the game and both checks pass, delete the `OPENCHQ_POLISH_LOOP` task and stop.
