// pb324_mission_ack — a mission is an order, so its seat hears it back.
//
// What breaks if this is removed: `missionOp` delivered the strike's Log lines (PB-316) and then
// returned nothing to the seat that ordered it. Every other order replies to its own seat —
// `order` with op:"ordered", `transferPlane` with op:"transferred" — and the page clears the
// selection on exactly those frames. With no frame for a mission, the aircraft stayed selected
// after the strike resolved and the hint under the map went on saying "hover a destination to see
// the route" for a mission already flown (PB-324, PM card 10205 §3).
//
// The rule this leg pins:
//   (a) a strike ordered by a human seat draws exactly one op:"missioned" frame on THAT seat's
//       socket, carrying the order's own id, the plane and mode:"strike";
//   (b) a bomb ordered by the same seat draws the same frame with mode:"bomb" — the second mode the
//       card names, graded separately so one mode cannot carry the other;
//   (c) the other seat receives none of them (the ack is seat-scoped like its siblings);
//   (d) a replayed copy of the same order id does not draw a second ack.
//
// The lobby writes rooms to SQLite, so this node points OPENCHQ_WEB_DATA at a throwaway directory
// BEFORE importing lobby.mjs: a test must never read or write the operator's real store.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { speedSeconds } from "../../server/rules.mjs";

export const name = "pb324_mission_ack";

function fakePeer() {
  const box = [];
  return {
    box,
    closed: false,
    send(message) { box.push(message); },
    close() { this.closed = true; },
    onclose: null,
  };
}

function lastRoom(peer) {
  const frames = peer.box.filter((m) => m && (m.op === "room" || m.op === "welcome") && m.room);
  return frames.length ? frames[frames.length - 1].room : null;
}

const ackFrames = (peer) => peer.box.filter((m) => m && m.op === "missioned");

const CELL_W = 320;
const wrapCheb = (a, b) => {
  const dx = Math.abs(Number(a.x) - Number(b.x));
  return Math.max(Math.min(dx, CELL_W - dx), Math.abs(Number(a.y) - Number(b.y)));
};
const CITY_KINDS = ["city", "capital", "base"];
const isCity = (site) => CITY_KINDS.includes(String(site && site.kind));
// "A bombing run hits a city, a base, an oil field or a capital" (air.mjs).
const BOMBABLE = ["city", "capital", "base", "oilfield"];
// The restricted air radius, measured against this build rather than assumed: sendMission refuses a
// target outside 6 with its own sentence naming that number.
const RESTRICTED = 6;

// One 1942 two-human room with the clock started and then held at speed 0. 1942 opens at war; 1986
// would open in the peace, where no round runs and PB-316's at-the-order delivery does not fire.
function openRoomShell(gate, fail, tag) {
  const alice = fakePeer(); // blue, the seat that orders
  const bob = fakePeer();   // red, the seat that must hear nothing
  const a = tag + "_alice";
  const b = tag + "_bob";
  gate.join(a, alice);
  gate.join(b, bob);
  const inv = gate.handle(a, { op: "invite", user: b, era: "1942", side: "blue" });
  if (!inv || inv.error) fail("the invite failed: " + JSON.stringify(inv));
  const invite = bob.box.filter((m) => m && m.op === "invite").pop();
  if (!invite) fail("the red seat never received the invite frame");
  const acc = gate.handle(b, { op: "answer", id: invite.invite.id, accept: true });
  if (!acc || acc.error) fail("the accept failed: " + JSON.stringify(acc));
  const opening = lastRoom(alice);
  if (!opening) fail("the blue seat got no room frame after the accept");
  if (opening.blue.kind !== "human" || opening.red.kind !== "human") {
    fail("the room is not two-human: " + JSON.stringify({ blue: opening.blue, red: opening.red }));
  }
  const run0 = gate.handle(a, { op: "run" });
  if (!run0 || run0.error) fail("the clock would not start: " + JSON.stringify(run0));
  const slow = gate.handle(a, { op: "speed", speed: 0 });
  if (!slow || slow.error) fail("speed 0 was refused: " + JSON.stringify(slow));
  const sites = opening.sites || [];
  return {
    alice,
    bob,
    user: a,
    foe: b,
    roomId: opening.id,
    sites,
    blueCities: sites.filter((s) => s.owner === "blue" && isCity(s)),
    debugNow: () => gate.debugRoom(opening.id) || {},
  };
}

