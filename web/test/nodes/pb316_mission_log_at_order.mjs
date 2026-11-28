// pb316_mission_log_at_order — a strike ordered on a HELD clock resolves on the map at once, so
// both seats must read its line at the order, and read it ONCE when the round finally runs.
//
// What breaks if this is removed: `missionOp` queued the mission's events in `pendingEvents`, and
// the only consumers of that queue are `tickMatch` (tick.mjs) and the cold-war peace beat. A war at
// speed 0 runs neither, so the strike took half the target's strength and printed nothing in either
// seat's Log for as long as the clock was held - and the defender never got its own sentence at
// any speed, because the queue is drained into the round's flush, which words the event per seat.
// Measured RED at 7ba897d before the change: the attacker's `op:"log"` frames carry no strike line
// while the round is 0.
//
// The rule this leg pins (gate conditions, frodo 10175 §4):
//   (i)   the attacker's `op:"log"` frame carries "an aircraft flew a strike" while the room's
//         round stays 0 - the line is delivered at the ORDER, not by a round;
//   (ii)  the defender's own seat gets its own line ("an enemy strike went in") - a mine-only copy
//         of destinationOp's delivery writes the mover's log and would have deleted this one;
//   (iii) after ONE round at speed 1 the line is present EXACTLY ONCE in each seat - the queued
//         copy is still there for the film, and logLines is what must skip it;
//   (iv)  the event still reaches the round's film frame (appendFrame stores the tick's events and
//         film.mjs renders a replay's log from them), so the strike is not erased from the replay.
//
// The lobby writes rooms and films to SQLite, so this node points OPENCHQ_WEB_DATA at a throwaway
// directory BEFORE importing lobby.mjs: a test must never read or write the operator's real store.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const name = "pb316_mission_log_at_order";

const ATTACKER_LINE = "an aircraft flew a strike";
const DEFENDER_LINE = "an enemy strike went in";

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

// Every `log` line this socket has been handed, in arrival order. The page prints exactly these.
function logText(peer) {
  return peer.box
    .filter((m) => m && m.op === "log")
    .flatMap((m) => (Array.isArray(m.lines) ? m.lines : []).map((line) => String(line && line.text)));
}

function countLine(peer, text) {
  return logText(peer).filter((line) => line === text).length;
}

// The round the log frame itself claimed, so the arm is "the frame says 0", not "the room is 0".
function logRounds(peer) {
  return peer.box.filter((m) => m && m.op === "log").map((m) => Number(m.round));
}

const cheb = (a, b) => Math.max(Math.abs(Number(a.x) - Number(b.x)), Math.abs(Number(a.y) - Number(b.y)));
const isCity = (site) => ["city", "capital", "base"].includes(String(site && site.kind));

