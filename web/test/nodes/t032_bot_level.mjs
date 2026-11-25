// T-032 Part B: opponents, the level gate and the spare-action budget.
// Owner: game.
//
// What breaks if this file is removed: B1-B3 and B6 go back to being prose. The lobby could stop
// listing MARS, level 1 could start acting, and the e94c budget could drift to a per-level story
// that the bytes do not tell.
//
// B1: five opponents in DS:0x4fea order, ANOTHER HUMAN = 0, level 1 labelled "Stands still:
// practice". B2: level 1 never enters the AI pass, so 50 rounds of orders and buys are empty.
// B3: e94c = level*2-4 (never set at level 1, so 0/2/4/6 at levels 2-5) is the ARMY pass's repeat
// counter (ai_turn_process 3410-3416) and the buy spends it (1649-1651); 0bd6 allows THREE
// successful actions a pass at every level (1126-1268, nine `local_c < 3` reads) plus the combat-4
// tail, and reads the counter nowhere. B7: the buy path calls the free-slot check (1629).
// B6: the starting-money spinner is independent of the level and exists for 2023 too.

import { openMatch } from "../../server/match.mjs";
import { tickMatch } from "../../server/tick.mjs";
import { UNIT_RECORDS, effectivePassCap, marchOne, ordersFor, spendRepeat } from "../../server/bot.mjs";
import { readFileSync } from "node:fs";
import {
  botDeviations,
  botStandIns,
  defaultOpponentLevel,
  dispatchRepeatLimit,
  dispatchRepeatPool,
  handicapDefault,
  opponentLevels,
  opponents,
  spareActionBudget,
  spareActionPassCap,
} from "../../server/rules.mjs";

export const name = "t032_bot_level";

const EXPECTED = [
  [1, "SGT. STAN STIL"],
  [2, "CAP. LUKE WARM"],
  [3, "COL. BUCK ZEAL"],
  [4, "GEN. WIN MOORE"],
  [5, "MARS GOD OF WAR"],
];

function piece(id, side, x, y, extra = {}) {
  return {
    id, side, domain: "land", kind: "infantry", x, y, path: [], pace: 1,
    strength: 100, maxStrength: 100, ...extra,
  };
}

// Three of our cities, each with a hostile pair beside it. The spare blue units sit 25 cells out:
// outside the 20-cell own-site threat radius (so they do not make the site look safe) but inside
// the 50-cell dispatch reach, which is what makes them eligible to send. No board extract is
// needed: the defence routine issues the order through move.planOrder, which works on the
// coordinates alone, and the fixture is the same on every host.
function budgetRoom(level, sparePerSite = 8) {
  const sites = [1, 2, 3].map((n) => ({ id: "s" + n, name: "S" + n, kind: "city", owner: "blue", x: 20 + n * 20, y: 40 }));
  const match = {
    era: "1942",
    round: 1,
    pieces: [],
    sites,
    capitals: { blue: { x: 20, y: 40 }, red: { x: 200, y: 40 } },
    capitalSet: { list: sites.map((site) => ({ siteId: site.id, name: site.name })) },
    // Cash 0 keeps botBuy out of the count so the numbers below are the defence pass alone.
    sides: { blue: { cash: 0, bought: 99 }, red: { cash: 0, bought: 99 } },
    seats: { blue: { kind: "bot" }, red: { kind: "human" } },
    opponentLevel: level,
  };
  for (const site of sites) {
    match.pieces.push(piece("red" + site.id + "a", "red", site.x + 1, site.y),
      piece("red" + site.id + "b", "red", site.x, site.y + 1));
    for (let k = 0; k < sparePerSite; k++) {
      match.pieces.push(piece("blue" + site.id + ":" + k, "blue", site.x - 4 + k, site.y + 25));
    }
  }
  return match;
}

