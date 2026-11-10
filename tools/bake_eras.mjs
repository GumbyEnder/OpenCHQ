// Bake each era's opening into the repo: which sites exist, what type byte each carries, who owns
// it at the first bell, and which cells are capitals. Read from the Phase A captures - the live
// bytes of the running original - not typed by hand and not taken from country index 0/1.
//
//   node tools/bake_eras.mjs
//
// Sources:
//   docs/re/era-captures/era-*.sites.json   the live 84-site table (byte, subtype, owner)
//   <extract>/data/cbr_type_by_era.json     the era file's type rows: drift guard, and the 2023 row
//   web/data/world.json                     site names and map cells (the committed board)
//
// Follows tools/bake_world.mjs: same data root via resolveDataRoot(), same BAKE_FAILED contract,
// same sha256_16 of every source file read. _meta.generated is pinned to the source fingerprint,
// not a clock, so a second run leaves the file byte-identical.
//
// Ownership rule (T-002 Phase B): 1918, 1942 and 1986 are fixed fixtures and their owners are the
// live capture bytes. 2023 has no owner or subtype fixture in the captures (both runs roll), so its
// row ships the file subtype and no owners; the match rolls owners, capitals and the unowned count
// from its seed. ???? is a labelled stand-in for the 2023 rule until FUN_23aa_054c is traced.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveDataRoot } from "../web/server/board.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(here, "..");
const outDir = path.join(projectDir, "web", "data");
const captureDir = path.join(projectDir, "docs", "re", "era-captures");

function die(message) {
  console.error("BAKE_FAILED: " + message);
  process.exit(1);
}

function readJson(file, what) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    die("cannot read " + what + ": " + (err && err.message));
  }
}

function sha16(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 16);
}

// The bundled board is committed, so the bake reproduces on a host with no extract. The extract,
// where present, must agree with it on names and cells: a board that moved needs a new bake.
const world = readJson(path.join(projectDir, "web", "data", "world.json"), "web/data/world.json");
const baseSites = (Array.isArray(world.sites) ? world.sites : []).slice().sort((a, b) => a.id - b.id);
if (baseSites.length !== 84) die("web/data/world.json has " + baseSites.length + " sites, expected 84");
const byId = new Map(baseSites.map((site) => [site.id, site]));

const root = resolveDataRoot();
let fileRows = null;
if (root) {
  fileRows = readJson(path.join(root, "data", "cbr_type_by_era.json"), "data/cbr_type_by_era.json");
  const fileSitesRaw = readJson(path.join(root, "data", "sites.json"), "data/sites.json");
  const fileSites = Array.isArray(fileSitesRaw) ? fileSitesRaw : fileSitesRaw.sites;
  for (const site of baseSites) {
    const other = Array.isArray(fileSites) ? fileSites[site.id] : null;
    if (!other) continue;
    if (other.name !== site.name || other.x !== site.x || other.y !== site.y) {
      die("site " + site.id + " differs between world.json and the extract (" + site.name + " " +
        site.x + "," + site.y + " vs " + other.name + " " + other.x + "," + other.y + ")");
    }
  }
} else {
  console.warn("bake_eras: no extract on this machine; the 2023 type row falls back to world.json kinds and the drift guard is skipped");
}

const CAPTURES = {
  "1918": { fileEra: 0, tags: ["era-1918-blue", "era-1918-red"] },
  "1942": { fileEra: 1, tags: ["era-1942-blue", "era-1942-red"] },
  "1986": { fileEra: 2, tags: ["era-1986-blue"] },
};

// The four cities the original clears after the loader (§4). The live byte already reads null
// owner for all four; naming them here keeps the rule explicit and fails loudly if a capture drifts.
const NEUTRAL_1986 = [43, 46, 50, 53];

// The capital each side opens on. Blue's army and the page's "home" marker sit here, and the extra
// capitals are the rest of the side's ground. 1918 blue is Paris (docs/REA_PASS.md: the French
// flag with PARIS selected); the others are the capital on the board's own seat cell.
const SEAT_CAPITAL = {
  "1918": { blue: 17, red: 11, source: "docs/REA_PASS.md (1918 blue opens on Paris)" },
  "1942": { blue: 62, red: 11, source: "board seat cell (Washington / Berlin nearest)" },
  "1986": { blue: 62, red: 63, source: "board seat cell (Washington / Moscow)" },
};

function orderCapitals(capitals, era) {
  const pick = SEAT_CAPITAL[era];
  if (!pick) return capitals;
  for (const side of ["blue", "red"]) {
    const rows = capitals[side];
    const at = rows.findIndex((row) => row.id === pick[side]);
    if (at > 0) rows.unshift(rows.splice(at, 1)[0]);
    if (rows.length) rows[0].seat = true;
  }
  return capitals;
}
const SIDE_OF_OWNER = { 0: null, 1: "blue", 2: "red" };

