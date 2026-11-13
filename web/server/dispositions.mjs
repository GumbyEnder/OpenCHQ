// The opening force per era, as the original places it.
//
// web/data/dispositions.json is the round-0 army read out of the original's own unit arrays
// (notes/t013/orig-1942-round0.txt, 2026-11-13). 1942 carries 60 records: blue 29, red 31, with
// kinds, cells and the dug-in flag; every other year is UNMEASURED and has no entry, so
// match.openingPieces keeps the four-piece opening it has always shipped for those years.
//
// Why this file exists at all: the original loads its starting army from HQLAYOUT.<era><side>
// (era index 1 for 1942 -> HQLAYOUT.100 blue, HQLAYOUT.110 red). Measured 2026-11-13: with both
// files renamed the game prints CAN'T OPEN LAYOUT! and the live unit array reads 0 records; with
// them restored it reads the same 60 records as the capture. The remake's four-piece opening was
// therefore not a tuning choice, it was a missing army.
//
// Nothing here reads the extract at runtime, exactly like era.mjs: the data file is committed, so a
// host with no reference tree still opens on the original's disposition.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dataFile = path.join(projectDir, "web", "data", "dispositions.json");

let baked = null;
let attempted = false;

function load() {
  if (attempted) return baked;
  attempted = true;
  try {
    baked = JSON.parse(readFileSync(dataFile, "utf8"));
  } catch {
    baked = null;
  }
  return baked;
}

const SIDES = Object.freeze(["blue", "red"]);

// One era's opening force, or null when the year was never captured. A side with no records is not
// a measured empty army - it is a broken file, so it is reported rather than spawned as nothing.
export function openingForce(era) {
  const table = load();
  if (!table) return null;
  const rows = table[String(era)];
  if (!rows || typeof rows !== "object") return null;
  const sides = {};
  for (const side of SIDES) {
    const list = Array.isArray(rows[side]) ? rows[side] : [];
    sides[side] = list
      .filter((row) => row && Number.isInteger(Number(row.x)) && Number.isInteger(Number(row.y)))
      .map((row) => ({
        kind: String(row.kind),
        domain: String(row.domain || "land"),
        x: Number(row.x),
        y: Number(row.y),
        strength: Number(row.strength) > 0 ? Number(row.strength) : null,
        entrenched: row.entrenched === true,
      }));
  }
  if (!sides.blue.length && !sides.red.length) return null;
  return { era: String(era), sides, meta: table._meta || null };
}

// The provenance string the report and the diffs quote, so a claim about the army carries where the
// army came from instead of pointing at a bare data file.
export function openingSource(era) {
  const table = load();
  const source = table && table._meta && table._meta.source ? table._meta.source[String(era)] : null;
  return source || null;
}
