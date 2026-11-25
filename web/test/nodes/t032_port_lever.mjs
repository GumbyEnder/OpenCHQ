// T-032 Part D / PB-258: the port-only strength lever.
// Owner: game. Design: frodo (room 9407), approved PM 9408 §2, Shane option B (9405).
//
// What breaks if this file is removed: D1-D3 go back to being prose. The lever could become a
// second implementation with its own budget, a level-1 or level-2 seat could silently get the
// bonus, or a later edit could reach a price, an income, a strength value or a sight radius from
// the lever path - which is exactly the class of cheat D3 refuses.
//
// D1: with bot.portLevers false the shipped path is executed and the event stream is row-for-row
//     the faithful one - same code, one read, sum is spareActionPassCap().
// D2: levels 1-2 take 0 from the table; a level-1 seat still stands still with the same note.
// D3: the lever path reads no price, income, strength, sight or force-advantage value, and the only
//     new config keys are portLevers / portLevelLever / portLeverSource / portLeverHelp.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { openMatch } from "../../server/match.mjs";
import { effectivePassCap, ordersFor, portLeverFor } from "../../server/bot.mjs";
import { botSpec, configPath, resetRules, spareActionPassCap } from "../../server/rules.mjs";

export const name = "t032_port_lever";

const here = path.dirname(fileURLToPath(import.meta.url));
const BOT_SOURCE = path.resolve(here, "..", "..", "server", "bot.mjs");

// Eight blue infantry with a clear run at the red capital, plus the capital's garrison. The same
// fixture the probe used: the army pass has somewhere to file, so the pass budget is the only
// thing that limits the dispatch count.
function fixture(level) {
  const match = openMatch("1942");
  match.seats = { blue: { username: "Bot", kind: "bot" }, red: { username: "Ada", kind: "human" } };
  match.opponentLevel = level;
  match.clock = "running";
  match.capitals = { blue: { x: 20, y: 40 }, red: { x: 200, y: 40 } };
  match.pieces = [];
  for (let i = 0; i < 8; i += 1) {
    match.pieces.push({
      id: "b" + i, side: "blue", domain: "land", kind: "infantry",
      x: 40 + i * 12, y: 60, path: [], pace: 1, strength: 100, maxStrength: 100,
    });
  }
  match.pieces.push({
    id: "r0", side: "red", domain: "land", kind: "infantry",
    x: 200, y: 40, path: [], pace: 1, strength: 100, maxStrength: 100,
  });
  return match;
}

// A defended board: three blue cities, each with two hostile pieces beside it and a stack of spare
// blue units 25 cells out (inside the dispatch reach, outside the own-site threat radius), cash 0 so
// botBuy stays out of the count. Same fixture as t032_bot_level's budgetRoom: the defence pass is
// the only spender, so the count of defend events is the pass budget.
function defenceFixture(level, count = 3) {
  const sites = Array.from({ length: count }, (_, index) => index + 1).map((n) => ({ id: "s" + n, name: "S" + n, kind: "city", owner: "blue", x: 20 + n * 20, y: 40 }));
  const match = {
    era: "1942",
    round: 1,
    pieces: [],
    sites,
    capitals: { blue: { x: 20, y: 40 }, red: { x: 200, y: 40 } },
    capitalSet: { list: sites.map((site) => ({ siteId: site.id, name: site.name })) },
    sides: { blue: { cash: 0, bought: 99 }, red: { cash: 0, bought: 99 } },
    seats: { blue: { kind: "bot" }, red: { kind: "human" } },
    opponentLevel: level,
  };
  for (const site of sites) {
    for (const [id, x, y] of [["a", site.x + 1, site.y], ["b", site.x, site.y + 1]]) {
      match.pieces.push({ id: "red" + site.id + id, side: "red", domain: "land", kind: "infantry", x, y, path: [], pace: 1, strength: 100, maxStrength: 100 });
    }
    for (let k = 0; k < 8; k += 1) {
      match.pieces.push({ id: "blue" + site.id + ":" + k, side: "blue", domain: "land", kind: "infantry", x: site.x - 4 + k, y: site.y + 25, path: [], pace: 1, strength: 100, maxStrength: 100 });
    }
  }
  return match;
}

function defends(level, count = 3) {
  return ordersFor(defenceFixture(level, count), "blue").filter((event) => event.type === "bot_defend").length;
}

function dispatches(level) {
  return ordersFor(fixture(level), "blue").filter((event) => event.type === "bot_order").length;
}

// A whole event stream, reduced to what a comparison can honestly pin: type, piece, destination
// and the repeat/recorded flags. Ids and timestamps are not in the stream, but sorting by piece
// keeps the compare independent of array order.
function stream(level) {
  return ordersFor(fixture(level), "blue")
    .map((event) => [event.type, event.side, event.pieceId || "", event.to ? event.to.x + "," + event.to.y : "", event.reason || ""].join("|"))
    .sort();
}

