// Steel ran out at round 40 and the log blamed fuel while the fuel meter still read 9,900. Steel
// is not in the original (Manual p.27: oil is the only resource), so it must never stall a
// match. This runs 200 rounds and checks the army is still walking long after the steel meter is
// empty, and that a stall line names the resource that actually ran out.
import { CELL_W, boardPayload, matchSites } from "../../server/board.mjs";
import { openMatch } from "../../server/match.mjs";
import { seedOwners } from "../../server/economy.mjs";
import { issueOrder } from "../../server/move.mjs";
import { tickMatch } from "../../server/tick.mjs";
import { logLines } from "../../server/log.mjs";
import { consume, meterOf, movementBlocked } from "../../server/resources.mjs";

export const name = "resources_stall";

// The first land cell in a ring around a cell. Used for the Moscow approach, so the march is the
// long Washington-to-Moscow walk the original played, not a one-step hop.
function nearCapital(board, centre) {
  for (let r = 1; r <= 4; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = ((centre.x + dx) % CELL_W + CELL_W) % CELL_W;
        const y = centre.y + dy;
        if (y < 0 || y >= board.height) continue;
        const id = board.cells[y * CELL_W + x];
        if (id !== null && id > 2 && id !== 3 && id !== 14) return { x, y };
      }
    }
  }
  return null;
}

function nextLand(board, from) {
  for (let r = 1; r <= 8; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = ((from.x + dx) % CELL_W + CELL_W) % CELL_W;
        const y = from.y + dy;
        if (y < 0 || y >= board.height) continue;
        const id = board.cells[y * CELL_W + x];
        if (id !== null && id > 2 && id !== 3 && id !== 14) return { x, y };
      }
    }
  }
  return null;
}

