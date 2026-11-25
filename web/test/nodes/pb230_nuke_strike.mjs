// Node test for PB-229 + PB-230: the nuke as an ORDER that changes the board.
//
// What breaks if this node is removed: a launch is a 10b event that paints nothing and damages
// nothing (the old stand-in), the kill zone loses its geometry, both sides' units inside the blast
// survive, cities/bases/oil fields are never levelled, wasteland is never painted, attrition never
// reads it, and the three refusals each lose their own sentence.
//
// Rules, from the card (Manual p.28/p.30, PM 8854 §3):
//   a. 10b a launch; Escape before placing refunds (the charge is server-side at LAUNCH, so an
//      unplaced aim never spends - web/public/app.js clears `pendingTool` on Escape, line 1324).
//   b. three refusals, each its own sentence, each charging 0: capital ring (SDI/ABM, size a
//      STAND-IN), the FIRER's own home country ("even if it's been invaded"), and the three-nuke
//      lead (PB-156).
//   c. kill zone: everything within 3 spaces, both sides, land/sea/air units plus cities, bases and
//      oil fields. 3 and its square shape are a PORT DECISION, UNVERIFIED.
//   d. wasteland on every land cell in the blast; attrition there goes below the 20% floor.
//
// The fixture is the real 1986 board, so the home-country predicate runs through the era's own
// region -> site rows instead of a hand-written country map.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { boardPayload, TERRAIN } from "../../server/board.mjs";
import { openMatch } from "../../server/match.mjs";
import { priceOf, resetRules, rules } from "../../server/rules.mjs";
import { kitBriefing, useTool } from "../../server/late.mjs";
import { attritionStep, issueOrder } from "../../server/move.mjs";
import {
  NUKE_HOME_COUNTRY, NUKE_HOME_UNKNOWN, NUKE_NEEDS_CELL, NUKE_OFF_MAP, NUKE_RADIUS_UNKNOWN, capitalText,
  cellCountry, homeCountriesOf, killRadius, nukeTarget, resolvedCapitals, wastelandCells,
  wastelandTerrain,
} from "../../server/nukestrike.mjs";
import { blastRadius, STAND_IN } from "../../server/blast.mjs";
import { forSeat } from "../../server/view.mjs";
import { NO_REGION, regionAt, regionSites } from "../../server/territory.mjs";
import { assertShippedNukesArmed } from "./_nuke_default.mjs";

export const name = "pb230_nuke_strike";

const WATER = new Set(["ocean", "docks", "shallows"]);

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

// The same config swap pb156_nuke uses: the shipped file keeps nukes off, so a test that fires one
// has to turn the block on and must put the file back.
function withNukes(on, patch = {}) {
  const custom = JSON.parse(JSON.stringify(rules()));
  custom.nukes = { ...(custom.nukes || {}), enabled: on };
  // A null in the patch DELETES the key, so "the config lost killRadius" is testable.
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete custom.nukes[key];
    else custom.nukes[key] = value;
  }
  const dir = mkdtempSync(path.join(tmpdir(), "pb230-"));
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

function terrainAt(grid, x, y) {
  return TERRAIN[grid[Number(y) * 320 + ((Number(x) % 320) + 320) % 320]];
}

function fixture() {
  const payload = boardPayload();
  const match = openMatch("1986", payload.sites, {});
  match.clock = "running";
  match.round = 4;
  match.over = false;
  match.sides = { blue: { cash: 500000 }, red: { cash: 500000 } };
  match.pieces = [];
  match.satellites = [];
  return { match, payload };
}

// A land cell, in a country, far enough from both capitals for a full 7x7 blast, and not inside
// Blue's own home country. Scanned from the board rather than typed in, so a board change moves the
// target with it.
function pickTarget(match, payload, { excludeHome = true, margin = 3, radius = killRadius() ?? 3 } = {}) {
  const home = homeCountriesOf(match, "blue") || new Set();
  const capitals = resolvedCapitals(match).list;
  for (let y = margin; y < 136 - margin; y += 1) {
    for (let x = margin; x < 320 - margin; x += 1) {
      const t = terrainAt(payload.cells, x, y);
      if (!t || WATER.has(t)) continue;
      let nearCapitalCell = false;
      for (const cap of capitals) {
        if (Math.abs(cap.x - x) <= margin && Math.abs(cap.y - y) <= margin) nearCapitalCell = true;
      }
      if (nearCapitalCell) continue;
      const here = cellCountry(match, x, y);
      if (!here || here.country === null) continue;
      if (excludeHome && home.has(here.country)) continue;
      if (wastelandCells(match, { x, y }, radius).length < 45) continue;
      return { x, y, terrain: t, country: here.country };
    }
  }
  return null;
}

