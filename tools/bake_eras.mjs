// Bake the per-era site table into the repo so the game can play the original's opening, not one
// opening for every year.
//
//   node tools/bake_eras.mjs
//
// Source: <extract>/data/cbr_type_by_era.json - five 84-entry rows read out of CBR-TYPE.DTn. Each
// byte carries the subtype in the low three bits (byte & 7) and the owner bits above it
// (0x40 blue, 0x80 red). Nothing else is invented here: absent sites keep type 0 so the raw row
// stays visible, and 2023 keeps its subtype row while shipping no owners at all.
//
// Follows tools/bake_world.mjs: same data root, same BAKE_FAILED contract, same sha256_16 of every
// source file read. Re-running it is idempotent - _meta.generated is pinned to the source hash
// rather than a clock, so a second run leaves the file byte-identical.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveDataRoot } from "../web/server/board.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(here, "..");
const outDir = path.join(projectDir, "web", "data");

const root = resolveDataRoot();
if (!root) {
  console.error("BAKE_FAILED: no extract on this machine; the era table cannot be re-baked here");
  process.exit(1);
}

const sourceFile = "data/cbr_type_by_era.json";
const sourcePath = path.join(root, sourceFile);
let raw;
try {
  raw = JSON.parse(readFileSync(sourcePath, "utf8"));
} catch (err) {
  console.error("BAKE_FAILED: " + sourceFile + " did not read: " + err.message);
  process.exit(1);
}

const hash = createHash("sha256").update(readFileSync(sourcePath)).digest("hex").slice(0, 16);

// era label -> file row. ???? is deliberately absent: its row (type 3/4 everywhere) contradicts the
// live subtype the captures show, so baking it would be a fixture invented from a contradiction.
const ERA_ROWS = [
  { label: "1918", fileEra: 0, ownerSource: "file" },
  { label: "1942", fileEra: 1, ownerSource: "file" },
  { label: "1986", fileEra: 2, ownerSource: "file" },
  { label: "2023", fileEra: 3, ownerSource: "rolled" },
];

// The original clears these four owner bits after the loader, so the site starts unowned in 1986
// even though the file still carries 0x54/0x94 there. Forcing them here keeps the override in the
// data instead of in a special case the gameplay code would have to remember.
const NEUTRAL_1986 = new Set([43, 46, 50, 53]);

function ownerOf(byte) {
  if (byte & 0x40) return "blue";
  if (byte & 0x80) return "red";
  return null;
}

const eras = {};
for (const { label, fileEra, ownerSource } of ERA_ROWS) {
  const row = raw[String(fileEra)];
  if (!Array.isArray(row) || row.length !== 84) {
    console.error("BAKE_FAILED: era row " + fileEra + " is not an 84-entry array");
    process.exit(1);
  }
  const sites = row.map((byte, id) => {
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
      console.error("BAKE_FAILED: era " + label + " id " + id + " is not a byte: " + JSON.stringify(byte));
      process.exit(1);
    }
    // A rolled era ships its subtype row but no owners: the file carries zero owner bits and both
    // captures roll ownership, so a baked owner there would be a guess.
    let owner = ownerSource === "rolled" ? null : ownerOf(byte);
    if (ownerSource === "file" && label === "1986" && NEUTRAL_1986.has(id)) owner = null;
    return { id, type: byte & 7, owner };
  });
  eras[label] = { fileEra, ownerSource, sites };
}

const payload = {
  _meta: {
    what: "Per-era site table: subtype (byte & 7) and owner bits (0x40 blue / 0x80 red) for all 84 site ids, read from the extract by tools/bake_eras.mjs",
    not: "This is not the extract and it is not world.json's kind. No data file of the 1990 release is shipped, and the subtype is not mapped onto kind: the two disagree on 14 of 84 sites at 1986 (city-kind, capitals excluded) - the 12 sites whose 1986 row is type 3 that world.json calls city (0, 1, 2, 4, 21, 22, 51, 52, 54, 55, 57, 58) plus ids 10 London and 35 Tokyo, which the file calls type 1 and world.json calls city. The capital-kind ids 62/63 agree, and so do the 20 facility ids 64..83.",
    generated: "pinned to " + sourceFile + " sha256_16 " + hash,
    extract: path.basename(path.dirname(root)) + "/" + path.basename(root),
    sha256_16: { [sourceFile]: hash },
  },
  eras,
};

mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, "eras.json");
const text = JSON.stringify(payload) + "\n";
writeFileSync(outPath, text);

console.log(JSON.stringify({
  wrote: path.relative(projectDir, outPath),
  bytes: Buffer.byteLength(text),
  source: sourceFile,
  sha256_16: hash,
  eras: Object.fromEntries(Object.entries(eras).map(([label, era]) => {
    const live = era.sites.filter((site) => site.type !== 0).length;
    return [label, { live, absent: 84 - live, ownerSource: era.ownerSource }];
  })),
}));
