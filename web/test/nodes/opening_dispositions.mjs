// The opening army and the seats (T-013b).
//
// Two fidelity bugs the T-013 report measured, both pinned here:
//
//   1. SEATS. The archive's fixed pair is Washington/Moscow, but Moscow is a BLUE capital in 1942,
//      so the remake's red opening piece stood on a blue capital and red took it on the first pass
//      (blitz_1942.mjs: r1 CAPTURES=Moscow). A seat is now the side's own capital from the era file
//      (match.eraSeats), so no opening piece stands on the other side's ground.
//
//   2. The army. The original loads its starting force from HQLAYOUT.<era><side>; with both 1942
//      files renamed the game prints CAN'T OPEN LAYOUT! and the unit array reads 0 records, with
//      them restored it reads the 60 records in notes/t013/orig-1942-round0.txt. The remake opened
//      with 4. 1942 now spawns the captured 60 (web/data/dispositions.json, committed with its
//      source); every other year is UNMEASURED and keeps the four-piece opening.
//
// What this node pins, every era:
//   - round 0 capital owners equal the era file's own bytes;
//   - round 1 capital owners are identical to round 0 - one pass with no orders re-owns nothing;
//   - a file era's two seats are capitals that side owns;
//   - no opening piece stands on a capital held by the other side.
// And for 1942 specifically: 60 pieces, 0 missing / 0 different against the data file, dug-in
// infantry carrying the remake's own entrenched flag.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { matchSites } from "../../server/board.mjs";
import { openMatch, eraSeats } from "../../server/match.mjs";
import { seedOwners } from "../../server/economy.mjs";
import { tickMatch } from "../../server/tick.mjs";
import { eraTable } from "../../server/era.mjs";

export const name = "opening_dispositions";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ERAS = ["1918", "1942", "1986", "2023", "9999"];
const OWNER_SIDE = { 1: null, 2: null };

function fail(message) {
  throw new Error("node test opening_dispositions: " + message);
}

function table() {
  return JSON.parse(readFileSync(path.join(root, "web", "data", "dispositions.json"), "utf8"));
}

function capitalRowsOf(era) {
  const sheet = eraTable(era);
  if (!sheet || !Array.isArray(sheet.sites)) return [];
  return sheet.sites.filter((row) => Number(row.type) === 1 || Number(row.type) === 2);
}

function capitalOwners(match) {
  const out = {};
  for (const site of match.sites) {
    if (Number(site.type) === 1 || Number(site.type) === 2) out[String(site.id)] = site.owner || null;
  }
  return out;
}

function diffOwners(era, before, after) {
  const keys = Object.keys(before);
  for (const key of keys) {
    if (before[key] !== after[key]) {
      fail(`${era}: capital ${key} changed owner on one no-orders pass (${before[key]} -> ${after[key]})`);
    }
  }
}

function fresh(era) {
  const sites = JSON.parse(JSON.stringify(matchSites(era)));
  const match = openMatch(era, sites, { handicapSide: "red" });
  seedOwners(match);
  return match;
}

