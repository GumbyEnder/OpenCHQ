// Node transport_escort: the decision around the sink rule.
//
// combat.mjs already decides the outcome — under the T-003 strength model a ship loses strength per
// shot and a transport is cargo, so the first hit ends it — and the player had no way to act on it.
// This node adds the hedge: a warship told to travel with a transport, and the seat told which
// transports are crossing with nobody watching. Screening reuses the sight radius the game already
// uses; nothing here invents a number. The fixtures carry a strength bar, because that is what the
// model fights over now; the last block resolves a caught transport and shows the escort lets go.
import { orderEscort, followEscorts, unscreenedTransports, isWarship, isTransport } from "../../server/escort.mjs";
import { resolve } from "../../server/combat.mjs";
import { logLines } from "../../server/log.mjs";
import { combatRules } from "../../server/rules.mjs";
import { forSeat } from "../../server/view.mjs";

function fail(message) {
  throw new Error(message);
}

function eq(message, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) fail(message + ": " + a + " !== " + b);
}

function ship(id, side, x, y, extra = {}) {
  // A sea piece carries the strength bar the model fights over (T-003); nothing counts hits.
  const max = combatRules().maxStrength;
  return { id, side, domain: "sea", kind: "carrier", x, y, path: [], pace: 1, transport: false, strength: max, maxStrength: max, ...extra };
}

function land(id, side, x, y, extra = {}) {
  const max = combatRules().maxStrength;
  return { id, side, domain: "land", kind: "infantry", x, y, path: [], pace: 1, strength: max, maxStrength: max, ...extra };
}

function match(pieces) {
  return { round: 1, foughtRound: -1, pieces, capitals: {}, sites: [], sides: {} };
}

export const name = "transport_escort";

