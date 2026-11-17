// PB-113 — an order stops where it arrives. Owner: game.
//
// What breaks if this is removed: a sea route's destination is appended as the FINAL anchor after
// the lane waypoint chain, so a leg toward an intermediate waypoint can cross the destination cell
// first and sail on for tens of cells before returning to it. Destroyer 58,66 -> 61,66 planned 82
// cells and quoted 28 rounds for a three-cell order. A land order whose line crosses water has the
// same shape through its sea hop. Each case below fails by name on the pre-fix code.

import { resolveDataRoot } from "../../server/board.mjs";
import { openMatch } from "../../server/match.mjs";
import { issueOrder, walkRounds, wrapX } from "../../server/move.mjs";
import { tickMatch } from "../../server/tick.mjs";

export const name = "first_arrival";

function piece(kind, domain, x, y) {
  return { id: "blue:p", side: "blue", kind, domain, x, y, path: [], credit: 0, pace: 1,
    strength: 100, maxStrength: 100, transport: false, entrenched: false, pinned: false, fighting: null };
}

const CASES = [
  // kind, domain, from x,y, to x,y, the label the failure names
  ["destroyer", "sea", 58, 66, 61, 66, "destroyer 58,66->61,66 (82 cells / 28 rounds before the fix)"],
  ["destroyer", "sea", 3, 3, 10, 3, "destroyer 3,3->10,3 (38 cells before the fix)"],
  ["infantry", "land", 80, 45, 90, 45, "infantry 80,45->90,45 (land order with a sea hop)"],
  ["destroyer", "sea", 223, 92, 225, 91, "destroyer 223,92->225,91 (frodo's random-sample case)"],
];

export async function run(ctx) {
  const fail = ctx.fail;
  if (!resolveDataRoot()) ctx.skip("first_arrival: no data root resolved (set OPENCHQ_DATA or OPENCHQ_EXTRACT)");

  const lines = [];
  const problems = [];
  for (const [kind, domain, x, y, tx, ty, label] of CASES) {
    const match = openMatch("1986");
    match.clock = "running";
    const p = piece(kind, domain, x, y);
    match.pieces = [p];
    const order = issueOrder(match, "blue", "blue:p", tx, ty);
    if (!order || order.error) { problems.push("PB-113 " + label + ": the order was refused: " + JSON.stringify(order)); continue; }

    const path = order.path;
    const hits = path
      .map((step, i) => (wrapX(step.x) === wrapX(tx) && step.y === ty ? i : -1))
      .filter((i) => i >= 0);
    if (!hits.length) { problems.push("PB-113 " + label + ": the planned path never stands on the destination"); continue; }
    if (hits[0] !== path.length - 1) {
      problems.push("PB-113 " + label + ": the path stands on the destination at index " + hits[0] +
        " of " + (path.length - 1) + " and carries on (" + path.length + " cells): " +
        path.map((step) => step.x + "," + step.y).join(" "));
    }
    if (hits.length > 1) {
      problems.push("PB-113 " + label + ": the path visits the destination " + hits.length + " times: " + hits.join(", "));
    }

    // The quote is the round the order lands on, computed from the path it is cut to.
    const rounds = walkRounds(p, path);
    if (rounds !== order.rounds) {
      problems.push("PB-113 " + label + ": the order quotes " + order.rounds + " rounds but its own path walks in " + rounds);
    }
    // And the clock has to agree with the quote: the unit stands on the destination when the
    // quoted round has been run, and it is not still walking away from it afterwards.
    for (let round = 0; round < order.rounds; round++) tickMatch(match);
    const px = wrapX(match.pieces[0].x);
    if (px !== wrapX(tx) || match.pieces[0].y !== ty) {
      problems.push("PB-113 " + label + ": " + order.rounds + " rounds ran and the unit stands on " +
        px + "," + match.pieces[0].y + ", not the destination");
    }
    if (Array.isArray(match.pieces[0].path) && match.pieces[0].path.length) {
      problems.push("PB-113 " + label + ": the unit arrived on round " + order.rounds +
        " but still carries " + match.pieces[0].path.length + " un-walked cells");
    }
    lines.push(label.split(" (")[0] + " " + path.length + " cells / " + order.rounds + " rounds");
  }
  // Every case is measured before the node fails, so the mutant run names all four, not just the first.
  if (problems.length) fail(problems.join(" | "));
  console.log("first_arrival: every named order ends on its first arrival — " + lines.join("; "));
}
