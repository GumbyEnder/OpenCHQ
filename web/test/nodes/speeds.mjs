// speeds — the 0-6 game speed and the per-kind movement rates (T-004, AC5-AC6).
//
// What fails if this is removed:
//   - config.move.cellsPerRound keeps the manual's orderings   -> sea stops being faster than land
//     and a tank stops being faster than infantry (p.9, p.21)
//   - speed 0 accepts an order and lets no time pass           -> a player at speed 0 loses the
//     order they just gave, or the war runs on without them
//   - speed 6 is much faster than speed 1                      -> the control is decoration
//   - every speed slot is labelled                             -> a stand-in is mistaken for a
//     recovered figure (Open RE Questions Q5)
//
// Only the orderings are binding. The seven round lengths are stand-ins, and this test says so
// rather than pinning the numbers as if they were measured.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openMatch } from "../../server/match.mjs";
import { advance, issueOrder } from "../../server/move.mjs";
import { tickMatch } from "../../server/tick.mjs";
import {
  cellsPerRound, moveSource, moveValue, rules, speedDue, speedSeconds, speedTable, SPEED_MAX,
} from "../../server/rules.mjs";

export const name = "speeds";

const here = path.dirname(fileURLToPath(import.meta.url));
const configFile = path.resolve(here, "..", "..", "..", "config", "game.json");

