// Node test for PB-233 AC (a2): "some number of cities" switch after a strike.
//
// Manual p.30: "some number of cities in [the attacked country] switch to neutral if part of the
// offending alliance, or shifting to the enemy if already neutral. The number of cities that switch
// is partly random, and partly determined by civilian casualties (represented by destruction of
// cities) and friendly casualties caused by the nuke. Also, the first side to use nukes suffers an
// additional penalty in this regard."
//
// What breaks if this node is removed: a strike never moves a city, or it moves cities in countries
// the blast never touched, or it flips cities TO the firer instead of against them, or the
// first-strike penalty / the random term / the casualty terms stop being counted.
//
// The archive's owner flip (decompiled.c 12167-12185) walks 100 PIECE slots, not cities, so it
// yields no city count to decode: every count here is a STAND-IN and config carries it.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { boardPayload, TERRAIN } from "../../server/board.mjs";
import { openMatch } from "../../server/match.mjs";
import { resetRules, rules } from "../../server/rules.mjs";
import { seedOwners } from "../../server/economy.mjs";
import { useTool } from "../../server/late.mjs";
import { nukeState } from "../../server/nukes.mjs";
import { switchCities, switchRoll } from "../../server/aftermath.mjs";
import { blastCountries, cellCountry, homeCountriesOf, killRadius, resolvedCapitals } from "../../server/nukestrike.mjs";

export const name = "pb233_switch";

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

function withNukes(on, patch = {}) {
  const custom = JSON.parse(JSON.stringify(rules()));
  custom.nukes = { ...(custom.nukes || {}), enabled: on };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete custom.nukes[key];
    else custom.nukes[key] = value;
  }
  const dir = mkdtempSync(path.join(tmpdir(), "pb233s-"));
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
  const id = grid[Number(y) * 320 + ((Number(x) % 320) + 320) % 320];
  return id === undefined || id === null ? null : TERRAIN[Number(id)] || null;
}

// The real 1986 board with real owners, and one land cell outside Blue's home country in a country
// that holds at least `need` cities - scanned, so a board change moves the target with it.
function fixture({ seed = undefined, need = 6 } = {}) {
  const payload = boardPayload();
  const match = openMatch("1986", payload.sites, {});
  match.clock = "running";
  match.round = 4;
  match.over = false;
  match.sides = { blue: { cash: 500000 }, red: { cash: 500000 } };
  match.pieces = [];
  match.satellites = [];
  if (seed !== undefined) match.capitalSeed = seed;
  seedOwners(match);
  const home = homeCountriesOf(match, "blue") || new Set();
  const capitals = resolvedCapitals(match).list;
  // Countries with enough cities to hold a census, worked out ONCE: scanning cells and counting
  // cities per candidate makes the fixture quadratic and the band arm unusable.
  const cityCount = new Map();
  for (const site of match.sites) {
    if (!site || site.kind !== "city" || site.country_id === undefined || site.country_id === null) continue;
    const country = Number(site.country_id);
    cityCount.set(country, (cityCount.get(country) || 0) + 1);
  }
  const candidates = new Set([...cityCount.entries()]
    .filter(([country, count]) => count >= need && !home.has(country))
    .map(([country]) => country));
  if (!candidates.size) return null;
  for (let y = 4; y < 132; y += 1) {
    for (let x = 4; x < 316; x += 1) {
      const t = terrainAt(payload.cells, x, y);
      if (!t || WATER.has(t)) continue;
      let near = false;
      for (const cap of capitals) {
        if (Math.abs(cap.x - x) <= 3 && Math.abs(cap.y - y) <= 3) near = true;
      }
      if (near) continue;
      const here = cellCountry(match, x, y);
      if (!here || here.country === null) continue;
      if (!candidates.has(here.country)) continue;
      const countries = blastCountries(match, { x, y }, killRadius(), []);
      const cities = match.sites.filter((site) => site.kind === "city"
        && countries.includes(Number(site.country_id)));
      if (cities.length < need) continue;
      return { match, payload, at: { x, y }, countries, cities };
    }
  }
  return null;
}

