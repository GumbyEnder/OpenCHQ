// Node test: PB-248 — the closing seam as the LOBBY drives it, one arm per ending.
//
// Why this file exists (frodo 9183 §4, PM 9189 §1b): t031_lifecycle calls history.closeFilm()
// directly, so it pins the helper and none of its four call sites. Measured on bfcb719: deleting
// `closeFilmNow(room)` from resignOp, or the tool path's `if (room.match.over) closeFilmNow(room)`,
// still left the suite green. A change that removes the seam shipped.
//
// Each arm starts from a STORED room, lets the real lobby restore it, and drives the ending through
// the same door main.mjs's socket handler uses (lobby.handle) or the same beat main.mjs runs
// (lobby.tickRooms):
//   1. resign         op "resign"                                    -> resignOp
//   2. cease-fire     op "tool" ceasefire, op "ceasefire_answer"     -> toolOp + ceasefireAnswerOp
//   3. nuclear winter op "tool" nuke from 18 detonations             -> toolOp (the war ends INSIDE
//                     the tool call — a path the tick can never cover)
//   4. capital capture a real tick that takes the last enemy capital -> recordFilm (the tick path,
//                     the only recorder there was before the fix)
// Every arm asserts the header closed (ended_at + final_digest), the film's last frame carrying the
// over-state, that state hashing to the recorded digest, and the arm's own events in that frame.
//
// Each arm has its OWN two accounts: the lobby maps username -> one room, so four rooms sharing two
// seats would have the last restored room answer every op (seen on the first draft of this file).
//
// Mutants this is built to red, one per arm (counts in the gate row):
//   M1 delete closeFilmNow(room) from resignOp                          -> arm 1
//   M2 delete closeFilmNow(room, result.events) from ceasefireAnswerOp  -> arm 2
//   M3 delete if (room.match.over) closeFilmNow(room) from toolOp       -> arm 3
//   M4 delete if (room.match && room.match.over) closeFilmNow(room) from recordFilm -> arm 4
//
// The winter fixture is deterministic on purpose: the global detonation count starts at 18, so the
// one launch is detonation 19 and the chance clamp (100 / (20 - 19)) is 100 — no roll can save it.

import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const name = "t031_seams";

function fail(message) {
  throw new Error(message);
}

function eq(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(label + ": expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
  }
}

const HEX64 = /^[0-9a-f]{64}$/;