function loadCapture(tag) {
  const parsed = readJson(path.join(captureDir, tag + ".sites.json"), tag);
  const sites = Array.isArray(parsed.sites) ? parsed.sites : [];
  if (sites.length !== 84) die(tag + " has " + sites.length + " site rows, expected 84");
  return { tag, sites };
}

function captureRows(capture) {
  return capture.sites.map((live) => {
    const base = byId.get(live.id);
    if (!base) die(capture.tag + " names site id " + live.id + " that the board does not have");
    const type = live.byte & 7;
    if (type !== live.subtype) die(capture.tag + " id " + live.id + ": byte " + live.byte + " disagrees with its own subtype " + live.subtype);
    return {
      id: live.id,
      type,
      owner: SIDE_OF_OWNER[live.owner] ?? null,
      present: type !== 0,
      x: base.x,
      y: base.y,
      name: base.name,
      source: capture.tag + ".sites.json (live byte 0x" + live.byte.toString(16) + ")",
    };
  });
}

function capitalsOf(rows, capture) {
  const out = { blue: [], red: [] };
  for (const row of rows) {
    if (row.type !== 1 && row.type !== 2) continue;
    if (row.owner !== "blue" && row.owner !== "red") continue;
    out[row.owner].push({
      id: row.id,
      name: row.name,
      x: row.x,
      y: row.y,
      type: row.type,
      source: capture.tag + ".sites.json subtype " + row.type + " owner " + row.owner,
    });
  }
  return out;
}

const eras = {};

// What the lobby calls each side. 1918 blue is France (docs/REA_PASS.md: the French flag with
// PARIS selected); the rest are the manual's words (p.17: red is the Axis in 1918/1942 and the
// Warsaw Pact in 1986) or a labelled stand-in where no source names a bloc.
const SIDE_LABELS = {
  "1918": {
    blue: { label: "France", source: "docs/REA_PASS.md (French flag, PARIS selected)" },
    red: { label: "Germany", source: "capital is Berlin (capture); manual p.17 calls red the Axis - the name is UNVERIFIED" },
  },
  "1942": {
    blue: { label: "Allies", source: "manual p.17 (USSR is on the Allied side this era)" },
    red: { label: "Axis", source: "manual p.17" },
  },
  "1986": {
    blue: { label: "NATO", source: "manual p.17" },
    red: { label: "Warsaw Pact", source: "manual p.17" },
  },
  "2023": {
    blue: { label: "Bloc A", source: "stand-in: FUN_23aa_0e1c assigns from two power blocs; the bloc table is not recovered" },
    red: { label: "Bloc B", source: "stand-in: FUN_23aa_0e1c assigns from two power blocs; the bloc table is not recovered" },
  },
  "9999": {
    blue: { label: "Bloc A", source: "stand-in, UNVERIFIED (FUN_23aa_054c not yet traced)" },
    red: { label: "Bloc B", source: "stand-in, UNVERIFIED (FUN_23aa_054c not yet traced)" },
  },
};

// --- fixed fixtures -------------------------------------------------------------------------
for (const [era, spec] of Object.entries(CAPTURES)) {
  const captures = spec.tags.map(loadCapture);
  const rows = captureRows(captures[0]);
  // Every capture of one era must show the same owner map: who owns a site is scenario data, not
  // a per-seat fact. A disagreement is a harness error, not something to average away.
  for (const other of captures.slice(1)) {
    const again = captureRows(other);
    for (let i = 0; i < rows.length; i++) {
      const a = rows[i];
      const b = again[i];
      if (a.type !== b.type || a.owner !== b.owner) {
        die(era + ": " + captures[0].tag + " and " + other.tag + " disagree at id " + a.id +
          " (" + a.type + "/" + a.owner + " vs " + b.type + "/" + b.owner + ")");
      }
    }
  }
  if (era === "1986") {
    for (const id of NEUTRAL_1986) {
      const row = rows.find((entry) => entry.id === id);
      if (!row) die("1986 row " + id + " is missing");
      if (row.owner !== null) die("1986 id " + id + " reads owner " + row.owner + ", expected the §4 clear");
      row.source = "era-1986-blue.sites.json (live byte 0x1c; §4 owner-bit clear, cause UNVERIFIED)";
    }
  }
  eras[era] = {
    fileEra: spec.fileEra,
    ownerSource: "capture",
    sides: SIDE_LABELS[era],
    captures: spec.tags.map((tag) => "docs/re/era-captures/" + tag + ".sites.json"),
    capitals: orderCapitals(capitalsOf(rows, captures[0]), era),
    seatCapital: SEAT_CAPITAL[era],
    sites: rows,
  };
}

// --- 2023: subtype row, no owners ------------------------------------------------------------
function fileRow(fileEra) {
  if (!fileRows) return null;
  const row = fileRows[String(fileEra)];
  return Array.isArray(row) && row.length === 84 ? row : null;
}