// One blue land piece south of the red capital. The approach ring is the same on every run, so a
// cell recorded by one dispatch can be checked against the next dispatch's choice.
function marchRoom() {
  return {
    era: "1942",
    round: 1,
    pieces: [piece("blue1", "blue", 100, 30)],
    sites: [],
    capitals: { blue: { x: 20, y: 40 }, red: { x: 100, y: 40 } },
    capitalSet: { list: [] },
    sides: { blue: { cash: 0, bought: 0 }, red: { cash: 0, bought: 0 } },
    seats: { blue: { kind: "bot" }, red: { kind: "human" } },
    opponentLevel: 3,
  };
}

// One pass action is a buy OR one dispatch to a site OR one army dispatch: 1216-1218 enters the
// army pass with `3 - local_c` and adds what it issues back into the same counter, so a march order
// is a pass action like any other. This counted only buys and distinct defend sites, which is why
// no arm here could see a march order before the B3 re-cut.
function countActions(events) {
  const buys = events.filter((event) => event.type === "bot_buy").length;
  const sites = new Set(events.filter((event) => event.type === "bot_defend").map((event) => event.site));
  const marches = events.filter((event) => event.type === "bot_order").length;
  return buys + sites.size + marches;
}

function countDefend(events) {
  return events.filter((event) => event.type === "bot_defend").length;
}

