// T-032 Part B: opponents, the level gate and the spare-action budget.
// Owner: game.
//
// What breaks if this file is removed: B1-B3 and B6 go back to being prose. The lobby could stop
// listing MARS, level 1 could start acting, and the e94c budget could drift to a per-level story
// that the bytes do not tell.
//
// B1: five opponents in DS:0x4fea order, ANOTHER HUMAN = 0, level 1 labelled "Stands still:
// practice". B2: level 1 never enters the AI pass, so 50 rounds of orders and buys are empty.
// B3: e94c = level*2-4 (0/2/4/6) and 0bd6's three-site pass cap makes the observable per-pass
// counts 0/2/3/3 for levels 2-5. B6: the starting-money spinner is independent of the level.

import { openMatch } from "../../server/match.mjs";
import { tickMatch } from "../../server/tick.mjs";
import { ordersFor } from "../../server/bot.mjs";
import {
  botDeviations,
  botStandIns,
  defaultOpponentLevel,
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

// Three of our sites, each with a hostile pair beside it and one idle defender five cells out. No
// board extract is needed: the defence routine issues the order through move.planOrder, which works
// on the coordinates alone, and the fixture is the same on every host.
function budgetRoom(level) {
  const sites = [1, 2, 3].map((n) => ({ id: "s" + n, name: "S" + n, kind: "city", owner: "blue", x: 20 + n * 20, y: 40 }));
  const match = {
    era: "1942",
    round: 1,
    pieces: [],
    sites,
    capitals: { blue: { x: 20, y: 40 }, red: { x: 200, y: 40 } },
    capitalSet: { list: sites.map((site) => ({ siteId: site.id, name: site.name })) },
    // Cash 0 keeps botBuy out of the count so the number below is the defence pass alone.
    sides: { blue: { cash: 0, bought: 99 }, red: { cash: 0, bought: 99 } },
    seats: { blue: { kind: "bot" }, red: { kind: "human" } },
    opponentLevel: level,
  };
  for (const site of sites) {
    match.pieces.push(piece("red" + site.id + "a", "red", site.x + 1, site.y),
      piece("red" + site.id + "b", "red", site.x, site.y + 1),
      piece("blue" + site.id, "blue", site.x + 5, site.y));
  }
  return match;
}

function countActions(events) {
  return events.filter((event) => event.type === "bot_buy" || event.type === "bot_defend").length;
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

  // ---- B3. e94c = level*2 - 4, and the pass cap binds at levels 4-5 --------------------------
  {
    const budgets = [2, 3, 4, 5].map((level) => spareActionBudget(level));
    if (JSON.stringify(budgets) !== JSON.stringify([0, 2, 4, 6])) say("spareActionBudget is not 0/2/4/6", budgets);
    if (spareActionPassCap() !== 3) say("the 0bd6 pass cap is not three", spareActionPassCap());

    const observed = [];
    for (const level of [2, 3, 4, 5]) {
      const events = ordersFor(budgetRoom(level), "blue");
      const actions = countActions(events);
      observed.push(actions);
      const ceiling = Math.min(spareActionBudget(level), spareActionPassCap());
      if (actions > ceiling) say("level " + level + " spent " + actions + " spare actions over a ceiling of " + ceiling, events);
    }
    // Level 2's zero is the bytes, not an omission: it enters the pass and has nothing to spend.
    // Levels 4 and 5 both hit 0bd6's three-site cap, so they look alike in one pass.
    if (JSON.stringify(observed) !== JSON.stringify([0, 2, 3, 3])) {
      say("per-pass spare actions are not 0/2/3/3", observed);
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
    if (handicapDefault("2023") !== null) say("2023 grew an opponent spinner", handicapDefault("2023"));
  }

  // ---- B7/B8. the card's deviations and STAND-INs are in config and not only in prose --------
  {
    const deviations = botDeviations();
    if (!deviations.some((line) => /unitCap/i.test(line))) say("the unit cap is missing from the deviation list", deviations);
    if (!deviations.some((line) => /defaultLevel/i.test(line))) say("the default level is missing from the deviation list", deviations);
    const standIns = botStandIns();
    for (const token of ["ownership counters", "staging arrays", "garrison-buy"]) {
      if (!standIns.some((line) => String(line).toLowerCase().includes(token))) say("A7 STAND-IN missing: " + token, standIns);
    }
  }
}
