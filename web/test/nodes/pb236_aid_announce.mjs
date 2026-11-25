// Node test for PB-236: only LARGE nations make it known that they received foreign aid.
//
// What breaks if this node is removed: every gift into every nation announces itself to the other
// seat, so a small-nation campaign is as loud as a superpower's and the manual's asymmetry (p.30:
// "only large countries make it known that they have received foreign aid") is gone. The defect is
// one `legible()` in `web/server/log.mjs` `case "aid"`: the old line was announced for every
// nation whatever its size.
//
// The size cut is a STAND-IN (the archive prints no cut), so the node pins three things about it:
//   - the shipped config carries an integer cut and says STAND-IN in its own note and in
//     `sources.loyalty`, with the manual sentence quoted (AC1);
//   - a cut the config cannot supply announces NOTHING rather than guessing (fail-quiet);
//   - a nation at the cut is large, one city below it is not (the boundary, not a vibe).
//
// Arms, all through the production door (`late.useTool` -> `log.logLines`), never a re-implemented
// line builder:
//   1. blue gifts into a LARGE nation: RED reads the announcement naming the nation, and it names
//      no giver and no amount (AC2, direction 1);
//   2. red gifts into a LARGE nation: BLUE reads it (AC2, direction 2);
//   3. the same two nations SMALL: the other seat reads nothing at all, in both directions (AC2);
//   4. the payer's own line is present and unchanged in all four cases (they paid for it);
//   5. the cancel composite: red banks a gift first, blue's gift cancels it, and the announcement
//      is still driven by the nation's SIZE - it neither disappears nor mentions the cancel (AC3);
//   6. fog: a large nation with the reading seat's nearest piece outside `sightCells` is silent,
//      while the same gift with the piece inside sight is announced. The arm is labelled with the
//      gate it exercises: gate 1 = size, gate 2 = `legible()` (AC4);
//   7. the announcement changes nothing: owners, ledgers and the purse are identical across the
//      `logLines` call that carries it (AC5).

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { boardPayload } from "../../server/board.mjs";
import { openMatch } from "../../server/match.mjs";
import { announceFromCities, resetRules, rules, sightCells } from "../../server/rules.mjs";
import { nationOf, useTool } from "../../server/late.mjs";
import { logLines } from "../../server/log.mjs";
import { countryName } from "../../server/countries.mjs";

export const name = "pb236_aid_announce";

const ANNOUNCE = /reports receiving foreign aid/;

function fail(message) {
  throw new Error(message);
}

function eq(message, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) fail(message + ": " + a + " !== " + b);
}

function must(ok, message) {
  if (!ok) fail(message);
}

// The same config swap the other nodes use, here to REMOVE the size cut: the rules are cached, so
// the file is rewritten and the cache reset, then the environment is put back.
function withoutCut(patch) {
  const custom = JSON.parse(JSON.stringify(rules()));
  patch(custom);
  const dir = mkdtempSync(path.join(tmpdir(), "pb236-"));
  const file = path.join(dir, "game.json");
  writeFileSync(file, JSON.stringify(custom, null, 2));
  const previous = process.env.OPENCHQ_CONFIG;
  process.env.OPENCHQ_CONFIG = file;
  resetRules();
  return () => {
    if (previous === undefined) delete process.env.OPENCHQ_CONFIG;
    else process.env.OPENCHQ_CONFIG = previous;
    resetRules();
    rmSync(dir, { recursive: true, force: true });
  };
}

function fixture(payload) {
  const match = openMatch("1986", payload.sites, {});
  match.clock = "running";
  match.round = 4;
  match.over = false;
  match.sides = { blue: { cash: 900000 }, red: { cash: 900000 } };
  match.pieces = [];
  match.satellites = [];
  return match;
}

// Every nation on the board, keyed the way `late.nationOf` keys it, with its city list.
function nations(match) {
  const seen = new Map();
  for (const site of match.sites || []) {
    if (!site || site.kind !== "city") continue;
    const nation = nationOf(match, site);
    if (!seen.has(nation.key)) seen.set(nation.key, nation);
  }
  return [...seen.values()];
}

// A city of this nation that `side` can actually gift to, found by asking the engine on a throwaway
// match (aid has its own refusals - a city in the other side's home country, a city you already own
// - and the arm must not depend on which ones this board happens to trip).
function aidableCity(payer, nation, payload) {
  for (const city of nation.cities) {
    const scratch = fixture(payload);
    const trial = useTool(scratch, payer, "aid", { x: city.x, y: city.y });
    if (trial.ok) return city;
  }
  return null;
}

