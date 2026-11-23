// Node test for `pb202_transport_fight` (PB-202, filed room 8552).
//
// What breaks if this node is removed: a submarine and a transport sit in the same water, the
// board lists four transports as "fighting", and no exchange ever happens - the sub neither
// damages them nor takes their fire, forever. Measured live on 6f41ade, room 8552.
//
// Cause: a transport is a LAND piece at sea (move.mjs syncTransport), so it kept its land kind and
// the damage table was indexed as infantry/tank. A submarine's row (row 7 = 5,0,0,0,0,100,100,25,34)
// is 0 in those columns, and combat.mjs drops a pairing whose base is 0. The sea cargo row
// (row 5 = 0,18,16,14,0,10,10,5,5) is the row the original indexes for cargo: docs/re/COMBAT.md s3
// (0x194c maps kinds 5-6 to class 1), config combat.transportDamageKind.
//
// Rates asserted here, both table reads (T-009, live dump of 0x18f0):
//   submarine -> transport = 100 (row 7, column 5), so the first exchange sinks the transport;
//   transport -> submarine = 5 (row 5, column 7).
// The manual's claims behind them: transports are fragile against subs (manual_pages l.332, l.1222)
// and have very little combat power (l.759).

import { openMatch } from "../../server/match.mjs";
import { combatRules, seaRangeFor } from "../../server/rules.mjs";
import { resolve } from "../../server/combat.mjs";
import { logLines } from "../../server/log.mjs";

export const name = "pb202_transport_fight";

function fail(message) {
  throw new Error(message);
}

function piece(id, side, x, y, extra = {}) {
  return {
    id, side, x, y, path: [], pace: 1, facing: null, fighting: null, shots: 0,
    strength: 100, maxStrength: 100, domain: "land", kind: null,
    ...extra,
  };
}

function sub(id, side, x, y) {
  return piece(id, side, x, y, { domain: "sea", kind: "submarine" });
}

// A land piece in the water: kind stays whatever it is ashore, and the flag is the sea state.
function cargo(id, side, x, y) {
  return piece(id, side, x, y, { kind: "infantry", transport: true });
}

function fight(pieces, round = 1) {
  const match = openMatch("1986", []);
  match.clock = "running";
  match.round = round;
  match.foughtRound = round - combatRules().shotEveryRounds;
  match.pieces = pieces;
  const events = resolve(match);
  return { match, events, shots: events.filter((event) => event.type === "shot") };
}

