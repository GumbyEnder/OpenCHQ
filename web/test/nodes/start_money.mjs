// T-006: starting money, from the original's own setup.
//
// Two numbers, deliberately kept apart:
//   * the PLAYER's opening pool, per era, read off Monitor Four on the running original
//     (docs/re/START_MONEY.md; renderer `FUN_3711_16a8`, balance = DS:0x148e / 0x28 at 3711:16f3);
//   * the OPPONENT's starting-money spinner (Manual p.17), which is a handicap on the other side
//     and is NOT the player's cash - 1942 proves it: player 50b, spinner 030 = 30b.
//
// What breaks if this is removed: `startPool` drifts back to the unexplained 9/40 pair, a 1918 side
// can no longer afford the 10b infantry at round 1, and the spinner would silently move both sides'
// money instead of only the opponent's.
export const name = "start_money";

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handicapDefault, handicapSpec, opponentPool, startPool } from "../../server/rules.mjs";
import { openMatch } from "../../server/match.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const START_MONEY_DOC = path.join(root, "docs", "re", "START_MONEY.md");

// docs/re/START_MONEY.md, table "Era (Blue, SGT. STAN STIL)". In billions.
const PLAYER_POOL = { 1918: 10, 1942: 50, 1986: 50, 2023: 600, 9999: 50 };
// The OPPONENT'S starting-money spinner defaults. 1918 010 and 1942 030 are captured; 1986 050 is
// inferred from DS:0x148e = 2000 on both sides (no dialog capture); 2023 has no spinner (null);
// ???? showed 150 on the dialog and is UNVERIFIED (never reached the war room).
const SPINNER = { 1918: 10, 1942: 30, 1986: 50, 2023: null, 9999: 150 };

function decodeCell(message, occupied) {
  const binary = Buffer.from(String(message.mask), "base64");
  const width = Number(message.width);
  const height = Number(message.height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!binary[y * width + x]) continue;
      if (occupied.has(x + "," + y)) continue;
      return { x, y };
    }
  }
  return null;
}

