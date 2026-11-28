// PB-302 node leg: a submarine on a sea lane is hidden while it is still and visible to a surface
// ship for the round it moves — measured by placing both pieces, not by waiting for a playtest to
// happen to produce a red boat.
//
// MANUAL printed p.12 l.329: "Submarines are always hidden from air and satellite scanning."
// MANUAL printed p.18 l.554-556: a submarine is not seen while it is stationary; it is seen when it
// moves or fires. MANUAL printed p.24 l.756: the same rule from the sight side — radar range alone
// does not put a still submarine on the other seat's board.
//
// What fails if this is removed:
//   - the submarine branch in visibleEnemy() disappears        -> a still sub leaks into the view
//   - it hardens into "subs are never visible"                 -> a moving sub stays invisible
//   - the move is read off a queued path only, never the step  -> the post-step round loses the sub
//   - the hiding is applied to the OWNER's view too            -> red cannot see its own boat
//   - a hidden piece travels as a flag or a route instead      -> the payload leaks it without the
//                                                                 piece list naming it
//
// The fixtures are planted. No match is played forward looking for a red submarine: the leg picks a
// lane waypoint from the recovered lane graph, stands a red boat on it, and gives the boat ONE
// one-cell order. (a) is that boat still; (b) is that boat after the step. The blue hull sits at
// exactly `sightCells` from the lane cell, so both readings are inside radar and differ only by
// movement. Radius comes from rules.sightCells(), never from a literal.
//
// PB-283 pins the same branch with hand-stamped piece fields; this leg is the lane-and-step twin
// the PB-302 card asked for, so a change that only works for a fabricated `path` array (and not for
// a step the walker actually took) reds here.

import { CELL_W, boardPayload, resolveDataRoot } from "../../server/board.mjs";
import { joinLane } from "../../server/lanes.mjs";
import { openMatch } from "../../server/match.mjs";
import { forSeat } from "../../server/view.mjs";
import { advance, issueOrder } from "../../server/move.mjs";
import { sightCells } from "../../server/rules.mjs";

export const name = "pb302_sub_radar";

const MESSAGES = [];

function must(ok, message) {
  MESSAGES.push(message);
  if (!ok) throw new Error("node test pb302_sub_radar: " + message);
}

function piece(id, side, kind, x, y, extra = {}) {
  return {
    id,
    side,
    domain: "sea",
    kind,
    x,
    y,
    path: [],
    pace: 1,
    facing: null,
    fighting: null,
    shots: 0,
    ...extra,
  };
}

function ids(view) {
  return (view.pieces || []).map((p) => p.id);
}

