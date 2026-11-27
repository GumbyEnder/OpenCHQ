// pb321_log_scope — seat scope for log delivery lives in ONE helper, and `destinationOp` does not
// carry a copy of it (PB-321).
//
// What breaks if this is removed: `destinationOp` (web/server/lobby.mjs) writes `room.log[mine]`
// and sends `op:"log"` to one socket, by construction. PB-316 copied that block as its first
// template for a mission line and the defender's "an enemy strike went in" would have vanished.
// PB-316 fixed its own path by routing through `deliverSeatLog`; `destinationOp` still carries the
// template, and `transferOp` (:1720-1726) carries the same mine-only block under the AC4 comment
// (:1718-1719) — that second one is a follow-up card, not this pin's business.
//
// Why a body-scoped pin and not a file-wide count: at 7ba897d `lobby.mjs` has SIX
// `room.log[...].push(` sites and SIX `op: "log"` sends (pushes :1367 :1416 :1461 :1626 :1724
// :1765; sends :1375 :1417 :1462 :1630 :1725 :1766). Four of them belong to handlers this ticket
// does not touch (ceasefireAnswerOp, resumeWarOp, chatOp, transferOp). A file-wide "exactly one
// write site" boolean would red on those four and only green by dragging them into the build. After
// the fix the file still carries FIVE of each; what this ticket changes is which one `destinationOp`
// uses. So the counts below are scoped to two function bodies, sliced by DECLARATION OFFSET rather
// than line number — the fix moves every line under these declarations, and a line-number pin would
// go stale on the change it exists to check.
//
// The property that makes a copy fail: `destinationOp` may not contain `room.log[` or `op: "log"`
// at all. A re-inlined mine-only copy reds by construction, without a file-wide count.
//
// The text half reads one tracked file; the behaviour half builds real two-human rooms through
// `createLobby()` and hands the delivery a SYNTHETIC event set (see `debugSeatLog`, beside
// `debugRoom`). Neither half needs the extraction tree — the board comes from the baked table — so
// this file must never skip, and a bare checkout still reds at base for the named reason.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..", "..");
const lobbyPath = path.join(root, "web", "server", "lobby.mjs");

export const name = "pb321_log_scope";

function must(ok, why) {
  if (!ok) throw new Error(why);
}

function count(source, pattern) {
  return (source.match(pattern) || []).length;
}

// `function <name>(` at the factory's two-space indent, up to the next declaration at the same
// indent. Offsets, not line numbers.
function bodyOf(source, fn) {
  const decl = new RegExp("^  function " + fn + "\\(", "m").exec(source);
  must(
    decl,
    "lobby.mjs no longer declares `function " + fn + "(` at the factory's indent — the pin reads " +
      "declarations by offset and cannot find the body it is meant to check"
  );
  const rest = source.slice(decl.index + decl[0].length);
  const next = /\n  function /.exec(rest);
  must(
    next,
    "`function " + fn + "(` is the last two-space declaration in lobby.mjs — the pin slices to the " +
      "next declaration and found none"
  );
  return rest.slice(0, next.index);
}

function linesMatching(source, pattern) {
  return source.split("\n").filter((line) => pattern.test(line));
}

