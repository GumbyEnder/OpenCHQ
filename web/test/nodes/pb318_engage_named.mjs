// PB-318 — the engage line names whose unit closed and what kind it engaged.
//
// PM room 10144 item 3: the live Log read "a unit engaged the enemy at range" (round 3,
// playtest/combat_live_f82114b/). It named neither the reader's side nor the target, so a player
// could not tell whether the line was about their infantry closing on a tank or the reverse. The
// style it had to match already existed one branch above in the same producer — "your infantry
// landed a hit on an enemy infantry for 17 (83 left)".
//
// Two facts are asserted, in that order, because they can break independently:
//   (a) the PRODUCER: completeAsEngage writes `kind` (the closing piece) and `targetKind` (the held
//       foe) onto the engage event. Without these the sentence cannot be built at all, and reading
//       the kinds back off match.pieces later would miss a foe that died in the same round.
//   (b) the LINE: logLines speaks it as "your <kind> engaged an enemy <kind> at range" for the
//       mover and "an enemy <kind> engaged your <kind> at range" for the other seat, with no cell,
//       no distance and no piece id anywhere in the text.
//
// The arms are exact-string compares on purpose: the pre-318 wording fails them BY NAME
// ("a unit engaged the enemy at range"), so this file is the red on the old line rather than a
// substring check that both wordings could satisfy.

import { boardPayload, CELL_W } from "../../server/board.mjs";
import { openMatch } from "../../server/match.mjs";
import { issueOrder, advance, wrapX, squaredDistance, inEngageRange } from "../../server/move.mjs";
import { landPace, combatRules, sightCells } from "../../server/rules.mjs";
import { logLines } from "../../server/log.mjs";

export const name = "pb318_engage_named";

function must(ok, why) {
  if (!ok) throw new Error(why);
}

function piece(id, side, kind, x, y) {
  return { id, side, kind, domain: "land", x, y, path: [], credit: 0, pace: 1,
    strength: 100, maxStrength: 100, transport: false, entrenched: false, pinned: false, fighting: null };
}

const linesOf = (match, side, events, round) => logLines(match, side, events, round).map((line) => line.text);

export async function run() {
  const board = boardPayload();
  must(board && Array.isArray(board.cells), "PB-318 needs the board cells");
  const cell = (x, y) => board.cells[Number(y) * CELL_W + wrapX(x)];
  const open = (x, y) => landPace(cell(x, y)) === 1;

  // An open five-by-five land block: the mover, the foe at (2,1) and the whole approach must be
  // walkable, or the order is refused and the leg tests the planner instead of the sentence.
  let block = null;
  for (let y = 2; y < 130 && !block; y++) {
    for (let x = 2; x < 300 && !block; x++) {
      let ok = true;
      for (let i = 0; i <= 4 && ok; i++) for (let j = 0; j <= 4 && ok; j++) if (!open(x + i, y + j)) ok = false;
      if (ok) block = { x, y };
    }
  }
  must(block, "PB-318: no open five-by-five land block on the board, the test cannot run");
  const range = combatRules().landEngageCells;
  must(range === 2, "PB-318: landEngageCells is " + range + ", the measured pair below assumes 2");

  const match = openMatch("1986");
  match.round = 1;
  // Deliberately two DIFFERENT kinds: the point of the card is that the line can tell them apart.
  const mover = piece("blue:closer", "blue", "infantry", block.x, block.y);
  const foe = piece("red:held", "red", "tank", block.x + 2, block.y + 1);
  must(squaredDistance(mover, foe) === 5 && inEngageRange(mover, foe, range),
    "PB-318: the pair is not inside engage range: dist^2 = " + squaredDistance(mover, foe));
  match.pieces = [mover, foe];

  const order = issueOrder(match, "blue", mover.id, foe.x, foe.y);
  must(order.ok, "PB-318: the order onto the held cell was refused: " + JSON.stringify(order));
  const events = advance(match);
  const engaged = events.find((event) => event.type === "engage" && event.pieceId === mover.id);
  must(engaged, "PB-318: no engage event for the mover (events " + JSON.stringify(events.map((e) => e.type)) + ")");

  // ---- (a) the producer carries both kinds --------------------------------------------------
  must(engaged.kind === "infantry",
    "PB-318: the engage event's kind is " + JSON.stringify(engaged.kind) + ", want \"infantry\"");
  must(engaged.targetKind === "tank",
    "PB-318: the engage event's targetKind is " + JSON.stringify(engaged.targetKind) + ", want \"tank\"");

  // ---- (b) the mover reads its own line, naming both kinds and nothing else ------------------
  const mine = linesOf(match, "blue", [engaged], engaged.round);
  must(mine.length === 1, "PB-318: the mover read " + mine.length + " lines for one engage: " + JSON.stringify(mine));
  const want = "your infantry engaged an enemy tank at range";
  must(mine[0] === want, "PB-318: the mover read " + JSON.stringify(mine[0]) + ", want " + JSON.stringify(want));
  for (const raw of [mover.id, foe.id, "blue:", "red:"]) {
    must(!mine[0].includes(raw), "PB-318: the mover's line carries the raw id " + JSON.stringify(raw) + ": " + mine[0]);
  }
  must(!/\d+\s*,\s*\d+/.test(mine[0]), "PB-318: the mover's line carries a cell: " + mine[0]);

  // ---- (c) the other seat reads the same act in its own voice --------------------------------
  // The foe stands two cells from the mover's cell and sight is 8, so this seat IS legible and its
  // arm must speak; a seat that cannot see it reads nothing (the legible() gate is unchanged).
  must(sightCells() >= 2, "PB-318: sight is " + sightCells() + " cells, the red arm assumes 2");
  const theirs = linesOf(match, "red", [engaged], engaged.round);
  must(theirs.length === 1, "PB-318: the other seat read " + theirs.length + " lines: " + JSON.stringify(theirs));
  const wantEnemy = "an enemy infantry engaged your tank at range";
  must(theirs[0] === wantEnemy,
    "PB-318: the other seat read " + JSON.stringify(theirs[0]) + ", want " + JSON.stringify(wantEnemy));

  // ---- (d) the old sentence is gone from every arm ------------------------------------------
  for (const text of mine.concat(theirs)) {
    must(!text.includes("a unit engaged the enemy at range"),
      "PB-318: the pre-318 wording survived: " + text);
    must(!text.includes("an enemy unit engaged ours"), "PB-318: the pre-318 enemy arm survived: " + text);
  }
}
