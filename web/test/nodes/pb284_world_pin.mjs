// PB-284: the Baku literal in pb186_oil_log.mjs is a CHECKED row of the baked board, not a
// coincidence that happens to read true.
//
// Frodo's 9764 §2 struck the durability claim I published in 9756: at 4b7c3d7 `git grep russia_baku`
// returns exactly two hits, both in web/test/nodes/pb186_oil_log.mjs (the comment and the hand-built
// `const city`), and nothing under tests/ or web/test/ reads web/data/world.json. So moving Baku in
// the board reddened nothing. That sentence was wrong and stays withdrawn.
//
// This node is the ticket that makes the claim true: it reads the baked board, resolves the one
// `russia_baku` row, pins its six fields, and then pins pb186's own literal to that row field for
// field. Either side moving now fails a named test instead of silently ageing.
//
// It reads two tracked files and needs no reference tree, so it must never skip: a skip here would
// be the same "I checked nothing" green that env.mjs exists to prevent.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..", "..");
const boardPath = path.join(root, "web", "data", "world.json");
const legPath = path.join(root, "web", "test", "nodes", "pb186_oil_log.mjs");

export const name = "pb284_world_pin";

// The row the pb186 arm names, as the baked board carries it.
const EXPECTED = {
  id: "russia_baku",
  name: "Baku",
  x: 192,
  y: 52,
  kind: "oilfield",
  region: "Azerbaijan",
  era_min: 1918,
};

function must(ok, why) {
  if (!ok) throw new Error(why);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

// `const city = { id: "russia_baku", name: "Baku", ... };` -> {id: "russia_baku", ...}
// Flat literals only: pb186's row has no nesting, and a nested one would be a bigger change than
// this pin can honestly follow, so refuse rather than guess.
function literalOf(source) {
  const match = source.match(/const city = (\{[^}]*\})[^;]*;/);
  must(match, "pb186_oil_log.mjs no longer declares `const city = {...};` — the pin cannot find the literal to check");
  const body = match[1].trim().replace(/^\{/, "").replace(/\}$/, "");
  const out = {};
  for (const field of body.split(",")) {
    const text = field.trim();
    if (!text) continue;
    const split = text.indexOf(":");
    must(split > 0, "unparseable field in the pb186 city literal: " + JSON.stringify(text));
    const key = text.slice(0, split).trim();
    let value = text.slice(split + 1).trim();
    must(!/[[{]/.test(value), "the pb186 city literal gained a nested value at " + key + "; extend the pin deliberately");
    if (/^".*"$/.test(value) || /^'.*'$/.test(value)) value = value.slice(1, -1);
    else if (/^-?\d+(\.\d+)?$/.test(value)) value = Number(value);
    else must(false, "unquoted non-numeric value in the pb186 city literal at " + key + ": " + value);
    out[key] = value;
  }
  return out;
}

export async function run() {
  const board = readJson(boardPath);
  must(Array.isArray(board.wells), "web/data/world.json has no wells list — the pin reads the baked board, not the extract");

  const rows = board.wells.filter((well) => well && well.id === EXPECTED.id);
  must(rows.length === 1, "web/data/world.json must carry exactly one " + EXPECTED.id + " row, found " + rows.length);
  const row = rows[0];

  for (const [key, want] of Object.entries(EXPECTED)) {
    must(
      row[key] === want,
      "world.json " + EXPECTED.id + "." + key + " is " + JSON.stringify(row[key]) + ", the pin holds " + JSON.stringify(want)
    );
  }

  const literal = literalOf(readFileSync(legPath, "utf8"));
  must(
    literal.id === row.id,
    "pb186's literal names " + JSON.stringify(literal.id) + ", the board row is " + JSON.stringify(row.id)
  );
  for (const key of Object.keys(literal)) {
    must(
      literal[key] === row[key],
      "pb186's literal " + key + " is " + JSON.stringify(literal[key]) + ", the board row holds " + JSON.stringify(row[key])
    );
  }
  must(
    ["id", "name", "x", "y", "kind", "region"].every((key) => key in literal),
    "pb186's literal lost a field the capture line reads: " + JSON.stringify(Object.keys(literal))
  );
}