export async function run(ctx) {
  const { fail } = ctx;
  const eq = (actual, expected, label) => {
    if (actual !== expected) fail(label + ": expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
  };

  // ---- 1: the document the numbers come from is in the repo, and it names each era's capture ----
  let doc = "";
  try {
    doc = readFileSync(START_MONEY_DOC, "utf8");
  } catch {
    fail("docs/re/START_MONEY.md is missing; the start-pool values have no source");
  }
  for (const [era, billions] of Object.entries(PLAYER_POOL)) {
    if (!doc.includes(String(era))) fail("START_MONEY.md does not mention era " + era);
  }
  if (!/3711:16f3/.test(doc)) fail("START_MONEY.md does not cite the balance divide at 3711:16f3");
  if (!/FUN_20b1_01b6/.test(doc)) fail("START_MONEY.md does not cite the setup write at FUN_20b1_01b6");

  // ---- 2: config carries every era, and every era carries a source ----------------------------
  const sources = (ctx.config && ctx.config.sources && ctx.config.sources.startPool) || {};
  for (const [era, billions] of Object.entries(PLAYER_POOL)) {
    eq(startPool(era), billions * 1000, "startPool(" + era + ") in millions");
    eq(startPool(era) / 1000, billions, "startPool(" + era + ") in billions");
    const source = sources[era];
    if (!source || typeof source !== "string") fail("no sources.startPool entry for " + era);
    if (/^STAND-IN\b/i.test(source.trim())) {
      fail("sources.startPool[" + era + "] is still only a stand-in: " + source);
    }
  }
  // The old unexplained pair is gone.
  if (Object.hasOwn(ctx.config.startPool, "early")) fail("config.startPool still carries the 'early' stand-in");
  // 9999 is the one era with no capture; its source must say so out loud.
  if (!/UNVERIFIED/.test(sources["9999"] || "")) fail("the ???? era must be marked UNVERIFIED in sources.startPool");
  console.log("criteria 1-2 ok: per-era player pool wired with a source; 9999 still labelled UNVERIFIED");

  // ---- 3: the spinner - default per era, range and step, and no spinner in 2023 ----------------
  const spec = handicapSpec();
  eq(spec.unit, "billion", "handicap unit");
  eq(spec.min, 0, "handicap min");
  eq(spec.max, 999, "handicap max");
  eq(spec.step, 1, "handicap step");
  for (const [era, billions] of Object.entries(SPINNER)) {
    eq(handicapDefault(era), billions, "handicapDefault(" + era + ")");
  }
  const handicapSources = (ctx.config.sources && ctx.config.sources.handicap) || {};
  if (!handicapSources.range) fail("sources.handicap has no range entry");
  if (!/UNVERIFIED/.test(handicapSources.range)) fail("the 0-999/1 range must be labelled UNVERIFIED (it was never clicked to either end)");
  console.log("criterion 3 ok: 1918 010 / 1942 030 / 1986 050 / ???? 150, 2023 none; 0-999 step 1 labelled UNVERIFIED");

  // ---- 4: the two sides open on different money, and the spinner moves only the opponent ------
  const plain = openMatch("1918", []);
  eq(plain.sides.blue.cash, 10 * 1000, "a 1918 match with no handicap: blue cash");
  eq(plain.sides.red.cash, 10 * 1000, "a 1918 match with no handicap: red cash");
  eq(plain.handicap, null, "no handicap recorded when none was set");

  const handicap1918 = openMatch("1918", [], { handicapSide: "red", opponentPool: 10 });
  eq(handicap1918.sides.blue.cash, 10 * 1000, "1918 blue (player) cash with the default spinner");
  eq(handicap1918.sides.red.cash, 10 * 1000, "1918 red (bot) cash with spinner 010");
  eq(handicap1918.handicap && handicap1918.handicap.side, "red", "the handicap side");
  eq(handicap1918.handicap.billions, 10, "the handicap the match recorded");

  // 1942 is the case that proves the spinner is the opponent's number, not the player's.
  const two = openMatch("1942", [], { handicapSide: "red", opponentPool: 30 });
  eq(two.sides.blue.cash, 50 * 1000, "1942 blue (player) opens on 50b");
  eq(two.sides.red.cash, 30 * 1000, "1942 red (bot) opens on the 030 spinner, 30b");

  // Setting the spinner to 0 must empty the bot's pool and leave the player's untouched.
  const zero = openMatch("1942", [], { handicapSide: "red", opponentPool: 0 });
  eq(zero.sides.blue.cash, 50 * 1000, "spinner 000 leaves the player's pool alone");
  eq(zero.sides.red.cash, 0, "spinner 000 empties the bot's pool");

  // The handicap follows the human's side: a Red player handicaps Blue.
  const redPlayer = openMatch("1942", [], { handicapSide: "blue", opponentPool: 5 });
  eq(redPlayer.sides.red.cash, 50 * 1000, "a Red player still opens on 50b");
  eq(redPlayer.sides.blue.cash, 5 * 1000, "a Red player's bot opens on the spinner");

  // 2023 has no spinner: the handicap cannot move either side off the large pool.
  const large = openMatch("2023", [], { handicapSide: "red", opponentPool: 0 });
  eq(large.sides.blue.cash, 600 * 1000, "2023 blue large pool");
  eq(large.sides.red.cash, 600 * 1000, "2023 red large pool (no spinner in this era)");
  eq(opponentPool("2023", null), 600 * 1000, "opponentPool(2023) with no spinner");
  console.log("criterion 4 ok: player pool and opponent spinner are separate; 2023 takes no handicap");

  // ---- 5: the served setup table is the same one the lobby draws ------------------------------
  const res = await fetch(ctx.base + "/api/setup");
  if (res.status !== 200) fail("/api/setup status " + res.status);
  const served = await res.json();
  eq(served.handicap.min, 0, "served handicap min");
  eq(served.handicap.max, 999, "served handicap max");
  eq(served.handicap.step, 1, "served handicap step");
  for (const [era, billions] of Object.entries(SPINNER)) {
    eq(served.handicap.defaults[era], billions, "served spinner default for " + era);
  }
  for (const [era, billions] of Object.entries(PLAYER_POOL)) {
    eq(served.startPool[era], billions * 1000, "served startPool for " + era);
  }

  // ---- 6: a real 1918 Blue match can buy one infantry at round 1 ------------------------------
  // The original's 1918 opening is 10 billion and an infantry costs 10 (Manual p.28), so the first
  // purchase has to be possible before any income lands. This is the whole point of the task.
  const boardRes = await fetch(ctx.base + "/api/board");
  const board = boardRes.ok ? await boardRes.json() : {};
  if (!Array.isArray(board.cells)) {
    ctx.skip("no board extract on this host, so the round-1 purchase cannot be placed");
  }
  const user = await ctx.register();
  const socket = ctx.socket(user.token);
  await socket.wait((m) => m.op === "welcome", "welcome");
  socket.send({ op: "bot", era: "1918", side: "blue", handicap: 10 });
  const opening = await socket.wait((m) => m.op === "room" && m.room && m.room.mode === "bot", "bot room");
  const room = opening.room;
  eq(room.era, "1918", "room era");
  eq(room.seat && room.seat.cash, 10 * 1000, "1918 Blue opens with 10b on the live server");
  eq(room.round, 0, "a fresh match starts held at round 0");

  const occupied = new Set((room.pieces || []).map((piece) => piece.x + "," + piece.y));
  socket.send({ op: "placement", kind: "infantry" });
  const mask = await socket.wait((m) => m.op === "placement" && m.kind === "infantry", "placement mask");
  if (mask.error || !mask.mask) fail("no placement mask in 1918: " + JSON.stringify(mask));
  const cell = decodeCell(mask, occupied);
  if (!cell) fail("the 1918 placement mask offered no free cell");

  socket.send({ op: "buy", id: "t006-first-buy", kind: "infantry", x: cell.x, y: cell.y });
  const bought = await socket.wait((m) => (m.op === "bought" && m.id === "t006-first-buy") ||
    (m.op === "error" && m.id === "t006-first-buy"), "first buy in 1918");
  if (bought.op !== "bought") fail("a 1918 Blue seat could not buy infantry at round 1: " + JSON.stringify(bought));
  eq(bought.cash, 0, "the 10b infantry leaves the 1918 pool at exactly 0");
  socket.close();
  console.log("criterion 6 ok: 1918 Blue buys the 10b infantry at round 1 and lands on 0b");

  // ---- 7: a bad spinner value is refused, not silently clamped --------------------------------
  const second = await ctx.register();
  const bad = ctx.socket(second.token);
  await bad.wait((m) => m.op === "welcome", "welcome");
  bad.send({ op: "bot", era: "1942", side: "blue", handicap: 5000 });
  const err = await bad.wait((m) => m.op === "error" || m.op === "room", "answer to an out-of-range spinner");
  if (err.op !== "error") fail("a spinner of 5000 was accepted: " + JSON.stringify(err && err.room && err.room.id));
  if (!/0 to 999/.test(String(err.message || err.error || ""))) {
    fail("the refusal does not name the range: " + JSON.stringify(err));
  }
  bad.close();
  console.log("criterion 7 ok: an out-of-range spinner is refused with the range named");
}