// A country's cities, owned one third Blue (must go neutral), one third neutral (must go to Red),
// one third Red (must not move) - plus synthetic rows so the census does not depend on how many
// cities the real board puts inside one blast.
let SYNTHETIC = 90000;
function seedCities(match, country, count) {
  const made = [];
  for (let i = 0; i < count; i += 1) {
    const site = {
      id: SYNTHETIC++,
      name: "Test city " + i,
      x: 10 + i,
      y: 10,
      kind: "city",
      country_id: country,
      owner: i % 3 === 0 ? "blue" : (i % 3 === 1 ? null : "red"),
    };
    match.sites.push(site);
    made.push(site);
  }
  return made;
}

export async function run(ctx) {
  eq("the shipped config leaves nukes inert", Boolean((rules().nukes || {}).enabled), false);
  must(/Manual p\.30/.test(String(rules().nukes.switchChanceSource)),
    "nukes.switchChanceSource must quote the manual sentence it stands in for");
  must(/Manual p\.30/.test(String(rules().nukes.firstStrikePenaltySource)),
    "nukes.firstStrikePenaltySource must quote the manual sentence it stands in for");

  const restore = withNukes(true);
  try {
    let base;
    try {
      base = fixture();
      must(Boolean(base), "no 1986 country with six cities outside Blue's home ground was found");
    } catch {
      ctx.skip("no extracted board on this host (set OPENCHQ_DATA / OPENCHQ_EXTRACT)");
    }

    // --- a2(i). the count, the direction, and the rotation ------------------------------------
    {
      const restoreCounts = withNukes(true, {
        switchChance: 100, switchPerCity: 1, switchPerLoss: 1, firstStrikePenalty: 2,
      });
      try {
        const built = fixture();
        const { match, countries } = built;
        const country = countries[0];
        seedCities(match, country, 9);
        // The control: a real city in a country the blast did NOT touch, held by the firer. It must
        // be untouched - a country inside the same blast is a legal target, so it cannot control.
        const outsideCity = match.sites.find((site) => site.kind === "city"
          && site.country_id !== undefined && site.country_id !== null
          && !countries.includes(Number(site.country_id)));
        if (outsideCity) outsideCity.owner = "blue";
        const outsideBefore = outsideCity ? outsideCity.owner : null;

        // First side to fire (mine fired once, theirs never), two cities levelled, no friendly loss.
        match.late = { launched: { blue: { fired: 1 }, red: { fired: 0 } } };
        const result = switchCities(match, "blue", countries, { struckCities: 2, friendlyLosses: 0 });
        eq("the count is random + per-city casualties + the first-strike penalty", result.wanted, 1 + 2 + 2);
        eq("it is the first side to fire", result.first, true);
        eq("the eligible cities moved, up to the count", result.switched.length, 5);
        must(result.switched.every((row) => row.to === null || row.to === "red"),
          "a city switched TO the firer: " + JSON.stringify(result.switched));
        must(!result.switched.some((row) => row.from === "red"),
          "a city the enemy already held was counted as a switch: " + JSON.stringify(result.switched));
        must(result.switched.every((row) => countries.includes(Number(row.country))),
          "a city outside the attacked countries switched: " + JSON.stringify(result.switched));
        for (const row of result.switched) {
          const site = match.sites.find((entry) => entry.id === row.id);
          eq("the site row itself moved", site.owner, row.to);
          // The manual's two directions: the firer's city goes neutral, a neutral one goes over.
          eq("a switch direction is one of the manual's two", [row.from, row.to],
            row.from === "blue" ? ["blue", null] : [null, "red"]);
        }
        if (outsideCity) {
          eq("a city in another country did not move", outsideCity.owner, outsideBefore);
        }
      } finally {
        restoreCounts();
      }
    }

    // --- a2(ii). the penalty is FIRST-strike only -------------------------------------------
    {
      const restoreCounts = withNukes(true, {
        switchChance: 100, switchPerCity: 0, switchPerLoss: 0, firstStrikePenalty: 2,
      });
      try {
        const built = fixture();
        const { match, countries } = built;
        seedCities(match, countries[0], 9);
        match.late = { launched: { blue: { fired: 1 }, red: { fired: 0 } } };
        const first = switchCities(match, "blue", countries, { struckCities: 0, friendlyLosses: 0 });
        eq("the first side to fire gets the extra two", [first.first, first.wanted], [true, 3]);
        match.late = { launched: { blue: { fired: 2 }, red: { fired: 0 } } };
        const second = switchCities(match, "blue", countries, { struckCities: 0, friendlyLosses: 0 });
        eq("a later launch counts the random term only", [second.first, second.wanted], [false, 1]);
        match.late = { launched: { blue: { fired: 1 }, red: { fired: 1 } } };
        const mutual = switchCities(match, "blue", countries, { struckCities: 0, friendlyLosses: 0 });
        eq("a side whose opponent has fired is not the first to fire", [mutual.first, mutual.wanted], [false, 1]);
      } finally {
        restoreCounts();
      }
    }

    // --- a2(iii). the random term is a real roll, and the stream is its own --------------------
    {
      const restoreChance = withNukes(true, {
        switchChance: 50, switchPerCity: 0, switchPerLoss: 0, firstStrikePenalty: 0,
      });
      try {
        const TRIALS = 120;
        let hits = 0;
        for (let seed = 0; seed < TRIALS; seed += 1) {
          const built = fixture({ seed });
          must(Boolean(built), "the band arm found no fixture at seed " + seed);
          const { match, countries } = built;
          seedCities(match, countries[0], 9);
          // The expected draw: the same seed on a fresh match, rolled once.
          const replay = fixture({ seed });
          const expectedRoll = switchRoll(replay.match);
          const result = switchCities(match, "blue", countries, { struckCities: 0, friendlyLosses: 0 });
          eq("seed " + seed + ": the switch roll is seeded", result.roll, expectedRoll);
          eq("seed " + seed + ": the switch is the roll against the chance", result.switched.length, expectedRoll < 50 ? 1 : 0);
          if (result.switched.length === 1) hits += 1;
        }
        must(hits >= 30 && hits <= 90,
          "a 50 per cent chance switched in " + hits + " of " + TRIALS + " seeded trials (band 30..90)");
      } finally {
        restoreChance();
      }
    }

    // --- a2(iv). zero chance and zero casualties switch nothing -------------------------------
    {
      const restoreNone = withNukes(true, {
        switchChance: 0, switchPerCity: 0, switchPerLoss: 0, firstStrikePenalty: 0,
      });
      try {
        const built = fixture();
        const { match, countries } = built;
        const made = seedCities(match, countries[0], 9);
        const before = made.map((site) => site.owner);
        const result = switchCities(match, "blue", countries, { struckCities: 0, friendlyLosses: 0 });
        eq("a zero chance and zero casualties switch nothing", [result.wanted, result.switched.length], [0, 0]);
        eq("no city moved", made.map((site) => site.owner), before);
      } finally {
        restoreNone();
      }
    }

    // --- a2(v). a real launch switches, and PB-156's decoded draw order is untouched -----------
    {
      const restoreMix = withNukes(true, { switchChance: 100, switchPerCity: 0, firstStrikePenalty: 0 });
      try {
        const built = fixture();
        const { match, at, countries } = built;
        seedCities(match, countries[0], 9);
        // PB-156 pinned the match's draw order: below the winter threshold a launch takes NO draw.
        // The switch roll is its own stream precisely so this stays true.
        const before = nukeState(match).rngState;
        const result = useTool(match, "blue", "nuke", at);
        if (result.error) fail("the launch was refused: " + result.error);
        eq("PB-156's income/winter stream took no draw from the switch",
          nukeState(match).rngState, before);
        const event = (result.events || []).find((entry) => entry.type === "nuke_switch");
        must(Boolean(event), "the launch emitted no nuke_switch event");
        eq("the launch switched a city", event.switched.length, 1);
        must(event.switched.every((row) => countries.includes(Number(row.country))),
          "the launch switched a city outside the attacked countries: " + JSON.stringify(event.switched));
        must(/city switched after the strike/.test(String(event.note)),
          "the seat is not told which city changed hands: " + event.note);
        // A tool that is not the nuke flips nothing.
        const owners = new Map(match.sites.map((site) => [site.id, site.owner]));
        const ceasefire = useTool(match, "blue", "ceasefire");
        if (ceasefire.error) fail("the ceasefire arm was refused: " + ceasefire.error);
        eq("a tool that is not the nuke flips no city",
          match.sites.filter((site) => owners.get(site.id) !== site.owner).length, 0);
      } finally {
        restoreMix();
      }
    }

    // --- a2(vi). ground with no nation switches nothing instead of crashing ---------------------
    {
      const { match } = base;
      const moved = switchCities(match, "blue", [null, undefined, 999], { struckCities: 1, friendlyLosses: 0 });
      eq("a strike on ground with no nation switches nothing", moved.switched, []);
    }
  } finally {
    restore();
  }
}
