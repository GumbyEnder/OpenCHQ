// PB-214: the map badge and the unit list must agree on the ARRIVAL round.
//
// The defect: the walker empties a unit's path when it spends its last step, so on the arrival round
// the page's badgeState() found no path and no `moving` field and painted "idle", while the same
// frame's server-side `state` said "moving". The fix is one field: viewPiece ships `moving` (the same
// movedThisRound() predicate stateOf() uses), and badgeState has always read it.
//
// This node pins both halves of the contract on one match: the server sends the word, and the page
// paints the same word, on the arrival round and on the round after it.
import { forSeat } from "../../server/view.mjs";
import { badgeState } from "../../public/badges.mjs";

export const name = "pb214_arrival_badge";

function must(ok, why) {
  if (!ok) throw new Error(why);
}

function arrivingMatch() {
  return {
    round: 7,
    era: "1986",
    pieces: [
      {
        id: "blue:arrives",
        side: "blue",
        domain: "land",
        kind: "infantry",
        x: 70,
        y: 43,
        strength: 100,
        path: [],
        // The walker stamps the round it stepped on; the path is already empty.
        movedRound: 7,
        fighting: null,
      },
      {
        id: "blue:idle",
        side: "blue",
        domain: "land",
        kind: "infantry",
        x: 71,
        y: 43,
        strength: 100,
        path: [],
        movedRound: 5,
        fighting: null,
      },
      {
        id: "blue:walking",
        side: "blue",
        domain: "land",
        kind: "tank",
        x: 72,
        y: 43,
        strength: 100,
        path: [{ x: 73, y: 43 }],
        fighting: null,
      },
    ],
    sites: [],
    capitals: {},
  };
}

export async function run() {
  const match = arrivingMatch();
  const view = forSeat(match, null);
  const byId = new Map((view.pieces || []).map((piece) => [piece.id, piece]));

  const arriving = byId.get("blue:arrives");
  must(!!arriving, "the arriving piece is missing from the seat view");
  must(arriving.state === "moving", "the arrival round is not 'moving' on the server: " + arriving.state);
  must(arriving.moving === true, "viewPiece does not ship the arrival round as moving: " + JSON.stringify(arriving.moving));
  must(Array.isArray(arriving.path) && arriving.path.length === 0, "the fixture is not an arrival (path not empty)");
  must(badgeState(arriving) === "moving", "the badge disagrees with the unit list on the arrival round: " + badgeState(arriving));

  const idle = byId.get("blue:idle");
  must(idle.state === "idle", "a unit that moved two rounds ago must read idle on the server: " + idle.state);
  must(idle.moving === false, "a unit that moved two rounds ago must not ship moving: " + JSON.stringify(idle.moving));
  must(badgeState(idle) === "idle", "the badge says a parked unit is moving: " + badgeState(idle));

  const walking = byId.get("blue:walking");
  must(walking.moving === true, "a unit with a path still in hand must ship moving: " + JSON.stringify(walking.moving));
  must(badgeState(walking) === "moving", "a walking unit's badge is not moving: " + badgeState(walking));

  // The next round the arrival is over: the same unit must fall back to idle, or the badge would be
  // one round ahead instead of one behind.
  const next = forSeat({ ...match, round: 8 }, null);
  const after = (next.pieces || []).find((piece) => piece.id === "blue:arrives");
  must(after.state === "idle", "the round after arrival must read idle on the server: " + after.state);
  must(after.moving === false, "the round after arrival must not ship moving");
  must(badgeState(after) === "idle", "the badge stays ahead of the arrival round: " + badgeState(after));
}
