// Node test for PB-233 AC (a): a strike moves world opinion, and only where it landed.
//
// What breaks if this node is removed: a nuke leaves no diplomatic mark at all, or it moves every
// country on the board instead of the ones the blast covered, or the archive's halving / odd-nudge /
// clamp arithmetic silently becomes a flat subtraction.
//
// Ghidra: FUN_1eb5_0eae, decompiled.c 12133-12166 - a signed byte per nation at 0x13e4, moved by
// (0x13be[nation] & 0xf) * one global sign, HALVED when the magnitude is no bigger than the
// referenced attitude, nudged by one when the halved value is 0 and the gate byte is odd, clamped
// +-0x7f. The magnitude's per-nation nibble table does not exist in this build, so
// `nukes.attitudeShift` is a STAND-IN from the archive's 1..15 range.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { boardPayload, TERRAIN } from "../../server/board.mjs";
import { openMatch } from "../../server/match.mjs";
import { resetRules, rules } from "../../server/rules.mjs";
import { useTool } from "../../server/late.mjs";
import { attitudeOf, attitudeShift, shiftAttitude } from "../../server/aftermath.mjs";
import { blastCountries, cellCountry, homeCountriesOf, killRadius, resolvedCapitals } from "../../server/nukestrike.mjs";

export const name = "pb233_attitude";

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
  const dir = mkdtempSync(path.join(tmpdir(), "pb233a-"));
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

// A land cell outside Blue's home country, far enough from every capital for a full blast - scanned
// from the board, so a board change moves the target with it (the pb230_nuke_strike shape).
function pickTarget(match, payload, { margin = 3 } = {}) {
  const home = homeCountriesOf(match, "blue") || new Set();
  const capitals = resolvedCapitals(match).list;
  for (let y = margin; y < 136 - margin; y += 1) {
    for (let x = margin; x < 320 - margin; x += 1) {
      const t = terrainAt(payload.cells, x, y);
      if (!t || WATER.has(t)) continue;
      let near = false;
      for (const cap of capitals) {
        if (Math.abs(cap.x - x) <= margin && Math.abs(cap.y - y) <= margin) near = true;
      }
      if (near) continue;
      const here = cellCountry(match, x, y);
      if (!here || here.country === null) continue;
      if (home.has(here.country)) continue;
      return { x, y, country: here.country };
    }
  }
  return null;
}

export async function run(ctx) {
  eq("the shipped config leaves nukes inert", Boolean((rules().nukes || {}).enabled), false);
  must(/decompiled\.c 12133/.test(String(rules().nukes.attitudeShiftSource)),
    "config nukes.attitudeShiftSource must name the routine and the line range it ports");
  must(new RegExp("STAND-IN").test(String(rules().nukes.attitudeShiftSource)),
    "the magnitude is a stand-in and its source must say so");

  const restore = withNukes(true);
  try {
    let payload;
    try {
      payload = boardPayload();
      must(Boolean(payload && payload.cells), "the board has no terrain grid");
    } catch {
      ctx.skip("no extracted board on this host (set OPENCHQ_DATA / OPENCHQ_EXTRACT)");
    }

    // --- a(i). one strike, the countries it covered, and nothing else -------------------------
    {
      const { match } = fixture();
      const target = pickTarget(match, payload);
      must(Boolean(target), "no land cell outside Blue's home country could be found");
      const at = { x: target.x, y: target.y };
      const radius = killRadius();
      const cellCountries = blastCountries(match, at, radius, []);
      must(cellCountries.length > 0, "the blast covered no named country");
      eq("no country has an opinion before any strike", JSON.stringify(match.attitude || {}), "{}");

      const preSites = match.sites.slice();
      const result = useTool(match, "blue", "nuke", at);
      if (result.error) fail("a legal launch was refused: " + result.error);
      const strikeEvent = (result.events || []).find((event) => event.type === "nuke");
      must(Boolean(strikeEvent), "the launch emitted no nuke event");
      // A city the blast levelled contributes its own country byte, so the expected set is the cell
      // scan plus the destroyed sites' countries.
      const destroyedCountries = strikeEvent.sites
        .map((row) => {
          const pre = preSites.find((site) => String(site.id) === String(row.id));
          return pre && pre.country_id !== undefined && pre.country_id !== null ? Number(pre.country_id) : null;
        })
        .filter((country) => country !== null);
      const expected = new Set([...cellCountries, ...destroyedCountries]);

      const base = attitudeShift();
      must(base >= 1, "attitudeShift must be at least 1, got " + base);
      for (const country of expected) {
        eq("country " + country + " turned against the launch by the config magnitude", attitudeOf(match, country), -base);
      }
      const keys = Object.keys(match.attitude || {});
      eq("the ledger holds exactly the countries the blast touched", keys.sort(), [...expected].map(String).sort());

      // A country the blast did NOT touch has no entry at all - not a zero, not a copy.
      let outside = null;
      for (let country = 0; country < 38; country += 1) {
        if (!expected.has(country)) { outside = country; break; }
      }
      must(outside !== null, "every country in the 1986 roster was inside the blast");
      eq("a country outside the blast has no ledger entry", Object.prototype.hasOwnProperty.call(match.attitude, String(outside)), false);

      const event = (result.events || []).find((entry) => entry.type === "nuke_attitude");
      must(Boolean(event), "the launch emitted no nuke_attitude event");
      eq("the event reports one row per country moved", event.moved.length, expected.size);
      must(/World opinion turned against the launch/.test(String(event.note)),
        "the seat is not told that world opinion moved: " + event.note);
      must(event.moved.every((row) => row.after === row.before - base),
        "a reported row did not move by the config magnitude: " + JSON.stringify(event.moved));

      // A second strike on the same ground moves the SAME countries again, and the archive's halving
      // shows up on the strike path too: once the opinion is as strong as the magnitude, the next
      // hit is half of it (4 -> -4, then -4 - floor(4/2) = -6, never a flat -8).
      const again = useTool(match, "blue", "nuke", at);
      if (again.error) fail("the second legal launch was refused: " + again.error);
      const country = [...expected][0];
      eq("a second strike moves the country again, by half", attitudeOf(match, country), -base - Math.floor(base / 2));
    }

    // --- a(ii). the archive's arithmetic: halving, the odd nudge, the clamp -------------------
    {
      const { match } = fixture();
      match.attitude = { "0": 16, "1": 1, "2": 2, "3": -126 };
      shiftAttitude(match, [0], { base: 4 });
      eq("a country already at 16 takes HALF the hit", attitudeOf(match, 0), 14);
      shiftAttitude(match, [1], { base: 1 });
      eq("a halved-to-zero hit on an odd attitude still moves by 1", attitudeOf(match, 1), 0);
      shiftAttitude(match, [2], { base: 1 });
      eq("the same halved-to-zero hit on an EVEN attitude moves nothing", attitudeOf(match, 2), 2);
      shiftAttitude(match, [3], { base: 4 });
      eq("the ledger clamps at -0x7f", attitudeOf(match, 3), -127);
      eq("every move is against the firer", shiftAttitude(match, [0], { base: 4 })[0].shift < 0, true);
    }

    // --- a(iii). the magnitude follows config, so a literal dies here -----------------------
    {
      const restoreOverlay = withNukes(true, { attitudeShift: 6 });
      try {
        eq("attitudeShift reads config", attitudeShift(), 6);
        const { match } = fixture();
        shiftAttitude(match, [9]);
        eq("the ledger moves by the CONFIG magnitude, not the shipped 4", attitudeOf(match, 9), -6);
      } finally {
        restoreOverlay();
      }
    }
  } finally {
    restore();
  }
}
