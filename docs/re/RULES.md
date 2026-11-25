# RULES.md — the difficulty table as shipped (T-032 Part D / PB-258)

One row per computer level. Two paths ship and they are separate on purpose:

- **FAITHFUL** is what the original does: the pass allowance is the constant three (`FUN_107e_0bd6`,
  decompiled.c 1126-1268, docs/re/AI.md 1a), and `0xe94c = level*2 - 4` (0/2/4/6 at levels 2-5) is the
  army-repeat counter seeded once per game at new-game setup.
- **PORT LEVER** is the deliberate deviation (Shane option B, PM room 9405; approved 9408 §2). It adds
  `bot.portLevelLever[level]` fileable actions a turn on top of the decoded three, in
  `web/server/bot.mjs`. It changes how many times the bot asks the faithful code for an action; it does
  not change what an action does, and it reads no price, income, strength, sight or fog value.

| Level | Opponent | Faithful pass | 0xe94c repeats/game | Port lever (+actions/turn) | Effective pass |
|---|---|---|---|---|---|
| 1 | SGT. STAN STIL | does not act (gate `1 < 0x1a0`) | never set | 0 | does not act |
| 2 | CAP. LUKE WARM | 3 | 0 | 0 | 3 |
| 3 | COL. BUCK ZEAL | 3 | 2 | 1 | 4 |
| 4 | GEN. WIN MOORE | 3 | 4 | 2 | 5 |
| 5 | MARS GOD OF WAR | 3 | 6 | 3 | 6 |

The lobby labels name the lever for levels 3-5 ("… extra actions a turn (beyond the original)"). The
faithful 2/4/6 repeat allowance is served separately in `/api/setup` (`bot.spareActions`) and in the
lobby's level note (`bot.portLeverHelp`), not in the label — PM 9408 §2.

`bot.portLevers: false` disables the lever entirely: `portLeverFor` returns 0 at every level, the
budget is `spareActionPassCap()`, and the executed path is the faithful one (D1; the row-for-row
comparison against 2423ae6 lives in `web/test/nodes/t032_port_lever.mjs` and the PB-257 harness run).

The census (`tools/t032-repeat-census.mjs`) prints `capFaithful` and `capEffective` side by side, and
`web/server/rules.mjs` keeps reporting the faithful cap so a tool that quotes `dispatchRepeatLimit`
never silently reports the levers' number.