// Swap the config file the rules module memoises, and put it back even if the body throws.
function withConfig(mutate, body) {
  const original = process.env.OPENCHQ_CONFIG;
  const dir = mkdtempSync(path.join(tmpdir(), "openchq-lever-"));
  const file = path.join(dir, "game.json");
  try {
    const raw = JSON.parse(readFileSync(configPath(), "utf8"));
    if (mutate) mutate(raw.bot || (raw.bot = {}));
    writeFileSync(file, JSON.stringify(raw, null, 2));
    process.env.OPENCHQ_CONFIG = file;
    resetRules();
    return body();
  } finally {
    if (original === undefined) delete process.env.OPENCHQ_CONFIG;
    else process.env.OPENCHQ_CONFIG = original;
    resetRules();
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function run(ctx) {
  const { fail } = ctx;
  const eq = (actual, expected, label) => {
    if (actual !== expected) fail(label + ": expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
  };
  const must = (ok, why) => {
    if (!ok) fail(why);
  };

  // ---- the table is data, and it is the approved staircase -------------------------------
  const spec = botSpec();
  eq(spec.portLevers, true, "bot.portLevers must ship true (PM 9408 §2: Shane chose B)");
  const table = spec.portLevelLever || {};
  for (const [level, extra] of [[1, 0], [2, 0], [3, 1], [4, 2], [5, 3]]) {
    eq(Number(table[String(level)]), extra, "bot.portLevelLever[" + level + "]");
    eq(portLeverFor(level), extra, "portLeverFor(" + level + ")");
    eq(effectivePassCap(level), spareActionPassCap() + extra, "effectivePassCap(" + level + ")");
  }
  eq(portLeverFor(0), 0, "level 0 (ANOTHER HUMAN) has no lever");
  eq(portLeverFor(99), 0, "an unknown level has no lever");

  // ---- D2: levels 1-2 unchanged ----------------------------------------------------------
  const level1On = ordersFor(fixture(1), "blue");
  eq(level1On.length, 1, "level 1 must emit exactly its skip note");
  eq(level1On[0].type, "bot_skip", "level 1's single event is the skip note");
  eq(level1On[0].reason, "level 1 stands still: the AI pass is gated on 1 < 0x1a0", "level 1's note text");
  eq(dispatches(2), spareActionPassCap(), "level 2 must keep the faithful dispatch count");

  // ---- the lever reaches the pass: one more action per rung ------------------------------
  eq(dispatches(3), 4, "level 3 files 3 + 1 dispatches on the fixture");
  eq(dispatches(4), 5, "level 4 files 3 + 2 dispatches on the fixture");
  eq(dispatches(5), 6, "level 5 files 3 + 3 dispatches on the fixture");
  // The same channel on a board where the DEFENCE pass is the spender. With five threatened cities
  // the faithful pass answers three; level 3 answers four and level 5 five (the board's ceiling).
  eq(defends(1, 5), 0, "level 1 sends no defender");
  eq(defends(2, 5), 3, "level 2 answers exactly the faithful three cities");
  eq(defends(3, 5), 4, "level 3 answers the faithful three plus the lever's one");
  eq(defends(5, 5), 5, "level 5 answers five, the board's own ceiling");

  // ---- D1: flag off = the shipped path, row for row ------------------------------------
  const withLever = { 2: stream(2), 3: stream(3), 5: stream(5) };
  withConfig((bot) => { bot.portLevers = false; }, () => {
    eq(portLeverFor(3), 0, "flag off: portLeverFor(3) is 0");
    eq(portLeverFor(5), 0, "flag off: portLeverFor(5) is 0");
    for (const level of [1, 2, 3, 4, 5]) {
      eq(effectivePassCap(level), spareActionPassCap(), "flag off: effectivePassCap(" + level + ") is the faithful cap");
    }
    const off = { 2: stream(2), 3: stream(3), 5: stream(5) };
    eq(off[2].join("\n"), withLever[2].join("\n"), "flag off: level 2 stream is unchanged");
    must(off[3].join("\n") !== withLever[3].join("\n"), "flag off: level 3 stream must DIFFER from the lever arm (otherwise the test cannot see the lever)");
    must(off[5].join("\n") !== withLever[5].join("\n"), "flag off: level 5 stream must differ from the lever arm");
    eq(dispatches(5), spareActionPassCap(), "flag off: level 5 files the faithful 3 dispatches");
    // ...and the same stream as a config that never had the keys, which is the 2423ae6 shape.
    withConfig((bot) => { delete bot.portLevers; delete bot.portLevelLever; }, () => {
      eq(stream(5).join("\n"), off[5].join("\n"), "flag off must equal a config with no lever keys at all");
      eq(stream(1).join("\n"), level1On.map((event) => [event.type, event.side, event.pieceId || "", "", event.reason || ""].join("|")).sort().join("\n"), "flag off must equal the lever arm at level 1 (D2)");
    });
  });

  // ---- D3: one read, no new predicate, no bonus ------------------------------------------
  const source = readFileSync(BOT_SOURCE, "utf8");
  const flagReads = source.split("spec.portLevers").length - 1;
  eq(flagReads, 1, "the flag is read in exactly ONE place in bot.mjs");
  const leverBody = source.slice(source.indexOf("export function portLeverFor"), source.indexOf("export function ordersFor"));
  for (const forbidden of ["priceOf", "cityIncome", "forceAdvantageUnits", "sightCells", "strength", "cash", "budget - spent"]) {
    must(!leverBody.includes(forbidden), "the lever body must not read " + forbidden + " (D3)");
  }
  must(!/spendRepeat|buy\(|issueOrder/.test(leverBody), "the lever body must not call the buy, the repeat counter or issueOrder (D3)");
  // The faithful reporting helpers are not rewritten by this ticket: the lever adds a cap, it does
  // not move the decoded three.
  eq(spareActionPassCap(), 3, "rules.spareActionPassCap stays the faithful decoded 3");
  const leverKeys = Object.keys(spec).filter((key) => /^port/.test(key)).sort();
  eq(leverKeys.join(","), "portLevelLever,portLeverHelp,portLeverSource,portLevers", "the only new bot config keys are the four lever keys");
}
