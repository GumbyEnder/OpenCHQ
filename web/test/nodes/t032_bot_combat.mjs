// T-032 Part B: the force threshold and the target sets, plus the capital's defence radius.
// Owner: game.
//
// What breaks if this file is removed: B4 and B5 go back to prose. A bot could attack at parity,
// a cruiser could be ordered at a city, and the 25/20/15-cell capital radius could quietly become a
// single number.
//
// B4: a land attack only with a force advantage strictly greater than 11 strength units inside 30
// cells; movement onto an enemy-held cell is an attack, so the gate sits on that order. Ships and
// air target only ships and air. B5: a 4-unit massed attack on the bot's own capital gets a
// defender, and the capital's radius is 25 against 20 for an own site and 15 otherwise.

import { boardPayload, matchSites } from "../../server/board.mjs";
import { openMatch } from "../../server/match.mjs";
import { seedOwners } from "../../server/economy.mjs";
import { forceAdvantage, landAttackAllowed, marchOne, ordersFor, selectCombatTargets, siteThreat, threatenedSites } from "../../server/bot.mjs";
import { botAttackRangeCells, botThreatRadii, forceAdvantageUnits } from "../../server/rules.mjs";

export const name = "t032_bot_combat";

function piece(id, side, x, y, extra = {}) {
  return {
    id, side, domain: "land", kind: "infantry", x, y, path: [], pace: 1,
    strength: 100, maxStrength: 100, ...extra,
  };
}

function ring(cell) {
  const out = [];
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      if (ox === 0 && oy === 0) continue;
      out.push({ x: cell.x + ox, y: cell.y + oy });
    }
  }
  return out;
}

function haveBoard() {
  try {
    const payload = boardPayload();
    return Boolean(payload && Array.isArray(payload.cells) && payload.cells.length);
  } catch {
    return false;
  }
}