export async function run(ctx) {
  const { fail } = ctx;
  const board = boardPayload();
  if (!Array.isArray(board.cells)) fail("resources_stall: the board has no cells");

  const match = openMatch("1942", matchSites("1942", board));
  seedOwners(match);
  match.clock = "running";

  // T-013b: 1942 opens with the original's 60 pieces, not one piece per seat, so the long marcher
  // is whichever blue land piece gives a march of at least 80 rounds - the archive's own
  // Washington-to-Moscow shape. Selecting by id "blue:land" was an accident of the old four-piece
  // opening, not a rule.
  const dest = nearCapital(board, { x: 183, y: 25 });
  if (!dest) fail("resources_stall: no land cell beside Moscow for the target");
  let army = null;
  let order = null;
  for (const piece of match.pieces.filter((unit) => unit.side === "blue" && unit.domain === "land")) {
    const attempt = issueOrder(match, "blue", piece.id, dest.x, dest.y);
    if (!attempt || attempt.error) continue;
    if (Number(attempt.rounds) < 80) continue;
    army = piece;
    order = attempt;
    break;
  }
  if (!army) fail("resources_stall: no blue land piece has a march of 80+ rounds toward Moscow");
  if (Number(order.rounds) < 80) fail("resources_stall: the chosen march is only " + order.rounds + " rounds");

  const at = [];
  const movedAt = [];
  let last = { x: army.x, y: army.y };
  for (let round = 1; round <= 200; round++) {
    tickMatch(match);
    if (army.x !== last.x || army.y !== last.y) movedAt.push(round);
    last = { x: army.x, y: army.y };
    if ([30, 40, 41, 90, 100].includes(round)) at.push({ round, x: army.x, y: army.y });
  }

  // The steel meter is empty well before round 100, exactly as the owner saw.
  const steel = meterOf(match, "blue", "steel");
  if (!steel) fail("resources_stall: 1942 carries no steel meter");
  if (Number(steel.held) !== 0) fail("resources_stall: steel should be empty after 200 rounds, is " + steel.held);

  const pick = (round) => at.find((p) => p.round === round);
  const same = (a, b) => a.x === b.x && a.y === b.y;
  if (same(pick(30), pick(41))) {
    fail("resources_stall: the army stood still from round 30 to 41: " + JSON.stringify([pick(30), pick(41)]));
  }
  if (same(pick(90), pick(100))) {
    // T-004 makes the march a straight line, so the army reaches the Moscow ring sooner than the
    // old bent A* route and then stands there. Standing still at the destination is arrival, not a
    // stall - the stall this test exists for is steel stopping the march, reported below.
    const arrived = { x: pick(90).x, y: pick(90).y };
    const atDest = Math.abs(arrived.x - dest.x) <= 1 && Math.abs(arrived.y - dest.y) <= 1;
    if (!atDest) {
      fail("resources_stall: the army stood still from round 90 to 100 away from its destination: " +
        JSON.stringify([pick(90), pick(100), dest]));
    }
  }
  // And the step is a real step in the round, not a teleport between samples: a slow cell costs
  // two rounds, so the window is a few rounds wide rather than exactly 41.
  if (!movedAt.some((round) => round >= 39 && round <= 43)) {
    fail("resources_stall: no step was taken around round 41; moves " + JSON.stringify(movedAt.slice(0, 8)));
  }
  if (!movedAt.some((round) => round > 41)) {
    fail("resources_stall: no step was taken after the steel meter ran out; moves " + JSON.stringify(movedAt));
  }
  if (movedAt.length < 40) {
    fail("resources_stall: the march took only " + movedAt.length + " moving rounds");
  }
  if (movementBlocked(match, "blue") !== null) {
    fail("resources_stall: steel is blocking movement for blue: " + movementBlocked(match, "blue"));
  }

  // The line names the right resource. Steel is non-original and stops nobody; fuel is the one
  // resource the original had, and a dry fuel meter is the only thing allowed to stop a unit.
  const steelLines = logLines(match, "blue", [{ type: "dry", side: "blue", kind: "steel" }], 40);
  if (!steelLines.some((line) => line.text === "out of steel")) {
    fail("resources_stall: a dry steel meter did not say 'out of steel': " + JSON.stringify(steelLines));
  }
  if (steelLines.some((line) => /out of fuel/.test(line.text))) {
    fail("resources_stall: a dry steel meter was reported as fuel: " + JSON.stringify(steelLines));
  }
  const fuelLines = logLines(match, "blue", [{ type: "dry", side: "blue", kind: "fuel" }], 40);
  if (!fuelLines.some((line) => line.text === "out of fuel: units are not moving")) {
    fail("resources_stall: a dry fuel meter did not say 'out of fuel': " + JSON.stringify(fuelLines));
  }
  if (fuelLines.some((line) => /out of steel/.test(line.text))) {
    fail("resources_stall: a dry fuel meter was reported as steel: " + JSON.stringify(fuelLines));
  }

  // Fuel, the original's own resource, does stop a unit when it is truly empty.
  const dryMatch = openMatch("1942", matchSites("1942", board));
  seedOwners(dryMatch);
  dryMatch.clock = "running";
  const walker = dryMatch.pieces.find((piece) => piece.side === "blue" && piece.domain === "land");
  const walkDest = nextLand(board, walker);
  if (!walkDest) fail("resources_stall: no nearby land destination for the fuel case");
  const walkOrder = issueOrder(dryMatch, "blue", walker.id, walkDest.x, walkDest.y);
  if (!walkOrder || walkOrder.error) fail("resources_stall: the fuel case order was refused: " + JSON.stringify(walkOrder));
  consume(dryMatch, "blue", "fuel", 10000);
  if (movementBlocked(dryMatch, "blue") !== "fuel") {
    fail("resources_stall: an empty fuel meter did not block movement");
  }
  const before = { x: walker.x, y: walker.y };
  tickMatch(dryMatch);
  if (walker.x !== before.x || walker.y !== before.y) {
    fail("resources_stall: a unit moved with an empty fuel meter");
  }

  console.log("resources_stall: 200 rounds, steel 0, army " +
    at.map((p) => "r" + p.round + " " + p.x + "," + p.y).join(" / ") +
    "; steel does not block; fuel does and is named");
}
