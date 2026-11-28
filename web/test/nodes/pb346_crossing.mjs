// PB-346 — a sea crossing is ordered, lost and logged as a walk.
//
// What fails if this is removed:
//   - the order ack says "N rounds to walk" for a plan whose steps are nearly all water -> the
//     player is promised a march and gets cargo (PB-342 Arm A: an infantry ordered Vladivostok ->
//     Nagoya read "5 rounds to walk" and was a transport from its first step)
//   - the ack names a sea leg for a hull or a plane -> a cruiser sailing its own lane would be told
//     it becomes cargo, which syncTransport never does to a sea-domain piece
//   - the loss line for drowned cargo names only the hull -> "lost a transport" is the obituary of
//     the infantry the player ordered, and it cannot be tied back to the order
//   - the round's sightings can precede the loss -> the one line that matters is buried under the
//     contact lines the same round prints
//
// The board is whatever the host has (extract or the bundled world). The cell ids below are the
// archive's own 1942 opening, so the test measures the crossing instead of hand-building one; a
// host whose board has no water at the Vladivostok docks skips rather than passing on nothing.

import { boardPayload, matchSites } from "../../server/board.mjs";
import { openMatch } from "../../server/match.mjs";
import { issueOrder, planOrder } from "../../server/move.mjs";
import { tickMatch } from "../../server/tick.mjs";
import { logLines } from "../../server/log.mjs";
import { ackText } from "../../public/command.mjs";

export const name = "pb346_crossing";

const START = { x: 267, y: 39 }; // Vladivostok, blue, the opening's first infantry
const INLAND = { x: 267, y: 36 }; // three cells north, all land
const NAGOYA = { x: 270, y: 46 }; // empty red city across the water

function open() {
  const match = openMatch("1942", matchSites("1942"));
  match.clock = "running";
  match.round = 0;
  return match;
}

function opening(match) {
  return match.pieces.find((p) => p.side === "blue" && p.x === START.x && p.y === START.y) || null;
}