export async function run(ctx) {
  const dataRoot = resolveDataRoot();
  if (!dataRoot) {
    return ctx.skip("pb302_sub_radar: no reference extract is mounted (set OPENCHQ_DATA / OPENCHQ_EXTRACT), so the lane graph cannot be read");
  }

  // A lane waypoint is water by construction (joinLane's default accept test), so a boat standing
  // on it is on a real lane cell, not on a remembered coordinate.
  const joined = joinLane(dataRoot, { x: 160, y: 68 });
  must(Boolean(joined && joined.waypoint), "no wet lane waypoint was found on the recovered lane graph");
  const lane = joined.waypoint;

  const radius = Number(sightCells());
  must(Number.isInteger(radius) && radius > 0, "sightCells is not a positive integer");

  // The blue hull stands exactly at the radar edge from the lane cell: inside sight by the radius
  // alone, on water (checked from the same board the lanes are read from).
  const hullX = (lane.x + radius) % CELL_W;
  const hullY = lane.y;
  const board = boardPayload();
  const terrain = Number(board.cells[hullY * CELL_W + hullX]);
  must(terrain <= 2, "the blue hull's cell at the radar edge is not water");

  const build = (enemyKind, extra = {}) => {
    const match = openMatch("1942");
    match.round = 5;
    match.clock = "running";
    match.pieces = [
      piece("blue:hull", "blue", "cruiser", hullX, hullY),
      piece("red:boat", "red", enemyKind, lane.x, lane.y, extra),
    ];
    return match;
  };

  // 1. The control the hiding rule is measured against: a surface hull at the SAME lane cell, still,
  //    is in blue's view. Without this, "the submarine is absent" could be an empty or broken view.
  {
    const view = forSeat(build("cruiser"), "blue");
    must(ids(view).includes("red:boat"), "control failed - a still enemy cruiser on the lane cell is not in the blue seat's view");
  }

  // 2. (a) The rule: a stationary submarine at that same lane cell is absent, and it is absent from
  //    the whole payload - not merely from the piece list, and not as a route.
  {
    const view = forSeat(build("submarine"), "blue");
    must(!ids(view).includes("red:boat"), "a stationary submarine inside the blue hull's radar leaked into the blue seat's view");
    must(!JSON.stringify(view).includes("red:boat"), "the hidden submarine is named somewhere in the blue seat's payload");
    const routes = view.routes || {};
    must(!Object.prototype.hasOwnProperty.call(routes, "red:boat"), "the hidden submarine's route is in the blue seat's payload");
  }

  // 3. (b) One real order along the water, issued through the same entry point a socket order uses.
  //    The boat has not stepped yet, but it has moved this round by the view's rule (a queued path).
  const match = build("submarine");
  const order = issueOrder(match, "red", "red:boat", lane.x + 1, lane.y);
  must(Boolean(order && order.ok), "the one-cell lane order was refused" + (order && order.error ? ": " + order.error : ""));
  must(Array.isArray(order.path) && order.path.length === 1, "the one-cell lane order did not queue exactly one step");
  {
    const view = forSeat(match, "blue");
    must(ids(view).includes("red:boat"), "a submarine with a queued lane step inside radar is still hidden from the enemy");
    const sent = (view.pieces || []).find((p) => p.id === "red:boat");
    must(sent && sent.moving === true, "the moving submarine was sent without its moving state");
  }

  // 4. The step the walker actually took. One advance moves the boat onto the next water cell and
  //    stamps the round; the same round must still carry the boat, now at its NEW cell.
  const before = { x: match.pieces[1].x, y: match.pieces[1].y };
  advance(match);
  const boat = match.pieces[1];
  must(boat.x === before.x + 1 && boat.y === before.y, "the walker did not step the submarine onto the ordered lane cell");
  must(!Array.isArray(boat.path) || boat.path.length === 0, "the submarine still has a queued path after its step");
  {
    const view = forSeat(match, "blue");
    must(ids(view).includes("red:boat"), "the submarine vanished in the round it stepped (the move is read off the queued path only)");
    const sent = (view.pieces || []).find((p) => p.id === "red:boat");
    must(sent && Number(sent.x) === boat.x && Number(sent.y) === boat.y, "the moved submarine was sent at a cell other than the one it stepped onto");
  }

  // 5. (a) again, one round later with no new order: the boat is still at the same cell, and now
  //    still. The two absences are distinguishable from the moved case above by the step, not by a
  //    different view or a different radius.
  match.round += 1;
  {
    const view = forSeat(match, "blue");
    must(!ids(view).includes("red:boat"), "a submarine that stopped after one step stayed visible in the next round");
  }

  // 6. Hiding is the ENEMY's rule only: red always sees its own boat, still or moving.
  {
    const still = forSeat(build("submarine"), "red");
    must(ids(still).includes("red:boat"), "red cannot see its own stationary submarine");
    const moving = forSeat(match, "red");
    must(ids(moving).includes("red:boat"), "red cannot see its own submarine after it stepped");
  }

  // 7. (d) Every message this leg can print is prose: no wire id and no side:kind:n shape.
  {
    const leak = MESSAGES.find((m) => /(blue|red):[a-z]/.test(m));
    must(!leak, "a player-facing string in this leg carries a raw piece id");
  }
}