export async function run() {
  const file = readFileSync(lobbyPath, "utf8");

  // --- the shared helper: one declaration, one both-seat loop, one write, one send, one clamp.
  const helperDecls = count(file, /^  function deliverSeatLog\(/gm);
  must(
    helperDecls === 1,
    "lobby.mjs must declare `deliverSeatLog` exactly once at the factory's indent, found " +
      helperDecls + " — a second copy is the defect this arm exists to prevent"
  );

  const helper = bodyOf(file, "deliverSeatLog");

  // The both-seat loop, tolerant of `["blue", "red"]` and `["blue","red"]` spacing.
  const bothSeat = count(helper, /for \(const side of \["blue",\s*"red"\]\)/g);
  must(
    bothSeat === 1,
    "deliverSeatLog must carry exactly one `for (const side of [\"blue\",\"red\"])` loop, found " +
      bothSeat + " — mutant 3 (the loop removed) is what this count reds"
  );

  const writes = count(helper, /room\.log\[side\]\.push\(\.\.\.lines\)/g);
  must(
    writes === 1,
    "deliverSeatLog must carry exactly one `room.log[side].push(...lines)`, found " + writes
  );

  const sends = count(helper, /op:\s*"log"/g);
  must(
    sends === 1,
    "deliverSeatLog must carry exactly one `op: \"log\"` send, found " + sends
  );

  const clampChecks = linesMatching(helper, /room\.log\[side\]\.length > 240/);
  const clampSlices = linesMatching(helper, /\.slice\(-240\)/);
  must(
    clampChecks.length === 1 && clampSlices.length === 1,
    "deliverSeatLog must keep exactly one 240-line clamp (found " + clampChecks.length +
      " compare line(s), " + clampSlices.length + " slice line(s)) — PB-121's buffer and the " +
      "page's LOG_KEEP are the same figure"
  );

  // --- the handler: one call in, no inline block of its own. This block comes first because the
  // pre-fix tree trips it: at base `destinationOp` still carries the mine-only copy, and the red
  // should name that, not a helper the fix has not added yet.
  const destDecls = count(file, /^  function destinationOp\(/gm);
  must(destDecls === 1, "lobby.mjs must declare `destinationOp` exactly once, found " + destDecls);

  const dest = bodyOf(file, "destinationOp");
  const calls = count(dest, /deliverSeatLog\(room,/g);
  must(
    calls === 1,
    "destinationOp must route its lines through exactly one `deliverSeatLog(room, …)` call, found " +
      calls
  );

  const inlineWrites = count(dest, /room\.log\[/g);
  must(
    inlineWrites === 0,
    "destinationOp still writes `room.log[...]` itself (" + inlineWrites +
      " time(s)) — a re-inlined mine-only copy is exactly what this arm forbids; route it through " +
      "deliverSeatLog(room, result.events)"
  );

  const inlineSends = count(dest, /op:\s*"log"/g);
  must(
    inlineSends === 0,
    "destinationOp still sends `op: \"log\"` itself (" + inlineSends +
      " time(s)) — the socket frame for a log line belongs to deliverSeatLog only"
  );

  // --- the seat-scope decision is its own function, and the helper asks it.
  const scopeDecls = count(file, /^  function logSeatsFor\(/gm);
  must(
    scopeDecls === 1,
    "lobby.mjs must declare `logSeatsFor` exactly once at the factory's indent, found " +
      scopeDecls + " — the card's arm (b) puts seat scope in one pure decision, not in the " +
      "handler and not in two branches of the helper"
  );
  const scopeCalls = count(helper, /logSeatsFor\(/g);
  must(
    scopeCalls === 1,
    "deliverSeatLog must consult `logSeatsFor` exactly once, found " + scopeCalls +
      " — a helper that decides seat scope by hand is a second owner of the rule"
  );

  // --- the behaviour: the four counts above cannot see the RULE, only its shape.
  await seatScopeUnderLobby();
}

function peer(tag) {
  return {
    tag,
    box: [],
    closed: false,
    send(message) {
      this.box.push(message);
    },
    onclose() {},
  };
}

// A real two-human room off `createLobby()`: the invite/accept dance the page performs, so the
// seats are the shipped kind ("human") and the delivery's own `kind` gate is exercised.
async function twoHumanRoom(gate, tag) {
  const blue = peer(tag + "_blue");
  const red = peer(tag + "_red");
  gate.join(tag + "_blue", blue);
  gate.join(tag + "_red", red);
  const inv = gate.handle(tag + "_blue", { op: "invite", user: tag + "_red", era: "1942", side: "blue" });
  must(!(inv && inv.error), "the invite for " + tag + " was refused: " + JSON.stringify(inv));
  const invite = red.box.filter((m) => m && m.op === "invite").pop();
  must(invite && invite.invite, "the invited seat for " + tag + " never received an invite frame");
  const acc = gate.handle(tag + "_red", { op: "answer", id: invite.invite.id, accept: true });
  must(!(acc && acc.error), "the accept for " + tag + " was refused: " + JSON.stringify(acc));
  const frame = blue.box.filter((m) => m && m.op === "room" && m.room).pop();
  must(frame && frame.room, "no room frame reached the inviter for " + tag);
  const room = frame.room;
  must(
    room.blue && room.blue.kind === "human" && room.red && room.red.kind === "human",
    "the " + tag + " room is not two-human, so the seat-scope arms cannot run: " +
      JSON.stringify({ blue: room.blue, red: room.red })
  );
  return room.id;
}

// Arm (b)'s behaviour, on synthetic event sets handed to the REAL delivery. The text counts above
// are green on a build whose scope narrows EVERY event to its own side, and green on a build that
// moves `logLines` inside the `addressed` gate — this is the half that reds those two.
async function seatScopeUnderLobby() {
  const dir = mkdtempSync(path.join(tmpdir(), "openchq-pb321-"));
  const saved = process.env.OPENCHQ_WEB_DATA;
  process.env.OPENCHQ_WEB_DATA = dir;
  try {
    const { createLobby } = await import("../../server/lobby.mjs");
    const gate = createLobby();
    must(
      typeof gate.debugSeatLog === "function",
      "lobby.mjs no longer exposes `debugSeatLog(id, events)` beside `debugRoom` — the seat-log " +
        "delivery is a closure and no shipped room state carries the single-sided event set this " +
        "arm has to feed it, so without that entry point arm (b)'s rule is unmeasureable"
    );

    // (1) a NARROWED set (destination_set, the mover's own order): the mover reads its line, the
    // opponent reads none of it — and logLines still ran for the opponent, which is PB-196's
    // ordering: the builder sits OUTSIDE the `addressed` gate and only the write and the send
    // narrow. Memory first, so "the opponent's log did not grow" cannot be an accident of dedupe.
    const a = await twoHumanRoom(gate, "pb321_a");
    const narrowed = gate.debugSeatLog(a, [{ type: "destination_set", side: "blue", round: 0 }]);
    must(narrowed && narrowed.log && narrowed.log.blue && narrowed.log.red, "debugSeatLog returned no room dump");
    const destinationLines = (who) =>
      (narrowed.log[who] || []).filter((line) => /^a destination is set; it moves when the war begins$/.test(line.text)).length;
    must(
      destinationLines("blue") === 1,
      "the mover read " + destinationLines("blue") + " of its own destination lines, expected 1 — " +
        "a both-seat delivery on a narrowed set must not hide the mover's own order"
    );
    must(
      destinationLines("red") === 0,
      "the opponent read the mover's destination line " + destinationLines("red") +
        " time(s), expected 0 — p.31 keeps a peacetime destination invisible to the other seat"
    );
    for (const who of ["blue", "red"]) {
      const memory = narrowed.sightSeen && Array.isArray(narrowed.sightSeen[who]) ? narrowed.sightSeen[who] : [];
      must(
        memory.length > 0,
        "logLines did not run for seat " + who + " on a narrowed set (its sight memory is empty) — " +
          "moving the builder inside the `addressed` gate is green on the counts above and re-reports " +
          "a lost cell next round (PB-196)"
      );
    }

    // (2) ONE event, ONE side, addressed to BOTH seats: each seat reads it in its own wording.
    // This is the arm a scope that applies destination_set's rule to every event cannot satisfy.
    const both = gate.debugSeatLog(a, [{ type: "ceasefire_proposed", side: "blue", round: 0 }]);
    const own = (both.log.blue || []).filter((line) => /^cease fire proposed; your opponent must agree$/.test(line.text)).map((line) => line.text);
    const foe = (both.log.red || []).filter((line) => /^the enemy proposed a cease fire; answer it in the kit$/.test(line.text)).map((line) => line.text);
    must(
      own.length === 1 && foe.length === 1,
      "one both-seat event (ceasefire_proposed, side blue) reached the proposer and the opponent in " +
        "their own wording " + own.length + "/" + foe.length + " time(s), expected 1/1 — seat scope " +
        "for every event that is not a destination_set is BOTH seats"
    );
    must(
      own[0] !== foe[0],
      "both seats read the same sentence for a one-sided event (" + JSON.stringify(own[0] || "") +
        ") — each seat's line is built in its own voice, not delivered as one shared string"
    );

    // (3) an EMPTY set still builds both seats' logs: the clock's round refreshes each seat's sight
    // memory even when no event happened (PB-196). A `if (!events.length) return` at the top of the
    // helper is green on every count above and reds here.
    const b = await twoHumanRoom(gate, "pb321_b");
    const empty = gate.debugSeatLog(b, []);
    for (const who of ["blue", "red"]) {
      const memory = empty.sightSeen && Array.isArray(empty.sightSeen[who]) ? empty.sightSeen[who] : [];
      must(
        memory.length > 0,
        "an empty event set left seat " + who + "'s sight memory empty — logLines must still run for " +
          "each seat on a round with no events, or a stationary unit's cell looks lost and is " +
          "re-reported next round (PB-196)"
      );
      must(
        (empty.log[who] || []).length > 0,
        "an empty event set wrote no line to seat " + who + "'s log, so the round's own sightings " +
          "never reached it (PB-196: the clock's round is the delivery, not the event list)"
      );
    }
  } finally {
    if (saved === undefined) delete process.env.OPENCHQ_WEB_DATA;
    else process.env.OPENCHQ_WEB_DATA = saved;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* a temp dir is not evidence */
    }
  }
}
