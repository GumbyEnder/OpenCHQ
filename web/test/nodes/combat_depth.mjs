// Node test for `combat_depth` (order 265, rewritten for T-003).
//
// What breaks if this node is removed: there is no digging, no repairing, and the unit list has
// no words for what a piece is doing. The states are still words the archive printed; the numbers
// behind them (entrenchDamageFactor, repairPerRound) live in config.combat and are tested in
// combat_rules. This node pins the eight states and the refusals that keep them honest.

import { openMatch } from "../../server/match.mjs";
import { issueOrder, entrench, repair, pieceState, repairStep, ENTRENCH_NOTE } from "../../server/move.mjs";
import { combatRules } from "../../server/rules.mjs";
import { forSeat } from "../../server/view.mjs";

export const name = "combat_depth";

function unit(id, side, kind, x, y, extra = {}) {
  return { id, side, domain: "land", kind, x, y, path: [], pace: 1, facing: null, fighting: null, shots: 0, ...extra };
}

function fresh() {
  const match = openMatch("1986", []);
  match.clock = "running";
  match.sites = [
    { id: 10, name: "New York", x: 80, y: 40, kind: "city", owner: "blue" },
    { id: 12, name: "Kiev", x: 180, y: 22, kind: "city", owner: "red" },
    { id: 13, name: "Port", x: 5, y: 5, kind: "docks", owner: "blue" },
  ];
  match.round = 3;
  return match;
}

export async function run(ctx) {
  const { fail } = ctx;
  const cfg = combatRules();

  // --- infantry digs in; the state is a word and the note names the factor --------------
  const match = fresh();
  const foot = unit("blue:infantry:1", "blue", "infantry", 80, 40);
  const tank = unit("blue:tank:1", "blue", "tank", 81, 40);
  match.pieces = [foot, tank];

  const dug = entrench(match, "blue", "blue:infantry:1");
  if (dug.error) fail("infantry was refused entrenching: " + dug.error);
  if (foot.entrenched !== true) fail("entrenching did not set the state");
  if (pieceState(foot, match) !== "digging") fail("the state word is not digging: " + pieceState(foot, match));
  if (!dug.events.some((event) => event.type === "entrench" && event.note === ENTRENCH_NOTE)) {
    fail("the entrench event lost its note");
  }

  const noTank = entrench(match, "blue", "blue:tank:1");
  if (!noTank.error) fail("a tank was allowed to entrench");
  if (noTank.error !== "Only infantry can entrench.") fail("the refusal is not the archive's: " + noTank.error);

  const wrongSide = entrench(match, "red", "blue:infantry:1");
  if (!wrongSide.error) fail("the other seat entrenched a piece it does not own");

  // --- a move order clears digging ------------------------------------------------------
  const order = issueOrder(match, "blue", "blue:infantry:1", 88, 40);
  if (order.error) fail("the entrenched piece refused a move order: " + order.error);
  if (foot.entrenched !== false) fail("a move order left the piece dug in");
  if (pieceState(foot, match) !== "moving") fail("an ordered piece is not moving: " + pieceState(foot, match));

  // --- a moving piece cannot dig in ------------------------------------------------------
  const tankOrder = issueOrder(match, "blue", "blue:tank:1", 84, 40);
  if (tankOrder.error) fail("the tank refused an order: " + tankOrder.error);
  const during = entrench(match, "blue", "blue:tank:1");
  if (!during.error) fail("a moving tank was allowed to entrench");
  if (!/still moving|Only infantry/.test(during.error)) fail("the refusal did not name a real reason: " + during.error);

  // --- pinned is a state, and an order clears it ----------------------------------------
  tank.path = [];
  tank.pinned = true;
  if (pieceState(tank, match) !== "pinned") fail("a pinned piece does not read pinned: " + pieceState(tank, match));
  tank.path = [];
  const unpin = issueOrder(match, "blue", "blue:tank:1", 82, 40);
  if (unpin.error) fail("a pinned piece refused a new order: " + unpin.error);
  if (tank.pinned !== false) fail("a new order left the piece pinned");

  // --- repair happens at a friendly city, and holds until it moves again -----------------
  const yard = fresh();
  const hurt = unit("blue:infantry:9", "blue", "infantry", 80, 40, { strength: cfg.maxStrength - 20 });
  const stray = unit("blue:infantry:8", "blue", "infantry", 90, 90);
  const hull = unit("blue:cruiser:1", "blue", "cruiser", 5, 5, { domain: "sea", strength: cfg.maxStrength - 20 });
  yard.pieces = [hurt, stray, hull];

  const fixed = repair(yard, "blue", "blue:infantry:9");
  if (fixed.error) fail("repair at a friendly city was refused: " + fixed.error);
  if (pieceState(hurt, yard) !== "repairing") fail("the state word is not repairing: " + pieceState(hurt, yard));
  const away = repair(yard, "blue", "blue:infantry:8");
  if (!away.error) fail("a piece repaired in open ground");
  if (!/city or dock/.test(away.error)) fail("the refusal did not name where repair happens: " + away.error);

  // A ship repairs only in a dock; the same hull on a city cell is refused.
  const beached = repair(yard, "blue", "blue:cruiser:1");
  if (beached.error) fail("a ship in a dock was refused repair: " + beached.error);
  hull.x = 80;
  hull.y = 40;
  const onCity = repair(yard, "blue", "blue:cruiser:1");
  if (!onCity.error) fail("a ship repaired on a city cell");

  // --- the round's own repair moves the bar and stops at the maximum ---------------------
  hull.x = 5;
  hull.y = 5;
  hull.repairing = false;
  const before = hurt.strength;
  repairStep(yard);
  if (!(hurt.strength > before)) fail("a round of repair did not raise the bar");
  for (let i = 0; i < 40; i++) repairStep(yard);
  if (hurt.strength > cfg.maxStrength) fail("repair passed the starting maximum: " + hurt.strength);
  if (hurt.repairing === true) fail("a full-strength piece still says repairing");

  // --- the seat view carries the bar and the states --------------------------------------
  hurt.strength = cfg.maxStrength - 10;
  hurt.repairing = true;
  const seen = forSeat(yard, "blue");
  const report = seen.pieces.find((piece) => piece.id === "blue:infantry:9");
  if (!report) fail("the seat view lost its own piece");
  if (report.state !== "repairing") fail("the view did not carry the state word: " + JSON.stringify(report));
  if (report.entrenched === undefined) fail("the view lost the entrenched flag");
  if (report.transport === undefined) fail("the view lost the transport flag");
  if (report.pinned === undefined) fail("the view lost the pinned flag");
  if (report.maxStrength !== cfg.maxStrength) fail("the view lost the strength maximum: " + report.maxStrength);
  if (!(Number(report.strength) < cfg.maxStrength)) fail("the view lost the current strength: " + report.strength);

  // --- an inactive aircraft reads inactive, not idle ------------------------------------
  const air = fresh();
  const plane = unit("blue:air:1", "blue", "aircraft", 80, 40);
  plane.inactiveUntil = 9;
  air.pieces = [plane];
  if (pieceState(plane, air) !== "inactive") fail("an inactive aircraft is not inactive: " + pieceState(plane, air));
  air.round = 9;
  if (pieceState(plane, air) !== "idle") fail("the aircraft did not become idle when its countdown ended");
}
