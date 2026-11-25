// Node test: PB-239 — the OIL warning is In < Out, and the chip flashes while it is on.
//
// Manual p.6 l.118 and p.27 l.841: the budget reads "In" (what the wells produce) and "Out" (what
// the cities, bases and units consume), and the warning is for a side whose consumption is above its
// production. The shipped flag was `held + in < out` - consumption above the RESERVE plus production -
// so a side losing oil every round stayed quiet while it still had a pile, and the chip was a colour
// change with no motion at all.
//
// What fails if this node is removed:
//   - the flag goes back to reading the reserve, and a rich-but-bleeding side never warns
//     (the PM's live repro: 2023 blue round 1, in 600 < out 850, short=false);
//   - the chip keeps its colour but loses the flash, or the flash is written in JS as a second
//     copy of the predicate;
//   - the sentence goes back to naming the reserve as part of the condition;
//   - the chip keeps its pulse but loses the red (a deleted `color:` or `inherit` survives a
//     class+animation-only page leg), or the reduced-motion block drops the colour with the pulse.
//
// The page's own halves (class toggle from the server flag, the blink, the stop at In >= Out) are
// pinned here by source + CSS; the live page is the e2e leg beside it.

import { openMatch } from "../../server/match.mjs";
import { oilReadout } from "../../server/resources.mjs";
import { forSeat } from "../../server/view.mjs";
import { oilText, oilWarning, OIL_WARNING } from "../../public/command.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const name = "pb239_oil_warning";

function fail(message) {
  throw new Error(message);
}

function eq(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(label + ": expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
  }
}

// A room with an exact count of blue wells and blue cities, no pieces (the opening roster would add
// wells and cities nobody counted). `held` is the reserve the side carries into the round.
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
  // ---- the PM's live repro, as a fixture: in 600 < out 850, reserve 4000 ----------------
  // 3 wells at the recovered 200 a round = 600; 13 cities at 50 plus the 200 base = 850.
  const rich = room({ wells: 3, cities: 13, held: 4000 });
  const readRich = oilReadout(rich, "blue");
  eq([readRich.in, readRich.out], [600, 850], "the 2023 repro's flow");
  eq(readRich.short, true, "a side with a full reserve and in 600 < out 850 is short (PB-239)");
  eq(readRich.dry, false, "the repro's reserve is not dry");
  // The old rule, spelled out: 4000 + 600 > 850, so this is the exact case it stayed silent on.
  if (readRich.short !== true) fail("the reserve was read again; a rich side that bleeds must warn");

  // ---- and the other side of the line: In >= Out is not short, whatever the reserve ---------
  const lean = room({ wells: 3, cities: 13, held: 0 });
  lean.sides.blue.resources = { fuel: { held: 0, dry: true } };
  lean.sides.blue.fuel = 0;
  lean.sides.blue.dry = true;
  lean.sites = lean.sites.filter((site) => site.kind === "facility").concat(
    lean.sites.filter((site) => site.kind === "city").slice(0, 8),
  );
  const readLean = oilReadout(lean, "blue");
  eq([readLean.in, readLean.out], [600, 600], "eight cities pay exactly what three wells produce");
  eq(readLean.short, false, "In == Out is not short, even with an empty reserve");
  eq(readLean.dry, true, "the empty reserve is still its own flag");

  const plenty = room({ wells: 6, cities: 12, held: 0 });
  const readPlenty = oilReadout(plenty, "blue");
  eq(readPlenty.short, false, "In > Out is not short");

  // An era with no oil use never warns.
  const early = room({ wells: 0, cities: 13, held: 0, era: "1918" });
  eq(oilReadout(early, "blue").uses, false, "1918 carries no oil use");
  eq(oilReadout(early, "blue").short, false, "an era with no oil use never warns");

  // ---- the seat payload the page reads ------------------------------------------------
  const seat = forSeat(rich, "blue").seat;
  if (!seat || !seat.oil) fail("the seat carries no oil readout");
  eq(seat.oil.short, true, "the seat payload carries the same flag");

  // ---- the words ---------------------------------------------------------------------
  if (!/OIL SHORT/.test(oilText(readRich))) fail("the oil text does not say OIL SHORT: " + oilText(readRich));
  if (/OIL SHORT/.test(oilText(readLean))) fail("a side at In == Out was called short: " + oilText(readLean));
  eq(oilWarning(readRich), OIL_WARNING, "the short side gets the one warning sentence");
  eq(oilWarning(readLean), "", "a side that is not short has no warning");
  if (/reserve plus production/i.test(OIL_WARNING)) {
    fail("the warning still names the reserve as part of the condition: " + OIL_WARNING);
  }
  if (!/production/i.test(OIL_WARNING) || !/consumption/i.test(OIL_WARNING)) {
    fail("the warning does not name production and consumption: " + OIL_WARNING);
  }

  // ---- the page: the class comes from the server flag, and the chip flashes -------------
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const app = readFileSync(root + "public/app.js", "utf8");
  if (!/el\.classList\.toggle\("oilshort", Boolean\(budget && budget\.short === true\)\)/.test(app)) {
    fail("app.js no longer toggles oilshort from the server's own short flag");
  }
  const css = readFileSync(root + "public/app.css", "utf8");
  const rule = css.slice(css.indexOf(".pursechip.oilshort"));
  const block = rule.slice(0, rule.indexOf("}"));
  if (!/animation:\s*oilblink/.test(block)) fail("the oilshort chip does not blink: " + block);
  if (!/@keyframes\s+oilblink/.test(css)) fail("the blink has no keyframes");
  if (!/@media\s*\(prefers-reduced-motion:\s*reduce\)/.test(css)) {
    fail("the blink ignores prefers-reduced-motion");
  }
  const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
  if (!/animation:\s*none/.test(reduced.slice(0, reduced.indexOf("}")))) {
    fail("the reduced-motion block does not drop the animation");
  }
  // ---- the colour is the red (p.6 l.118, p.27 l.841: the word flashes RED) -------------------
  // The flash is motion; the warning itself is the colour, and the base rule is the only place it
  // is written. A mutant that deletes `color:` or sets it to `inherit` leaves the chip blinking in
  // the purse's ordinary green while the suite and a class/animation-only page leg stay green.
  const red = block.match(/(?:^|[;{\s])color:\s*([^;]+);/);
  if (!red) fail("the oilshort chip has no colour declaration at all: " + block);
  if (!/^#ff6b5e$/i.test(red[1].trim())) {
    fail("the oilshort chip's colour is not the warning red: " + red[1].trim());
  }
  if (/inherit|currentcolor/i.test(red[1])) fail("the oilshort chip inherits its colour: " + red[1]);
  // …and the reduced-motion block drops the pulse ONLY: it must not touch the colour, or the one
  // warning a motion-sensitive player sees disappears with the animation.
  const reduceBlock = reduced.slice(0, reduced.indexOf("}"));
  if (/(?:^|[;{\s])color\s*:/.test(reduceBlock)) {
    fail("the reduced-motion block overrides the warning colour, so the red is lost with the pulse: " + reduceBlock);
  }
  // A page that computed the deficit itself would be a second answer; the class is the only writer.
  if (/in\s*<\s*out/.test(app)) fail("app.js re-tests the flow itself instead of trusting the flag");
}