export async function run(ctx) {
  const { fail } = ctx;
  const dir = mkdtempSync(path.join(tmpdir(), "openchq-pb316-"));
  const saved = process.env.OPENCHQ_WEB_DATA;
  process.env.OPENCHQ_WEB_DATA = dir;
  try {
    const { createLobby } = await import("../../server/lobby.mjs");
    const { speedSeconds } = await import("../../server/rules.mjs");
    const { framesOf } = await import("../../server/history.mjs");
    // The suite imports db.mjs once, with whatever OPENCHQ_WEB_DATA the FIRST node test set, so the
    // handle this lobby wrote its frame through is the module's own - never a file named after this
    // test's directory. Read the frame from that same handle.
    const { db: sharedStore } = await import("../../server/db.mjs");
    const gate = createLobby();

    const alice = fakePeer(); // blue, the attacker
    const bob = fakePeer();   // red, the defender
    gate.join("pb316_alice", alice);
    gate.join("pb316_bob", bob);
    const inv = gate.handle("pb316_alice", { op: "invite", user: "pb316_bob", era: "1942", side: "blue" });
    if (!inv || inv.error) fail("the invite failed: " + JSON.stringify(inv));
    const invite = bob.box.filter((m) => m && m.op === "invite").pop();
    if (!invite) fail("bob never received the invite frame");
    const acc = gate.handle("pb316_bob", { op: "answer", id: invite.invite.id, accept: true });
    if (!acc || acc.error) fail("the accept failed: " + JSON.stringify(acc));
    const opening = lastRoom(alice);
    if (!opening) fail("alice got no room frame after the accept");
    if (opening.blue.kind !== "human" || opening.red.kind !== "human") {
      fail("the room is not two-human, so the defender arm cannot run: " +
        JSON.stringify({ blue: opening.blue, red: opening.red }));
    }
    const roomId = opening.id;
    // 1942 opens at war (1986 opens in the cold war, where no round runs and the peace beat would
    // drain the queue - the 1986 trap). A war at speed 0 is the state under test.
    if (Number(opening.round) !== 0) fail("the match did not open at round 0: " + opening.round);
    const run0 = gate.handle("pb316_alice", { op: "run" });
    if (!run0 || run0.error) fail("the clock would not start: " + JSON.stringify(run0));
    const slow = gate.handle("pb316_alice", { op: "speed", speed: 0 });
    if (!slow || slow.error) fail("speed 0 was refused: " + JSON.stringify(slow));
    if (Number(lastRoom(alice).round) !== 0) fail("speed 0 moved the round before any strike");

    // ---- a target and an aircraft -----------------------------------------------------------------
    // The target is a RED PIECE that already stands on the board: the board is generated per room, so
    // "buy an infantry on an empty red city" is not reproducible (a garrison may already hold every
    // city inside the radius). A strike on a standing unit is the same rule and needs no purchase.
    const sites = opening.sites || [];
    const dump0 = gate.debugRoom(roomId);
    const CELL_W = 320;
    const wrapCheb = (a, b) => {
      const dx = Math.abs(Number(a.x) - Number(b.x));
      return Math.max(Math.min(dx, CELL_W - dx), Math.abs(Number(a.y) - Number(b.y)));
    };
    const redPieces = (dump0.pieces || []).filter((p) => p.side === "red" &&
      p.kind !== "aircraft" && p.transport !== true && String(p.domain || "land") === "land");
    const blueCities = sites.filter((s) => s.owner === "blue" && isCity(s));
    const before = new Set((dump0.pieces || []).map((p) => String(p.id)));
    let target = null;
    let plane = null;
    for (const piece of redPieces) {
      const city = blueCities.find((c) => wrapCheb(c, piece) >= 1 && wrapCheb(c, piece) <= 6);
      if (!city) continue;
      const buy = gate.handle("pb316_alice", { op: "buy", kind: "aircraft", x: city.x, y: city.y });
      if (!buy || buy.error) continue;
      const fresh = (gate.debugRoom(roomId).pieces || []).find((p) => p.side === "blue" &&
        p.kind === "aircraft" && !before.has(String(p.id)));
      if (!fresh) continue;
      target = piece;
      plane = fresh;
      break;
    }
    if (!target || !plane) fail("no red land unit within the restricted air radius of a blue city the aircraft could buy from");
    const startStrength = Number(target.strength);

    // ---- (i)(ii) the strike at speed 0 -------------------------------------------------------------
    const strike = gate.handle("pb316_alice", {
      op: "mission", piece: plane.id, mode: "strike", to: { x: target.x, y: target.y }, id: "pb316-strike",
    });
    if (!strike || strike.error) fail("the strike was refused: " + JSON.stringify(strike));
    const afterStrike = gate.debugRoom(roomId);
    const targetNow = (afterStrike.pieces || []).find((p) => p.id === target.id) || {};
    if (Number(afterStrike.round) !== 0) fail("(i) the strike moved the round to " + afterStrike.round);
    // PB-348: land damage is the original's (strength >> 1) + 1, not a half of the bar.
    if (Number(targetNow.strength) !== startStrength - ((Math.floor(startStrength) >> 1) + 1)) {
      fail("the strike did not resolve on the map at speed 0: " + JSON.stringify({ before: startStrength, now: targetNow.strength })
        + " - expected " + (startStrength - ((Math.floor(startStrength) >> 1) + 1)) + " ((s>>1)+1, decompiled.c 8795-8814)");
    }
    const air0 = (lastRoom(alice).seat.air || []).find((p) => String(p.id) === String(plane.id)) || {};
    if (air0.ready !== false || Number(air0.roundsLeft) !== 8) {
      fail("the aircraft is not away for 8 rounds after the strike: " + JSON.stringify(air0));
    }

    if (countLine(alice, ATTACKER_LINE) !== 1) {
      fail("(i) the attacker's log frames do not carry exactly one \"" + ATTACKER_LINE + "\" while the " +
        "round is 0 - got " + countLine(alice, ATTACKER_LINE) + ": " + JSON.stringify(logText(alice).slice(0, 12)));
    }
    if (Number(lastRoom(alice).round) !== 0) fail("(i) the room's round left 0 with the line");
    const attackerRounds = logRounds(alice);
    if (!attackerRounds.length || attackerRounds.some((r) => r !== 0)) {
      fail("(i) a log frame carrying the strike claimed a round other than 0: " + JSON.stringify(attackerRounds));
    }
    if (countLine(bob, DEFENDER_LINE) !== 1) {
      fail("(ii) the defender's own seat has no \"" + DEFENDER_LINE + "\" line - got " +
        countLine(bob, DEFENDER_LINE) + ": " + JSON.stringify(logText(bob).slice(0, 12)));
    }
    if (countLine(bob, ATTACKER_LINE) !== 0) {
      fail("(ii) the defender was worded as the attacker: " + JSON.stringify(logText(bob).slice(0, 12)));
    }

    // ---- (iii) one round at speed 1: no second line ------------------------------------------------
    const sp = gate.handle("pb316_alice", { op: "speed", speed: 1 });
    if (!sp || sp.error) fail("speed 1 was refused: " + JSON.stringify(sp));
    const beat = Number(speedSeconds(1)) * 1000;
    const t = Date.now();
    gate.tickRooms(t);
    gate.tickRooms(t + beat + 1000);
    gate.handle("pb316_alice", { op: "sync" });
    gate.handle("pb316_bob", { op: "sync" });
    if (Number(gate.debugRoom(roomId).round) !== 1) {
      fail("(iii) the round did not advance to 1 at speed 1: " + gate.debugRoom(roomId).round);
    }
    if (countLine(alice, ATTACKER_LINE) !== 1) {
      fail("(iii) the attacker reads \"" + ATTACKER_LINE + "\" " + countLine(alice, ATTACKER_LINE) +
        " times after one round, expected exactly 1: " + JSON.stringify(logText(alice)));
    }
    if (countLine(bob, DEFENDER_LINE) !== 1) {
      fail("(iii) the defender reads \"" + DEFENDER_LINE + "\" " + countLine(bob, DEFENDER_LINE) +
        " times after one round, expected exactly 1: " + JSON.stringify(logText(bob)));
    }

    // ---- (iv) the film kept the event ---------------------------------------------------------------
    const frames = framesOf(roomId, sharedStore);
    const round1 = frames.find((row) => Number(row.round) === 1);
    if (!round1) fail("(iv) the round-1 film frame was not recorded: " + JSON.stringify(frames.map((f) => f.round)));
    const recorded = Array.isArray(round1.frame.events) ? round1.frame.events : [];
    const strikeEvent = recorded.find((event) => event && event.type === "strike");
    if (!strikeEvent) {
      fail("(iv) the film's round-1 frame lost the strike: " + JSON.stringify(recorded.map((e) => e && e.type)));
    }
    if (!recorded.some((event) => event && event.type === "strike_hit")) {
      fail("(iv) the film's round-1 frame lost the strike's hit: " + JSON.stringify(recorded.map((e) => e && e.type)));
    }
  } finally {
    if (saved === undefined) delete process.env.OPENCHQ_WEB_DATA;
    else process.env.OPENCHQ_WEB_DATA = saved;
    rmSync(dir, { recursive: true, force: true });
  }
}