function piece(id, side, kind, x, y, strength = 100) {
  return { id, side, kind, x, y, domain: "land", path: [], pace: 1, strength };
}

export async function run(ctx) {
  // PB-233 (f): the shipped default is ARMED; a forced-off config still refuses at nukeStatus.
  assertShippedNukesArmed();

  const radius = killRadius();
  must(Number.isInteger(radius) && radius >= 1, "config nukes.killRadius must be an integer >= 1, got " + radius);
  eq("killRadius reads config, not a literal", radius, Number(rules().nukes.killRadius));
  must(/PORT DECISION/.test(String(rules().nukes.killRadiusSource)) && /UNVERIFIED/.test(String(rules().nukes.killRadiusSource)),
    "config nukes.killRadiusSource must name the decision and the gap");
  eq("the manual's count is stored", Number(rules().nukes.killRadius), 3);

  // Both directions (PM 8963, from frodo 8962 §2b): the nuke's zone is nukes.killRadius 3 while the
  // satellite blast is still blast.radius 6. A nuke arm that compares against blastRadius() would go
  // green with the wrong number, so both values are pinned here and they must differ.
  eq("the satellite blast keeps its own 6", blastRadius(), 6);
  eq("the nuke's kill zone is its own config value", killRadius(), 3);
  must(blastRadius() !== killRadius(), "the nuke and the satellite blast read one number");

  const restore = withNukes(true);
  try {
    let payload;
    try {
      payload = boardPayload();
      must(Boolean(payload && payload.cells), "the board has no terrain grid");
    } catch (err) {
      ctx.skip("no extracted board on this host (set OPENCHQ_DATA / OPENCHQ_EXTRACT)");
    }

    // --- a(ii). both directions, with the config MOVED ---------------------------------------
    // frodo's PB-230 card finding 2: a hardcoded 3 inside killRadius() is invisible while config
    // says 3. Move nukes.killRadius to 4 and blast.radius stays 6: the nuke must follow config, the
    // satellite must not, and a literal dies here.
    {
      const restoreOverlay = withNukes(true, { killRadius: 4 });
      try {
        eq("the nuke radius follows config", killRadius(), 4);
        eq("the satellite radius does not move with it", blastRadius(), 6);
        const { match } = fixture();
        const target = pickTarget(match, payload, { margin: 4 });
        must(Boolean(target), "no target cell for the overlay arm");
        const at = { x: target.x, y: target.y };
        match.pieces = [
          piece("in-4", "red", "tank", at.x + 4, at.y), // Chebyshev 4: inside a 4-square
          piece("out-5", "red", "tank", at.x + 5, at.y), // Chebyshev 5: outside it
        ];
        const result = useTool(match, "blue", "nuke", at);
        if (result.error) fail("the overlay launch was refused: " + result.error);
        eq("a radius-4 blast kills at 4 and spares 5", match.pieces.map((p) => p.id), ["out-5"]);
        const event = (result.events || []).find((e) => e.type === "nuke");
        eq("the event carries the config radius, not the shipped 3", event.radius, 4);
        const wasteland = match.wasteland || [];
        // The paint must reach 4 rows out (and no further): a radius-3 path would stop at 3.
        const maxDy = Math.max(...wasteland.map((key) => Math.abs(Number(key.split(",")[1]) - at.y)));
        eq("the radius-4 blast painted out to 4 rows", maxDy, 4);
      } finally {
        restoreOverlay();
      }
    }

    // --- a(iii). a config that lost its nuke radius refuses instead of guessing 3 --------------
    // frodo's PB-230 card finding 9: "refuses rather than picking a number" sat above code that
    // picked one. With the key gone the tool must refuse and charge 0.
    {
      const restoreGone = withNukes(true, { killRadius: null });
      try {
        eq("a missing nuke radius answers null", killRadius(), null);
        const { match } = fixture();
        const target = pickTarget(match, payload);
        const cash = match.sides.blue.cash;
        const refused = useTool(match, "blue", "nuke", target);
        eq("a missing nuke radius refuses", refused.error, NUKE_RADIUS_UNKNOWN);
        eq("a missing-radius refusal costs nothing", match.sides.blue.cash, cash);
      } finally {
        restoreGone();
      }
    }

    // --- a. the price, and a refusal that costs nothing ------------------------------------
    {
      const { match } = fixture();
      const target = pickTarget(match, payload);
      must(Boolean(target), "no land cell outside Blue's home country could be found on this board");
      const before = match.sides.blue.cash;
      const fired = useTool(match, "blue", "nuke", { x: target.x, y: target.y });
      if (fired.error) fail("a legal launch was refused: " + fired.error);
      const spent = before - match.sides.blue.cash;
      eq("a launch costs the manual's 10b", spent, priceOf("nuke"));
      eq("the event carries the price it charged", (fired.events || []).find((e) => e.type === "nuke").cost, priceOf("nuke"));

      const refusedMatch = fixture().match;
      const cash = refusedMatch.sides.blue.cash;
      const bad = useTool(refusedMatch, "blue", "nuke", { x: 5, y: 200 });
      must(Boolean(bad.error), "an off-map aim was allowed");
      eq("a refused aim costs nothing", refusedMatch.sides.blue.cash, cash);
    }

    // --- b(0). the aim itself ----------------------------------------------------------------
    {
      const { match } = fixture();
      eq("an aim with no cell is refused", nukeTarget(match, "blue", null).error, NUKE_NEEDS_CELL);
      eq("an off-map aim is refused", nukeTarget(match, "blue", { x: 40, y: 200 }).error, NUKE_OFF_MAP);
      eq("a non-integer aim is refused", nukeTarget(match, "blue", { x: 40.5, y: 40 }).error, NUKE_OFF_MAP);
      const cash = match.sides.blue.cash;
      useTool(match, "blue", "nuke", null);
      eq("an aim with no cell costs nothing", match.sides.blue.cash, cash);
    }

    // --- b(i). the capital-distance / SDI ring, and it says it is a stand-in ------------------
    {
      const { match } = fixture();
      const cap = match.capitals.red;
      const ring = Number(rules().nukes.exclusion);
      const inside = nukeTarget(match, "blue", { x: cap.x + ring, y: cap.y });
      eq("the ring cell is refused", inside.error, capitalText());
      // PB-244: the refusal names the ring size; the fact that the size is a stand-in lives in config.
      must(!String(inside.error).includes(STAND_IN), "the capital refusal hands the player a developer tag");
      must(String(inside.error).includes(String(ring)), "the capital refusal does not print the ring size: " + inside.error);
      const outside = nukeTarget(match, "blue", { x: cap.x + ring + 1, y: cap.y });
      must(!outside.error, "one cell past the ring was refused: " + outside.error);
      // Blue's own capital as well: the guard is home ground, not one side's.
      const ownCap = match.capitals.blue;
      eq("the firer's own capital ring is refused too", nukeTarget(match, "blue", { x: ownCap.x, y: ownCap.y }).error, capitalText());
      // PM 8963: every refusal arm also proves the refusal charged nothing.
      const cash = match.sides.blue.cash;
      const throughTool = useTool(match, "blue", "nuke", { x: cap.x + ring, y: cap.y });
      eq("the ring is the same sentence through useTool", throughTool.error, capitalText());
      eq("a capital-ring refusal costs nothing", match.sides.blue.cash, cash);
    }

    // --- b(i) reads the RESOLVED set, not just the seat pair ----------------------------------
    // frodo 8962 §4: with the ring on `match.capitals[side]` and the home country on the capital
    // set, a set that lost a capital moves one refusal and not the other. 1986 Blue holds London,
    // Tokyo and Washington; only Washington is the seat pair, so London is the discriminating arm.
    {
      const { match } = fixture();
      const capitals = resolvedCapitals(match);
      eq("the resolved set is the era's whole capital list", capitals.list.map((c) => c.siteId).sort((a, b) => a - b),
        [10, 35, 62, 63]);
      must(capitals.complete, "the 1986 capital set did not resolve completely");
      const ring = Number(rules().nukes.exclusion);
      const london = capitals.list.find((c) => c.siteId === 10);
      const seat = match.capitals.blue;
      must(Math.abs(london.x - seat.x) > ring || Math.abs(london.y - seat.y) > ring,
        "London sits on the seat capital, so this arm would prove nothing");
      // Red fires: London is BLUE's capital, so b(ii) (the FIRER's home country) cannot be what
      // refuses this cell - only the ring can.
      eq("a non-seat capital's ring still refuses", nukeTarget(match, "red", { x: london.x + ring, y: london.y }).error, capitalText());
      const cash = match.sides.red.cash;
      const throughTool = useTool(match, "red", "nuke", { x: london.x + ring, y: london.y });
      eq("the non-seat ring refuses through useTool too", throughTool.error, capitalText());
      eq("a non-seat ring refusal costs nothing", match.sides.red.cash, cash);
      // The exclude-one-past-the-ring direction on the same capital.
      must(!nukeTarget(match, "red", { x: london.x + ring + 1, y: london.y }).error,
        "one cell past London's ring was refused");
    }

    // --- b(ii). the firer's own home country, even when it has been invaded --------------------
    {
      const { match } = fixture();
      const home = homeCountriesOf(match, "blue");
      must(home && home.size, "Blue's home country did not resolve from the capital set");
      // frodo 8962 §4: home ground is EVERY country Blue's capitals stand in, not just the seat.
      const blueCapitals = resolvedCapitals(match).list.filter((c) => c.side === "blue");
      eq("Blue's home ground is every country its capitals stand in",
        [...home].sort((a, b) => a - b), blueCapitals.map((c) => c.country).sort((a, b) => a - b));
      must(home.size >= 2, "1986 Blue answered one home country; London and Tokyo were dropped");
      const capitals = resolvedCapitals(match).list;
      let homeCell = null;
      for (let y = 3; y < 133 && !homeCell; y += 1) {
        for (let x = 3; x < 317 && !homeCell; x += 1) {
          const t = terrainAt(payload.cells, x, y);
          if (!t || WATER.has(t)) continue;
          let near = false;
          for (const cap of capitals) {
            if (Math.abs(cap.x - x) <= 3 && Math.abs(cap.y - y) <= 3) near = true;
          }
          if (near) continue;
          const here = cellCountry(match, x, y);
          if (here && here.country !== null && home.has(here.country)) homeCell = { x, y };
        }
      }
      must(Boolean(homeCell), "no home-country cell outside a capital ring could be found");
      const aim = nukeTarget(match, "blue", homeCell);
      eq("the firer's home country is refused", aim.error, NUKE_HOME_COUNTRY);
      const cash = match.sides.blue.cash;
      const refused = useTool(match, "blue", "nuke", homeCell);
      eq("the refusal is the same sentence through useTool", refused.error, NUKE_HOME_COUNTRY);
      eq("a home-country refusal costs nothing", match.sides.blue.cash, cash);

      // "even if it's been invaded": hand the capital to the other side and ask again. The predicate
      // reads the country the capital STANDS IN, not who holds it.
      const row = (match.capitalSet.list || []).find((entry) => Number(entry.x) === Number(match.capitals.blue.x)
        && Number(entry.y) === Number(match.capitals.blue.y));
      const site = row && match.sites.find((place) => Number(place.id) === Number(row.siteId));
      must(Boolean(site), "Blue's capital site did not resolve");
      site.owner = "red";
      const invaded = nukeTarget(match, "blue", homeCell);
      eq("an invaded home country is still refused", invaded.error, NUKE_HOME_COUNTRY);

      // The opponent's home country is NOT refused: the rule is about the firer's own ground.
      const other = homeCountriesOf(fixture().match, "red");
      let enemy = null;
      for (let y = 3; y < 133 && !enemy; y += 1) {
        for (let x = 3; x < 317 && !enemy; x += 1) {
          const t = terrainAt(payload.cells, x, y);
          if (!t || WATER.has(t)) continue;
          const here = cellCountry(match, x, y);
          if (here && here.country !== null && other.has(here.country)
            && Math.abs(match.capitals.red.x - x) > 3 && Math.abs(match.capitals.red.y - y) > 3) enemy = { x, y };
        }
      }
      if (enemy) {
        const at = nukeTarget(match, "blue", enemy);
        must(!at.error, "the opponent's home country was refused: " + at.error);
      }
    }

    // --- b(ii) fails closed: an unnameable map never becomes foreign ground -------------------
    // PM 8963: the region, the country or the capital set missing must refuse and charge 0. Each arm
    // below removes ONE answer and checks both the sentence and the wallet.
    {
      // (1) a set that reported a missing row (the PB-228 shape).
      const incomplete = fixture().match;
      incomplete.capitalSet = { ...incomplete.capitalSet, missing: [63] };
      const cashIncomplete = incomplete.sides.blue.cash;
      const refusedIncomplete = useTool(incomplete, "blue", "nuke", { x: 100, y: 100 });
      eq("an incomplete capital set refuses", refusedIncomplete.error, NUKE_HOME_UNKNOWN);
      eq("an incomplete-set refusal costs nothing", incomplete.sides.blue.cash, cashIncomplete);

      // (2) no capital set at all: the seat pair cannot name a home country on its own.
      const absent = fixture().match;
      absent.capitalSet = null;
      const cashAbsent = absent.sides.blue.cash;
      const refusedAbsent = useTool(absent, "blue", "nuke", { x: 100, y: 100 });
      eq("a missing capital set refuses", refusedAbsent.error, NUKE_HOME_UNKNOWN);
      eq("a missing-set refusal costs nothing", absent.sides.blue.cash, cashAbsent);

      // (3) a cell the territory map leaves unassigned (NO_REGION) and that is LAND.
      // PB-242 (frodo 8985 §1) makes NO_REGION + water a legal aim, so the residue that still
      // refuses is the land one - every such cell on this board is lake. The arm keeps its subject
      // (an unnameable cell still refuses instead of reading as foreign ground); only the class it
      // samples moved, because the ruling moved that class. Without the terrain filter this arm now
      // samples an ocean cell and fails for the right reason: see pb242_sea_aim for the other side.
      const noRegion = fixture().match;
      let blank = null;
      for (let y = 3; y < 133 && !blank; y += 1) {
        for (let x = 3; x < 317 && !blank; x += 1) {
          if (regionAt(x, y) !== NO_REGION) continue;
          const terrain = terrainAt(payload.cells, x, y);
          if (terrain && WATER.has(terrain)) continue;
          let near = false;
          for (const cap of resolvedCapitals(noRegion).list) {
            if (Math.abs(cap.x - x) <= Number(rules().nukes.exclusion) && Math.abs(cap.y - y) <= Number(rules().nukes.exclusion)) near = true;
          }
          if (!near) blank = { x, y };
        }
      }
      must(Boolean(blank), "the board has no unassigned cell outside every capital ring");
      const cashBlank = noRegion.sides.blue.cash;
      const refusedBlank = useTool(noRegion, "blue", "nuke", blank);
      eq("an unassigned cell refuses instead of reading as foreign ground", refusedBlank.error, NUKE_HOME_UNKNOWN);
      eq("an unassigned-cell refusal costs nothing", noRegion.sides.blue.cash, cashBlank);

      // (4) a resolved region whose site carries no country byte.
      const noCountry = fixture().match;
      const spot = pickTarget(noCountry, payload);
      must(Boolean(spot), "no target cell for the no-country arm");
      const region = regionAt(spot.x, spot.y);
      const wantedId = regionSites("1986")[region];
      let site = (noCountry.sites || []).find((place) => String(place.id) === String(wantedId));
      if (!site) {
        site = { id: wantedId, kind: "city", name: "no-country fixture", x: spot.x, y: spot.y, owner: "red", country_id: null };
        noCountry.sites.push(site);
      } else {
        site.country_id = null;
      }
      must(cellCountry(noCountry, spot.x, spot.y).country === null, "the no-country fixture still answers a country");
      const cashNoCountry = noCountry.sides.blue.cash;
      const refusedNoCountry = useTool(noCountry, "blue", "nuke", spot);
      eq("a site with no country byte refuses", refusedNoCountry.error, NUKE_HOME_UNKNOWN);
      eq("a no-country refusal costs nothing", noCountry.sides.blue.cash, cashNoCountry);

      // (5) a FIRER'S capital whose country byte is gone: the home set is unknowable, not smaller.
      const unnamed = fixture().match;
      must(homeCountriesOf(unnamed, "blue") !== null, "the control home set did not resolve");
      const wash = (unnamed.sites || []).find((place) => Number(place.x) === Number(unnamed.capitals.blue.x)
        && Number(place.y) === Number(unnamed.capitals.blue.y));
      must(Boolean(wash), "Blue's capital site did not resolve");
      wash.country_id = null;
      eq("one unnamed capital makes the home set unknowable", homeCountriesOf(unnamed, "blue"), null);
      const cashUnnamed = unnamed.sides.blue.cash;
      const refusedUnnamed = useTool(unnamed, "blue", "nuke", { x: 100, y: 100 });
      eq("an unnamed capital refuses the launch", refusedUnnamed.error, NUKE_HOME_UNKNOWN);
      eq("an unnamed-capital refusal costs nothing", unnamed.sides.blue.cash, cashUnnamed);
    }

    // --- b(iii). the three-nuke lead keeps its own sentence -----------------------------------
    {
      const { match } = fixture();
      const target = pickTarget(match, payload);
      match.late = { launched: { blue: { fired: 3 }, red: { fired: 0 } } };
      const cash = match.sides.blue.cash;
      const refused = useTool(match, "blue", "nuke", target);
      must(/3 more launches/.test(String(refused.error)), "the lead refusal does not name the rule: " + refused.error);
      eq("the lead refusal costs nothing", match.sides.blue.cash, cash);
    }

    // --- c. the kill zone: a SQUARE of 3, both sides, and nothing past it --------------------
    {
      const { match } = fixture();
      const target = pickTarget(match, payload);
      const at = { x: target.x, y: target.y };
      match.pieces = [
        piece("corner-e", "red", "tank", at.x + 3, at.y + 3), // Chebyshev 3, Euclid 4.24
        piece("corner-w", "red", "tank", at.x - 3, at.y + 3),
        piece("own", "blue", "infantry", at.x, at.y - 3), // the firer's own side
        piece("edge-far", "red", "tank", at.x + 4, at.y), // Chebyshev 4
        piece("edge-y", "red", "tank", at.x, at.y + 4),
        piece("far", "red", "tank", at.x + 20, at.y),
      ];
      const result = useTool(match, "blue", "nuke", at);
      if (result.error) fail("the launch was refused: " + result.error);
      const left = match.pieces.map((p) => p.id).sort();
      eq("the square kills the corner and the firer's own unit and nothing past the edge", left,
        ["edge-far", "edge-y", "far"]);
      const event = (result.events || []).find((e) => e.type === "nuke");
      eq("the event lists what died", event.killed.map((p) => p.id).sort(), ["corner-e", "corner-w", "own"]);
      eq("the event names the radius", event.radius, radius);
      // PB-244: the launch line prints the radius and the shape; no tag.
      must(!String(event.note).includes(STAND_IN), "the launch line hands the player a developer tag");
      must(String(event.note).includes(String(radius)), "the launch line does not print the radius: " + event.note);
      must(/wasteland/.test(String(event.note)), "the launch line does not say what it leaves");
      // PM 8963 / frodo 8962 §6: the retired sentence must not survive anywhere in the events.
      must(!(result.events || []).some((e) => /paints nothing|deals no damage/.test(String(e.note || ""))),
        "an event still carries the retired 'paints nothing and deals no damage' note");
      must(!(result.events || []).some((e) => String(e.note || "") === "Stand-in nuke. It paints nothing and deals no damage."),
        "an event still carries the retired stand-in nuke note verbatim");

      // Every unit death gets its own line, so the round log can speak for it.
      const destroyed = (result.events || []).filter((e) => e.type === "destroyed").map((e) => e.pieceId).sort();
      eq("every unit killed in the blast is reported", destroyed, ["corner-e", "corner-w", "own"]);
    }

    // --- c(ii). sites: cities, bases and oil fields are levelled; a capital and a dock stand ---
    {
      const { match } = fixture();
      const target = pickTarget(match, payload);
      const at = { x: target.x, y: target.y };
      const synth = (id, kind, dx, dy) => {
        const x = at.x + dx;
        const y = at.y + dy;
        match.sites.push({ id, kind, x, y, owner: "red", country_id: 22, name: kind + "-" + id });
        return { id, x, y };
      };
      const city = synth(9001, "city", 1, 1);
      const base = synth(9002, "base", -2, 0);
      const oil = synth(9003, "oilfield", 0, 2);
      const capital = synth(9004, "capital", 3, -1); // inside the blast, not one of the seat capitals
      const dock = synth(9005, "docks", -1, -1);
      const outside = synth(9006, "city", 30, 30);
      const result = useTool(match, "blue", "nuke", at);
      if (result.error) fail("the launch was refused: " + result.error);
      const ids = new Set(match.sites.map((site) => site.id));
      for (const [label, site] of [["city", city], ["base", base], ["oil field", oil]]) {
        must(!ids.has(site.id), "the " + label + " in the blast survived");
      }
      must(ids.has(capital.id), "a capital site was levelled by the blast");
      must(ids.has(dock.id), "a dock was levelled; the manual's list is cities, bases and oil fields");
      must(ids.has(outside.id), "a site outside the blast was levelled");
    }

    // --- c(iii). satellites are above the board --------------------------------------------
    {
      const { match } = fixture();
      const target = pickTarget(match, payload);
      match.satellites = [
        { id: "sat-blue", side: "blue", x: target.x, y: target.y, fuel: 2 },
        { id: "sat-red", side: "red", x: target.x + 1, y: target.y },
      ];
      // PM 8963 / frodo 8962 §6: "satellites unaffected" is free only by construction today. Pin the
      // whole view.satellites array (fuel and position included) so the day a satellite becomes a
      // piece, this reds instead of the AC inverting silently. frodo's PB-230 finding 8: the SOURCE
      // array is not enough - the seat frame is what a player reads, so compare forSeat().
      const sourceBefore = JSON.stringify(match.satellites);
      const frameBefore = JSON.stringify(forSeat(match, "blue").satellites);
      const result = useTool(match, "blue", "nuke", { x: target.x, y: target.y });
      if (result.error) fail("the launch was refused: " + result.error);
      eq("satellites are untouched by a launch", match.satellites.map((s) => s.id), ["sat-blue", "sat-red"]);
      eq("view.satellites is byte-identical across a blast", JSON.stringify(match.satellites), sourceBefore);
      eq("the blue seat frame's satellites are unchanged", JSON.stringify(forSeat(match, "blue").satellites), frameBefore);
      must(!(match.pieces || []).some((p) => p.id === "sat-blue" || p.id === "sat-red"),
        "a satellite appeared in the piece list after a blast");
    }

    // --- d. wasteland: every land cell in the square, water untouched -----------------------
    {
      const { match } = fixture();
      const target = pickTarget(match, payload);
      const at = { x: target.x, y: target.y };
      const result = useTool(match, "blue", "nuke", at);
      if (result.error) fail("the launch was refused: " + result.error);
      const painted = match.wasteland || [];
      // The expected set, computed here from the board rather than from the module's own answer.
      const want = new Set();
      let water = 0;
      for (let dy = -radius; dy <= radius; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          const x = ((at.x + dx) % 320 + 320) % 320;
          const y = at.y + dy;
          const t = terrainAt(payload.cells, x, y);
          if (WATER.has(t)) { water += 1; continue; }
          want.add(x + "," + y);
        }
      }
      eq("every land cell in the blast is wasteland", painted.length, want.size);
      must(painted.every((key) => want.has(key)), "a painted cell is outside the blast or is water");
      must(painted.every((key) => !WATER.has(terrainAt(payload.cells, ...key.split(",").map(Number)))),
        "a water cell was painted");
      eq("the list is sorted and unique", painted, [...new Set(painted)].sort());
      must(water > 0 ? !painted.some((key) => {
        const [x, y] = key.split(",").map(Number);
        return WATER.has(terrainAt(payload.cells, x, y));
      }) : true, "a water cell in the square was painted");

      // The attrition seam: the cell reads as wasteland, and the floor does not apply there.
      const [wx, wy] = painted[0].split(",").map(Number);
      const lookup = wastelandTerrain(match);
      eq("the attrition lookup reads the painted cell as wasteland", lookup({ x: wx, y: wy }), "wasteland");
      const adjacent = { x: wx + 60, y: wy };
      must(lookup({ x: adjacent.x, y: adjacent.y }) !== "wasteland", "an unpainted cell read as wasteland");

      match.round = 5;
      match.pieces = [piece("b18", "red", "tank", wx, wy, 19), piece("b1", "red", "tank", wx, wy + 40, 19)];
      const before = match.pieces.map((p) => p.strength);
      attritionStep(match, lookup);
      const drained = match.pieces.find((p) => p.id === "b18");
      if (!drained) fail("the unit on wasteland was destroyed from 19 in one round");
      must(drained.strength < 20, "wasteland attrition stopped at the 20% floor: " + drained.strength);
      must(drained.strength < before[0], "wasteland attrition drained nothing");

      // And it can kill: the floor for wasteland is 0, so one point of strength left is one point.
      match.pieces = [piece("last", "red", "tank", wx, wy, 1)];
      attritionStep(match, lookup);
      eq("a unit on wasteland can be killed by attrition", match.pieces.length, 0);
    }

    // --- d(ii). no wasteland means attrition keeps its own path ----------------------------
    {
      const { match } = fixture();
      eq("a room with no blast hands attrition its grid path back", wastelandTerrain(match), null);
    }

    // --- e. an order onto wasteland is refused, the same as the board's own cells ----------
    {
      const { match } = fixture();
      const target = pickTarget(match, payload);
      const at = { x: target.x, y: target.y };
      const result = useTool(match, "blue", "nuke", at);
      if (result.error) fail("the launch was refused: " + result.error);
      const [wx, wy] = match.wasteland[0].split(",").map(Number);
      // A blue infantry next door, with a clear cell between it and the wasteland.
      match.pieces = [piece("mover", "blue", "infantry", wx + 2, wy)];
      const order = issueOrder(match, "blue", "mover", wx, wy);
      eq("an order onto wasteland is refused", order.error, "Wasteland is refused.");
    }

    // --- e(ii). the page ARMS a picker for the nuke instead of spending blind ---------------
    // PB-229's door: before this the Nuke button sent {op:"tool",tool:"nuke"} with no cell, so the
    // server answered "A nuke needs a target cell" every time and the tool was unreachable from the
    // page. The pin reads the page source because the flow itself is a click (the live leg is owed
    // at the deployed literal, the same shape PB-224 used).
    {
      const src = readFileSync(new URL("../../public/app.js", import.meta.url), "utf8");
      must(/TOOL_PICKERS = new Set\(\["aid", "nuke"\]\)/.test(src),
        "the Kit/Buy row does not arm a picker for the nuke");
      must(/NUKE_PICK_HINT/.test(src), "the page has no aiming sentence for a nuke");
      must(/send\(\{ op: "tool", tool, to: \{ x: cell\.x, y: cell\.y \} \}\)/.test(src),
        "the armed click no longer sends the cell it was given");
      must(/if \(event\.key === "Escape" && pendingTool\)/.test(src),
        "Escape no longer disarms an armed tool");
    }

    // --- f. the briefing stops promising "no damage" ---------------------------------------
    {
      const { match } = fixture();
      const briefing = kitBriefing(match, "blue").find((entry) => entry.name === "nuke");
      must(Boolean(briefing), "the kit has no nuke row");
      must(!/no damage/.test(briefing.text), "the briefing still promises no damage");
      must(/wasteland/.test(briefing.text), "the briefing does not mention wasteland");
      must(/home country/.test(briefing.text), "the briefing does not name the home-country refusal");
      must(briefing.text.includes(String(radius)), "the briefing does not print the kill radius");
    }
  } finally {
    restore();
  }
}