export async function run(ctx) {
  const { fail } = ctx;
  const say = (what, actual) => fail(what + ": " + JSON.stringify(actual));

  // ---- B1. the five, in the order the original's setup printed them --------------------------
  {
    const rows = opponents();
    if (rows.length !== 6) say("the opponent table is not ANOTHER HUMAN + five computers", rows.map((row) => [row.level, row.name]));
    if (rows[0].level !== 0 || rows[0].name !== "ANOTHER HUMAN") say("entry zero is not ANOTHER HUMAN", rows[0]);
    const levels = opponentLevels();
    const wantedLevels = EXPECTED.map(([level]) => level);
    if (JSON.stringify(levels) !== JSON.stringify(wantedLevels)) say("the computer levels are not 1..5 in order", levels);
    for (const [index, [level, expected]] of EXPECTED.entries()) {
      const row = rows[index + 1];
      if (row.level !== level || row.name !== expected) {
        say("opponent " + level + " is not " + expected + " in DS:0x4fea order", row);
      }
    }
    if (rows[1].label !== "Stands still: practice") say("level 1 is not labelled 'Stands still: practice'", rows[1].label);
    if (defaultOpponentLevel() !== 3) say("the lobby default is not the declared level 3", defaultOpponentLevel());

    // The served table is the one the page builds its select from, so it has to carry the same five.
    const response = await fetch(ctx.base + "/api/setup", { cache: "no-store" });
    if (!response.ok) say("/api/setup did not answer", response.status);
    const setup = await response.json();
    const served = setup.bot && Array.isArray(setup.bot.opponents) ? setup.bot.opponents : [];
    if (served.length !== 6) say("/api/setup does not serve all six lobby entries", served);
    for (const [index, [level, expected]] of EXPECTED.entries()) {
      const row = served[index + 1];
      if (!row || row.level !== level || row.name !== expected) say("/api/setup order drifted at level " + level, row);
    }
    if (served[1].label !== "Stands still: practice") say("/api/setup lost the level-1 label", served[1]);
    const spare = (setup.bot && setup.bot.spareActions) || {};
    for (const [level, budget] of [[2, 0], [3, 2], [4, 4], [5, 6]]) {
      if (Number(spare[level]) !== budget) say("/api/setup spareActions[" + level + "] is not " + budget, spare);
    }
  }

  // ---- B3. 0xe94c is the ARMY pass's repeat counter; 0bd6 is a constant three ----------------
  //
  // Decoded here: the counter's values (never set at level 1, 0/2/4/6 at 2-5), the constant three
  // plus the combat-4 tail in 0bd6, and what one step of 3410-3416 does on each branch. The reach
  // of the counter into the army pass is the port's mapping of that step, and the events carry
  // `repeat` / `recorded` so a leg can count the two apart.
  {
    const budgets = [1, 2, 3, 4, 5].map((level) => spareActionBudget(level));
    if (JSON.stringify(budgets) !== JSON.stringify([0, 0, 2, 4, 6])) {
      say("the e94c counter is not 0 at levels 1-2 and 0/2/4/6 at levels 2-5", budgets);
    }
    if (spareActionPassCap() !== 3) say("the 0bd6 pass cap is not three", spareActionPassCap());
    // The reachable form, not the raw pool: 1 + e94c is 1/3/5/7, but the army pass is handed
    // `3 - local_c` (1216-1218) and every dispatch goes back into that counter, so a cell cannot
    // take more than `min(1 + e94c, 3 - spent)` dispatches in one turn.
    const limits = [2, 3, 4, 5].map((level) => dispatchRepeatLimit(level));
    if (JSON.stringify(limits) !== JSON.stringify([1, 3, 3, 3])) {
      say("the reachable same-cell limits with nothing spent are not 1/3/3/3", limits);
    }
    const afterOne = [2, 3, 4, 5].map((level) => dispatchRepeatLimit(level, 1));
    if (JSON.stringify(afterOne) !== JSON.stringify([1, 2, 2, 2])) {
      say("one spent action did not cap the same-cell limit at 2", afterOne);
    }
    const afterTwo = [2, 3, 4, 5].map((level) => dispatchRepeatLimit(level, 2));
    if (JSON.stringify(afterTwo) !== JSON.stringify([1, 1, 1, 1])) {
      say("two spent actions did not cap the same-cell limit at 1", afterTwo);
    }

    // The defence pass does not carry the level in the ORIGINAL: three actions, one unit each, at
    // every level. PB-258 adds the port-only lever (PB-258 / T-032 Part D, Shane option B), so the
    // shipped bound is the faithful three plus the lever table; the faithful-three arm with the
    // flag off is pinned in t032_port_lever (D1), not re-implemented here.
    for (const level of [2, 3, 4, 5]) {
      const match = budgetRoom(level);
      const events = ordersFor(match, "blue");
      const actions = countActions(events);
      const cap = effectivePassCap(level);
      if (actions > cap) say("level " + level + " spent " + actions + " pass actions, over the effective cap " + cap, events);
      if (actions < spareActionPassCap()) say("level " + level + " spent only " + actions + " pass actions, under the faithful 3", events);
      const sent = countDefend(events);
      if (sent > cap) say("level " + level + " sent " + sent + " defenders, over the effective cap", events);
    }

    // Both branches of 3410-3416. A repeat spends the counter and leaves the cell eligible; the step
    // that finds the counter empty records the cell.
    {
      const cell = { x: 21, y: 41 };
      const key = "21,41";
      const state = { pool: dispatchRepeatPool(5), recorded: new Set() };
      for (let n = 1; n <= 6; n++) {
        const step = spendRepeat(state, cell);
        if (!step.repeat || step.recorded) say("repeat " + n + " at level 5 did not spend the counter", step);
        if (state.recorded.has(key)) say("a repeat recorded the cell, so it could not be picked again", [...state.recorded]);
      }
      if (state.pool !== 0) say("level 5's six repeats did not drain the counter", state.pool);
      const last = spendRepeat(state, cell);
      if (last.repeat || !last.recorded || !state.recorded.has(key)) {
        say("the dispatch after the counter ran out did not record the cell", last);
      }
      const empty = { pool: 0, recorded: new Set() };
      const first = spendRepeat(empty, cell);
      if (first.repeat || !empty.recorded.has(key)) say("a zero counter did not record its first cell", first);
      // The buy spends a repeat too, and records nothing (1649-1651).
      const buyState = { pool: 2, recorded: new Set() };
      spendRepeat(buyState);
      if (buyState.pool !== 1 || buyState.recorded.size !== 0) say("the buy did not spend one repeat", buyState);
    }

    // Through the march, which is the routine the counter lives in: with a repeat left the second
    // dispatch takes the same cell; with the counter at zero the first dispatch records the cell and
    // the second must take a different one.
    for (const [level, sameCell] of [[5, true], [2, false]]) {
      const match = marchRoom();
      const army = match.pieces.find((unit) => unit.side === "blue");
      const capital = { x: 100, y: 40 };
      const state = { pool: dispatchRepeatPool(level), recorded: new Set() };
      const firstTo = marchOne(match, "blue", army, capital, [], { skip: state.recorded });
      if (!firstTo) say("level " + level + ": the army did not march at all", match.pieces.length);
      const step = spendRepeat(state, firstTo);
      if (level === 2 && !step.recorded) say("level 2's first dispatch did not record its cell", step);
      if (level === 5 && step.recorded) say("level 5's first dispatch recorded its cell", step);
      army.path = [];
      const secondTo = marchOne(match, "blue", army, capital, [], { skip: state.recorded });
      const same = secondTo && secondTo.x === firstTo.x && secondTo.y === firstTo.y;
      if (sameCell && !same) say("level " + level + " refused a cell it had not recorded", { firstTo, secondTo });
      if (!sameCell && same) say("level " + level + " re-picked a cell it had recorded", { firstTo, secondTo });
    }
  }

  // ---- B3 (re-cut). The army pass is bounded by what the pass had left ------------------------
  //
  // 1216-1218 calls the army pass only while `local_c < 3` and hands it `3 - local_c`; 1218 adds the
  // dispatches back into the same counter. Before this re-cut the port's loop walked every idle
  // piece: measured at 76d3b8a, 9/11/13/14 land orders in the opening turn at levels 2-5, against a
  // pass that allows three actions in total. The same 40-round campaign is now capped at three,
  // and the control (a fixture with actions already spent) at three minus those actions.
  {
    const cap = spareActionPassCap();
    for (const level of [2, 3, 4, 5]) {
      // PB-258: the budget this build actually hands the passes is the faithful three plus the
      // port lever. With bot.portLevers false levelCap IS cap; the lever arm is t032_port_lever.
      const levelCap = effectivePassCap(level);
      const match = openMatch("1942");
      match.seats = { blue: { username: "Bot", kind: "bot" }, red: { username: "Ada", kind: "human" } };
      match.opponentLevel = level;
      match.clock = "running";
      let worstMarch = 0;
      const over = [];
      let turns = 0;
      for (let round = 1; round <= 40; round++) {
        const events = ordersFor(match, "blue") || [];
        const buys = events.filter((event) => event.type === "bot_buy").length;
        const defends = events.filter((event) => event.type === "bot_defend").length;
        const marches = events.filter((event) => event.type === "bot_order").length;
        const room = Math.max(0, levelCap - (buys + defends));
        turns += 1;
        if (marches > room) over.push({ round, marches, buys, defends, room, levelCap });
        if (marches > worstMarch) worstMarch = marches;
        tickMatch(match);
        if (match.over) break;
      }
      if (over.length) {
        say("level " + level + " issued army dispatches past the pass budget on " + over.length + " of " + turns + " turns", over.slice(0, 3));
      }
      // The busiest turn must reach the cap, not merely stay under it: the opening board has more
      // idle land pieces than three, so a worst turn below three means the bound is not exercised.
      if (worstMarch !== levelCap) say("level " + level + "'s busiest turn issued " + worstMarch + " army dispatches, not the effective cap of " + levelCap, worstMarch);
    }

    // A turn that has already bought and defended: the army gets the remainder, not a fresh three.
    const spentMatch = budgetRoom(3);
    spentMatch.sides.blue.cash = 1e6;
    const spentEvents = ordersFor(spentMatch, "blue") || [];
    const spentBuys = spentEvents.filter((event) => event.type === "bot_buy").length;
    const spentDefends = spentEvents.filter((event) => event.type === "bot_defend").length;
    const spentMarches = spentEvents.filter((event) => event.type === "bot_order").length;
    if (spentBuys !== 1) say("the spent-turn control did not buy once", spentBuys);
    if (spentDefends !== 2) say("the spent-turn control defended " + spentDefends + " sites, not the two the buy left", spentDefends);
    if (spentMarches !== 0) say("the spent-turn control still marched " + spentMarches + " pieces with no pass action left", spentMarches);
    if (countActions(spentEvents) !== cap) say("the spent-turn control counted " + countActions(spentEvents) + " actions, not " + cap, spentEvents.length);
  }

  // ---- B3 (the pool carries). 0xe94c is seeded once per game, not once per turn ---------------
  //
  // Read from the 547f99f9 export: the setter at 13232 sits in FUN_20b1_01b6, the new-game setup
  // routine, whose ONLY caller is main_game_loop line 23; the turn loop that routine hands off to is
  // FUN_1000_01da(7) (26-28), which never writes 0xe94c. The second setter line, 15158, is the same
  // routine decompiled a second time inside the jump-table blob Ghidra labels 20b1:2eea (warnings
  // 15015-15048, call arguments dropped) - one setter seen twice, not a second event. Nothing else
  // writes the byte (seven references total: 1649, 1650, 3410, 3415, 3438, 13232, 15158), so the
  // pool is match-long and the per-turn reset this port used was a stand-in, now retired.
  {
    const spent = {};
    for (const level of [1, 2, 3, 4, 5]) {
      const match = openMatch("1942");
      match.seats = { blue: { username: "Bot", kind: "bot" }, red: { username: "Ada", kind: "human" } };
      match.opponentLevel = level;
      match.clock = "running";
      const seed = dispatchRepeatPool(level);
      if (JSON.stringify([0, 0, 2, 4, 6][level - 1]) !== JSON.stringify(seed)) {
        say("level " + level + " seeds 0xe94c at " + seed + ", not the byte's 2*level-4", seed);
      }
      let lastPool = null;
      let repeats = 0;
      let buys = 0;
      let maxRepeatTurn = 0;
      let maxSameCell = 0;
      for (let round = 1; round <= 40; round++) {
        if (lastPool !== null && match.botRepeatPool.blue > lastPool) {
          say("level " + level + " refilled 0xe94c on round " + round, { before: lastPool, now: match.botRepeatPool.blue });
        }
        const events = ordersFor(match, "blue") || [];
        if (lastPool === null && (!match.botRepeatPool || match.botRepeatPool.blue > seed)) {
          say("level " + level + " seeded 0xe94c above the byte's " + seed + " on its first turn", match.botRepeatPool);
        }
        const orders = events.filter((event) => event.type === "bot_order");
        const turnRepeats = orders.filter((event) => event.repeat === true).length;
        const turnBuys = events.filter((event) => event.type === "bot_buy").length;
        const perCell = new Map();
        for (const order of orders) {
          const key = order.to.x + "," + order.to.y;
          perCell.set(key, (perCell.get(key) || 0) + 1);
        }
        for (const count of perCell.values()) {
          if (count - 1 > maxSameCell) maxSameCell = count - 1;
        }
        repeats += turnRepeats;
        buys += turnBuys;
        if (turnRepeats > maxRepeatTurn) maxRepeatTurn = turnRepeats;
        // The carryover, stated as a per-turn identity on the 1942 campaign (it buys nothing there):
        // the pool after the turn is the pool before it minus the repeats the turn spent.
        const before = lastPool === null ? seed : lastPool;
        if (turnBuys === 0 && match.botRepeatPool.blue !== Math.max(0, before - turnRepeats)) {
          say("level " + level + " round " + round + " left " + match.botRepeatPool.blue +
            " in 0xe94c after spending " + turnRepeats + " from " + before, { turnRepeats, before });
        }
        lastPool = match.botRepeatPool.blue;
        tickMatch(match);
        if (match.over) break;
      }
      if (repeats > seed) say("level " + level + " spent " + repeats + " repeats from a pool of " + seed, repeats);
      if (repeats + (lastPool || 0) > seed) {
        say("level " + level + " spent past its seed: " + repeats + " repeats and " + lastPool + " left of " + seed);
      }
      if (maxRepeatTurn > spareActionPassCap()) {
        say("level " + level + " spent " + maxRepeatTurn + " counter units in one turn, past the pass cap", maxRepeatTurn);
      }
      if (maxSameCell > 2) say("level " + level + " put " + maxSameCell + " repeats on one cell in a turn, past two", maxSameCell);
      spent[level] = { seed, repeats, buys, left: lastPool, maxRepeatTurn, maxSameCell };
    }
    // The separation C1 needs is a MATCH column, not a turn column: both 4 and 5 reach the pass cap
    // inside a turn, and only the seed differs (4 vs 6 repeats over the campaign).
    if (!(spent[5].repeats > spent[4].repeats)) {
      say("levels 4 and 5 spent the same repeats over a campaign, so the pool does not separate them", spent);
    }
    if (spent[2].repeats !== 0) say("level 2 spent a repeat from a pool of zero", spent[2]);

    // MUTANT: a per-turn refill must turn this arm red. Re-stamp 0xe94c every round on the same 1942
    // campaign and count: the arm above bounds repeats by the seed, so the refill has to break it.
    // This is the shape frodo's probe measured on the shipped 1487367 (36 spends against a stamp of 2),
    // kept here as a leg so the bound cannot quietly become "whatever the loop does".
    {
      const match = openMatch("1942");
      match.seats = { blue: { username: "Bot", kind: "bot" }, red: { username: "Ada", kind: "human" } };
      match.opponentLevel = 3;
      match.clock = "running";
      const seed = dispatchRepeatPool(3);
      let spends = 0;
      for (let round = 1; round <= 40; round++) {
        match.botRepeatPool = { blue: seed };        // the mutation: a fresh pool every turn
        const events = ordersFor(match, "blue") || [];
        spends += events.filter((event) => event.type === "bot_order" && event.repeat === true).length;
        tickMatch(match);
        if (match.over) break;
      }
      if (spends <= seed) {
        say("the per-turn-refill mutant did not red the campaign bound", { spends, seed });
      }
    }
  }

  // ---- B2. level 1 never enters the AI pass: 50 rounds, no orders, no buys --------------------
  {
    const match = openMatch("1942");
    match.seats = { blue: { username: "Bot", kind: "bot" }, red: { username: "Ada", kind: "human" } };
    match.opponentLevel = 1;
    match.clock = "running";
    let orders = 0;
    let buys = 0;
    let gateNotes = 0;
    for (let round = 1; round <= 50; round++) {
      const events = ordersFor(match, "blue") || [];
      orders += events.filter((event) => event.type === "bot_order" || event.type === "bot_defend").length;
      buys += events.filter((event) => event.type === "bot_buy").length;
      gateNotes += events.filter((event) => event.type === "bot_skip" && /0x1a0/.test(String(event.reason))).length;
      tickMatch(match);
    }
    if (orders !== 0) say("the level-1 opponent issued " + orders + " orders in 50 rounds", orders);
    if (buys !== 0) say("the level-1 opponent bought " + buys + " pieces in 50 rounds", buys);
    if (gateNotes === 0) say("the level-1 room never said why it stood still", gateNotes);

    // The control: the same fixture at the next level does act, so the leg is not measuring an
    // empty board or a broken tick.
    const control = openMatch("1942");
    control.seats = { blue: { username: "Bot", kind: "bot" }, red: { username: "Ada", kind: "human" } };
    control.opponentLevel = 3;
    control.clock = "running";
    let controlOrders = 0;
    for (let round = 1; round <= 50; round++) {
      controlOrders += (ordersFor(control, "blue") || [])
        .filter((event) => event.type === "bot_order" || event.type === "bot_defend").length;
      tickMatch(control);
    }
    if (controlOrders === 0) say("the level-3 control issued no order in 50 rounds, so the pass is not sampling", controlOrders);
  }

  // ---- B6. the spinner is its own control and does not follow the level ----------------------
  {
    const sites = [];
    const low = openMatch("1942", sites, { opponentLevel: 2, handicapSide: "red", opponentPool: 10 });
    const high = openMatch("1942", sites, { opponentLevel: 5, handicapSide: "red", opponentPool: 10 });
    const richer = openMatch("1942", sites, { opponentLevel: 5, handicapSide: "red", opponentPool: 30 });
    if (!Number.isFinite(low.sides.red.cash)) fail("the level-2 opponent has no cash pool");
    if (low.sides.red.cash !== high.sides.red.cash) {
      say("changing the level changed the opponent's starting money", { l2: low.sides.red.cash, l5: high.sides.red.cash });
    }
    if (!(richer.sides.red.cash > high.sides.red.cash)) {
      say("the spinner no longer moves the opponent's pool", { spinner10: high.sides.red.cash, spinner30: richer.sides.red.cash });
    }
    if (high.sides.blue.cash !== low.sides.blue.cash) say("the player's own pool followed the opponent's spinner", { l2: low.sides.blue.cash, l5: high.sides.blue.cash });

    // B6/2023: Manual p.17 applies to all scenarios, so 2023 carries the spinner too. Its default
    // is a labelled STAND-IN at the era's own 600b pool, and the control moves the OPPONENT only.
    const default2023 = handicapDefault("2023");
    if (default2023 !== 600) say("2023's spinner default is not the 600b stand-in", default2023);
    const plain2023 = openMatch("2023", sites, { opponentLevel: 3, handicapSide: "red" });
    if (plain2023.sides.red.cash !== 600 * 1000) say("2023's opponent does not open on the spinner default", plain2023.sides.red.cash);
    const poor2023 = openMatch("2023", sites, { opponentLevel: 3, handicapSide: "red", opponentPool: 300 });
    if (poor2023.sides.red.cash !== 300 * 1000) say("2023's spinner does not move the opponent's pool", poor2023.sides.red.cash);
    if (poor2023.sides.blue.cash !== plain2023.sides.blue.cash) {
      say("2023's spinner moved the player's pool", { plain: plain2023.sides.blue.cash, poor: poor2023.sides.blue.cash });
    }
    // The served table is what the lobby page reads; 2023 must carry a value there, not null.
    const served = await (await fetch(ctx.base + "/api/setup", { cache: "no-store" })).json();
    const served2023 = served.handicap && served.handicap.defaults ? served.handicap.defaults["2023"] : undefined;
    if (Number(served2023) !== 600) say("/api/setup does not serve 2023's spinner default", served2023);
  }

  // ---- B7/B8. the card's deviations and STAND-INs are in config and not only in prose --------
  {
    const deviations = botDeviations();
    // B7: AC5 allows only the e94c lever (the level-5 garrison gate was refused by 0x10ae and is
    // gone), so there is NO production cap at
    // all - not a small one and not one raised out of the way. The config row is gone, the code
    // reads no cap, and no deviation claims one.
    const config = JSON.parse(readFileSync(new URL("../../../config/game.json", import.meta.url), "utf8"));
    if (config.bot.unitCap !== undefined) say("a unit cap is back in config", config.bot.unitCap);
    if (deviations.some((line) => /unitCap/i.test(line))) say("a unit cap is back in the deviation list", deviations);
    const botSource = readFileSync(new URL("../../server/bot.mjs", import.meta.url), "utf8");
    if (/BOT_UNIT_CAP|botUnitCap|seat\.bought\s*\|\|/.test(botSource)) say("bot.mjs still enforces a production cap");
    if (!deviations.some((line) => /defaultLevel/i.test(line))) say("the default level is missing from the deviation list", deviations);
    const standIns = botStandIns();
    for (const token of ["ownership counters", "staging arrays"]) {
      if (!standIns.some((line) => String(line).toLowerCase().includes(token))) say("A7 STAND-IN missing: " + token, standIns);
    }
    // 0x10ae is a once-per-round countdown, not a garrison latch (PM ruling, room 9370), so the
    // level-5 garrison-buy gate is REFUSED, not marked: it is gone from config, rules and bot, and
    // the A7 list no longer carries it. These are greps because a reinstated key or call must red.
    if (standIns.some((line) => /garrison/i.test(String(line)))) say("a garrison STAND-IN is back in config", standIns);
    if (config.bot.levelFiveGarrisonGate !== undefined) say("a level-5 garrison gate is back in config", config.bot.levelFiveGarrisonGate);
    const rulesSource = readFileSync(new URL("../../server/rules.mjs", import.meta.url), "utf8");
    if (/levelFiveGarrisonGate|siteHasGarrison/.test(rulesSource)) say("rules.mjs still names the level-5 garrison gate");
    if (/levelFiveGarrisonGate|siteHasGarrison/.test(botSource)) say("bot.mjs still carries the level-5 garrison gate");

    // And the removal is behaviour, not only deleted text: level 5, a threatened site that already
    // holds our own dug-in piece, cash in hand - the buy still happens. The retired gate refused
    // exactly this turn, so a reinstated gate reds here without reading any source string.
    const garrisoned = budgetRoom(5);
    garrisoned.sides.blue.cash = 1e6;
    for (const site of garrisoned.sites) {
      garrisoned.pieces.push(piece("hold:" + site.id, "blue", site.x, site.y, { entrenched: true }));
    }
    const heldEvents = ordersFor(garrisoned, "blue") || [];
    if (!heldEvents.some((event) => event.type === "bot_buy")) {
      say("level 5 refused a buy at a garrisoned threatened site, so the 0x10ae gate is still live",
        heldEvents.filter((event) => event.type === "bot_skip"));
    }
  }

  // ---- B7. the buy path calls the free-slot check, and a full table refuses (1629) -------------
  {
    const full = budgetRoom(3, 0);
    full.sides.blue.cash = 1e6;
    while (full.pieces.length < UNIT_RECORDS) {
      full.pieces.push(piece("filler" + full.pieces.length, "blue", 10 + (full.pieces.length % 40),
        60 + Math.floor(full.pieces.length / 40)));
    }
    const events = ordersFor(full, "blue") || [];
    if (events.some((event) => event.type === "bot_buy")) say("a full unit table still bought a piece", events.length);
    const refused = events.filter((event) => event.type === "bot_skip" && /free unit (slot|record)/.test(String(event.reason)));
    if (refused.length !== 2) {
      say("the free-slot gates did not both report: expected the 1629 buy note and the 3385 dispatch note, saw " + refused.length,
        events.filter((event) => event.type === "bot_skip"));
    }
    if (!refused.some((event) => /1629/.test(String(event.reason)))) say("the buy did not refuse at 1629", refused);
    if (!refused.some((event) => /3385/.test(String(event.reason)))) say("the army pass did not return at 3385", refused);
    if (events.some((event) => event.type === "bot_order")) say("a full table still dispatched");

    // The control: the same fixture with a slot free does buy, so the leg is not measuring a board
    // that refuses for some other reason.
    const room = budgetRoom(3, 0);
    room.sides.blue.cash = 1e6;
    const buys = (ordersFor(room, "blue") || []).filter((event) => event.type === "bot_buy");
    if (buys.length !== 1) say("the same fixture with a free slot did not buy", buys.length);
  }
}