// A strike aims at a standing enemy unit, bought inside the restricted radius of a friendly city.
function strikeSetup(gate, fail, tag) {
  const shell = openRoomShell(gate, fail, tag);
  const { user, blueCities, debugNow } = shell;
  const pieces = debugNow().pieces || [];
  const targets = pieces.filter((p) => p.side === "red" && p.kind !== "aircraft" &&
    p.transport !== true && String(p.domain || "land") === "land");
  const pairs = [];
  for (const city of blueCities) {
    for (const target of targets) {
      const d = wrapCheb(city, target);
      if (d >= 1 && d <= RESTRICTED) pairs.push({ city, target, d });
    }
  }
  pairs.sort((p, q) => p.d - q.d);
  if (!pairs.length) {
    fail(tag + ": no enemy land unit inside " + RESTRICTED + " cells of a friendly city " +
      "(cities " + blueCities.length + ", targets " + targets.length + ")");
  }
  const before = new Set(pieces.map((p) => String(p.id)));
  for (const pair of pairs) {
    const buy = gate.handle(user, { op: "buy", kind: "aircraft", x: pair.city.x, y: pair.city.y });
    if (!buy || buy.error) continue;
    const plane = (debugNow().pieces || []).find((p) => p.side === "blue" && p.kind === "aircraft" &&
      !before.has(String(p.id)));
    if (!plane) continue;
    return { ...shell, plane, target: pair.target };
  }
  fail(tag + ": the aircraft could not buy from any city holding a strike target");
}

// The bomb arm needs an EMPTY enemy site inside the restricted radius. A fresh 1942 board has none:
// the closest pair is London -> Paris at 4 cells, and Paris is garrisoned. So the arm does what a
// player does - red walks its own garrison out of the city, blue lets one round land, then blue
// bombs the empty city. The neighbour search only accepts a cell the server actually moved to.
function bombSetup(gate, fail, tag) {
  const shell = openRoomShell(gate, fail, tag);
  const { user, blueCities, sites, debugNow } = shell;
  const shieldsOn = (site) => (debugNow().pieces || []).filter((p) => p &&
    Number(p.x) === Number(site.x) && Number(p.y) === Number(site.y) &&
    String(p.domain || "land") !== "air");
  const bombableSites = sites.filter((s) => s.owner === "red" && BOMBABLE.includes(String(s.kind)));
  const pairs = [];
  for (const city of blueCities) {
    for (const site of bombableSites) {
      const d = wrapCheb(city, site);
      if (d >= 1 && d <= RESTRICTED) pairs.push({ city, site, d });
    }
  }
  pairs.sort((p, q) => p.d - q.d);
  if (!pairs.length) fail(tag + ": no enemy site inside " + RESTRICTED + " cells of a friendly city");
  const pair = pairs[0];

  const shields = shieldsOn(pair.site);
  if (shields.length) {
    if (shields.length !== 1) {
      fail(tag + ": " + shields.length + " defenders stand on the bomb target, so the arm cannot clear it");
    }
    const shield = shields[0];
    const from = { x: Number(shield.x), y: Number(shield.y) };
    const steps = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
      [2, 0], [-2, 0], [0, 2], [0, -2]];
    let moved = false;
    for (const [dx, dy] of steps) {
      const to = { x: from.x + dx, y: from.y + dy };
      const sent = gate.handle(shell.foe, { op: "order", piece: shield.id, x: to.x, y: to.y });
      if (!sent || sent.error) continue;
      // A round at speed 1 is what actually moves the piece: a held clock only records the path.
      gate.handle(user, { op: "speed", speed: 1 });
      const now = Date.now();
      gate.tickRooms(now);
      gate.tickRooms(now + Number(speedSeconds(1)) * 1000 + 1200);
      gate.handle(user, { op: "speed", speed: 0 });
      // The check is the SITE, not the cell the order named: a second order replaces the first path,
      // and what the bombing rule reads is whether a ground or sea defender still stands there.
      if (!shieldsOn(pair.site).length) { moved = true; break; }
    }
    if (!moved) fail(tag + ": the garrison on the bomb target would not step off it");
    if (shieldsOn(pair.site).length) {
      fail(tag + ": the target site is still defended after the garrison walked: " +
        JSON.stringify(shieldsOn(pair.site)));
    }
  }

  const before = new Set((debugNow().pieces || []).map((p) => String(p.id)));
  const buy = gate.handle(user, { op: "buy", kind: "aircraft", x: pair.city.x, y: pair.city.y });
  if (!buy || buy.error) fail(tag + ": the aircraft would not buy from " + pair.city.name + ": " + JSON.stringify(buy));
  const plane = (debugNow().pieces || []).find((p) => p.side === "blue" && p.kind === "aircraft" &&
    !before.has(String(p.id)));
  if (!plane) fail(tag + ": the purchase did not put an aircraft on the board");
  return { ...shell, plane, target: pair.site };
}

