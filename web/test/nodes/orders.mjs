// orders — land orders. See docs/CONTRACTS.md and the `orders` node in
// docs/web-loop.graph.json. Every pace figure is read from rules.landPace; none is written
// here. If move.mjs stops walking one step per running round, stops wrapping X, stops
// refusing wasteland, or lets a piece share a cell, these assertions fail.

import { boardPayload, CELL_W, CELL_H } from "../../server/board.mjs";
import { openMatch } from "../../server/match.mjs";
import { issueOrder, advance, blockedCells, wrapX } from "../../server/move.mjs";
import { tickMatch } from "../../server/tick.mjs";
import { landPace, isRefused } from "../../server/rules.mjs";

export const name = "orders";

export async function run(ctx) {
  const { fail } = ctx;

  const board = boardPayload();
  if (!board || !Array.isArray(board.cells)) fail("orders needs the board cells: " + board.source);
  const cellAt = (x, y) => board.cells[y * CELL_W + wrapX(x)];
  const terrainAt = (x, y) => cellAt(x, y);
  if (board.cells.length !== CELL_W * CELL_H) fail("board cell count " + board.cells.length);

  // ---- the opening land piece and one open step on a running round -------------------
  const match = openMatch("1986");
  const blueLand = match.pieces.find((unit) => unit.id === "blue:land");
  if (!blueLand) fail("1986 has no blue:land piece: " + JSON.stringify(match.pieces));
  if (blueLand.x !== 79 || blueLand.y !== 44) fail("blue land is not on Washington: " + JSON.stringify(blueLand));
  if (blueLand.domain !== "land" || blueLand.side !== "blue") fail("blue:land shape " + JSON.stringify(blueLand));

  const stepX = blueLand.x + 1;
  const stepY = blueLand.y;
  const stepPace = landPace(terrainAt(stepX, stepY));
  if (stepPace !== 1) fail("the cell east of Washington is not open ground: " + stepPace);

  const ordered = issueOrder(match, "blue", "blue:land", stepX, stepY);
  if (!ordered.ok) fail("an open step was refused: " + JSON.stringify(ordered));
  if (!Array.isArray(ordered.path) || ordered.path.length !== 1) {
    fail("an open step is not one step: " + JSON.stringify(ordered.path));
  }
  const first = ordered.path[0];
  if (first.x !== stepX || first.y !== stepY) fail("ordered path ends at " + JSON.stringify(first));
  if (first.pace !== stepPace) fail("ordered step pace " + first.pace + " is not the rule's " + stepPace);

  match.clock = "running";
  const ticked = tickMatch(match);
  const moved = ticked.events.find((event) => event.type === "move" && event.pieceId === "blue:land");
  if (!moved) fail("one running tick did not move blue:land: " + JSON.stringify(ticked.events));
  if (moved.x !== stepX || moved.y !== stepY) fail("move event is " + JSON.stringify(moved));
  if (blueLand.x !== stepX || blueLand.y !== stepY) fail("blue:land is at " + blueLand.x + "," + blueLand.y);
  if (blueLand.path.length !== 0) fail("blue:land kept a path after the last step: " + JSON.stringify(blueLand.path));

  // ---- refusals: unknown piece, wrong side, a sea piece, Y off the map ---------------
  const unknown = issueOrder(match, "blue", "blue:ghost", stepX, stepY);
  if (!unknown.error) fail("an unknown piece id was accepted");
  const wrongSide = issueOrder(match, "red", "blue:land", stepX, stepY);
  if (!wrongSide.error) fail("a piece of the other side was ordered by blue");
  // A sea piece is not a land order: since the lanes node it routes on the lane graph instead.
  // Either it gets a lane path or it refuses; it must never be walked as if it were on land.
  const seaOrder = issueOrder(match, "blue", "blue:sea", 0, 16);
  if (seaOrder.ok) {
    if (!Array.isArray(seaOrder.path) || !seaOrder.path.length) fail("a sea order returned an empty path");
    const end = seaOrder.path[seaOrder.path.length - 1];
    if (end.x !== 0 || end.y !== 16) fail("a sea order did not end at the destination: " + JSON.stringify(end));
  }
  const tooFarSouth = issueOrder(match, "blue", "blue:land", stepX, CELL_H);
  if (!tooFarSouth.error) fail("an order off the Y range (y=" + CELL_H + ") was accepted");
  const negative = issueOrder(match, "blue", "blue:land", stepX, -1);
  if (!negative.error) fail("an order off the Y range (y=-1) was accepted");

  // ---- an enemy-held cell is a target; a friendly-held cell is a refusal ---------------
  // Two player-like sides used to stand eight cells apart for a thousand rounds because the order
  // to close was refused as if it were a collision. The order is now accepted; the walk still stops
  // one short (advance reports `blocked`), which is where combat happens.
  const held = issueOrder(match, "blue", "blue:land", 183, 25);
  if (held.error) fail("an order onto red:land's cell was refused: " + held.error);
  if (!Array.isArray(held.path) || !held.path.length) fail("an attack order returned no path");
  const friendCell = (match.pieces || []).find((piece) => piece.side === "blue" && piece.id !== "blue:land" && !piece.path);
  if (friendCell) {
    const friendly = issueOrder(match, "blue", "blue:land", friendCell.x, friendCell.y);
    if (!friendly.error) fail("an order onto a friendly piece's cell was accepted");
    if (!String(friendly.error).includes("holds")) fail("held-cell refusal reads: " + friendly.error);
  }
  const blocked = blockedCells(match);
  if (!blocked.has("183,25") || !blocked.has(String(stepX) + "," + String(stepY))) {
    fail("blockedCells missed a held cell: " + JSON.stringify([...blocked]));
  }

  // ---- wasteland is refused ----------------------------------------------------------
  // A blast makes wasteland at runtime; this extract has none, so one plain cell is marked
  // refused for the length of the check and restored afterwards. move.mjs must read terrain
  // and refuse it, not merely trust a blacklist of piece ids.
  const wastelandX = 170;
  const wastelandY = 10;
  const wastelandIndex = wastelandY * CELL_W + wastelandX;
  if (board.cells[wastelandIndex] !== 8) fail("the probe cell is not plain: " + board.cells[wastelandIndex]);
  const saved = board.cells[wastelandIndex];
  let wasteland;
  try {
    board.cells[wastelandIndex] = 14;
    if (!isRefused(14)) fail("rules no longer refuses id 14");
    if (landPace(14) !== -1) fail("rules landPace(14) is " + landPace(14));
    wasteland = issueOrder(match, "blue", "blue:land", wastelandX, wastelandY);
  } finally {
    board.cells[wastelandIndex] = saved;
  }
  if (!wasteland.error) fail("a wasteland order was accepted");
  if (!/wasteland/i.test(String(wasteland.error))) fail("wasteland refusal reads: " + wasteland.error);

  // ---- slow ground takes more rounds, at whatever pace the rules give -----------------
  const slowMatch = openMatch("1986");
  const walker = slowMatch.pieces.find((unit) => unit.id === "blue:land");
  walker.x = 165;
  walker.y = 8;
  walker.path = [];
  walker.pace = 1;
  const slowPace = landPace(terrainAt(166, 8));
  if (slowPace < 2) fail("the probe neighbour is not slow ground: " + slowPace);
  const slowOrder = issueOrder(slowMatch, "blue", "blue:land", 166, 8);
  if (!slowOrder.ok) fail("a slow-ground step was refused: " + JSON.stringify(slowOrder));
  if (slowOrder.path.length !== 1) fail("slow path length " + slowOrder.path.length);
  if (slowOrder.path[0].pace !== slowPace) fail("slow step pace " + slowOrder.path[0].pace + " vs " + slowPace);
  slowMatch.clock = "running";
  tickMatch(slowMatch);
  if (walker.x !== 165 || walker.y !== 8) fail("slow ground was crossed in one round: " + walker.x + "," + walker.y);
  tickMatch(slowMatch);
  if (walker.x !== 166 || walker.y !== 8) fail("slow ground was not crossed on the second round: " + walker.x + "," + walker.y);

  // ---- X wraps, Y does not -----------------------------------------------------------
  // The seam columns are ocean on this extract, so the wrap probe walks a transport cell
  // from x=319 to x=0 at the same row: one step, taken at the transport pace.
  const wrapMatch = openMatch("1986");
  const traveler = wrapMatch.pieces.find((unit) => unit.id === "blue:land");
  traveler.x = 319;
  traveler.y = 5;
  traveler.path = [];
  traveler.pace = 1;
  if (landPace(terrainAt(0, 5)) < 1) fail("the seam cell at 0,5 is refused");
  const wrapOrder = issueOrder(wrapMatch, "blue", "blue:land", 0, 5);
  if (!wrapOrder.ok) fail("a wrapping step was refused: " + JSON.stringify(wrapOrder));
  if (wrapOrder.path.length !== 1) fail("wrap path length " + wrapOrder.path.length + ": " + JSON.stringify(wrapOrder.path));
  if (wrapOrder.path[0].x !== 0 || wrapOrder.path[0].y !== 5) fail("wrap step is " + JSON.stringify(wrapOrder.path[0]));
  if (wrapX(320) !== 0 || wrapX(-1) !== CELL_W - 1) fail("wrapX does not wrap: " + wrapX(320) + "," + wrapX(-1));
  const eastward = issueOrder(wrapMatch, "blue", "blue:land", CELL_W, 5);
  if (!eastward.ok) fail("x=320 was refused instead of wrapping to x=0: " + JSON.stringify(eastward));
  if (eastward.path.length !== 1 || eastward.path[0].x !== 0 || eastward.path[0].y !== 5) {
    fail("x=320 did not wrap to cell 0,5: " + JSON.stringify(eastward.path));
  }
  const wrapMatch2 = openMatch("1986");
  const walker2 = wrapMatch2.pieces.find((unit) => unit.id === "blue:land");
  walker2.x = 319;
  walker2.y = 5;
  walker2.path = [];
  walker2.pace = 1;
  issueOrder(wrapMatch2, "blue", "blue:land", 0, 5);
  wrapMatch2.clock = "running";
  const rounds = Math.max(1, landPace(terrainAt(0, 5)));
  for (let i = 0; i < rounds; i++) tickMatch(wrapMatch2);
  if (walker2.x !== 0 || walker2.y !== 5) fail("the wrapping walk did not finish at 0,5: " + walker2.x + "," + walker2.y);

  // ---- a piece stops one short of another piece's cell -------------------------------
  const clash = openMatch("1986");
  const front = clash.pieces.find((unit) => unit.id === "blue:land");
  const wall = clash.pieces.find((unit) => unit.id === "red:land");
  front.x = 165;
  front.y = 8;
  front.path = [{ x: 166, y: 8, pace: 1 }];
  front.pace = 1;
  wall.x = 166;
  wall.y = 8;
  wall.path = [];
  const clashEvents = advance(clash);
  const stopped = clashEvents.find((event) => event.type === "blocked" && event.pieceId === "blue:land");
  if (!stopped) fail("a walk into a held cell was not blocked: " + JSON.stringify(clashEvents));
  if (stopped.by !== "red:land") fail("blocked event names " + JSON.stringify(stopped.by));
  if (front.x !== 165 || front.y !== 8) fail("the walker shared the held cell: " + front.x + "," + front.y);
  if (front.path.length !== 0) fail("the walker kept its path after being blocked");

  // ---- an empty roster is an error, not a crash --------------------------------------
  const empty = openMatch("2023");
  if (empty.pieces.length !== 0) fail("2023 opened with " + empty.pieces.length + " pieces");
  const noRoster = issueOrder(empty, "blue", "blue:land", 79, 44);
  if (!noRoster.error) fail("an order against an empty roster was accepted");
  if (advance(empty).length !== 0) fail("advance invented movement with no pieces");
}
