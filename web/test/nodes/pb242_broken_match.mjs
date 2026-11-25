// Node test for PB-242 decision (a): a match that cannot name its capitals still refuses a SEA aim.
//
// What breaks if this node is removed: PB-242 relaxes the home-country guard for NO_REGION + water,
// and that relaxation is only safe while it sits BELOW the capitals-completeness refusal. Hoist the
// water branch above `if (!capitals.declared || !capitals.complete || !home)` and a match whose
// capital set never resolved starts accepting launches at sea: a fail-closed guard turns into a
// hole that pays out. frodo's m6 arm (the water branch moved above the guard) survived the whole
// suite at 9d0e021 - 177 passed / 0 failed / 0 skipped - because no arm exercised a broken match
// with a sea aim. This node is that arm, and PM 9021 §1(d) makes it a requirement rather than a
// courtesy.
//
// The node lives here, not inside pb242_sea_aim: the sweep node is frodo's accepted artifact and
// was held byte-identical through the successor commit (frodo 9016 §3, PM 9021 §1).
//
// Three reads, in order, so a red names which half broke:
//   1. control - the same cell on an INTACT match is a legal sea aim. Without this the arm could
//      pass on a board where the cell was never aimable in the first place.
//   2. the aim - capitalSet/capitals nulled: nukeTarget refuses with NUKE_HOME_UNKNOWN, says the
//      capitals were never declared, and does not claim the water branch.
//   3. the charge - useTool refuses through the same door, the wallet is untouched and no strike
//      piece is placed. A refusal that costs 0 is the whole point of the guard sitting above it.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { boardPayload, TERRAIN } from "../../server/board.mjs";
import { openMatch } from "../../server/match.mjs";
import { resetRules, rules } from "../../server/rules.mjs";
import { useTool } from "../../server/late.mjs";
import { NUKE_HOME_UNKNOWN, nukeTarget, resolvedCapitals } from "../../server/nukestrike.mjs";
import { NO_REGION, regionAt } from "../../server/territory.mjs";

export const name = "pb242_broken_match";

const CELL_W = 320;
const MARGIN = 3;

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

// The same config swap the other nuke nodes use: the shipped file keeps nukes off, so a node that
// fires one turns the block on and puts the environment back.
function withNukes(on) {
  const custom = JSON.parse(JSON.stringify(rules()));
  custom.nukes = { ...(custom.nukes || {}), enabled: on };
  const dir = mkdtempSync(path.join(tmpdir(), "pb242-broken-"));
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

function terrainAt(cells, x, y) {
  const id = cells[Number(y) * CELL_W + (((Number(x) % CELL_W) + CELL_W) % CELL_W)];
  return id === undefined || id === null ? null : TERRAIN[Number(id)] || null;
}

function fixture(payload) {
  const match = openMatch("1986", payload.sites, {});
  match.clock = "running";
  match.round = 4;
  match.over = false;
  match.sides = { blue: { cash: 500000 }, red: { cash: 500000 } };
  match.pieces = [];
  match.satellites = [];
  return match;
}

// A NO_REGION ocean cell outside every capital ring, so the ring refusal cannot preempt the branch
// under test, and the water relaxation is what makes it aimable on an intact match.
function seaCell(match, payload) {
  const capitals = resolvedCapitals(match).list;
  const ring = Number(rules().nukes.exclusion);
  for (let y = MARGIN; y < 136 - MARGIN; y += 1) {
    for (let x = MARGIN; x < CELL_W - MARGIN; x += 1) {
      if (regionAt(x, y) !== NO_REGION) continue;
      if (terrainAt(payload.cells, x, y) !== "ocean") continue;
      let near = false;
      for (const cap of capitals) {
        if (Math.abs(cap.x - x) <= ring && Math.abs(cap.y - y) <= ring) near = true;
      }
      if (near) continue;
      return { x, y, terrain: "ocean" };
    }
  }
  return null;
}

export async function run(ctx) {
  const payload = boardPayload();
  const restore = withNukes(true);
  try {
    const match = fixture(payload);
    const sea = seaCell(match, payload);
    must(Boolean(sea), "no NO_REGION ocean cell outside every capital ring on this board");

    // --- 1. the control: the cell is a legal sea aim while the match can name its capitals -----
    const intact = nukeTarget(match, "blue", { x: sea.x, y: sea.y });
    must(
      intact.ok === true,
      "the sea aim is refused on an INTACT match at (" + sea.x + "," + sea.y +
        "), so this arm could not tell the guard from the map: " + JSON.stringify(intact),
    );
    eq("the intact aim names the water branch", intact.water, true);
    eq("the intact aim names the terrain it read", intact.terrain, "ocean");

    // --- 2. the aim: a match that never declared its capitals refuses the same cell -----------
    match.capitalSet = null;
    match.capitals = null;
    const aimed = nukeTarget(match, "blue", { x: sea.x, y: sea.y });
    eq("a match with no capital set refuses the sea aim", aimed.error, NUKE_HOME_UNKNOWN);
    eq(
      "the broken-match refusal says the capitals were never declared",
      aimed.capitals && aimed.capitals.declared, false,
    );
    eq("a broken-match refusal is not a water claim", aimed.water, undefined);
    eq("a broken-match refusal names no terrain it did not read", aimed.terrain, undefined);

    // --- 3. the charge: the door a player uses refuses too, and the wallet is untouched --------
    const cash = match.sides.blue.cash;
    const refused = useTool(match, "blue", "nuke", { x: sea.x, y: sea.y });
    eq("a broken match refuses the sea aim through the tool too", refused.error, NUKE_HOME_UNKNOWN);
    eq("a broken-match refusal costs nothing", match.sides.blue.cash, cash);
    eq("a broken-match refusal places no strike", (match.pieces || []).length, 0);

    console.log(
      "broken match: sea aim (" + sea.x + "," + sea.y + ") ok on an intact match, refused " +
        JSON.stringify(refused.error) + " with capitalSet null, cash " + cash + " -> " +
        match.sides.blue.cash,
    );
  } finally {
    restore();
  }
}