function missionArm(gate, fail, mode, tag, setup) {
  const box = setup(gate, fail, tag, mode);
  const orderId = "pb324-" + mode;
  const sent = gate.handle(box.user, {
    op: "mission", piece: box.plane.id, mode, to: { x: box.target.x, y: box.target.y }, id: orderId,
  });
  if (!sent || sent.error) fail(mode + ": the mission was refused: " + JSON.stringify(sent));
  const acks = ackFrames(box.alice);
  if (acks.length !== 1) {
    fail("(" + mode + ") the ordering seat got " + acks.length + " op:\"missioned\" frames, expected " +
      "exactly 1 — the page clears the selection on that frame and nothing else: " + JSON.stringify(acks));
  }
  const ack = acks[0];
  if (String(ack.id) !== orderId) fail("(" + mode + ") the ack does not carry the order's own id: " + JSON.stringify(ack));
  if (String(ack.piece) !== String(box.plane.id)) fail("(" + mode + ") the ack names the wrong piece: " + JSON.stringify(ack));
  if (String(ack.mode) !== mode) fail("(" + mode + ") the ack reports mode " + JSON.stringify(ack.mode) + ": " + JSON.stringify(ack));
  if (ackFrames(box.bob).length !== 0) {
    fail("(" + mode + ") the other seat was sent the ack too: " + JSON.stringify(ackFrames(box.bob)));
  }
  // (d) a replayed order id must not draw a second ack: the plane is away by now, so the replay is
  // refused by the dedupe or the inactivity gate - what is graded is that the page is told once.
  gate.handle(box.user, {
    op: "mission", piece: box.plane.id, mode, to: { x: box.target.x, y: box.target.y }, id: orderId,
  });
  if (ackFrames(box.alice).length !== 1) {
    fail("(" + mode + ") a replayed order id drew a second ack: " + ackFrames(box.alice).length);
  }
}

export async function run(ctx) {
  const { fail } = ctx;
  const dir = mkdtempSync(path.join(tmpdir(), "openchq-pb324-"));
  const saved = process.env.OPENCHQ_WEB_DATA;
  process.env.OPENCHQ_WEB_DATA = dir;
  try {
    const { createLobby } = await import("../../server/lobby.mjs");
    const gate = createLobby();
    missionArm(gate, fail, "strike", "pb324s", strikeSetup);
    missionArm(gate, fail, "bomb", "pb324b", bombSetup);
  } finally {
    if (saved === undefined) delete process.env.OPENCHQ_WEB_DATA;
    else process.env.OPENCHQ_WEB_DATA = saved;
    rmSync(dir, { recursive: true, force: true });
  }
}
