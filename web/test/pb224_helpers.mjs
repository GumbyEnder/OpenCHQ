// Shared fixtures for the PB-224 satellite arms. It lives one level above web/test/nodes/ on
// purpose: the suite harness (web/test/run.mjs) loads every .mjs in nodes/ as a label, and the gate
// script (pb224-mutants.sh) parks every node that is not pb224*, so a fixture inside nodes/ would
// either be counted as a test or be parked away and turn every import into a false red. Out here it
// is invisible to both. Each AC still gets its own file and its own line, so a red names the AC that
// broke (PM 8918 §2 / 8919 §3).
//
// Nothing here asserts. `makeAsserts` counts the assertion calls a label actually made, so the row
// can carry per-label counts instead of one opaque total.

import { openMatch } from "../server/match.mjs";

export function makeAsserts(prefix) {
  let count = 0;
  const fail = (message) => {
    throw new Error(prefix + ": " + message);
  };
  const eq = (label, actual, expected) => {
    count += 1;
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) fail(label + ": " + a + " !== " + b);
  };
  const ok = (label, condition) => {
    count += 1;
    if (!condition) fail(label);
  };
  return {
    fail,
    eq,
    ok,
    total: () => count,
    line: () => prefix + ": " + count + " assertions passed",
  };
}

export const VIEW = { scale: 4, boardW: 320, boardH: 136, viewW: 640, viewH: 300, left: 0, top: 0 };

export function unit(id, side, kind, domain, x, y) {
  return { id, side, domain, kind, x, y, path: [], pace: 1, facing: null, fighting: null, shots: 0, movedRound: -1 };
}

// A 1986 board with a running clock, both purses full, and an EMPTY satellite map: a buy arm measures
// against nothing but its own purchase. The start-of-match pair is the start node's arm, not this.
export function fresh(era = "1986") {
  const match = openMatch(era, []);
  match.clock = "running";
  match.sides.blue.cash = 50000;
  match.sides.red.cash = 50000;
  match.round = 5;
  match.sites = [
    { id: 10, name: "New York", x: 80, y: 40, kind: "city", owner: "blue" },
    { id: 12, name: "Kiev", x: 200, y: 40, kind: "city", owner: "red" },
  ];
  match.capitalSet = { era, source: "fixture", list: [], missing: [] };
  match.pieces = [];
  match.satellites = [];
  return match;
}

// A ctx that records what the painter was asked to draw. The node has no canvas, and the arm's job is
// to pin what the layer DRAWS, not to re-implement a rasteriser.
export function recordingCtx() {
  const calls = { arcs: 0, text: [], rects: 0, layers: [] };
  return {
    calls,
    save() { calls.layers.push("save"); },
    restore() { calls.layers.push("restore"); },
    beginPath() {},
    stroke() {},
    fill() {},
    arc() { calls.arcs += 1; },
    fillRect() { calls.rects += 1; },
    strokeRect() { calls.rects += 1; },
    fillText(text) { calls.text.push(String(text)); },
    set strokeStyle(value) { calls.strokeStyle = value; },
    set fillStyle(value) { calls.fillStyle = value; },
    set lineWidth(value) { calls.lineWidth = value; },
    set globalAlpha(value) { calls.globalAlpha = value; },
    set font(value) { calls.font = value; },
    set textBaseline(value) { calls.textBaseline = value; },
    setLineDash() {},
  };
}

// --- the wire -----------------------------------------------------------------------------------
// The lobby's ROOM frame is what the page draws from, so an arm that reads view.forSeat can be green
// under a roomView that never forwards the field (measured: frodo's m3 at 301e7fa). These helpers
// drive createLobby() through a real invite/accept and hand back the frames the server SENT.

export function fakePeer() {
  const box = [];
  return {
    box,
    closed: false,
    send(message) { box.push(message); },
    close() { this.closed = true; },
    onclose: null,
  };
}

// A rejoin answers with a full `welcome`, not a `room` frame: both carry the room view.
export function lastRoom(peer) {
  const frames = peer.box.filter((m) => m && (m.op === "room" || m.op === "welcome") && m.room);
  return frames.length ? frames[frames.length - 1].room : null;
}

export function openRoom(gate, era, tag, prefix = "pb224") {
  const blue = fakePeer();
  const red = fakePeer();
  gate.join(tag + "_blue", blue);
  gate.join(tag + "_red", red);
  const invite = gate.handle(tag + "_blue", { op: "invite", user: tag + "_red", era, side: "blue" });
  if (!invite || invite.error) throw new Error(prefix + ": the invite for " + era + " failed: " + JSON.stringify(invite));
  const sent = red.box.filter((m) => m && m.op === "invite").pop();
  if (!sent) throw new Error(prefix + ": the red seat never received the invite frame for " + era);
  const accept = gate.handle(tag + "_red", { op: "answer", id: sent.invite.id, accept: true });
  if (!accept || accept.error) throw new Error(prefix + ": the accept for " + era + " failed: " + JSON.stringify(accept));
  for (const [who, peer] of [["blue", blue], ["red", red]]) {
    if (!lastRoom(peer)) throw new Error(prefix + ": the " + who + " seat got no room frame after the accept (" + era + ")");
  }
  return { blue, red };
}
