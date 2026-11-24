// The nation a `country_id` names, read from the archive's own country list.
//
// `countries[]` in the extract's game_meta.json is ordered by country_id (12 = China, 0 = USA), so
// the name is looked up, never inferred from where the cities happen to sit. The public host has no
// extract, so the list ships as web/data/countries.json, baked by tools/bake_countries.mjs.
//
// A city with no country_id, or an id past the end of the list, has NO name: callers say "that
// nation" rather than invent one.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(here, "..", "..");
const bundledFile = path.join(projectDir, "web", "data", "countries.json");

let cached = null;

export function countries() {
  if (cached) return cached;
  if (!existsSync(bundledFile)) {
    cached = [];
    return cached;
  }
  try {
    const baked = JSON.parse(readFileSync(bundledFile, "utf8"));
    cached = Array.isArray(baked && baked.countries) ? baked.countries : [];
  } catch {
    cached = [];
  }
  return cached;
}

export function countryName(id) {
  const index = Number(id);
  if (id === null || id === undefined || !Number.isInteger(index)) return null;
  const name = countries()[index];
  return typeof name === "string" && name ? name : null;
}