export async function run() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const serverUrl = pathToFileURL(path.join(repoRoot, "web", "server")).href;
  const dir = mkdtempSync(path.join(tmpdir(), "openchq-t031-seams-"));
  const childSource = `
const u = (name) => ${JSON.stringify(serverUrl)} + "/" + name;
const history = await import(u("history.mjs"));
const { db } = await import(u("db.mjs"));
const rooms = await import(u("rooms.mjs"));
const { openMatch } = await import(u("match.mjs"));
const { matchSites } = await import(u("board.mjs"));
const { createLobby } = await import(u("lobby.mjs"));
history.ensureHistorySchema(db);

const report = {};

function makeRoom(id, era, blue, red) {
  const match = openMatch(era, matchSites(era));
  match.clock = "running";
  match.round = 6;
  match.sides.blue.cash = 900000;
  match.sides.red.cash = 900000;
  return {
    id, mode: "human", era, clock: "running", speed: 1,
    // resume:true is the deploy-drain shape: the room comes back with its clock. Three arms need a
    // running clock (the tool gate refuses a held one; the tick skips a held room).
    resume: true,
    seats: { blue: { username: blue, kind: "human" }, red: { username: red, kind: "human" } },
    match,
  };
}

const built = {
  resign: makeRoom("seam-resign", "1942", "ada", "grace"),
  // The cease-fire is part of the 1986 kit (late.mjs LATE_ERAS), so that arm plays that year.
  ceasefire: makeRoom("seam-ceasefire", "1986", "bob", "eve"),
  winter: makeRoom("seam-winter", "1986", "cy", "dot"),
  capital: makeRoom("seam-capital", "1942", "gus", "hal"),
};

// The winter fixture: one launch from 18 detonations is detonation 19, and the chance clamp is 100.
// The aim is a city red holds that is not inside blue's capital ring (the target refuses an own-home
// country cell and a capital ring, both above the charge).
built.winter.match.nukes = { detonated: 18, rngState: 1 };
const aim = built.winter.match.sites.find((site) => site && site.owner === "red" && site.kind === "city");
report.aim = aim ? { name: aim.name, x: aim.x, y: aim.y } : null;

// The capital fixture: every capital but one is already blue, and a blue infantry stands on the last
// red one. The next tick's occupy() emits the capture, and the capture is what completes the set.
const capitalRoom = built.capital;
const capitalList = capitalRoom.match.capitalSet.list;
for (const entry of capitalList) {
  const site = capitalRoom.match.sites.find((row) => Number(row.id) === Number(entry.siteId));
  if (site) site.owner = "blue";
}
const lastCapital = capitalList[capitalList.length - 1];
const lastSite = capitalRoom.match.sites.find((row) => Number(row.id) === Number(lastCapital.siteId));
lastSite.owner = "red";
capitalRoom.match.pieces = [{
  id: "capital-taker", side: "blue", domain: "land", kind: "infantry",
  x: lastSite.x, y: lastSite.y, path: [], pace: 1, facing: null, fighting: null, shots: 0,
  movedRound: -1, strength: 100,
}];
report.capitalAim = { name: lastSite.name, x: lastSite.x, y: lastSite.y };

for (const room of Object.values(built)) {
  history.startFilm(room, db);
  history.appendFrame(room, [{ type: "income", side: "blue", amount: 3, round: 5 }], db);
  report[room.id] = { roundBefore: room.match.round };
  rooms.saveRoom(room);
}

// The real boot path: the lobby restores stored rooms (seat table, film re-arm); the ops below are
// the ones a socket sends and the beat below is the one main.mjs runs.
const lobby = createLobby();
const mkPeer = () => ({ sent: [], send(value) { this.sent.push(value); }, onclose: null });
const peers = {};
for (const name of ["ada", "grace", "bob", "eve", "cy", "dot", "gus", "hal"]) {
  peers[name] = mkPeer();
  lobby.join(name, peers[name]);
}
report.joined = ["ada", "grace", "bob", "eve", "cy", "dot", "gus", "hal"].every((name) =>
  peers[name].sent.some((row) => row && row.op === "welcome"));

const readArm = (id, result) => {
  const header = history.filmMeta(id, db);
  const frames = history.framesOf(id, db);
  const last = frames.length ? frames[frames.length - 1].frame : null;
  const out = report[id];
  out.result = result;
  out.frameRounds = frames.map((row) => row.round);
  out.endedAt = header ? header.ended_at : null;
  out.digest = header ? header.final_digest : null;
  out.headerRounds = header ? header.rounds : null;
  out.digestMatches = Boolean(last && header && last.state && history.digestOf(last.state) === header.final_digest);
  out.lastStateOver = Boolean(last && last.state && last.state.over === true);
  out.lastFrameRound = last ? last.round : null;
  out.lastEventTypes = last && Array.isArray(last.events) ? last.events.map((event) => event.type) : [];
  return out;
};

// ---- 1. capital capture: the TICK path (recordFilm) -----------------------------------
// Two calls: the first seeds the room's beat (tickRooms stamps tickedAt and returns), the second is
// due, advances exactly one round, takes the capital and ends the war.
const t0 = Date.now();
lobby.tickRooms(t0);
lobby.tickRooms(t0 + 60000);
const capitalAfter = lobby.debugRoom("seam-capital");
report.capitalTicked = capitalAfter ? { round: capitalAfter.round, over: capitalAfter.over } : null;
readArm("seam-capital", { ok: Boolean(capitalAfter && capitalAfter.over) });

// ---- 2. resign ------------------------------------------------------------------------
readArm("seam-resign", lobby.handle("ada", { op: "resign" }));

// ---- 3. cease-fire: propose with the kit, accept from the other seat -------------------
report.proposed = lobby.handle("bob", { op: "tool", tool: "ceasefire" });
readArm("seam-ceasefire", lobby.handle("eve", { op: "ceasefire_answer", accept: true }));

// ---- 4. nuclear winter, ended inside the tool call ------------------------------------
report.nuked = lobby.handle("cy", {
  op: "tool",
  tool: "nuke",
  to: aim ? { x: aim.x, y: aim.y } : { x: 0, y: 0 },
});
readArm("seam-winter", report.nuked);
const winterRoom = lobby.debugRoom("seam-winter");
report.winterPendingLeft = winterRoom ? (winterRoom.pendingEvents || []).length : null;

lobby.flushAll();
db.close();
console.log("SEAMS_REPORT " + JSON.stringify(report));
`;

  const childRun = spawnSync(process.execPath, ["--input-type=module", "-e", childSource], {
    cwd: repoRoot,
    env: { ...process.env, OPENCHQ_WEB_DATA: dir },
    encoding: "utf8",
    timeout: 120000,
  });
  if (childRun.status !== 0) {
    fail("the seam child exited " + childRun.status + ": " + String(childRun.stderr || childRun.stdout).slice(-1600));
  }
  const line = String(childRun.stdout || "").split("\n").find((row) => row.startsWith("SEAMS_REPORT "));
  if (!line) fail("the seam child printed no report: " + String(childRun.stdout).slice(-1200) + String(childRun.stderr).slice(-1200));
  const report = JSON.parse(line.slice("SEAMS_REPORT ".length));

  eq(report.joined, true, "all eight seats joined the lobby");
  eq(Boolean(report.aim), true, "the winter fixture found an enemy city to aim at");
  eq(Boolean(report.capitalAim), true, "the capital fixture found the last enemy capital");
  eq(report.proposed && report.proposed.ok, true, "the cease-fire proposal was accepted by the kit (" + JSON.stringify(report.proposed) + ")");
  eq(report.capitalTicked && report.capitalTicked.over, true, "the tick took the last capital and ended the war");

  const arms = [
    // The tick arm's closing frame is the round the capture happened in, and it carries the tick's
    // own events: the capture and the win.
    { id: "seam-capital", label: "capital capture (tick)", events: ["capture", "win"], grew: true },
    { id: "seam-resign", label: "resign", events: [] },
    { id: "seam-ceasefire", label: "cease-fire", events: ["ceasefire_accepted"] },
    // The nuke and the winter are two events: the strike, and the sentence that ends the war.
    { id: "seam-winter", label: "nuclear winter", events: ["nuke", "nuclear_winter"] },
  ];

  for (const arm of arms) {
    const got = report[arm.id];
    const result = got.result || {};
    if (result.error) fail(arm.label + " op refused: " + result.error);
    eq(result.ok, true, arm.label + " answered ok");
    eq(got.endedAt !== null && got.endedAt !== undefined && got.endedAt !== "", true, arm.label + ": ended_at was written");
    eq(HEX64.test(String(got.digest || "")), true, arm.label + ": final_digest is a 64-char hex string (" + got.digest + ")");
    // The tick arm advances exactly one round; the op arms end on whatever round their room was on
    // when the op ran (the shared tick above may have advanced it once).
    eq(got.lastFrameRound, got.headerRounds, arm.label + ": the closing frame is the round the film ends on");
    if (arm.grew) eq(got.headerRounds, got.roundBefore + 1, arm.label + ": the tick advanced exactly one round");
    else eq(got.headerRounds >= got.roundBefore, true, arm.label + ": the film ends on or after its first round (" + got.headerRounds + ")");
    eq(got.lastStateOver, true, arm.label + ": the film's last frame carries the over state");
    eq(got.digestMatches, true, arm.label + ": that frame's state hashes to the recorded digest");
    for (const type of arm.events) {
      eq(got.lastEventTypes.includes(type), true, arm.label + ": the closing frame carries '" + type + "' (" + got.lastEventTypes.join(",") + ")");
    }
  }

  // The winter arm's queued events must be DRAINED into the closing frame, not left to a tick that
  // never runs for a finished room.
  eq(report.winterPendingLeft, 0, "the winter arm's pending events were drained by the closing frame");
}