// Every disposition record has to have its piece, and every piece its record: a cell-for-cell,
// kind-for-kind, side-for-side match with no slack in either direction.
function checkArmy() {
  const sheet = table();
  const rows = sheet["1942"];
  if (!rows || !rows.blue || !rows.red) fail("dispositions.json has no 1942 army");
  const match = fresh("1942");
  const pieces = match.pieces;
  const want = [];
  for (const side of ["blue", "red"]) {
    for (const row of rows[side]) want.push({ side, kind: row.kind, x: row.x, y: row.y, entrenched: row.entrenched === true });
  }
  const key = (side, kind, x, y) => `${side}|${kind}|${x},${y}`;
  const have = new Map();
  for (const unit of pieces) {
    const k = key(unit.side, unit.kind, unit.x, unit.y);
    if (have.has(k)) fail("two opening pieces share " + k);
    have.set(k, unit);
  }
  const missing = [];
  const different = [];
  for (const row of want) {
    const k = key(row.side, row.kind, row.x, row.y);
    const unit = have.get(k);
    if (!unit) {
      missing.push(k);
      continue;
    }
    have.delete(k);
    if (unit.domain !== (row.kind === "infantry" || row.kind === "tank" ? "land" : "sea")) {
      different.push(`${k} domain ${unit.domain}`);
    }
    if (row.entrenched === true && unit.entrenched !== true) different.push(`${k} is not dug in`);
    if (!unit.entrenched && Number(unit.strength) !== Number(unit.maxStrength)) different.push(`${k} opens damaged`);
  }
  if (missing.length) fail(`${missing.length} disposed pieces missing: ${missing.slice(0, 6).join(" ")}`);
  if (different.length) fail(`${different.length} disposed pieces different: ${different.slice(0, 6).join(" ")}`);
  if (have.size) fail(`${have.size} pieces have no disposition record: ${[...have.keys()].slice(0, 6).join(" ")}`);
  if (pieces.length !== want.length) fail(`spawned ${pieces.length} pieces, the capture has ${want.length}`);
  if (pieces.length !== 60) fail(`1942 opened with ${pieces.length} pieces, the capture has 60`);
  const dugIn = pieces.filter((unit) => unit.entrenched === true).length;
  if (dugIn === 0) fail("no 1942 piece opened dug in, but the capture carries kind 3");
  return { pieces: pieces.length, dugIn, blue: pieces.filter((p) => p.side === "blue").length };
}

export async function run() {
  const report = [];
  for (const era of ERAS) {
    const match = fresh(era);
    // 1. round 0: the file's bytes, exactly. A rolled year has no rows, so only its seats exist.
    const rows = capitalRowsOf(era);
    const r0 = capitalOwners(match);
    for (const row of rows) {
      const got = r0[String(row.id)];
      const want = row.owner === "blue" || row.owner === "red" ? row.owner : null;
      if (got !== want) fail(`${era}: capital ${row.id} opens ${got}, the file says ${want}`);
    }
    // 2. the seats are the era's own capitals, and no opening piece stands on enemy ground.
    const seats = eraSeats(era, match.sites);
    if (rows.length) {
      for (const side of ["blue", "red"]) {
        const seat = seats[side];
        const site = match.sites.find((place) => Number(place.id) === Number(seat.siteId));
        if (!site) fail(`${era}: the ${side} seat is not a site`);
        if (site.owner !== side) fail(`${era}: the ${side} seat ${site.name} is owned by ${site.owner}`);
      }
    }
    for (const unit of match.pieces) {
      const site = match.sites.find(
        (place) => Number(place.x) === Number(unit.x) && Number(place.y) === Number(unit.y)
      );
      if (!site) continue;
      if (site.owner && site.owner !== unit.side) {
        fail(`${era}: ${unit.side} ${unit.kind} opens on ${site.name}, held by ${site.owner}`);
      }
      if ((Number(site.type) === 1 || Number(site.type) === 2) && site.owner !== unit.side) {
        fail(`${era}: ${unit.side} ${unit.kind} opens on a capital held by ${site.owner}`);
      }
    }
    // 3. one full pass with no orders: no capital changes hands.
    const before = capitalOwners(match);
    match.clock = "running";
    match.seats = { blue: { kind: "human" }, red: { kind: "human" } };
    tickMatch(match);
    if (match.round !== 1) fail(`${era}: one tick left the match on round ${match.round}`);
    const after = capitalOwners(match);
    diffOwners(era, before, after);
    report.push(`${era} r0/r1 owners stable, seats ${seats.blue.name}/${seats.red.name}, pieces ${match.pieces.length}`);
  }

  const army = checkArmy();
  report.push(`1942 army 60: blue ${army.blue}, dug in ${army.dugIn}, 0 missing / 0 different`);
  for (const line of report) console.log("    " + line);
}
