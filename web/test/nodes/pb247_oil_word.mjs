// Node test: PB-247 — the strip chip says OIL while it flashes, and says it from the server's flag.
//
// Manual p.6 l.118 / p.27 l.841: the monitor's oil warning is a WORD and a colour, not motion
// alone. PB-239 shipped the pulse; the chip still carried no word, so the warning was legible only
// to a player who knew what the red meant, and invisible to one who reads the strip in a glance or
// cannot separate the two reds.
//
// What fails if this node is removed:
//   - the word goes back to being absent, so the chip is colour+motion only again;
//   - the word is emitted after the cash leg, where the chip's own `text-overflow: ellipsis` eats
//     it first when the purse string grows;
//   - the word is written from a second copy of the flow predicate instead of `budget.short`;
//   - a media query hides `.oilword`, which silently restores the colour-only warning at that width
//     while the wide viewport stays green in the suite.
//
// The live page half (the word on a real deficit chip at 1280x800, and its absence at In >= Out) is
// the e2e leg beside this file: tests/e2e/pb247-oil-word.mjs.

import { openMatch } from "../../server/match.mjs";
import { oilReadout } from "../../server/resources.mjs";
import { forSeat } from "../../server/view.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const name = "pb247_oil_word";

function fail(message) {
  throw new Error(message);
}

function eq(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(label + ": expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
  }
}

// The PB-239 repro shape: 3 wells at 200 a round = 600 in, 13 cities at 50 plus the 200 base = 850
// out, with a full reserve. `short` is true there and the page has a real deficit to name.
function room({ wells, cities, held, era = "2023" }) {
  const match = openMatch(era, []);
  match.sites = [];
  match.pieces = [];
  match.round = 1;
  match.clock = "running";
  let id = 100;
  for (let i = 0; i < wells; i += 1) {
    match.sites.push({ id: id += 1, name: "well " + id, kind: "facility", type: 5, owner: "blue", x: 10 + i, y: 10 });
  }
  for (let i = 0; i < cities; i += 1) {
    match.sites.push({ id: id += 1, name: "city " + id, kind: "city", owner: "blue", x: 20 + (i % 20), y: 30 + Math.floor(i / 20) });
  }
  match.sides.blue.resources = { fuel: { held, dry: false } };
  match.sides.blue.fuel = held;
  match.sides.blue.dry = false;
  return match;
}

export async function run() {
  // ---- the state the word is allowed to exist in -------------------------------------------
  const bleeding = room({ wells: 3, cities: 13, held: 4000 });
  const readBleeding = oilReadout(bleeding, "blue");
  eq([readBleeding.in, readBleeding.out], [600, 850], "the repro's flow");
  eq(readBleeding.short, true, "the repro is short, so the word has a state to render");
  const seatShort = forSeat(bleeding, "blue").seat;
  eq(seatShort.oil.short, true, "the page's seat payload carries the same flag");

  const paying = room({ wells: 6, cities: 12, held: 0 });
  eq(oilReadout(paying, "blue").short, false, "In > Out is not short");
  const seatPaying = forSeat(paying, "blue").seat;
  eq(seatPaying.oil.short, false, "and the payload is false there too");

  // ---- the page: one writer, server flag, first leg ----------------------------------------
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const app = readFileSync(root + "public/app.js", "utf8");

  if (!/word\.className = "oilword"/.test(app)) fail("app.js no longer builds the .oilword span");
  if (!/word\.textContent = "OIL"/.test(app)) fail("the word is no longer literally OIL");
  if (!/if \(budget && budget\.short === true\) \{[^}]*word\.className = "oilword"/s.test(app)) {
    fail("the word is not built from the server's own `budget.short` flag");
  }
  // The guard must be the flag, not a re-derived flow comparison: a second predicate is a second
  // answer and drifts from the server the first time a building changes the numbers.
  const wordBlock = app.slice(app.indexOf('word.className = "oilword"') - 400, app.indexOf('word.className = "oilword"'));
  if (/\.in\s*<\s*\.out|in\s*<\s*out/.test(wordBlock)) {
    fail("the word re-tests the flow instead of trusting the server flag: " + wordBlock.slice(-120));
  }
  // Emission order: the chip clips its TAIL (`text-overflow: ellipsis`), so a word placed after the
  // cash leg is the first thing lost when the purse string grows.
  const wordAt = app.indexOf('word.className = "oilword"');
  const cashAt = app.indexOf('cash.className = "cash"');
  if (wordAt < 0 || cashAt < 0) fail("app.js no longer builds both the word and the cash legs");
  if (!(wordAt < cashAt)) fail("the word is emitted after the cash leg, where the chip's ellipsis eats it first");

  // ---- the CSS: a real rule, and nothing that hides it --------------------------------------
  const css = readFileSync(root + "public/app.css", "utf8");
  if (!/\.pursechip \.oilword/.test(css)) fail("the .oilword leg has no CSS rule");
  const rule = css.slice(css.indexOf(".pursechip .oilword"));
  const block = rule.slice(0, rule.indexOf("}"));
  if (!/margin-right:\s*\d/.test(block)) fail("the word has no gap against the cash figure: " + block);

  // No media query may hide it. Leaving the word off at one width is the colour-only warning back,
  // and the wide-viewport suite would never see it.
  for (const media of ["max-width: 1100px", "max-width: 1024px", "max-width: 880px", "max-width: 720px"]) {
    const at = css.indexOf(media);
    if (at < 0) continue;
    const tail = css.slice(at, at + 4000);
    const end = tail.indexOf("\n@media");
    const body = end > 0 ? tail.slice(0, end) : tail;
    if (/\.oilword[^{]*\{[^}]*display:\s*none/s.test(body)) {
      fail("a media query hides the word at " + media + ", restoring the colour-only warning there");
    }
  }
}
