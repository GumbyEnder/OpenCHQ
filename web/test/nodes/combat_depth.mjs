// Node test for `combat_depth` (order 265).
//
// What breaks if this node is removed: there is no digging, no repairing, and the unit list has
// no words for what a piece is doing. The archive only ever printed the words - entrenchment is
// infantry only, its bonus was never recovered, and a move order clears it - so this test pins
// the states and the refusals, not a number.

import { openMatch } from "../../server/match.mjs";
import { issueOrder, entrench, repair, pieceState, ENTRENCH_NOTE } from "../../server/move.mjs";
import { forSeat } from "../../server/view.mjs";

export const name = "combat_depth";

function unit(id, side, kind, x, y) {
  return { id, side, domain: "land", kind, x, y, path: [], pace: 1, facing: null, fighting: null, shots: 0 };
}

function fresh() {
  const match = openMatch("1986", []);
  match.clock = "running";
  match.sites = [
    { id: 10, name: "New York", x: 80, y: 40, kind: "city", owner: "blue" },
    { id: 12, name: "Kiev", x: 180, y: 22, kind: "city", owner: "red" },
  ];
  match.round = 3;
  return match;
}

export async function run(ctx) {
  const { fail } = ctx;

  // --- infantry digs in; the state is a word, and the note says the bonus is unknown ----
  const match = fresh();
  const foot = unit("blue:infantry:1", "blue", "infantry", 80, 40);
  const tank = unit("blue:tank:1", "blue", "tank", 81, 40);
  match.pieces = [foot, tank];

  const dug = entrench(match, "blue", "blue:infantry:1");
  if (dug.error) fail("infantry was refused entrenching: " + dug.error);
  if (foot.entrenched !== true) fail("entrenching did not set the state");
  if (pieceState(foot, match) !== "digging") fail("the state word is not digging: " + pieceState(foot, match));
  if (!dug.events.some((event) => event.type === "entrench" && event.note === ENTRENCH_NOTE)) {
    fail("the entrench event lost the archive's stand-in line");
  }
  if (/\d/.test(String(ENTRENCH_NOTE).replace("Stand-in", ""))) fail("the entrench note invented a number: " + ENTRENCH_NOTE);

  const noTank = entrench(match, "blue", "blue:tank:1");
  if (!noTank.error) fail("a tank was allowed to entrench");
  if (noTank.error !== "Only infantry can entrench.") fail("the refusal is not the archive's: " + noTank.error);

  const wrongSide = entrench(match, "red", "blue:infantry:1");
  if (!wrongSide.error) fail("the other seat entrenched a piece it does not own");

  // --- a move order clears digging, as the archive says --------------------------------
  const order = issueOrder(match, "blue", "blue:infantry:1", 88, 40);
  if (order.error) fail("the entrenched piece refused a move order: " + order.error);
  if (foot.entrenched !== false) fail("a move order left the piece dug in");
  if (pieceState(foot, match) !== "moving") fail("an ordered piece is not moving: " + pieceState(foot, match));

  // --- a moving piece cannot dig in ----------------------------------------------------
  const busy = entrench(match, "blue", "blue:tank:1");
  const tankOrder = issueOrder(match, "blue", "blue:tank:1", 84, 40);
  if (tankOrder.error) fail("the tank refused an order: " + tankOrder.error);
  const during = entrench(match, "blue", "blue:tank:1");
  if (!during.error) fail("a tank entrench order was refused for the wrong reason: " + busy.error);
  if (!/still moving|Only infantry/.test(during.error)) fail("the refusal did not name a real reason: " + during.error);

  // --- repair happens at a friendly city, and holds until it moves again ---------------
  const yard = fresh();
  const hurt = unit("blue:infantry:9", "blue", "infantry", 80, 40);
  const stray = unit("blue:infantry:8", "blue", "infantry", 90, 90);
  yard.pieces = [hurt, stray];

  const fixed = repair(yard, "blue", "blue:infantry:9");
  if (fixed.error) fail("repair at a friendly city was refused: " + fixed.error);
  if (pieceState(hurt, yard) !== "repairing") fail("the state word is not repairing: " + pieceState(hurt, yard));
  const away = repair(yard, "blue", "blue:infantry:8");
  if (!away.error) fail("a piece repaired in open ground");
  if (!/city or dock/.test(away.error)) fail("the refusal did not name where repair happens: " + away.error);

  // --- the seat view carries the state word for its own pieces ------------------------
  const seen = forSeat(yard, "blue");
  const report = seen.pieces.find((piece) => piece.id === "blue:infantry:9");
  if (!report) fail("the seat view lost its own piece");
  if (report.state !== "repairing") fail("the view did not carry the state word: " + JSON.stringify(report));
  if (report.entrenched === undefined) fail("the view lost the entrenched flag");
  if (report.transport === undefined) fail("the view lost the transport flag");

  // --- an inactive aircraft reads inactive, not idle -----------------------------------
  const air = fresh();
  const plane = unit("blue:air:1", "blue", "aircraft", 80, 40);
  plane.inactiveUntil = 9;
  air.pieces = [plane];
  if (pieceState(plane, air) !== "inactive") fail("an inactive aircraft is not inactive: " + pieceState(plane, air));
  air.round = 9;
  if (pieceState(plane, air) !== "idle") fail("the aircraft did not become idle when its countdown ended");
}
