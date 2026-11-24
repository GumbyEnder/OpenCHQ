// Bake the archive's country list into the repo so a sentence can name a nation on a host that has
// no extract.
//
// The list is `countries[]` in the extract's data/game_meta.json, and its ORDER is the meaning:
// every site's `country_id` is an index into it (12 = China, 0 = USA, 1 = USSR). Reading a nation's
// name off real geography would be our guess; reading it out of this array is the archive's own
// answer.
//
//   node tools/bake_countries.mjs
//
// Run it whenever the extract changes. web/test/nodes/pb228_nation_loyalty.mjs compares the baked
// copy against the extract whenever OPENCHQ_DATA is mounted, so a stale bake cannot ship quietly.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveDataRoot } from "../web/server/board.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(here, "..");
const outFile = path.join(projectDir, "web", "data", "countries.json");

const root = resolveDataRoot();
if (!root) {
  console.error("BAKE_FAILED: no extract on this machine; the country list cannot be re-baked here");
  process.exit(1);
}

const metaFile = path.join(root, "data", "game_meta.json");
let meta;
try {
  meta = JSON.parse(readFileSync(metaFile, "utf8"));
} catch (err) {
  console.error("BAKE_FAILED: " + metaFile + " is unreadable: " + err.message);
  process.exit(1);
}

const countries = Array.isArray(meta && meta.countries) ? meta.countries : null;
if (!countries || countries.length === 0 || countries.some((name) => typeof name !== "string" || !name)) {
  console.error("BAKE_FAILED: game_meta.json carries no usable countries[] list");
  process.exit(1);
}

const out = {
  _meta: {
    what: "The archive's country list, in the order that country_id indexes",
    not: "This is not a data file of the 1990 release. It is one array of names, decoded from the extract by tools/bake_countries.mjs.",
    source: "modern/extracted/data/game_meta.json countries[]",
    order: "countries[i] is the nation whose country_id is i",
    count: countries.length,
    generated: new Date().toISOString(),
  },
  countries,
};

mkdirSync(path.dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify(out, null, 2) + "\n");
console.log("wrote " + outFile + " (" + countries.length + " countries, " + countries[12] + " at 12)");
