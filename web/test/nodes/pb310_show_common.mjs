// pb310_show_common — Toggle Show-Who / Show Common (manual p.35 l.1115-1120):
// "By pressing Toggle Show-Who, you can switch to 'Show Common' mode, which displays only those enemy
// units in scanning range - and only those of your units that are in the scanning range of an enemy!"
//
// What breaks if this is removed:
//   - Common is a page-side filter          -> the page keeps a second copy of the sight rule, and
//                                              the two drift the first time rules.mjs changes;
//   - Common draws every own piece          -> the manual's second half is gone (M1);
//   - Common adds an out-of-range enemy     -> the fog leak the card guards against (M2/AC d);
//   - the mirrored set forgets the witness   -> an enemy aircraft reveals a submarine, or an inactive
//     rules                                  aircraft reveals anything, or the enemy's concealed-era
//                                              memory is ignored;
//   - the off state ships a spotted set     -> the answer travels while the mode is off (AC d);
//   - a delta frame carries the toggle      -> the page merges a filtered picture into an unfiltered
//                                              shadow; the lobby must send whole frames.
//
// The spotted set is checked against an INDEPENDENT mirror written here, not against view.mjs's own
// helper: the leg would otherwise grade the payload with the code that made it.

import { openMatch } from "../../server/match.mjs";
import { forSeat } from "../../server/view.mjs";
import { sightCells } from "../../server/rules.mjs";

export const name = "pb310_show_common";

function fail(message) {
  throw new Error("node test pb310_show_common: " + message);
}

function ok(value, message) {
  if (!value) fail(message);
}

function piece(id, side, kind, x, y, extra = {}) {
  return {
    id, side, domain: kind === "submarine" || kind === "carrier" || kind === "cruiser" ? "sea" : "land",
    kind, x, y, path: [], pace: 1, facing: null, fighting: null, shots: 0, movedRound: -1,
    strength: 100, maxStrength: 100, ...extra,
  };
}

function board(pieces, extra = {}) {
  const match = openMatch("1942", []);
  match.clock = "running";
  match.round = 3;
  match.sides.blue.cash = 50000;
  match.sides.red.cash = 50000;
  match.seen = {};
  match.capitals = { blue: { x: 5, y: 5 }, red: { x: 300, y: 150 } };
  match.sites = [];
  match.pieces = pieces;
  return Object.assign(match, extra);
}

const ids = (view) => view.pieces.map((entry) => entry.id).sort();

// The mirror the card asks for, written here from the manual and rules.mjs: the witness is the
// ENEMY. Aircraft reveal only while ready; an aircraft never reveals a submarine; a submarine is
// seen only when it moved this round or is fighting; peacetime hides enemy troops entirely; in the
// concealed era the enemy's own memory gates its ordinary sight.
function mirrorSpotted(match, side) {
  const enemySide = side === "blue" ? "red" : "blue";
  const mine = match.pieces.filter((unit) => unit.side === side);
  const theirs = match.pieces.filter((unit) => unit.side !== side);
  if (match.peace && match.peace.active) return [];
  if (match.era === "9999" && !(match.seen && match.seen[enemySide])) {
    const capital = match.capitals && match.capitals[side];
    const found = capital && theirs.some((unit) => chebyshev(unit, capital) <= sightCells());
    if (!found) return [];
  }
  const out = [];
  for (const unit of mine) {
    if (unit.kind === "submarine" && Number(unit.movedRound) !== Number(match.round) && !unit.fighting) continue;
    const witness = theirs.find((own) => {
      if (chebyshev(own, unit) > sightCells()) return false;
      if (own.kind === "aircraft") {
        if (Number(own.inactiveUntil) > Number(match.round)) return false;
        if (unit.kind === "submarine") return false;
      }
      return true;
    });
    if (witness) out.push(unit.id);
  }
  return out.sort();
}

function chebyshev(a, b) {
  const rawX = Math.abs(Number(a.x) - Number(b.x));
  const width = 352;
  return Math.max(Math.min(rawX, width - rawX), Math.abs(Number(a.y) - Number(b.y)));
}

