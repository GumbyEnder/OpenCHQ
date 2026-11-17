// PB-104 — the seat that owns the blocked unit is told, and the other seat is not. Owner: game.
//
// What breaks if this is removed: advance() pushed `{type:"blocked", pieceId, by, x, y, retry}` with
// no `side`, while log.mjs keys the case off `event.side === side`. So the owning seat's Log panel
// never received "a unit could not step: the way was held" and the `case "blocked"` branch was dead
// code — the ticket's own live hand-check found 0 of 65 seat frames carrying the sentence.
//
// The leg below drives the real emitter (tickMatch -> advance) with a friendly piece standing on the
// order's destination, then feeds THAT round's events to both seats' logs. It asserts the owning
// seat's line is present and the enemy seat's is absent, and that the sentence carries no
// coordinates (the PB-106 class).

import { openMatch } from "../../server/match.mjs";
import { issueOrder, wrapX } from "../../server/move.mjs";
import { logLines } from "../../server/log.mjs";
import { tickMatch } from "../../server/tick.mjs";

export const name = "blocked_log";
export const SENTENCE = "a unit could not step: the way was held";

function piece(id, side, x, y) {
  return { id, side, kind: "infantry", domain: "land", x, y, path: [], credit: 0, pace: 1,
    strength: 100, maxStrength: 100, transport: false, entrenched: false, pinned: false, fighting: null };
}

export async function run(ctx) {
  const fail = ctx.fail;

  const match = openMatch("1986");
  match.clock = "running";
  match.pieces = [
    piece("blue:occupant", "blue", 101, 100),
    piece("blue:mover", "blue", 99, 100),
    // A red unit far away, so the enemy seat exists and its log has something to be wrong about.
    piece("red:watcher", "red", 200, 120),
  ];
  // The order is placed while the destination is free: a FRIENDLY-held cell is refused at plan time
  // (orders.mjs :323 stays refused, order_wire pins it). The block this ticket is about is the race
  // the live hand-check found — a friend arrives on the cell AFTER the order is placed.
  const order = issueOrder(match, "blue", "blue:mover", 100, 100);
  if (!order || order.error) {
    fail("PB-104: the order onto the free destination was refused: " + JSON.stringify(order));
    return;
  }
  const occupant = match.pieces.find((p) => p.id === "blue:occupant");
  occupant.x = 100;
  occupant.y = 100;

  // Run rounds until the mover is actually blocked at the destination; the emitter only fires there.
  let events = [];
  let round = 0;
  for (let i = 0; i < 10; i++) {
    const tick = tickMatch(match);
    round = match.round;
    events = Array.isArray(tick.events) ? tick.events : [];
    if (events.some((e) => e && e.type === "blocked" && e.pieceId === "blue:mover")) break;
  }

  const blocked = events.filter((e) => e && e.type === "blocked");
  if (!blocked.length) {
    fail("PB-104: the mover was never blocked at a friendly-held destination, so the emitter was not exercised");
    return;
  }
  if (!blocked.every((e) => e.side === "blue")) {
    fail("PB-104: the blocked emitter did not stamp the owning side on its event(s): " +
      JSON.stringify(blocked.map((e) => ({ pieceId: e.pieceId, side: e.side }))));
    return;
  }

  const own = logLines(match, "blue", events, round).filter((line) => line.text.includes(SENTENCE));
  const other = logLines(match, "red", events, round).filter((line) => line.text.includes(SENTENCE));
  const problems = [];
  if (own.length !== 1) {
    problems.push("PB-104: the owning seat's log carries " + own.length +
      " \"" + SENTENCE + "\" line(s) for the blocked round, wanted exactly 1 (events: " +
      JSON.stringify(events.map((e) => e.type + (e.side ? ":" + e.side : ""))) + ")");
  }
  if (other.length !== 0) {
    problems.push("PB-104: the other seat's log carries the owning seat's blocked line " +
      other.length + " time(s): " + JSON.stringify(other));
  }
  // No coordinates in the text: the sentence names no cell, so a later reader cannot mine it.
  for (const line of own) {
    if (/\d+\s*,\s*\d+/.test(line.text)) {
      problems.push("PB-104: the blocked line carries coordinates: " + JSON.stringify(line.text));
    }
  }
  // ---- PB-121: a hold is one fact, and a real step forgets it -------------------------------
  // Three more rounds of the SAME hold must add no event: the retry is the same sentence, and a
  // Log that repeated it for 14 rounds (live r6..r19) is what buried every other line.
  const repeats = [];
  for (let i = 0; i < 3; i++) {
    const tick = tickMatch(match);
    for (const event of tick.events || []) {
      if (event && event.type === "blocked" && event.pieceId === "blue:mover") repeats.push(event);
    }
  }
  if (repeats.length) {
    fail("PB-121: the same hold was re-emitted " + repeats.length + " time(s) on the waiting rounds");
    return;
  }

  // The friend leaves; the mover takes the cell it was held out of, which must clear the memory.
  occupant.x = 100;
  occupant.y = 98;
  let arrived = false;
  for (let i = 0; i < 8; i++) {
    tickMatch(match);
    const mover = match.pieces.find((p) => p.id === "blue:mover");
    if (mover.path.length === 0) { arrived = true; break; }
  }
  if (!arrived) {
    fail("PB-121: the mover never stepped into the cell the friend had vacated");
    return;
  }
  // Walk the mover off the cell and back, so the SECOND hold lands on the SAME cell (100,100)
  // as the first: only the clear-on-step makes that a new fact. A different cell would speak
  // even with the memory left behind, and would pin nothing.
  const away = issueOrder(match, "blue", "blue:mover", 98, 100);
  if (!away || away.error) {
    fail("PB-121: the walk-away order was refused: " + JSON.stringify(away));
    return;
  }
  let parked = false;
  for (let i = 0; i < 8; i++) {
    tickMatch(match);
    const mover = match.pieces.find((p) => p.id === "blue:mover");
    if (mover.path.length === 0 && wrapX(mover.x) === 98) { parked = true; break; }
  }
  if (!parked) {
    fail("PB-121: the mover never reached the cell it walked away to");
    return;
  }
  const back = issueOrder(match, "blue", "blue:mover", 100, 100);
  if (!back || back.error) {
    fail("PB-121: the order back onto the (free) destination was refused: " + JSON.stringify(back));
    return;
  }
  // Put the friend back on 100,100 while the mover is one step out: the same cell as hold one.
  let spoke = null;
  for (let i = 0; i < 10 && !spoke; i++) {
    const tick = tickMatch(match);
    spoke = (tick.events || []).find((event) => event && event.type === "blocked" && event.pieceId === "blue:mover") || null;
    if (spoke) break;
    const mover = match.pieces.find((p) => p.id === "blue:mover");
    if (mover.path.length <= 1) { occupant.x = 100; occupant.y = 100; }
  }
  if (!spoke) {
    fail("PB-121: the same cell held a second time, after a real step, stayed silent - the hold memory never cleared");
    return;
  }
  if (spoke.side !== "blue") fail("PB-121: the fresh blocked event lost its owning side: " + JSON.stringify(spoke));

  if (problems.length) {
    fail(problems.join(" | "));
    return;
  }
  console.log("blocked_log: the owning seat is told once, the other seat never — \"" + own[0].text + "\" at r" + round);
}