// A piece of `side` placed so that `legible()` sees the gift's cell.
function watcherAt(match, side, x, y, offset = 0) {
  const piece = {
    id: "watch-" + side + "-" + x + "-" + y, side, kind: "infantry",
    x: (x + offset + 320) % 320, y, domain: "land", path: [], pace: 1, strength: 100,
  };
  match.pieces.push(piece);
  return piece;
}

function linesFor(match, side, events) {
  return logLines(match, side, events, match.round).map((line) => String(line.text));
}

export async function run(ctx) {
  const payload = boardPayload();
  must(Boolean(payload && payload.sites), "the board has no sites");

  // --- 0. the cut is config, is labelled, and is the boundary the arms below assume --------------
  const cut = announceFromCities();
  must(Number.isInteger(cut) && cut >= 2, "config loyalty.announceFromCities is not an integer >= 2: " + cut);
  const loyalty = rules().loyalty || {};
  must(typeof loyalty.note === "string" && /STAND-?IN/i.test(loyalty.note),
    "config loyalty.note does not label announceFromCities a STAND-IN");
  must(/only large countries make it known/i.test(loyalty.note),
    "config loyalty.note does not quote manual p.30's announcement sentence");
  must(/announceFromCities/.test(loyalty.note), "config loyalty.note does not name the key it labels");
  const sources = (rules().sources || {}).loyalty || "";
  must(/STAND-?IN/i.test(sources) && /announceFromCities/.test(sources),
    "config sources.loyalty does not carry the PB-236 stand-in label");
  // PB-236 (PM 9011 AC3, re-stated in PM 9031 §2(a)): the shipped cut is 4 cities and it is
  // INCLUSIVE. Pinned exactly, not as "an integer": 5 is a different rule, and no nation on the
  // archive board sits at 4, so this line is the only witness that would red on a drift to 5.
  // The full 1986 census and the 2023 rule live in the card (PM 9031 §2(b)).
  eq("the shipped size cut is 4 cities (PM 9011 AC3), inclusive", cut, 4);

  // The nations this board actually offers, one on each side of the cut.
  const probe = fixture(payload);
  const rows = nations(probe)
    .map((nation) => ({ nation, size: nation.cities.length }))
    .sort((a, b) => b.size - a.size);
  const large = rows.find((row) => row.size >= cut);
  const small = rows.filter((row) => row.size < cut).sort((a, b) => b.size - a.size)[0];
  must(Boolean(large), "no nation on this board is at or above the cut (" + cut + ")");
  must(Boolean(small), "no nation on this board is below the cut (" + cut + ")");
  const largeName = countryName(large.nation.country) || "a nation";
  const largeCity = aidableCity("blue", large.nation, payload) || aidableCity("red", large.nation, payload);
  const smallCity = aidableCity("blue", small.nation, payload) || aidableCity("red", small.nation, payload);
  must(Boolean(largeCity), "no city of the large nation (" + largeName + ") is aidable by either side");
  must(Boolean(smallCity), "no city of a small nation is aidable by either side");

  // --- 0b. the inclusive boundary the archive board CANNOT exercise ---------------------------
  // No nation on the shipped 1986 or 2023 board has exactly four cities (13, 10, 5, 3, 3, 2, 2,
  // 2 and 22 x 1), so a cut of 4 and a cut of 5 name the same three nations here. The boundary is
  // therefore pinned through the production log path with a synthetic event carrying the nation's
  // own count: 4 announces (at the cut), 3 stays quiet (below it). Same two gates as the real
  // arms - the watcher makes the cell legible, so only the size test moves.
  {
    const site = (payload.sites || []).find((s) => s && s.kind === "city");
    must(Boolean(site), "the board has no city site for the boundary arm");
    for (const [cities, want] of [[4, true], [3, false]]) {
      const m = fixture(payload);
      watcherAt(m, "red", site.x, site.y);
      const event = [{ type: "aid", side: "blue", x: site.x, y: site.y, country: 14, cities, name: "boundary" }];
      const got = linesFor(m, "red", event).some((line) => ANNOUNCE.test(line));
      eq("boundary: a " + cities + "-city nation " + (want ? "announces" : "stays quiet") + " at the cut", got, want);
    }
  }

  // --- 1 + 2 + 3 + 4. both directions, large and small ----------------------------------------
  for (const payer of ["blue", "red"]) {
    const reader = payer === "blue" ? "red" : "blue";
    const city = aidableCity(payer, large.nation, payload);
    must(Boolean(city), "the large nation has no city " + payer + " can gift to");
    const match = fixture(payload);
    watcherAt(match, reader, city.x, city.y);       // gate 2 (fog) satisfied: the reader can see it
    const before = match.sides[payer].cash;
    const gift = useTool(match, payer, "aid", { x: city.x, y: city.y });
    must(gift.ok === true, payer + "'s gift to the large nation was refused: " + JSON.stringify(gift));
    const events = gift.events;
    const readerLines = linesFor(match, reader, events);
    const payerLines = linesFor(match, payer, events);
    const announce = readerLines.filter((line) => ANNOUNCE.test(line));
    eq(payer + " -> large: the other seat reads exactly one announcement", announce.length, 1);
    must(announce[0].includes(largeName), "the announcement does not name the nation " + largeName + ": " + announce[0]);
    must(!/gave|giver|paid|billion/i.test(announce[0]),
      "the announcement leaks the giver or the amount: " + announce[0]);
    eq(payer + " -> large: the announcement names no cancel", /cancel/i.test(announce[0]), false);
    eq(payer + " -> large: the payer reads their own line", payerLines.some((line) => /^aid reached /.test(line)), true);
    eq(payer + " -> large: the payer reads no announcement about their own gift",
      payerLines.some((line) => ANNOUNCE.test(line)), false);
    eq(payer + " -> large: the gift charged the payer", match.sides[payer].cash < before, true);

    // The same shape for a SMALL nation: the reader gets nothing, the payer's line still lands.
    const smallCity2 = aidableCity(payer, small.nation, payload);
    must(Boolean(smallCity2), "the small nation has no city " + payer + " can gift to");
    const quiet = fixture(payload);
    watcherAt(quiet, reader, smallCity2.x, smallCity2.y);
    const quietGift = useTool(quiet, payer, "aid", { x: smallCity2.x, y: smallCity2.y });
    must(quietGift.ok === true, payer + "'s gift to the small nation was refused: " + JSON.stringify(quietGift));
    const quietReader = linesFor(quiet, reader, quietGift.events);
    eq(payer + " -> small: the other seat reads nothing about the gift",
      quietReader.some((line) => ANNOUNCE.test(line) || /^aid reached |enemy aid/.test(line)), false);
    eq(payer + " -> small: the payer still reads their own line",
      linesFor(quiet, payer, quietGift.events).some((line) => /^aid reached /.test(line)), true);
  }

  // --- 5. the cancel composite: announced by SIZE, not by the cancel ---------------------------
  {
    const city = aidableCity("blue", large.nation, payload);
    const match = fixture(payload);
    watcherAt(match, "red", city.x, city.y);
    const rival = useTool(match, "red", "aid", { x: city.x, y: city.y });
    must(rival.ok === true, "red's banked gift was refused: " + JSON.stringify(rival));
    const mine = useTool(match, "blue", "aid", { x: city.x, y: city.y });
    must(mine.ok === true, "blue's cancelling gift was refused: " + JSON.stringify(mine));
    const event = mine.events.find((e) => e.type === "aid");
    eq("the composite arm really cancelled a banked gift", event.cancelled, 1);
    const readerLines = linesFor(match, "red", mine.events);
    const announce = readerLines.filter((line) => ANNOUNCE.test(line));
    eq("a cancelling gift into a LARGE nation is still announced", announce.length, 1);
    eq("the announcement does not mention the cancel", /cancel/i.test(announce[0] || ""), false);
    // The payer's round log line is unchanged by the cancel in this build (the cancel is named in
    // the note the flash reads, not in the log row). Pin what is true rather than what would read
    // nicely: the payer still reads their own gift, and the log row carries no cancel either.
    eq("the payer still reads their own gift in the composite",
      linesFor(match, "blue", mine.events).some((line) => /^aid reached /.test(line)), true);
    eq("the payer's log row is not turned into a cancel notice",
      linesFor(match, "blue", mine.events).some((line) => /cancel/i.test(line)), false);
    eq("the event's note is what names the cancel",
      /cancel/i.test(String(event.note || "")), true);

    // ...and the same composite into a SMALL nation stays quiet, so the arm proves the SIZE drives
    // the line in both branches rather than the cancel doing it.
    const quietCity = aidableCity("blue", small.nation, payload);
    const quiet = fixture(payload);
    watcherAt(quiet, "red", quietCity.x, quietCity.y);
    must(useTool(quiet, "red", "aid", { x: quietCity.x, y: quietCity.y }).ok === true, "red's quiet gift was refused");
    const quietMine = useTool(quiet, "blue", "aid", { x: quietCity.x, y: quietCity.y });
    must(quietMine.ok === true, "blue's quiet cancelling gift was refused");
    const quietEvent = quietMine.events.find((e) => e.type === "aid");
    eq("the quiet composite arm really cancelled too", quietEvent.cancelled, 1);
    eq("a cancelling gift into a SMALL nation is silent",
      linesFor(quiet, "red", quietMine.events).some((line) => ANNOUNCE.test(line)), false);
  }

  // --- 6. fog: the other gate ----------------------------------------------------------------
  // The label is the point of AC4: this arm holds SIZE fixed (a large nation) and moves only
  // `legible()`, so a red here is the fog gate, not the size cut.
  {
    const city = aidableCity("blue", large.nation, payload);
    const match = fixture(payload);
    const reach = Number(sightCells()) || 0;
    // Outside sight: `near()` is Chebyshev with X wrap, so the offset is measured on the same axis.
    const far = reach + 2;
    watcherAt(match, "red", city.x, city.y, far);
    const gift = useTool(match, "blue", "aid", { x: city.x, y: city.y });
    must(gift.ok === true, "the fog arm's gift was refused: " + JSON.stringify(gift));
    eq("gate 2 (legible): a large nation the reader cannot see is silent",
      linesFor(match, "red", gift.events).some((line) => ANNOUNCE.test(line)), false);

    const seen = fixture(payload);
    watcherAt(seen, "red", city.x, city.y, 0);
    const gift2 = useTool(seen, "blue", "aid", { x: city.x, y: city.y });
    must(gift2.ok === true, "the fog control gift was refused");
    eq("gate 2 (legible): the same gift IS announced when the reader can see the city",
      linesFor(seen, "red", gift2.events).some((line) => ANNOUNCE.test(line)), true);
    must(reach >= 1, "sightCells is " + reach + "; the fog arm cannot be run");
  }

  // --- 7. the announcement touches nothing --------------------------------------------------
  {
    const city = aidableCity("blue", large.nation, payload);
    const match = fixture(payload);
    watcherAt(match, "red", city.x, city.y);
    const gift = useTool(match, "blue", "aid", { x: city.x, y: city.y });
    must(gift.ok === true, "the AC5 arm's gift was refused");
    const snapshot = () => JSON.stringify({
      // Only the cash figure, not the seat object: reading a seat's view lazily materialises
      // `resources`, which is presentation state and not the announcement's doing.
      cash: { blue: match.sides.blue.cash, red: match.sides.red.cash },
      owners: (match.sites || []).map((site) => [site.id, site.owner, site.country_id]).sort(),
      aid: match.aid || null,
    });
    const before = snapshot();
    const redLines = linesFor(match, "red", gift.events);
    must(redLines.some((line) => ANNOUNCE.test(line)), "the AC5 arm produced no announcement to test");
    eq("the announcement changes no owner, ledger, stance or purse", snapshot(), before);
  }

  // --- 8. a cut the config cannot supply announces nothing ----------------------------------
  {
    const restore = withoutCut((cfg) => { delete cfg.loyalty.announceFromCities; });
    try {
      eq("a missing cut reads as unreadable", announceFromCities(), null);
      const city = aidableCity("blue", large.nation, payload);
      const match = fixture(payload);
      watcherAt(match, "red", city.x, city.y);
      const gift = useTool(match, "blue", "aid", { x: city.x, y: city.y });
      must(gift.ok === true, "the fail-quiet arm's gift was refused");
      eq("an unreadable cut announces nothing, even for a large nation",
        linesFor(match, "red", gift.events).some((line) => ANNOUNCE.test(line)), false);
    } finally {
      restore();
    }
    eq("the shipped cut comes back after the swap", announceFromCities(), cut);
  }

  console.log(
    "aid announcement: cut " + cut + " cities; large " + largeName + " (" + large.size + " cities, " +
      largeCity.x + "," + largeCity.y + "); small " + (countryName(small.nation.country) || "?") +
      " (" + small.size + "); directions 2, composites 2, fog arm 1",
  );
}
