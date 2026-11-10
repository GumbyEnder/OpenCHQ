// Node era_table: the baked per-era site table matches the original, by exact count.
//
// B-1 lands data plus a pure function, so it can be checked instead of blamed. What this asserts:
// the bake carries all 84 ids per era (absent ones as type 0), and the live/absent/type/owner
// numbers are the ones docs/re/ERA_SETUP.md read off the running game - 1918 25 live, 1942 64,
// 1986 and 2023 all 84, with the 1986 §4 override forced neutral. Then the guard: if this host has
// the extract, the baked file must still agree with it, id by id, and name the first disagreement.
//
// Deliberately not asserted: the meaning of subtype 1 vs 2, and any mapping of `type` onto `kind`.
// The file and world.json disagree on 34 of 84 sites; mapping would reclassify income and the 20
// facilities in one keystroke, so `kind` staying put is itself a check.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { boardPayload, matchSites, resolveDataRoot } from "../../server/board.mjs";
import { applyEra, eraTable } from "../../server/era.mjs";

export const name = "era_table";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(here, "..", "..", "..");
const erasFile = path.join(projectDir, "web", "data", "eras.json");

// ERA_SETUP.md §2/§4/§6, by exact count. `neutralIds` is the whole neutral set, not just a count:
// a count can be right for the wrong reason. `neutralIds: null` means the era ships no owners.
const EXPECT = {
  "1918": { live: 25, absent: 59, types: { 1: 2, 2: 1, 4: 22 }, blue: 14, red: 9, neutralIds: [35, 53] },
  "1942": { live: 64, absent: 20, types: { 1: 4, 2: 2, 3: 12, 4: 46 }, blue: 40, red: 23, neutralIds: [29] },
  "1986": {
    live: 84, absent: 0, types: { 1: 3, 2: 1, 3: 12, 4: 48, 5: 20 }, blue: 49, red: 25,
    neutralIds: [31, 43, 46, 47, 50, 53, 56, 59, 60, 78],
  },
  "2023": { live: 84, absent: 0, types: { 3: 12, 4: 52, 5: 20 }, blue: 0, red: 0, neutralIds: null },
  // ???? is not a fixture: its row is the 2023 stand-in, labelled as one on every site.
  "9999": { live: 84, absent: 0, types: { 3: 12, 4: 52, 5: 20 }, blue: 0, red: 0, neutralIds: null },
};

// The original clears these four owner bits after the loader; the file still carries 0x54/0x94.
const NEUTRAL_1986 = [43, 46, 50, 53];

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function ownerOfByte(byte) {
  if (byte & 0x40) return "blue";
  if (byte & 0x80) return "red";
  return null;
}