export async function run(ctx) {
  // The single-node driver `test/nodes/_only.mjs` runs a node with an EMPTY ctx, so a red arm there
  // must surface the sentence that names the defect instead of "fail is not a function".
  const fail = typeof ctx.fail === "function" ? ctx.fail : (message) => { throw new Error(message); };
  const skip = ctx.skip || (() => {});
  const board = boardPayload();
  if (!board || !board.cells) skip("no board on this host (neither extract nor bundled world)");

  const probe = open();
  const infantry = opening(probe);
  if (!infantry) skip("the 1942 opening has no blue piece on Vladivostok (267,39)");

  const cross = planOrder(probe, "blue", infantry.id, NAGOYA.x, NAGOYA.y);
  if (cross.error || !cross.path || cross.path.length === 0) {
    fail("the Vladivostok -> Nagoya order was refused: " + (cross.error || "empty path"));
  }
  if (!(cross.seaSteps > 0)) {
    skip("this host's board has no water on the Vladivostok -> Nagoya line");
  }
  if (cross.crossing !== true) fail("a land order whose path is mostly water was not marked a crossing");

  // ---- AC1: the ack distinguishes a march from a crossing -----------------------------------
  const walkPlan = planOrder(probe, "blue", infantry.id, INLAND.x, INLAND.y);
  if (walkPlan.error) fail("the inland order was refused: " + walkPlan.error);
  if (walkPlan.seaSteps !== 0) fail("an inland plan counted " + walkPlan.seaSteps + " water steps");
  if (walkPlan.crossing === true) fail("an inland plan was marked a crossing");
  const walkAck = ackText({ op: "ordered", rounds: walkPlan.rounds, seaSteps: walkPlan.seaSteps, crossing: walkPlan.crossing });
  if (!/^Order sent\. \d+ rounds? to walk\.$/.test(walkAck)) fail("the march ack changed shape: " + walkAck);

  // The ack the socket actually receives is the one issueOrder returns; plan and order must agree.
  const order = issueOrder(probe, "blue", infantry.id, NAGOYA.x, NAGOYA.y);
  if (order.error) fail("the crossing order was refused at issue: " + order.error);
  if (order.seaSteps !== cross.seaSteps) {
    fail("the ordered ack counted " + order.seaSteps + " sea steps, the plan " + cross.seaSteps);
  }
  if (order.crossing !== true) fail("the crossing order's ack did not carry crossing:true");
  const crossAck = ackText({ op: "ordered", ...order });
  if (crossAck === walkAck) fail("a march and a crossing print the same acknowledgement: " + crossAck);
  if (crossAck.indexOf("to cross") < 0) fail("the crossing ack does not say it crosses: " + crossAck);
  if (crossAck.indexOf(order.seaSteps + " steps are by sea") < 0) {
    fail("the crossing ack does not name its " + order.seaSteps + " sea steps: " + crossAck);
  }
  if (!/cargo/.test(crossAck) || !/one hit sinks it/.test(crossAck)) {
    fail("the crossing ack does not warn that the unit becomes cargo: " + crossAck);
  }

  // A sea piece's own lane is not a crossing: syncTransport never stamps cargo on a sea domain.
  const hull = probe.pieces.find((p) => p.side === "red" && p.domain === "sea" && p.kind === "cruiser");
  if (hull) {
    const sail = planOrder(probe, "red", hull.id, hull.x, hull.y + 6);
    if (!sail.error && sail.seaSteps > 0 && sail.crossing === true) {
      fail("a cruiser's own water lane was marked a crossing (sea piece told it becomes cargo)");
    }
  }

  // ---- NIT-2: an aircraft is air even though its DOMAIN reads "land" --------------------------
  // economy's DOMAIN_BY_KIND buys `aircraft` with domain "land" (the match's piece shape names
  // land and sea only), so a `domain === "land"` crossing test told a plane it becomes cargo. The
  // predicate is placement.layerOf, the same ground/air split combat/economy/air use.
  {
    const air = open();
    const plane = {
      id: "blue:aircraft:n2", side: "blue", domain: "land", kind: "aircraft",
      x: START.x, y: START.y, path: [], pace: 1, facing: null, fighting: null, shots: 0,
      strength: 100, maxStrength: 100,
    };
    if (air.pieces.some((p) => p.x === START.x && p.y === START.y && p.kind === "aircraft")) {
      skip("the 1942 opening already parks an aircraft on " + START.x + "," + START.y);
    }
    air.pieces.push(plane);
    const fly = planOrder(air, "blue", plane.id, NAGOYA.x, NAGOYA.y);
    if (fly.error) fail("the aircraft's order across the water was refused: " + fly.error);
    if (!(fly.seaSteps > 0)) skip("this host's board has no water on the aircraft's line");
    if (fly.crossing === true) {
      fail("an aircraft (kind aircraft, domain land) was marked a crossing over " + fly.seaSteps
        + " water steps - a plane is never cargo (NIT-2: gate on layerOf, not domain)");
    }
    const flown = issueOrder(air, "blue", plane.id, NAGOYA.x, NAGOYA.y);
    if (flown.error) fail("the aircraft's order was refused at issue: " + flown.error);
    if (flown.crossing === true) fail("the issued aircraft order carried crossing:true (a plane told it becomes cargo)");
    const flyAck = ackText({ op: "ordered", ...flown });
    if (/cargo/.test(flyAck)) fail("the aircraft's ack warns about cargo: " + flyAck);
  }

  // ---- AC2: the loss of cargo names the unit the player ordered ------------------------------
  const match = open();
  const unit = opening(match);
  const issued = issueOrder(match, "blue", unit.id, NAGOYA.x, NAGOYA.y);
  if (issued.error) fail("the crossing order was refused at issue: " + issued.error);
  if (issued.crossing !== true) fail("the issued crossing did not carry crossing:true");

  let died = null;
  let lossRound = null;
  const seen = [];
  for (let i = 0; i < 10; i++) {
    const ticked = tickMatch(match) || {};
    const events = ticked.events || [];
    const round = match.round;
    const lines = logLines(match, "blue", events, round);
    seen.push({ round, lines, events });
    const alive = match.pieces.some((p) => p.id === unit.id);
    if (!alive) {
      died = events.find((e) => e.type === "destroyed" && e.pieceId === unit.id) || null;
      lossRound = { round, lines, events };
      break;
    }
  }
  if (!died || !lossRound) fail("the ordered infantry never died on this board; the loss arm measured nothing");
  if (died.kind !== "transport") fail("the death event named kind " + died.kind + ", not the hull a player never ordered");
  if (String(died.cargoKind || "") !== String(unit.kind)) {
    fail("the death event did not carry the cargo kind (got " + died.cargoKind + ", ordered " + unit.kind + ")");
  }
  if (died.x !== undefined && died.x === START.x && died.y === START.y) {
    fail("the piece died on its starting cell; this is not a crossing arm");
  }

  const lossLines = lossRound.lines.filter((l) => /^lost /.test(l.text));
  const cargoLine = lossLines.find((l) => l.text.indexOf("cargo on a transport") >= 0) || null;
  if (!cargoLine) {
    fail("the loss round printed no cargo line; it read: " + lossLines.map((l) => l.text).join(" | "));
  }
  if (String(died.cargoKind) && cargoLine.text.indexOf(String(died.cargoKind)) < 0) {
    fail("the cargo loss line does not name the unit that was ordered: " + cargoLine.text);
  }
  if (/^lost (a|your) transport/.test(cargoLine.text)) {
    fail("the cargo loss line still reads as the hull alone: " + cargoLine.text);
  }

  // The sightings a round prints must come AFTER the loss, never before it. The arm above may have
  // no new sighting, so the witness is the same event list with the sight memory cleared: every
  // enemy currently in view is reported, and every one of those lines has to sit after the loss.
  match.sightSeen = { ...(match.sightSeen || {}), blue: [] };
  const witness = logLines(match, "blue", lossRound.events, lossRound.round);
  const lossAt = witness.findIndex((l) => l.text === cargoLine.text);
  if (lossAt < 0) fail("the cargo line is not reproducible for its own round");
  const firstSight = witness.findIndex((l) => l.tag === "spotted");
  if (firstSight < 0) fail("the arm printed no sighting line to order against");
  if (firstSight < lossAt) {
    fail("a sighting preceded the loss (sight @" + firstSight + ", loss @" + lossAt + ")");
  }

  // ---- AC2b: the only notice before the loss names the unit, and what boarding costs ---------
  const board_ = seen.find((row) => row.lines.some((l) => l.text.indexOf("boarded a transport") >= 0));
  if (!board_) fail("the crossing logged no embark line at all");
  const embark = board_.lines.find((l) => l.text.indexOf("boarded a transport") >= 0);
  if (embark.text.indexOf(String(unit.kind)) < 0) {
    fail("the embark line does not name the unit that went aboard: " + embark.text);
  }
  if (!/one hit sinks it/.test(embark.text)) fail("the embark line does not say what cargo costs: " + embark.text);
}