export async function run(ctx) {
  const { fail } = ctx;
  const say = (what, actual) => fail(what + ": " + JSON.stringify(actual));

  // ---- B4 arm 1: both sides of the 11-strength threshold, and the 30-cell range --------------
  // A ringed capital is the only state in which the bot attacks at all, so the order-level arms use
  // one: eight hostile holders (10 strength each) around the capital and one blue army outside the
  // ring. The army's strength, not its position, moves the advantage across the threshold.
  {
    if (forceAdvantageUnits() !== 11) say("the force threshold is not 11", forceAdvantageUnits());
    if (botAttackRangeCells() !== 30) say("the attack radius is not 30 cells", botAttackRangeCells());

    const capital = { x: 100, y: 60 };
    const ringMatch = (blueStrength, extraBlue = null) => {
      const match = {
        pieces: ring(capital).map((cell, index) => piece("red:hold" + index, "red", cell.x, cell.y, { strength: 10 })),
        sites: [],
        capitals: { blue: { x: 10, y: 10 }, red: capital },
        seats: { blue: { kind: "bot" }, red: { kind: "human" } },
        sides: { blue: { cash: 0, bought: 99 }, red: { cash: 0, bought: 99 } },
        opponentLevel: 5,
      };
      const army = piece("blue:army", "blue", capital.x, capital.y + 10, { strength: blueStrength });
      match.pieces.push(army);
      if (extraBlue) match.pieces.push(extraBlue);
      return { match, army };
    };
    const probe = ring(capital)[0];

    const eleven = ringMatch(91);
    if (forceAdvantage(eleven.match, "blue", probe) !== 11) {
      say("the fixture does not sit at a force advantage of 11", forceAdvantage(eleven.match, "blue", probe));
    }
    if (landAttackAllowed(eleven.match, "blue", probe)) say("a force advantage of 11 passed the gate; the rule is strictly greater");
    const events11 = [];
    marchOne(eleven.match, "blue", eleven.army, capital, events11);
    if (events11.some((event) => event.type === "bot_order")) say("a force advantage of 11 was allowed to attack", events11);
    if (!events11.some((event) => event.type === "bot_skip" && /force edge/.test(String(event.reason)))) {
      say("the refused attack did not say why", events11);
    }

    const twelve = ringMatch(92);
    if (forceAdvantage(twelve.match, "blue", probe) !== 12) {
      say("the fixture does not sit at a force advantage of 12", forceAdvantage(twelve.match, "blue", probe));
    }
    const events12 = [];
    marchOne(twelve.match, "blue", twelve.army, capital, events12);
    const attack = events12.find((event) => event.type === "bot_order");
    if (!attack) say("a force advantage of 12 was not allowed to attack", events12);
    if (attack.assault !== true) say("the attack was not flagged as an assault", attack);

    // A piece outside 30 cells does not add to the force sum: 1 + a distant 100 must stay 1, so the
    // same stall is still the answer. If the radius were ignored this would read 101 and pass.
    const distant = piece("blue:far", "blue", capital.x, capital.y + 40, { strength: 100 });
    const ranged = ringMatch(81, distant);
    if (forceAdvantage(ranged.match, "blue", probe) !== 1) {
      say("a piece 40 cells away entered the force sum", forceAdvantage(ranged.match, "blue", probe));
    }
    const eventsRanged = [];
    marchOne(ranged.match, "blue", ranged.army, capital, eventsRanged);
    if (eventsRanged.some((event) => event.type === "bot_order")) say("a piece outside 30 cells created an attack", eventsRanged);
  }

  // ---- B4 arm 2: ships and air target only ships and air --------------------------------------
  {
    const match = {
      pieces: [
        piece("blue:ship", "blue", 10, 40, { domain: "sea", kind: "cruiser" }),
        piece("blue:plane", "blue", 12, 40, { domain: "air", kind: "aircraft" }),
        piece("red:ship", "red", 30, 40, { domain: "sea", kind: "cruiser" }),
        piece("red:plane", "red", 32, 40, { domain: "air", kind: "aircraft" }),
        piece("red:city", "red", 11, 40, { domain: "land", kind: "infantry" }),
      ],
      sites: [], capitals: { blue: { x: 10, y: 40 }, red: { x: 30, y: 40 } },
      seats: { blue: { kind: "bot" }, red: { kind: "human" } }, sides: { blue: { cash: 0 }, red: { cash: 0 } },
      opponentLevel: 5,
    };
    const rows = selectCombatTargets(match, "blue");
    if (rows.length !== 2) say("not every sea/air attacker got exactly one target", rows);
    for (const row of rows) {
      if (row.target.domain !== "sea" && row.target.domain !== "air") {
        say("a ship or aircraft was pointed at land", { attacker: row.attacker.id, target: row.target.id, domain: row.target.domain });
      }
    }
    const shipRow = rows.find((row) => row.attacker.id === "blue:ship");
    if (!shipRow || shipRow.target.id !== "red:ship") say("the ship did not pick the enemy ship", shipRow);
    if (rows.some((row) => row.target.id === "red:city")) say("the land piece entered the target set", rows);

    // No enemy hull or aircraft: a ship holds, and says so, instead of sailing at a capital.
    const empty = { ...match, pieces: match.pieces.filter((unit) => unit.side === "blue" || unit.id === "red:city") };
    const events = ordersFor(empty, "blue");
    const sailed = events.filter((event) => event.type === "bot_order" && event.pieceId === "blue:ship");
    if (sailed.length) say("a ship was ordered at a land target", sailed);
    if (!events.some((event) => event.type === "bot_skip" && event.pieceId === "blue:ship" && /no enemy ship/.test(String(event.reason)))) {
      say("the ship stayed put without saying why", events.filter((event) => event.pieceId === "blue:ship"));
    }
  }

  // ---- B5: the 25/20/15 radii and a 4-unit massed attack on our own capital -------------------
  {
    const radii = botThreatRadii();
    if (radii.capital !== 25 || radii.ownSite !== 20 || radii.otherSite !== 15) say("the threat radii are not 25/20/15", radii);
    const capital = { id: "cap", name: "HOME", kind: "capital", owner: "blue", x: 40, y: 40 };
    const city = { id: "city", name: "CITY", kind: "city", owner: "blue", x: 80, y: 80 };
    const dock = { id: "dock", name: "DOCK", kind: "dock", owner: "blue", x: 120, y: 80 };
    // One hostile piece just inside 25 cells of the capital contributes there and nowhere else.
    const near = piece("red:near", "red", 40 + 24, 40, { strength: 100 });
    const match = {
      // The friendly piece stands outside the 25-cell radius, so the score isolates the radius.
      pieces: [near, piece("blue:home", "blue", 40 + 30, 40, { strength: 100 })],
      sites: [capital, city, dock],
      capitals: { blue: { x: 40, y: 40 }, red: { x: 200, y: 40 } },
      capitalSet: { list: [{ siteId: "cap", name: "HOME" }] },
      seats: { blue: { kind: "bot" }, red: { kind: "human" } },
      sides: { blue: { cash: 0, bought: 99 }, red: { cash: 0, bought: 99 } },
      opponentLevel: 5,
    };
    if (siteThreat(match, capital) >= 0) say("an enemy 24 cells out did not count against the capital", siteThreat(match, capital));
    if (siteThreat(match, dock) !== 0) say("the same enemy was counted at a dock 80 cells away", siteThreat(match, dock));

    // The massed attack: four tanks on the capital's ring, two idle defenders in reach.
    capital.kind = "capital";
    const attackers = ring({ x: 40, y: 40 }).slice(0, 4)
      .map((cell, index) => piece("red:mass" + index, "red", cell.x, cell.y, { strength: 100 }));
    const defenders = [
      piece("blue:d1", "blue", 40 + 5, 40, { strength: 100 }),
      piece("blue:d2", "blue", 40 - 5, 40, { strength: 100 }),
    ];
    const massed = { ...match, pieces: [...attackers, ...defenders] };
    const threatened = threatenedSites(massed, "blue");
    if (!threatened.some((row) => row.site.id === "cap")) say("the 4-unit massed attack did not threaten the capital", threatened);
    const events = ordersFor(massed, "blue");
    const defence = events.filter((event) => event.type === "bot_defend");
    if (!defence.length) say("the bot answered a 4-unit massed attack on its capital with nothing", events);
    if (!defence.some((event) => event.site === "cap")) say("the defenders were sent somewhere other than the capital", defence);
    if (defence.some((event) => !["blue:d1", "blue:d2"].includes(event.pieceId))) say("the defence used a piece that was not a defender", defence);

    // The control: the same capital with the four attackers removed gets no defence order.
    const quiet = { ...massed, pieces: defenders };
    const quietEvents = ordersFor(quiet, "blue");
    if (quietEvents.some((event) => event.type === "bot_defend")) say("a quiet capital drew a defence order", quietEvents);
  }

  // ---- B5, second arm: on the real board, a buy at the threatened site counts too --------------
  // The AC allows "buying at the site and/or sending its nearest units". The synthetic leg above
  // proves the dispatch; this one proves the buy anchor when the extract is present.
  if (!haveBoard()) {
    console.log("t032_bot_combat: no board extract, so the buy-at-site arm is not run (dispatch arm stands)");
  } else {
    const sites = JSON.parse(JSON.stringify(matchSites("1942")));
    const match = openMatch("1942", sites, { handicapSide: "blue", opponentLevel: 5 });
    match.clock = "running";
    match.seats = { blue: { kind: "bot" }, red: { kind: "human" } };
    seedOwners(match);
    const capital = match.sites.find((site) => site.kind === "capital" && site.owner === "blue")
      || match.sites.find((site) => site.owner === "blue");
    if (!capital) fail("the 1942 board gives blue no capital to defend");
    capital.kind = "capital";
    // Enough cash for one infantry, and no free standing unit, so the only possible answer is a buy.
    match.sides.blue.cash = 100000;
    match.sides.blue.bought = 0;
    const ringCells = ring({ x: capital.x, y: capital.y });
    match.pieces = ringCells.slice(0, 4).map((cell, index) =>
      piece("red:mass" + index, "red", cell.x, cell.y, { domain: "land", kind: "tank", strength: 100 }));
    const events = ordersFor(match, "blue");
    const buys = events.filter((event) => event.type === "bot_buy");
    const defence = events.filter((event) => event.type === "bot_defend");
    if (!buys.length && !defence.length) say("neither a buy nor a dispatch answered the massed attack on the real board", events);
    for (const buy of buys) {
      // "At the site" is the nearest LEGAL placement cell inside the threatened site's radius: the
      // mask offers only ready ground and the capital's own cell is held by its garrison, so the
      // port's translation of FUN_107e_1612's "create a unit on the site" is the closest ready cell
      // (measured here 7 cells out, inside the capital's 25-cell radius). The dispatch arm above is
      // the one that proves the site cell itself is answered.
      const gapTo = (site) => Math.max(Math.abs(site.x - buy.at.x), Math.abs(site.y - buy.at.y));
      if (gapTo(capital) > 25) say("the buy landed outside the threatened capital's radius", { at: buy.at, capital: [capital.x, capital.y], gap: gapTo(capital) });
    }
    console.log("t032_bot_combat: real-board arm " + buys.length + " buy(s), " + defence.length + " dispatch(es)");
  }
}