export async function run(ctx) {
  // ---- 1. the two halves of the manual's sentence ---------------------------------
  {
    const match = board([
      piece("blue:near", "blue", "tank", 10, 10),
      piece("blue:far", "blue", "tank", 40, 40),
      piece("red:watch", "red", "tank", 12, 10),      // sees blue:near, not blue:far
      piece("red:home", "red", "tank", 300, 150),
    ]);
    const normal = forSeat(match, "blue", Date.now(), null, false);
    const common = forSeat(match, "blue", Date.now(), null, true);

    ok(!("showCommon" in normal), "the off payload carries a showCommon field");
    ok(ids(normal) .includes("blue:near") && ids(normal).includes("blue:far"), "Normal lost one of my pieces: " + ids(normal));
    ok(!ids(normal).includes("red:home"), "Normal already shows an out-of-range enemy: " + ids(normal));

    ok(common.showCommon && common.showCommon.on === true, "the on payload has no showCommon.on");
    ok(JSON.stringify(common.showCommon.spotted) === JSON.stringify(mirrorSpotted(match, "blue")),
      "the spotted set is not the mirror: " + JSON.stringify(common.showCommon.spotted));
    ok(ids(common).includes("blue:near"), "Common dropped the piece an enemy can see: " + ids(common));
    ok(!ids(common).includes("blue:far"), "Common still draws my piece the enemy cannot see: " + ids(common));

    // AC (b)/(d): the enemy half is EXACTLY today's visible set, in both modes.
    const enemyNormal = normal.pieces.filter((p) => p.side === "red").map((p) => p.id).sort();
    const enemyCommon = common.pieces.filter((p) => p.side === "red").map((p) => p.id).sort();
    ok(JSON.stringify(enemyNormal) === JSON.stringify(enemyCommon),
      "the enemy set changed with the toggle: " + JSON.stringify({ enemyNormal, enemyCommon }));
    ok(!enemyCommon.includes("red:home"), "Common leaks an out-of-range enemy: " + JSON.stringify(enemyCommon));

    // The spotted field is ids only: no coordinate, no range, no count of hidden pieces.
    const blob = JSON.stringify(common.showCommon);
    ok(!/"x":|"y":|range|hidden/.test(blob), "the spotted field carries more than ids: " + blob);
  }

  // ---- 2. the witness rules are the same ones visibleEnemy applies ----------------
  {
    // An enemy aircraft that is not ready reveals nothing; ready, it reveals the tank.
    const match = board([
      piece("blue:target", "blue", "tank", 10, 10),
      piece("red:plane", "red", "aircraft", 12, 10, { inactiveUntil: 9 }),
    ]);
    const asleep = forSeat(match, "blue", Date.now(), null, true);
    ok(!ids(asleep).includes("blue:target"), "an inactive enemy aircraft spotted my tank");
    const ready = board([
      piece("blue:target", "blue", "tank", 10, 10),
      piece("red:plane", "red", "aircraft", 12, 10, { inactiveUntil: 3 }),
    ]);
    const awake = forSeat(ready, "blue", Date.now(), null, true);
    ok(ids(awake).includes("blue:target"), "a ready enemy aircraft did not spot my tank");

    // An aircraft never reveals a submarine - not even adjacent.
    const sub = board([
      piece("blue:boat", "blue", "submarine", 10, 10, { movedRound: 3 }),
      piece("red:plane", "red", "aircraft", 11, 10, { inactiveUntil: 3 }),
    ]);
    const subView = forSeat(sub, "blue", Date.now(), null, true);
    ok(!ids(subView).includes("blue:boat"), "an enemy aircraft spotted my submarine");

    // A surface witness sees a submarine only when it moved this round or is fighting.
    const still = board([
      piece("blue:boat", "blue", "submarine", 10, 10, { movedRound: -1 }),
      piece("red:cruiser", "red", "cruiser", 12, 10),
    ]);
    ok(!ids(forSeat(still, "blue", Date.now(), null, true)).includes("blue:boat"), "a still submarine was spotted by a surface ship");
    const moving = board([
      piece("blue:boat", "blue", "submarine", 10, 10, { movedRound: 3 }),
      piece("red:cruiser", "red", "cruiser", 12, 10),
    ]);
    ok(ids(forSeat(moving, "blue", Date.now(), null, true)).includes("blue:boat"), "a moving submarine was not spotted by a surface ship");
  }

  // ---- 3. peacetime hides the enemy, so nothing of mine is spotted by it -----------
  {
    const match = board([
      piece("blue:tank", "blue", "tank", 10, 10),
      piece("red:tank", "red", "tank", 11, 10),
    ], { peace: { active: true, remaining: 4, coldWar: true } });
    const common = forSeat(match, "blue", Date.now(), null, true);
    ok(common.showCommon.spotted.length === 0,
      "at peace the enemy spotted my piece, but ordinary enemy sight is off: " + JSON.stringify(common.showCommon.spotted));
  }

  // ---- 4. the concealed era gates the MIRROR with the ENEMY's memory --------------
  {
    const pieces = [
      piece("blue:tank", "blue", "tank", 10, 10),
      piece("red:tank", "red", "tank", 12, 10),
    ];
    const blind = board(pieces, { era: "9999", seen: {} });
    blind.capitals = { blue: { x: 340, y: 150 }, red: { x: 300, y: 150 } };
    ok(forSeat(blind, "blue", Date.now(), null, true).showCommon.spotted.length === 0,
      "the concealed era spotted my piece before the enemy had found my capital");
    const found = board(pieces, { era: "9999", seen: { red: true } });
    found.capitals = { blue: { x: 340, y: 150 }, red: { x: 300, y: 150 } };
    ok(forSeat(found, "blue", Date.now(), null, true).showCommon.spotted.includes("blue:tank"),
      "the enemy's own memory did not open its eyes");
  }

  // ---- 5. toggle back is exact ----------------------------------------------------
  {
    const match = board([
      piece("blue:a", "blue", "tank", 10, 10, { path: [{ x: 11, y: 10 }] }),
      piece("blue:b", "blue", "infantry", 40, 40),
      piece("red:c", "red", "tank", 12, 10),
    ]);
    // `viewPiece` stamps the piece's own strength fields on the first read (`ensureStrength`), so a
    // warm-up read is the honest baseline: on the wire every frame has already been through here.
    forSeat(match, "blue", 1000, null, false);
    const before = JSON.stringify(forSeat(match, "blue", 1000, null, false));
    forSeat(match, "blue", 1000, null, true);
    forSeat(match, "blue", 1000, null, false);
    const after = JSON.stringify(forSeat(match, "blue", 1000, null, false));
    ok(before === after, "off -> on -> off is not byte-identical");
  }

  // ---- 6. the live surface: the op, whole frames, and an exact restore -------------
  // A delta against the shadow of the other mode would hand the page a filtered picture it could not
  // merge, so the toggle must arrive as WHOLE room frames. Read here off the wire, not inferred.
  if (ctx && typeof ctx.register === "function") {
    const player = await ctx.register("pb310_common");
    const sock = ctx.socket(player.token);
    await sock.wait((m) => m.op === "welcome", "the welcome");
    const mark = sock.box.length;
    sock.send({ op: "bot", era: "1942", side: "blue" });
    const opened = await sock.wait((m) => m.op === "room" && m.room && m.room.mode === "bot",
      "the bot room", mark, 30000);
    const ownBefore = opened.room.pieces.filter((p) => p.side === "blue").map((p) => p.id).sort();
    ok(ownBefore.length > 0, "the solo war opened with no blue pieces");
    ok(!("showCommon" in opened.room), "Normal mode carried a showCommon field");

    const mark2 = sock.box.length;
    sock.send({ op: "show_common" });
    const ackOn = await sock.wait((m) => m.op === "show_common", "the on ack", mark2, 20000);
    const flipped = await sock.wait((m) => m.room && m.room.showCommon && m.room.showCommon.on === true
      && m.room.pieces !== undefined, "the Common frame", mark2, 20000);
    ok(ackOn.on === true, "the toggle ack did not say on: " + JSON.stringify(ackOn));
    ok(flipped.op === "room", "the toggle arrived as a " + flipped.op + ", not a whole room frame");
    const spotted = flipped.room.showCommon.spotted.slice().sort();
    const ownCommon = flipped.room.pieces.filter((p) => p.side === "blue").map((p) => p.id).sort();
    ok(JSON.stringify(ownCommon) === JSON.stringify(spotted),
      "the drawn own set is not the spotted set: " + JSON.stringify({ ownCommon, spotted }));
    ok(flipped.room.pieces.some((p) => p.side === "blue"), "Common drew NONE of my pieces, including the spotted ones");
    ok(ownCommon.length < ownBefore.length,
      "Common drew every own piece (the toggle did nothing): " + ownCommon.length + " of " + ownBefore.length);

    const mark3 = sock.box.length;
    sock.send({ op: "show_common" });
    const ackOff = await sock.wait((m) => m.op === "show_common", "the off ack", mark3, 20000);
    const back = await sock.wait((m) => m.op === "room" && m.room && m.room.pieces !== undefined
      && !m.room.showCommon, "the Normal frame", mark3, 20000);
    ok(ackOff.on === false, "the second press did not say off: " + JSON.stringify(ackOff));
    const ownAfter = back.room.pieces.filter((p) => p.side === "blue").map((p) => p.id).sort();
    ok(JSON.stringify(ownAfter) === JSON.stringify(ownBefore),
      "toggling back did not restore the exact own set: " + JSON.stringify({ ownBefore, ownAfter }));

    // The opponent's frame does not carry it: this is a solo room, so the check that matters is that
    // the mode lives on this seat's view only - the stored room is untouched.
    const stored = ctx.sqlite().prepare("SELECT state FROM rooms WHERE id = ?").get(String(flipped.room.id));
    const room = stored ? JSON.parse(stored.state) : null;
    ok(room && !JSON.stringify(room).includes("showCommon"), "the toggle was written onto the stored room");
  }
}