export async function run() {
  // --- what counts as what ----------------------------------------------------------------
  if (!isWarship(ship("s1", "blue", 10, 10))) fail("a sea piece is a warship");
  if (isWarship(ship("s1", "blue", 10, 10, { transport: true }))) fail("a transport is not a warship");
  if (isWarship(land("l1", "blue", 10, 10))) fail("a land piece is not a warship");
  if (!isTransport(land("l1", "blue", 10, 10, { transport: true }))) fail("cargo at sea is a transport");
  if (isTransport(land("l1", "blue", 10, 10))) fail("infantry ashore is not a transport");

  // --- the order forms, and a second warship replaces the first -----------------------------
  {
    const m = match([ship("a", "blue", 10, 10), land("t", "blue", 30, 30, { transport: true })]);
    const result = orderEscort(m, "blue", "a", "t");
    if (result.error) fail("the escort was refused: " + result.error);
    eq("the ship knows the transport", m.pieces[0].escorting, "t");
    eq("the transport knows the ship", m.pieces[1].escortedBy, "a");
    eq("the order posted a line for the next round", m.pendingEvents.length, 1);
    eq("the line names an escort", m.pendingEvents[0].type, "escort");
    eq("the line is the seat's own", m.pendingEvents[0].side, "blue");

    m.pieces.push(ship("b", "blue", 11, 10));
    const second = orderEscort(m, "blue", "b", "t");
    if (second.error) fail("the second escort was refused: " + second.error);
    eq("the transport names the newest escort", m.pieces[1].escortedBy, "b");
    eq("the first ship lost the duty", m.pieces[0].escorting, undefined);
  }

  // --- refusals: a non-warship, a non-transport, another side, nobody ------------------------
  {
    const m = match([
      ship("a", "blue", 10, 10),
      ship("enemy", "red", 12, 10),
      land("t", "blue", 30, 30, { transport: true }),
      land("foot", "blue", 40, 40),
      land("enemyT", "red", 50, 50, { transport: true }),
    ]);
    const notShip = orderEscort(m, "blue", "t", "t");
    if (!notShip.error) fail("a transport was allowed to escort");
    const notTransport = orderEscort(m, "blue", "a", "foot");
    if (!notTransport.error) fail("a land piece ashore was allowed to be escorted");
    const notMine = orderEscort(m, "blue", "enemy", "t");
    if (!notMine.error) fail("an enemy ship was allowed to escort");
    const notMyCargo = orderEscort(m, "blue", "a", "enemyT");
    if (!notMyCargo.error) fail("an enemy transport was accepted");
    const nobody = orderEscort(m, "blue", "a", "missing");
    if (!nobody.error) fail("a missing transport was accepted");
    const self = orderEscort(m, "blue", "a", "a");
    if (!self.error) fail("a ship was allowed to escort itself");
    eq("a refused order changes nothing", m.pieces[0].escorting, undefined);
  }

  // --- release ---------------------------------------------------------------------------
  {
    const m = match([ship("a", "blue", 10, 10), land("t", "blue", 12, 10, { transport: true })]);
    orderEscort(m, "blue", "a", "t");
    const released = orderEscort(m, "blue", "a", null);
    if (released.error) fail("the release was refused: " + released.error);
    eq("the ship is free again", m.pieces[0].escorting, undefined);
    eq("the transport is alone again", m.pieces[1].escortedBy, undefined);
  }

  // --- unscreened: the seat is told ---------------------------------------------------------
  {
    // Far apart, nothing watching: the transport is crossing naked.
    const m = match([ship("a", "blue", 5, 5), land("t", "blue", 200, 100, { transport: true })]);
    eq("an unwatched transport is unscreened", unscreenedTransports(m, "blue"), ["t"]);

    // A warship within the sight radius screens it.
    m.pieces[0].x = 195;
    m.pieces[0].y = 100;
    eq("a warship that can see it screens it", unscreenedTransports(m, "blue"), []);

    // Out of sight again, but escorted: screened anyway.
    m.pieces[0].x = 5;
    m.pieces[0].y = 5;
    eq("out of sight it is unscreened again", unscreenedTransports(m, "blue"), ["t"]);
    orderEscort(m, "blue", "a", "t");
    eq("an escorted transport is not unscreened", unscreenedTransports(m, "blue"), []);

    // X wraps: 2 cells from the seam is two cells, not 318.
    const seam = match([ship("a", "blue", 319, 50), land("t", "blue", 1, 50, { transport: true })]);
    eq("sight wraps across the seam", unscreenedTransports(seam, "blue"), []);

    // The enemy is not your problem to report.
    const both = match([
      ship("a", "blue", 5, 5),
      land("t", "blue", 200, 100, { transport: true }),
      land("et", "red", 100, 100, { transport: true }),
    ]);
    eq("only your own transports are reported", unscreenedTransports(both, "blue"), ["t"]);
    eq("the enemy's transport is his own worry", unscreenedTransports(both, "red"), ["et"]);
  }

  // --- the seat's view carries it -----------------------------------------------------------
  {
    const m = match([ship("a", "blue", 5, 5), land("t", "blue", 200, 100, { transport: true })]);
    const view = forSeat(m, "blue");
    eq("the seat view says which transport is naked", view.unscreened, ["t"]);
    orderEscort(m, "blue", "a", "t");
    eq("the view clears once escorted", forSeat(m, "blue").unscreened, []);
  }

  // --- the round log names the escort -------------------------------------------------------
  {
    const m = match([ship("a", "blue", 10, 10), land("t", "blue", 12, 10, { transport: true })]);
    orderEscort(m, "blue", "a", "t");
    const event = m.pendingEvents[0];
    const mine = logLines(m, "blue", [event], 1);
    if (!mine.length) fail("the escort produced no log line");
    if (!/escort/i.test(mine[0].text)) fail("the log line does not name the escort: " + mine[0].text);
    eq("the round is the round it happened in", mine[0].round, 1);
    const theirs = logLines(m, "red", [event], 1);
    eq("the enemy is not told about your escort", theirs.length, 0);
  }

  // --- the follower steps where the transport steps -----------------------------------------
  {
    const transport = land("t", "blue", 30, 30, { transport: true, path: [{ x: 31, y: 30, pace: 1 }] });
    const escort = ship("a", "blue", 20, 30);
    const m = match([escort, transport]);
    orderEscort(m, "blue", "a", "t");
    followEscorts(m);
    eq("the escort takes the transport's next step", escort.path, [{ x: 31, y: 30, pace: 1 }]);

    // Alongside: nothing to chase.
    escort.x = 30;
    escort.y = 31;
    followEscorts(m);
    eq("an escort alongside holds station", escort.path, []);

    // A transport that landed releases its escort.
    transport.transport = false;
    followEscorts(m);
    eq("a landed transport releases the escort", escort.escorting, undefined);
  }

  // --- a round with no escorts is untouched ------------------------------------------------
  {
    const m = match([ship("a", "blue", 10, 10)]);
    eq("nothing to follow", followEscorts(m), []);
    eq("the ship has no path", m.pieces[0].path, []);
  }

  // --- under the strength model a caught transport is cargo, and the escort lets go --------
  // The archive's six-shot rule is gone: a warship's shot is a strength hit, and cargo takes the
  // whole bar on the first one. The escort must survive that round and then release a transport
  // that is no longer there, rather than trailing a dead id.
  {
    const m = match([
      ship("escort", "blue", 10, 10, { escorting: "t" }),
      land("t", "blue", 11, 10, { transport: true, escortedBy: "escort" }),
      ship("wolf", "red", 12, 10),
    ]);
    const max = combatRules().maxStrength;
    m.round = 1;
    m.foughtRound = -1;
    resolve(m);
    const ids = m.pieces.map((piece) => piece.id);
    if (ids.includes("t")) fail("a caught transport survived the strength model's first hit");
    if (!ids.includes("escort")) fail("the escorting warship was removed by cargo it was screening");
    if (!ids.includes("wolf")) fail("a full-strength warship was removed on its first exchange");
    const wolf = m.pieces.find((piece) => piece.id === "wolf");
    if (Number(wolf.strength) >= max) fail("the enemy warship took no strength damage");
    if (Number(wolf.strength) <= 0) fail("the enemy warship lost its whole bar in one shot");
    followEscorts(m);
    const escort = m.pieces.find((piece) => piece.id === "escort");
    eq("the escort releases a transport that is gone", escort.escorting, undefined);
  }
}
