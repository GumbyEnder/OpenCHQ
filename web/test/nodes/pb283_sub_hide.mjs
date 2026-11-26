// PB-283 node leg: a still submarine inside the enemy's radar is not in that enemy's view.
//
// The rule is the manual's (l.752-756) and the original's: a submarine is hidden while it is
// stationary, so radar range alone does not put it on the other seat's board. It becomes visible
// for the round it moves, while it is in a fight, and when an intel pass or a satellite reveals it.
//
// What fails if this is removed:
//   - the hiding branch in visibleEnemy() disappears            -> a still sub leaks into the view
//   - the branch hardens into "subs are never visible"          -> a moving sub stays invisible
//   - the hiding is applied to the OWNER's view too             -> red cannot see its own sub
//   - a hidden piece travels as a flag or a route instead       -> the payload leaks it without the
//                                                                  piece list naming it
//
// Radii come from ctx.config, never from a literal. Evidence: docs/re/MOVEMENT.md, the manual
// l.752-756, and the card's radar-radius note (UNVERIFIED radius; only the *inside range* fact is
// asserted here).

import { openMatch } from "../../server/match.mjs";
import { forSeat } from "../../server/view.mjs";

export const name = "pb283_sub_hide";

function piece(id, side, kind, x, y, extra = {}) {
  return {
    id,
    side,
    domain: kind === "submarine" || kind === "cruiser" || kind === "carrier" ? "sea" : "land",
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
  const { fail, config } = ctx;
  const radius = Number(config.sightCells);
  if (!Number.isInteger(radius) || radius <= 0) fail("pb283: config.sightCells is not a positive integer");

  // A blue hull and a red submarine exactly at the radar edge: distance == sightCells, so the sub
  // is unambiguously inside blue's sight by the sight rule alone.
  const blueX = 100;
  const blueY = 60;
  const subX = blueX + radius;
  const subY = blueY;

  const build = (subExtra = {}, enemyKind = "submarine") => {
    const match = openMatch("1942");
    match.pieces = [
      piece("blue:scout", "blue", "cruiser", blueX, blueY),
      piece("red:boat", "red", enemyKind, subX, subY, subExtra),
    ];
    return match;
  };

  // 1. The control the hiding rule is measured against: a surface hull at the SAME cell, still,
  //    is in the view. Without this, "the sub is absent" could be an empty or broken view.
  {
    const view = forSeat(build({}, "cruiser"), "blue");
    if (!ids(view).includes("red:boat")) fail("pb283: control failed - a still enemy cruiser at the radar edge is not in blue's view");
  }

  // 2. The rule itself: a still submarine at that same cell is absent.
  {
    const view = forSeat(build(), "blue");
    if (ids(view).includes("red:boat")) fail("pb283: a stationary red submarine inside blue's radar leaked into blue's view");
    if (JSON.stringify(view).includes("red:boat")) fail("pb283: the hidden submarine is named somewhere in blue's payload (not just the piece list)");
    const routes = view.routes || {};
    if (Object.prototype.hasOwnProperty.call(routes, "red:boat")) fail("pb283: the hidden submarine's route is in blue's payload");
  }

  // 3. The same boat, same cell, one ordered step: it moved this round, so blue sees it.
  {
    const moved = build({ path: [{ x: subX + 1, y: subY }], movedRound: 0 });
    moved.round = 0;
    const view = forSeat(moved, "blue");
    if (!ids(view).includes("red:boat")) fail("pb283: a red submarine that moved one cell inside blue's radar is still hidden");
  }

  // 4. The move is read off the round, not only the path: a piece that stamps movedRound and has
  //    spent its path is visible too (the coordinate the movement code actually leaves behind).
  {
    const stamped = build({ movedRound: 3 });
    stamped.round = 3;
    const view = forSeat(stamped, "blue");
    if (!ids(view).includes("red:boat")) fail("pb283: a submarine that moved this round (movedRound, no path) is hidden");
  }

  // 5. A boat in a fight is visible even if it did not move - "fired" is not "still".
  {
    const fighting = build({ fighting: "blue:scout" });
    const view = forSeat(fighting, "blue");
    if (!ids(view).includes("red:boat")) fail("pb283: a stationary submarine that is fighting is hidden from the enemy");
  }

  // 6. An intel/satellite reveal overrides the hiding for that round.
  {
    const revealed = build({ revealedRound: 2 });
    revealed.round = 2;
    const view = forSeat(revealed, "blue");
    if (!ids(view).includes("red:boat")) fail("pb283: a revealed submarine is still hidden from the enemy");
  }

  // 7. Hiding is the ENEMY's rule only: red always sees its own boat, still or not.
  {
    const view = forSeat(build(), "red");
    if (!ids(view).includes("red:boat")) fail("pb283: red cannot see its own stationary submarine");
  }

  // 8. Hiding is not a way around sight: outside the radar, a moving sub is still absent.
  {
    const outside = openMatch("1942");
    outside.pieces = [
      piece("blue:scout", "blue", "cruiser", blueX, blueY),
      piece("red:boat", "red", "submarine", blueX + radius + 1, blueY, { path: [{ x: blueX + radius + 2, y: blueY }] }),
    ];
    const view = forSeat(outside, "blue");
    if (ids(view).includes("red:boat")) fail("pb283: a moving submarine outside blue's radar is in blue's view");
  }

  // 9. One cell outside the radius, still: absent for the ordinary reason, and the two absences are
  //    distinguishable - a moving boat just outside is also absent, so the visible case above is the
  //    radius and not a general "moved = visible" bypass.
  {
    const stillOutside = openMatch("1942");
    stillOutside.pieces = [
      piece("blue:scout", "blue", "cruiser", blueX, blueY),
      piece("red:sail", "red", "cruiser", blueX + radius + 1, blueY, { path: [] }),
    ];
    const view = forSeat(stillOutside, "blue");
    if (ids(view).includes("red:sail")) fail("pb283: control failed - a still surface hull outside radar is in blue's view");
  }
}
