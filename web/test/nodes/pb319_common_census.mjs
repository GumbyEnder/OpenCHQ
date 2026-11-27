// pb319_common_census — the lobby does not retain a Show Common entry per room that ever toggled.
//
// What breaks if this is removed: `createLobby()` keeps `const commonSeats = new Map()` keyed by ROOM
// id, with a per-side entry inside. `setCommon()` deletes only a SIDE key when a seat toggles off;
// nothing in that map is bounded unless `endRoom` deletes the ROOM key. A long-lived lobby process
// would then retain one object per room that ever used the toggle — memory only (no frame, no wire,
// and no cross-room read: a stale key is reachable only through a room id that is gone), which is
// exactly why the behaviour arm cannot see it: `pb317_show_common_persist` stays GREEN with the
// prune deleted, because the next war opens a new room id.
//
// So this file reads the lobby's own census (`debugCommonCensus`, read-only: two integers, room keys
// and side keys — no mutator and no seat mode) and asserts it does not grow with the number of rooms
// that toggled Show Common and then left. The map is never enumerated for a seat's state here.
//
// Mutation: delete `commonSeats.delete(room.id)` from `endRoom` -> the last census reads N rooms / N
// seats and this file reds by name ("retained N room keys after N rooms left").

import { createLobby } from "../../server/lobby.mjs";

export const name = "pb319_common_census";

function must(ok, why) {
  if (!ok) throw new Error(why);
}

export async function run() {
  const lobby = createLobby();
  must(typeof lobby.debugCommonCensus === "function",
    "PB-319: createLobby() exposes no debugCommonCensus(), so the retention cannot be counted honestly");

  const peer = { sent: [], send(value) { this.sent.push(value); }, onclose: null };
  const seat = "pb319_census_seat";
  lobby.join(seat, peer);
  must(peer.sent.some((row) => row && row.op === "welcome"), "PB-319: the seat never got a welcome frame");

  const start = lobby.debugCommonCensus();
  must(start.rooms === 0 && start.seats === 0,
    "PB-319: a fresh lobby already retains " + start.rooms + " rooms / " + start.seats + " seats");

  // Five full cycles: open a war, turn Show Common ON, leave. Every one of them must be given back.
  const N = 5;
  const seen = [];
  for (let i = 0; i < N; i++) {
    const opened = lobby.handle(seat, { op: "bot", era: "1942", side: "blue" });
    must(opened && opened.ok !== false,
      "PB-319: cycle " + i + " could not open a war: " + JSON.stringify(opened));
    const toggled = lobby.handle(seat, { op: "show_common" });
    must(toggled && toggled.ok !== false,
      "PB-319: cycle " + i + " could not toggle Show Common: " + JSON.stringify(toggled));
    const on = lobby.debugCommonCensus();
    // Non-vacuity: the toggle must be VISIBLE in the census (one room, one side), or the arms below
    // would pass on a map this file never touched. The bound is >= 1, not === 1, so a leak reds on
    // the ticket's own sentence at the end instead of on this guard.
    must(on.rooms >= 1 && on.seats >= 1,
      "PB-319: cycle " + i + " toggled on but the census reads " + on.rooms + " rooms / " + on.seats +
        " seats, so the arm is counting nothing");
    const left = lobby.handle(seat, { op: "leave" });
    must(left && left.ok !== false, "PB-319: cycle " + i + " could not leave: " + JSON.stringify(left));
    seen.push(lobby.debugCommonCensus());
  }

  const last = seen[seen.length - 1];
  must(last.rooms === 0,
    "PB-319: retained " + last.rooms + " room keys after " + N + " rooms left (census per cycle " +
      JSON.stringify(seen) + ")");
  must(last.seats === 0,
    "PB-319: retained " + last.seats + " side keys after " + N + " rooms left (census per cycle " +
      JSON.stringify(seen) + ")");
  for (const row of seen) {
    must(row.rooms <= 1,
      "PB-319: the retained room-key count grew with the number of rooms: " + JSON.stringify(seen));
  }
}