const row2023 = fileRow(3);
const types2023 = row2023
  ? row2023.map((byte) => byte & 7)
  : baseSites.map((site) => (site.kind === "facility" ? 5 : site.kind === "capital" ? 1 : 4));
if (types2023.some((type) => type === 0)) die("the 2023 type row has an absent site");
if (row2023 && row2023.some((byte) => (byte & 0xc0) !== 0)) die("the 2023 row carries owner bits; the fixture says it has none");

const sites2023 = baseSites.map((site) => ({
  id: site.id,
  type: types2023[site.id],
  owner: null,
  present: true,
  x: site.x,
  y: site.y,
  name: site.name,
  source: row2023
    ? "data/cbr_type_by_era.json row 3 (subtype only; the file carries zero owner bits)"
    : "world.json kind (no extract on this host)",
  unverified: "ownership and capitals are rolled per match: Phase A has two observations only",
}));

const RULE_2023 = {
  function: "FUN_23aa_0e1c @ 23aa:0e1c",
  capitals: "two sites, one per side, different country ids",
  distance: "squared Euclidean distance in map cells with X wrapping at 320 (FUN_188b_0216 @ 188b:0216 returns dx*dx + dy*dy); the capitals must reach 0x271 = 625, i.e. at least 25 cells",
  distanceMinSquared: 625,
  unowned: "even count in [32, 52]; Phase A observed 52 (run a) and 32 (run b)",
  unownedMin: 32,
  unownedMax: 52,
  ownership: "bloc assignment anchored on the two rolled capitals; the remaining sites split evenly between the sides",
  unverified: "the rule is read from the function, but only two live observations exist and the bloc table itself is not recovered",
};

eras["2023"] = {
  fileEra: 3,
  ownerSource: "rolled",
  sides: SIDE_LABELS["2023"],
  captures: ["docs/re/era-captures/era-2023-blue-a.sites.json", "docs/re/era-captures/era-2023-blue-b.sites.json"],
  rule: RULE_2023,
  capitals: { blue: [], red: [] },
  sites: sites2023,
};

// --- ???? (era 9999): a labelled stand-in for the 2023 rule ----------------------------------
eras["9999"] = {
  fileEra: 4,
  ownerSource: "stand-in",
  sides: SIDE_LABELS["9999"],
  captures: ["docs/re/era-captures/era-concealed-blue-a.sites.json", "docs/re/era-captures/era-concealed-blue-b.sites.json"],
  rule: RULE_2023,
  capitals: { blue: [], red: [] },
  sites: sites2023.map((row) => ({
    ...row,
    source: "stand-in, UNVERIFIED (FUN_23aa_054c not yet traced)",
  })),
};

const hashes = { "web/data/world.json": sha16(path.join(projectDir, "web", "data", "world.json")) };
for (const spec of Object.values(CAPTURES)) {
  for (const tag of spec.tags) {
    hashes["docs/re/era-captures/" + tag + ".sites.json"] = sha16(path.join(captureDir, tag + ".sites.json"));
  }
}
for (const tag of ["era-2023-blue-a", "era-2023-blue-b", "era-concealed-blue-a", "era-concealed-blue-b"]) {
  hashes["docs/re/era-captures/" + tag + ".sites.json"] = sha16(path.join(captureDir, tag + ".sites.json"));
}
if (root) hashes["data/cbr_type_by_era.json"] = sha16(path.join(root, "data", "cbr_type_by_era.json"));

const fingerprint = createHash("sha256").update(JSON.stringify(hashes)).digest("hex").slice(0, 16);
const payload = {
  _meta: {
    what: "Each era's opening: which sites exist, each site's type byte, who owns it at the first bell, and the capital cells. Baked from the Phase A captures and the era type rows by tools/bake_eras.mjs",
    not: "This is not the 1990 release's data file. 2023 and ???? ship no owners: those eras roll them per match, and their owner column here is empty on purpose. `type` is not world.json's `kind`.",
    generated: "source-fingerprint:" + fingerprint,
    extract: root ? path.basename(path.dirname(root)) + "/" + path.basename(root) : "absent",
    sha256_16: hashes,
  },
  eras,
};

mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, "eras.json");
writeFileSync(outPath, JSON.stringify(payload, null, 1) + "\n");

const counts = {};
for (const [era, row] of Object.entries(eras)) {
  const present = row.sites.filter((site) => site.present !== false);
  const owners = { blue: 0, red: 0, none: 0 };
  for (const site of present) owners[site.owner === "blue" || site.owner === "red" ? site.owner : "none"] += 1;
  counts[era] = {
    rows: row.sites.length,
    present: present.length,
    absent: row.sites.length - present.length,
    owners,
    capitals: { blue: row.capitals.blue.length, red: row.capitals.red.length },
  };
}

console.log(JSON.stringify({
  wrote: path.relative(projectDir, outPath),
  bytes: readFileSync(outPath).length,
  fingerprint,
  source: root ? "extract + captures" : "captures + world.json (no extract)",
  counts,
}, null, 2));