export async function run(ctx) {
  const { fail } = ctx;

  let world;
  try {
    world = JSON.parse(readFileSync(erasFile, "utf8"));
  } catch (err) {
    fail("web/data/eras.json is missing or unreadable, so the game has no era opening: " + err.message);
  }
  if (!world._meta || !world._meta.not) fail("the baked era file does not say what it is not");
  if (!world._meta.sha256_16 || !world._meta.sha256_16["data/cbr_type_by_era.json"]) {
    fail("the baked era file does not carry the source hash, so a stale bake cannot be spotted");
  }
  if (!world.eras || typeof world.eras !== "object") fail("the baked era file has no eras table");

  const labels = Object.keys(world.eras).sort();
  if (!sameJson(labels, ["1918", "1942", "1986", "2023", "9999"])) {
    fail("the baked eras are " + JSON.stringify(labels) + ", expected 1918/1942/1986/2023/9999");
  }
  // ???? is out of the fixture. Its row is the 2023 rule as a labelled stand-in, and every site in
  // it must say so - the file's own era-4 row (type 3/4 everywhere) contradicts the live subtype,
  // so nothing in this row may be passed off as measured.
  const standIn = world.eras["9999"];
  if (!standIn || standIn.ownerSource !== "stand-in") fail("the 9999 row is not labelled a stand-in");
  if (!standIn.sites.every((site) => String(site.source).includes("UNVERIFIED (FUN_23aa_054c not yet traced)"))) {
    fail("a 9999 site row does not carry the stand-in label");
  }
  for (let id = 0; id < 84; id++) {
    if (standIn.sites[id].type !== world.eras["2023"].sites[id].type) {
      fail("9999 id " + id + " does not match the 2023 stand-in subtype");
    }
  }

  // ---- the drift guard, first: a stale bake is a lie the game would play --------------------
  // Re-read the extract and compare id by id. A count would not say which site is wrong; the id
  // does, so the failure points at the site instead of starting a hunt.
  const root = resolveDataRoot();
  if (root) {
    const source = "data/cbr_type_by_era.json";
    let raw;
    try {
      raw = JSON.parse(readFileSync(path.join(root, source), "utf8"));
    } catch (err) {
      fail("the extract has no readable " + source + ": " + err.message);
    }
    const overridden = [];
    for (const era of Object.keys(EXPECT).filter((key) => key !== "9999")) {
      const entry = eraTable(era);
      if (!entry) fail("eraTable(" + era + ") is null, but the bake carries that year");
      const row = raw[String(entry.fileEra)];
      if (!Array.isArray(row) || row.length !== 84) fail("the extract's era row " + entry.fileEra + " is not 84 entries");
      const wantSource = era === "2023" ? "rolled" : "capture";
      if (entry.ownerSource !== wantSource) {
        fail(era + " ownerSource is " + entry.ownerSource + " in the bake, expected " + wantSource);
      }
      for (let id = 0; id < 84; id++) {
        const byte = row[id];
        const baked = entry.sites[id];
        const type = byte & 7;
        let owner = era === "2023" ? null : ownerOfByte(byte);
        if (era === "1986" && NEUTRAL_1986.includes(id)) {
          if (owner !== null) overridden.push(id);
          owner = null;
        }
        if (baked.type !== type) {
          fail("eras.json is stale: " + era + " id " + id + " (" + world.eras[era].sites[id].id +
            ") type is " + baked.type + ", the extract says " + type + " - re-run node tools/bake_eras.mjs");
        }
        if (baked.owner !== owner) {
          fail("eras.json is stale: " + era + " id " + id + " owner is " + JSON.stringify(baked.owner) +
            ", the extract says " + JSON.stringify(owner) + " - re-run node tools/bake_eras.mjs");
        }
      }
    }
    // The override is exactly the four §4 ids and nothing else: if the bake starts neutralising
    // more, the table is quietly inventing ownership.
    if (!sameJson(overridden.sort((a, b) => a - b), NEUTRAL_1986)) {
      fail("the extract's 1986 row would give owners to ids " + JSON.stringify(overridden) +
        ", expected exactly the §4 four " + JSON.stringify(NEUTRAL_1986));
    }
    // The hash the bake recorded must be the hash of the file just compared against.
    const hash = createHash("sha256").update(readFileSync(path.join(root, source))).digest("hex").slice(0, 16);
    if (world._meta.sha256_16[source] !== hash) {
      fail("the bake was made from a different " + source + " (" + world._meta.sha256_16[source] + " vs " + hash + ")");
    }
  }

  // ---- A3: the counts, per era, off the baked file -----------------------------------------
  for (const [era, want] of Object.entries(EXPECT)) {
    const entry = eraTable(era);
    if (!entry) fail("eraTable(" + era + ") is null, but the bake carries that year");
    const sites = entry.sites;
    if (sites.length !== 84) fail(era + " carries " + sites.length + " ids, expected all 84");
    for (let id = 0; id < 84; id++) {
      if (!sites[id] || sites[id].id !== id) {
        fail(era + " id list is not one row per id at index " + id + ": " + JSON.stringify(sites[id]));
      }
    }
    if (new Set(sites.map((site) => site.id)).size !== 84) fail(era + " has duplicate ids");

    const live = sites.filter((site) => site.type !== 0);
    const absent = sites.filter((site) => site.type === 0);
    if (live.length !== want.live) fail(era + " has " + live.length + " live sites, the capture shows " + want.live);
    if (absent.length !== want.absent) fail(era + " has " + absent.length + " absent sites, the capture shows " + want.absent);

    const types = {};
    for (const site of live) types[site.type] = (types[site.type] || 0) + 1;
    if (!sameJson(types, want.types)) {
      fail(era + " type histogram is " + JSON.stringify(types) + ", expected " + JSON.stringify(want.types));
    }

    const blue = live.filter((site) => site.owner === "blue");
    const red = live.filter((site) => site.owner === "red");
    const neutral = live.filter((site) => site.owner === null);
    if (blue.length !== want.blue) fail(era + " has " + blue.length + " blue sites, the capture shows " + want.blue);
    if (red.length !== want.red) fail(era + " has " + red.length + " red sites, the capture shows " + want.red);
    if (blue.length + red.length + neutral.length !== live.length) {
      fail(era + " carries an owner that is neither blue, red nor null");
    }
    if (want.neutralIds === null) {
      if (neutral.length !== live.length) fail(era + " baked " + (live.length - neutral.length) + " owners for a rolled era");
    } else {
      const got = neutral.map((site) => site.id);
      if (!sameJson(got, want.neutralIds)) {
        fail(era + " neutral ids are " + JSON.stringify(got) + ", expected " + JSON.stringify(want.neutralIds));
      }
    }
  }

  // 1986's ten neutrals are the file's six plus the §4 four. Without the override the file alone
  // would give blue 52 / red 26 / neutral 6, so these four rows must be null in the bake.
  for (const id of NEUTRAL_1986) {
    const row = world.eras["1986"].sites[id];
    if (row.type === 0) fail("the §4 override names id " + id + ", which is absent in 1986");
    if (row.owner !== null) fail("id " + id + " was not forced neutral in 1986: " + row.owner);
  }

  // ---- R2: the subtype travels as `type`, and `kind` is not rewritten -----------------------
  const base = matchSites("1986");
  if (!Array.isArray(base) || !base.length) {
    fail("matchSites(1986) returned no sites, so the table cannot be applied to a real opening");
  }
  const opened = applyEra(base, "1986");
  if (opened === base) fail("applyEra(1986) returned the input array, so the table did nothing");
  if (opened.length !== base.length) {
    fail("applyEra(1986) changed the site count from " + base.length + " to " + opened.length + " in a year with no absent sites");
  }
  const baseSites = opened.filter((site) => Number.isInteger(site.id));
  if (baseSites.length !== 84) fail("the applied opening names " + baseSites.length + " sites off the 84-row table");
  const byId = (id) => baseSites.find((site) => site.id === id);
  // London (10), Tokyo (35) and Washington (62) are type 1 in the 1986 file while world.json calls
  // them city/city/capital. If the subtype ever lands in `kind`, this is where it shows.
  for (const [id, kind] of [[10, "city"], [35, "city"], [62, "capital"]]) {
    const site = byId(id);
    if (!site) fail("the applied 1986 opening lost id " + id);
    if (site.kind !== kind) fail("id " + id + " kind became " + JSON.stringify(site.kind) + ", the file must not be written into kind");
    if (site.type !== 1) fail("id " + id + " should carry subtype 1 from the file, got " + site.type);
  }
  const facility = byId(83);
  if (!facility) fail("the applied 1986 opening lost id 83");
  if (facility.kind !== "facility") fail("id 83 lost its facility kind: " + JSON.stringify(facility.kind));
  if (facility.type !== 5) fail("id 83 should carry subtype 5, got " + facility.type);

  // Docks and wells are not in the 84-row table and must survive untouched, x/y included.
  const docks = opened.filter((site) => String(site.id).startsWith("dock:"));
  const wells = opened.filter((site) => !Number.isInteger(site.id) && !String(site.id).startsWith("dock:"));
  if (!docks.length) fail("applyEra dropped every dock, which is not its business");
  if (!wells.length) fail("applyEra dropped every oil well, which is not its business");
  if (docks.some((site) => Object.hasOwn(site, "type"))) fail("applyEra wrote a type onto a dock");
  if (wells.some((site) => Object.hasOwn(site, "type"))) fail("applyEra wrote a type onto an oil well");
  for (const site of baseSites) {
    const before = base.find((old) => old.id === site.id);
    if (!before || before.x !== site.x || before.y !== site.y) {
      fail("applyEra moved id " + site.id + " from " + JSON.stringify([before && before.x, before && before.y]) +
        " to " + JSON.stringify([site.x, site.y]));
    }
  }

  // ---- R1: absent sites are dropped, nothing else is ---------------------------------------
  // matchSites already applies the era, so the absent row has to be applied to the raw list to
  // prove the drop still happens (and that it is the table, not the board, doing the dropping).
  const base1918 = (boardPayload().sites || []).map((site) => ({
    id: site.id, name: site.name, x: site.x, y: site.y, kind: site.kind, country_id: site.country_id,
  }));
  const opened1918 = applyEra(base1918, "1918");
  const live1918 = opened1918.filter((site) => Number.isInteger(site.id)).map((site) => site.id);
  const want1918 = world.eras["1918"].sites.filter((site) => site.type !== 0).map((site) => site.id);
  if (!sameJson(live1918, want1918)) {
    fail("applyEra(1918) plays " + JSON.stringify(live1918) + ", the capture has " + JSON.stringify(want1918));
  }
  if (opened1918.length >= base1918.length) {
    fail("applyEra(1918) dropped no absent site: " + opened1918.length + " of " + base1918.length + " kept");
  }
  if (opened1918.some((site) => Number.isInteger(site.id) && world.eras["1918"].sites[site.id].type === 0)) {
    fail("an absent 1918 site survived applyEra, so it could still be hovered and owned");
  }

  // ---- R4/R5: a rolled era keeps the owners it found; an unknown year is identity ----------
  const sample = [{ id: 10, name: "London", x: 1, y: 2, kind: "city", owner: "red" }];
  const rolled = applyEra(sample, "2023");
  if (rolled[0].owner !== "red") fail("applyEra(2023) overwrote an owner, but 2023 rolls them (B-3)");
  if (rolled[0].type !== world.eras["2023"].sites[10].type) fail("applyEra(2023) did not carry the subtype");
  if (sample[0].owner !== "red" || Object.hasOwn(sample[0], "type")) fail("applyEra mutated its input array's site");

  for (const junk of ["junk", "", null, undefined, 4242]) {
    if (eraTable(junk) !== null) fail("eraTable(" + JSON.stringify(junk) + ") returned a table for an unknown year");
    const arr = [{ id: 0, x: 0, y: 0 }];
    if (applyEra(arr, junk) !== arr) fail("applyEra(" + JSON.stringify(junk) + ") copied an unknown year instead of returning it");
  }

  // The board is untouched by B-1: no call site in the running game reads this table yet.
  const board = boardPayload();
  if (board.source !== "extract" && board.source !== "bundled") {
    fail("no board to apply an era to: " + board.source);
  }

  // A host with no extract cannot compare the bake to the original. That half is skipped by name
  // rather than counted as a pass - the counts above already ran against the committed file.
  if (!root) {
    return ctx.skip("no extract on this host (set OPENCHQ_DATA / OPENCHQ_EXTRACT), so the baked era table cannot be compared to the original");
  }
}