export function run() {
  const max = combatRules().maxStrength;

  // --- AC1/AC2: one submarine against one transport -----------------------------------
  {
    const hunter = sub("blue:sub", "blue", 10, 10);
    const boat = cargo("red:cargo", "red", 11, 10);
    const { match, shots } = fight([hunter, boat]);

    const bySub = shots.filter((event) => event.pieceId === hunter.id);
    const byCargo = shots.filter((event) => event.pieceId === boat.id);
    if (bySub.length !== 1) {
      fail("the submarine did not fire once at the transport: " + JSON.stringify(bySub));
    }
    if (Number(bySub[0].amount) !== 100) {
      fail("a submarine hit a transport for " + bySub[0].amount + ", not the row 7 column 5 value of 100");
    }
    if (byCargo.length !== 1) {
      fail("the transport did not return fire: " + JSON.stringify(byCargo));
    }
    if (Number(byCargo[0].amount) !== 5) {
      fail("a transport hit a submarine for " + byCargo[0].amount + ", not the row 5 column 7 value of 5");
    }
    if (match.pieces.some((p) => p.id === boat.id)) {
      fail("the transport survived a submarine's exchange: " + JSON.stringify(match.pieces));
    }
    const dealt = 100 - Number(hunter.strength);
    if (dealt !== 5) fail("the submarine took " + dealt + ", and the table says 5");
    if (dealt >= 100) fail("the submarine took at least what it dealt (" + dealt + " vs 100)");
    if (Number(hunter.strength) > max) fail("the submarine came out stronger than it went in");
    // AC2: the read-out counter is live, not a field nobody writes.
    if (Number(hunter.shots) !== 1) fail("the submarine's shots counter reads " + hunter.shots + ", not 1");
    if (Number(boat.shots) !== 1) fail("the transport's shots counter reads " + boat.shots + ", not 1");
  }

  // --- AC2: four transports against one submarine, and no zero-shot round ---------------
  // The sub damages ONE enemy per beat and keeps it until it dies (p.22), so four transports is
  // four beats, not one. What the AC forbids is a beat on which transports are in contact and
  // nothing resolves at all: that is the live shape, and it must not come back.
  {
    const match = openMatch("1986", []);
    match.clock = "running";
    const hunter = sub("blue:sub", "blue", 10, 10);
    const boats = [0, 1, 2, 3].map((i) => cargo("red:cargo:" + i, "red", 10 + (i % 2), 10 + Math.floor(i / 2)));
    match.pieces = [hunter, ...boats];
    let fired = 0;
    let zeroBeat = null;
    for (match.round = 1; match.round <= 8; match.round++) {
      const before = match.foughtRound;
      const events = resolve(match);
      const shots = events.filter((event) => event.type === "shot");
      const alive = boats.filter((boat) => match.pieces.some((p) => p.id === boat.id)).length;
      if (shots.length > 0) fired += 1;
      else if (alive > 0 && Number(match.round) - Number(before ?? -1) >= combatRules().shotEveryRounds) {
        zeroBeat = zeroBeat ?? { round: match.round, alive };
      }
    }
    if (zeroBeat) {
      fail("a beat with " + zeroBeat.alive + " transports in contact resolved no shot at all (round " +
        zeroBeat.round + "), which is the live defect");
    }
    const survivors = boats.filter((boat) => match.pieces.some((p) => p.id === boat.id));
    if (survivors.length !== 0) {
      fail(survivors.length + " of " + boats.length + " transports were still afloat after 8 rounds");
    }
    if (fired < 4) fail("only " + fired + " firing beats for four transports");
    const taken = 100 - Number(hunter.strength);
    const takenShots = boats.reduce((sum, boat) => sum + Number(boat.shots || 0), 0);
    if (taken !== 5 * takenShots) {
      fail("the submarine took " + taken + " from " + takenShots + " landed shots, not 5 each");
    }
    if (taken >= 100 * boats.length) fail("the submarine took at least what it dealt");
  }

  // --- AC3: the round log names both sides ---------------------------------------------
  {
    const hunter = sub("blue:sub", "blue", 10, 10);
    const boat = cargo("red:cargo", "red", 11, 10);
    const { match, events } = fight([hunter, boat]);
    const lines = logLines(match, "blue", events, 1).map((row) => row.text);
    const fightLine = lines.find((text) => /submarine/.test(text) && /transport/.test(text));
    if (!fightLine) {
      fail("no log line names both sides of the fight: " + JSON.stringify(lines));
    }
    const other = logLines(match, "red", events, 1).map((row) => row.text);
    if (!other.some((text) => /submarine/.test(text) && /transport/.test(text))) {
      fail("the red seat's log does not name the fight: " + JSON.stringify(other));
    }
  }

  // --- the pairing that must stay silent: a submarine cannot engage land ---------------
  // docs/re/COMBAT.md s2.4: the sub's land column is 0, and a landed infantry is not cargo.
  {
    const hunter = sub("blue:sub", "blue", 10, 10);
    const ashore = piece("red:foot", "red", 11, 10, { kind: "infantry" });
    const { shots } = fight([hunter, ashore]);
    if (shots.some((event) => event.pieceId === hunter.id)) {
      fail("a submarine fired at infantry ashore: " + JSON.stringify(shots));
    }
    if (!shots.some((event) => event.pieceId === ashore.id)) {
      fail("the infantry ashore did not fire back at the submarine: " + JSON.stringify(shots));
    }
  }

  // --- and cargo fire follows its row: 18 against infantry ashore (row 5, column 1) -------
  {
    const boat = cargo("blue:cargo", "blue", 10, 10);
    const ashore = piece("red:foot", "red", 11, 10, { kind: "infantry" });
    const { shots } = fight([boat, ashore]);
    const byCargo = shots.find((event) => event.pieceId === boat.id);
    if (!byCargo) fail("a transport did not fire at the infantry ashore: " + JSON.stringify(shots));
    if (Number(byCargo.amount) !== 18) {
      fail("a transport hit infantry for " + byCargo.amount + ", not the row 5 column 1 value of 18");
    }
    const byFoot = shots.find((event) => event.pieceId === ashore.id);
    if (!byFoot) fail("the infantry ashore did not fire at the transport");
    // Cargo is lost on the first hit whatever the matrix cell says (combat.mjs:427), which is the
    // rule the escort legs already pin; the matrix cell here is 25 (row 1, column 5).
    if (!(Number(byFoot.amount) >= 100)) {
      fail("an infantry hit sank a transport for " + byFoot.amount + ", and the cargo rule takes all of it");
    }
  }

  // --- the range still comes from the matrix, not from a wider guess -------------------
  {
    const hunter = sub("blue:sub", "blue", 10, 10);
    const far = cargo("red:cargo", "red", 13, 10); // 3 cells: outside the sub's 2
    const { shots } = fight([hunter, far]);
    if (shots.length !== 0) fail("a submarine fired at a transport three cells away");
    if (seaRangeFor("submarine") !== 2) fail("the sub's sea range is " + seaRangeFor("submarine") + ", not 2");
  }

  console.log("pb202_transport_fight: sub -> transport 100 (the first exchange sinks it), transport -> sub 5, " +
    "4 transports -> one kill a beat, no zero-shot beat, 5 per landed shot taken, log names both sides, " +
    "sub firing at land still silent");
}