export async function run(ctx) {
  const { fail } = ctx;
  const config = JSON.parse(readFileSync(configFile, "utf8"));

  // ---- AC5: the per-kind rates, and only their orderings are binding ------------------------
  const block = config.move && config.move.cellsPerRound;
  if (!block || typeof block !== "object") fail("config.move.cellsPerRound is missing");
  if (!block.value || typeof block.value !== "object") fail("cellsPerRound carries no value object");
  if (typeof block.source !== "string" || !/UNMEASURED|STAND-IN/i.test(block.source)) {
    fail("cellsPerRound has no UNMEASURED/STAND-IN source: " + JSON.stringify(block.source));
  }
  const rate = block.value;
  const A = Number(rate.infantry);       // open land, foot
  const B = Number(rate.warship);        // a hull on the lanes
  const C = Number(rate.transport);      // a land unit at sea
  const D = Number(rate.tank);           // open land, tracks
  for (const [label, value] of [["infantry", A], ["warship", B], ["transport", C], ["tank", D]]) {
    if (!Number.isFinite(value) || value <= 0) fail("cellsPerRound." + label + " is not a positive number: " + value);
  }
  if (Number(rate.submarine) !== B) {
    fail("a submarine moves at " + rate.submarine + " and a warship at " + B + "; p.21 makes all sea units alike except transports");
  }
  // p.21: sea is faster than land, transports slightly slower than other ships.
  if (!(B > C)) fail("a warship is not faster than a transport: " + B + " vs " + C);
  if (!(C > A)) fail("a transport is not faster than infantry on open land: " + C + " vs " + A);
  // p.9: tanks are faster than infantry, and at most twice as fast.
  if (!(D > A)) fail("a tank is not faster than infantry: " + D + " vs " + A);
  if (!(D <= 2 * A)) fail("a tank is more than twice infantry: " + D + " vs " + A);

  // The accessor is what the server actually reads, so the table and the piece agree.
  const foot = { kind: "infantry", domain: "land" };
  const tank = { kind: "tank", domain: "land" };
  const hull = { kind: "cruiser", domain: "sea" };
  const sub = { kind: "submarine", domain: "sea" };
  const cargo = { kind: "infantry", domain: "land", transport: true };
  if (cellsPerRound(foot) !== A) fail("cellsPerRound(infantry) is " + cellsPerRound(foot));
  if (cellsPerRound(tank) !== D) fail("cellsPerRound(tank) is " + cellsPerRound(tank));
  if (cellsPerRound(hull) !== B) fail("cellsPerRound(cruiser) is " + cellsPerRound(hull));
  if (cellsPerRound(sub) !== B) fail("cellsPerRound(submarine) is " + cellsPerRound(sub));
  if (cellsPerRound(cargo) !== C) fail("cellsPerRound(transport) is " + cellsPerRound(cargo));
  if (cellsPerRound({ kind: "infantry", domain: "land" }) > cellsPerRound({ kind: "tank", domain: "land" })) {
    fail("the accessor orders a tank behind infantry");
  }
  if (!moveSource("cellsPerRound")) fail("moveSource(cellsPerRound) is empty");
  if (moveValue("cellsPerRound") === null) fail("moveValue(cellsPerRound) is null");

  // The accessor is only half of AC5: the table can be right and the served piece still wrong.
  // Frodo's gate on 2d7326e found `syncTransport` stamping transport=true on every hull, because
  // a cruiser is on water by definition - so a real cruiser sailed at the transport rate and
  // combat read it as cargo. Drive a real piece over real water and read the rate each round.
  const hullMatch = openMatch("1986", []);
  hullMatch.clock = "running";
  const cruiser = {
    id: "blue:hull", side: "blue", domain: "sea", kind: "cruiser",
    x: 8, y: 0, path: [], pace: 1, facing: null, fighting: null, shots: 0,
  };
  hullMatch.pieces = [cruiser];
  const hullOrder = issueOrder(hullMatch, "blue", cruiser.id, 38, 0);
  if (hullOrder.error) fail("a cruiser order along open water was refused: " + hullOrder.error);
  if (!Array.isArray(cruiser.path) || cruiser.path.length === 0) fail("a cruiser order stored no path");
  const wrapGap = (a, b) => Math.min(Math.abs(b - a), 320 - Math.abs(b - a));
  for (let round = 1; round <= 3; round++) {
    const x0 = cruiser.x;
    advance(hullMatch);
    const moved = wrapGap(x0, cruiser.x);
    if (cruiser.transport === true) {
      fail("a cruiser on water is flagged transport=true after round " + round + " - it is cargo, not a warship");
    }
    if (cellsPerRound(cruiser) !== B) {
      fail("a cruiser on water moves at " + cellsPerRound(cruiser) + " cells/round, not the warship rate " + B +
        " (round " + round + ")");
    }
    // Settled rounds are the measurement: round 1 spends the order's opening credit.
    if (round >= 2 && moved !== B) fail("a cruiser moved " + moved + " cells in settled round " + round + ", not " + B);
  }

  // A submarine is the second hull kind the same bug hit, and the PM's gate item names both.
  // Same water, same order, same expectation: a sub is a warship (rate 3), never cargo.
  const subMatch = openMatch("1986", []);
  subMatch.clock = "running";
  const diesel = {
    id: "blue:sub", side: "blue", domain: "sea", kind: "submarine",
    x: 8, y: 0, path: [], pace: 1, facing: null, fighting: null, shots: 0,
  };
  subMatch.pieces = [diesel];
  const subOrder = issueOrder(subMatch, "blue", diesel.id, 38, 0);
  if (subOrder.error) fail("a submarine order along open water was refused: " + subOrder.error);
  if (!Array.isArray(diesel.path) || diesel.path.length === 0) fail("a submarine order stored no path");
  for (let round = 1; round <= 3; round++) {
    const x0 = diesel.x;
    advance(subMatch);
    const moved = wrapGap(x0, diesel.x);
    if (diesel.transport === true) {
      fail("a submarine on water is flagged transport=true after round " + round + " - it is cargo, not a warship");
    }
    if (cellsPerRound(diesel) !== B) {
      fail("a submarine on water moves at " + cellsPerRound(diesel) + " cells/round, not the warship rate " + B +
        " (round " + round + ")");
    }
    if (round >= 2 && moved !== B) fail("a submarine moved " + moved + " cells in settled round " + round + ", not " + B);
  }

  // The other half of AC5, on a served piece: a land unit on the same water is cargo, sails at
  // the transport rate, and therefore trails the hull. Frodo's hold on 6c1c396: this was only
  // ever a synthetic object before.
  const cargoMatch = openMatch("1986", []);
  cargoMatch.clock = "running";
  const footAtSea = {
    id: "blue:cargo", side: "blue", domain: "land", kind: "infantry",
    x: 8, y: 0, path: [], pace: 1, facing: null, fighting: null, shots: 0,
  };
  cargoMatch.pieces = [footAtSea];
  const cargoOrder = issueOrder(cargoMatch, "blue", footAtSea.id, 38, 0);
  if (cargoOrder.error) fail("a land unit ordered across open water was refused: " + cargoOrder.error);
  const cargoMoved = [];
  for (let round = 1; round <= 3; round++) {
    const x0 = footAtSea.x;
    advance(cargoMatch);
    const moved = wrapGap(x0, footAtSea.x);
    cargoMoved.push(moved);
    if (footAtSea.transport !== true) {
      fail("a land unit on water is not flagged transport on round " + round + " - it would fight as if on foot");
    }
    if (cellsPerRound(footAtSea) !== C) {
      fail("a transported land unit moves at " + cellsPerRound(footAtSea) + " cells/round, not the transport rate " + C);
    }
    if (round >= 2 && moved !== C) fail("a transported land unit moved " + moved + " cells in settled round " + round + ", not " + C);
  }
  if (!(cargoMoved[1] < B)) {
    fail("a transported land unit (" + cargoMoved[1] + " cells) does not trail a hull (" + B + ") on the same water");
  }

  // ---- AC6: speeds 0-6, and speed 0 lets no time pass --------------------------------------
  const table = speedTable();
  if (table.length !== SPEED_MAX + 1) fail("the speed table has " + table.length + " slots, not 7");
  if (table[0] !== 0) fail("speed 0 is " + table[0] + " seconds, not 0");
  if (!(table[1] > 0)) fail("speed 1 is not a positive round length: " + table[1]);
  for (let speed = 2; speed <= SPEED_MAX; speed++) {
    if (!(table[speed] > 0)) fail("speed " + speed + " is not a positive round length: " + table[speed]);
    // Speed 0 is 0 s (no rounds), so the shortening is ordered from 1 upward.
    if (!(table[speed] < table[speed - 1])) fail("speed " + speed + " is not shorter than speed " + (speed - 1));
  }
  if (!(speedSeconds(6) < speedSeconds(1))) {
    fail("speed 6 (" + speedSeconds(6) + " s) is not shorter than speed 1 (" + speedSeconds(1) + " s)");
  }
  if (typeof config.sources.speeds !== "string" || !/UNMEASURED|STAND-IN/i.test(config.sources.speeds)) {
    fail("config.sources.speeds does not label the round lengths UNMEASURED");
  }

  // Speed 0 never becomes due, at any elapsed time up to three speed-1 intervals.
  const oneInterval = Math.round(speedSeconds(1) * 1000);
  for (let elapsed = 0; elapsed <= 3 * oneInterval; elapsed += 50) {
    if (speedDue(0, elapsed)) fail("speed 0 became due after " + elapsed + " ms");
  }
  if (!speedDue(1, oneInterval)) fail("speed 1 was not due after its own round length");
  if (speedDue(1, oneInterval - 1)) fail("speed 1 was due before its round length");
  const fastSlot = Math.round(speedSeconds(6) * 1000);
  if (speedDue(6, fastSlot - 1)) fail("speed 6 was due before its own round length");
  if (!speedDue(6, fastSlot)) fail("speed 6 was not due after its own round length");

  // The room's gate, replayed: speed 0 over three speed-1 intervals leaves the round counter and
  // the order where they were; speed 1 over the same window runs the rounds it should.
  const runRoom = (speed, windowMs) => {
    const match = openMatch("1986", []);
    match.clock = "running";
    const piece = match.pieces.find((unit) => unit.id === "blue:land");
    piece.path = [];
    const room = { speed, clock: "running", tickedAt: 0, match };
    for (let now = 0; now <= windowMs; now += 50) {
      if (!speedDue(room.speed, now - room.tickedAt)) continue;
      tickMatch(room.match);
      room.tickedAt = now;
    }
    return { match, piece, room };
  };

  const frozen = runRoom(0, 3 * oneInterval);
  if (frozen.match.round !== 0) fail("the round counter moved at speed 0: round " + frozen.match.round);

  // An order given at speed 0 is stored on the piece and is still there when the clock resumes.
  const atZero = openMatch("1986", []);
  atZero.clock = "running";
  const walker = atZero.pieces.find((unit) => unit.id === "blue:land");
  walker.path = [];
  const order = issueOrder(atZero, "blue", walker.id, walker.x + 2, walker.y);
  if (order.error) fail("an order was refused at speed 0: " + order.error);
  if (!Array.isArray(walker.path) || walker.path.length === 0) fail("an order at speed 0 was not stored on the piece");
  const frozenPlan = { x: walker.x, y: walker.y, path: walker.path.map((step) => ({ ...step })) };
  const roomZero = { speed: 0, clock: "running", tickedAt: 0, match: atZero };
  for (let now = 0; now <= 3 * oneInterval; now += 50) {
    if (!speedDue(roomZero.speed, now - roomZero.tickedAt)) continue;
    tickMatch(roomZero.match);
    roomZero.tickedAt = now;
  }
  if (walker.x !== frozenPlan.x || walker.y !== frozenPlan.y) fail("a piece moved at speed 0");
  if (JSON.stringify(walker.path) !== JSON.stringify(frozenPlan.path)) fail("the stored order changed at speed 0");

  const fast = runRoom(6, 3 * oneInterval);
  const slow = runRoom(1, 3 * oneInterval);
  if (!(fast.match.round > slow.match.round)) {
    fail("speed 6 ran " + fast.match.round + " rounds against speed 1's " + slow.match.round);
  }

  // What a player sees, in rounds per minute, from the same table the server uses.
  const perMinute = (speed) => Math.round(60000 / Math.max(1, Math.round(speedSeconds(speed) * 1000)));
  console.log("speeds: " + table.join(" / ") + " s; speed 1 = " + perMinute(1) + " rounds/min, speed 6 = " +
    perMinute(6) + " rounds/min; rates infantry " + A + ", transport " + C + ", warship " + B + ", tank " + D +
    "; speed 0 froze " + frozen.match.round + " rounds over " + (3 * oneInterval) + " ms");
}
