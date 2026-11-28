// combat_vs_doc — PB-343: the documented fight, formula by formula, with its citation.
//
// What fails if this node is removed:
//   - a config matrix byte drifts from the EXE's 0x18f0 table        -> the data arm reds
//   - a modifier is applied on the wrong side of flank/rear          -> the ordering arm reds
//   - a range threshold is graded through the wrong distance          -> the s3 arms name the cell
//   - the attrition/militia pairs lose one side of the doc's pair     -> s5 arms red
//   - an air strike loses its per-kind amount or its integer +1       -> s6 arms red
//   - a DEVIATION row starts or stops being true                      -> the pinned arm reds and
//     the row must be re-measured, never quietly edited
//
// Graded against docs/re/COMBAT.md (347 lines, T-009, 2026-11-13) and the routines it cites:
//   s2 :49   damage per exchange, the 0x18f0 byte        FUN_194c_000e, decompiled.c 7020-7133
//   s2 :113  the modifier chain, IN CODE ORDER           7032-7093
//   s3 :139  ranges as SQUARED thresholds                FUN_188b_0216, decompiled.c 6496-6519
//   s4 :170  entrenchment is a kind change, not a timer  FUN_1c0d_0656, 9287-9290
//   s5 :186  attrition, repair, militia, strength-20     FUN_1c0d_00b4, 9030-9110
//   s6 :233  air strike resolution                       FUN_1ac5_0dbe, decompiled.c 8679-8826
//   s10 :286 items the doc leaves open -> UNVERIFIED below, never filled from the manual's prose
//
// Arms that already existed and are NOT re-cut here: measured_combat (config labels, matrix
// wiring, kind-9 alias, flank/rear), t016_terrain (cover arithmetic, dig-in ids), combat /
// combat_rules / combat_depth (states, repair, pinning). This file adds the per-formula citation,
// the full 9x9 graded against both the doc and the EXE bytes, the modifier ORDER as arithmetic,
// an inside/outside pair at every range class, the s5 pairs, one s6 case per target class, and the
// DEVIATIONS table.
//
// Tree: origin/web bc2d02d (the PB-341 live sha). PB-204 already moved reach onto the 0x1956
// squared matrix and PB-216/PB-288 already moved militia onto the occupied cell, so the two
// deviations a Chebyshev read of this file would have produced are NOT here: they were measured
// against the stale pb098 worktree first and the arms caught it. Do not re-add them.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { CELL_W, boardPayload, resolveDataRoot } from "../../server/board.mjs";
import { attritionStep } from "../../server/move.mjs";
import { baseDamageFor, candidatesFor, coverFor, damageFor, engageRange2, resolve, squaredDistance } from "../../server/combat.mjs";
import { combatRules, combatValue, digInIds } from "../../server/rules.mjs";
import { sendMission } from "../../server/air.mjs";

export const name = "combat_vs_doc";

// ---------------------------------------------------------------------------------------------
// DEVIATIONS — every disagreement this node measured, reported and NOT fixed (the card ships
// tests only). `doc` / `server` are the two sides; `cls` is doc error | server defect |
// unmeasured stand-in; `card` owns the product change. A row asserted below is PINNED: a fix reds
// that arm in the same commit that edits this table.
// ---------------------------------------------------------------------------------------------
export const DEVIATIONS = [
  { id: "D1", formula: "s2 0x18f0 cell [9][0]", doc: 25, server: 34, cls: "doc error", card: "PB-350",
    note: "COMBAT.md:72 transcribes row 9 col 0 as 25; the EXE byte is 34 (0x341a0+81) and config agrees. Column 0 is never read at runtime (kind 0 is an empty slot)." },
  { id: "D2", formula: "s2 0x18f0 cell [4][0]", doc: 0, server: 35, cls: "doc error", card: "PB-350",
    note: "COMBAT.md:67 transcribes row 4 col 0 as 0; the EXE byte is 35 (0x341a0+36). Kind 4 is unused." },
  { id: "D3", formula: "s2.1 terrain cover ('Not wired: T-009b')", doc: "unwired", server: "wired", cls: "doc error", card: "PB-350",
    note: "coverFor()/damageFor() apply it and t016_terrain.mjs pins the arithmetic; s2.1, s4 :183 and s10 item 5 are stale." },
  { id: "D4", formula: "s2.3 ship-vs-land cap ('Not wired: T-009b')", doc: "unwired", server: "wired", cls: "doc error", card: "PB-350",
    note: "combat.damageFor applies config.terrain.shoreFire (tag disassembly, PM 4572 interim); s2.3 and s10 item 5 are stale." },
  { id: "D9", formula: "s5 attrition and repair rates", doc: "per PASS (lake 3, polar 5, desert/jungle 3, site 20; repair +10 every other call)", server: "per ROUND stand-in (0.5 for those terrains, 1 wasteland; repair 5)", cls: "unmeasured stand-in", card: "D-017",
    note: "labelled STAND-IN in config; no per-round figure exists until the speed ruling. Not a defect." },
  { id: "D10", formula: "s5 attrition on a city/base/capital/dock with no site row", doc: "20 per pass", server: "0 (the site branch skips a cell with no site row)", cls: "server defect", card: "PB-349",
    note: "attritionStep's isSite branch requires a site; the original's 0xf4 byte damages the terrain, not the site." },
  { id: "D11", formula: "s5 militia on an UNOWNED site", doc: "20 per pass until capture", server: "0 (militia fires only when site.owner is set and is not the piece's side)", cls: "server defect", card: "PB-349",
    note: "combat.militiaDamage carries the enemy-site 2 only; the neutral-site 20 has no runtime actor." },
  { id: "D12", formula: "s5 militia also zeroes move points", doc: "move points to -10 (9056-9077)", server: "strength only; move points untouched", cls: "server defect", card: "PB-349",
    note: "the doc's own militia live leg (docs/re/t009b/militia-2026-11-13.txt) names the -10; no module writes it." },
  { id: "D13", formula: "s2.2 flank multiplier", doc: "'x1.5' (s2.2 :121, :125)", server: "d + floor(d x 0.5), the original's integer form (13 -> 19)", cls: "doc error", card: "PB-350",
    note: "decompiled.c 7070 is `local_8 += local_8/2`, so 13 reads 19, not 19.5. The port is faithful; the doc's prose rounds." },
];

const must = (ok, message) => {
  if (!ok) throw new Error(message);
};
const eq = (actual, expected, message) => {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(message + ": " + a + " !== " + b);
};

const cfg = combatRules();
const measured = combatValue("measured", {}) || {};
const matrix = measured.damageMatrix || {};
const rows = matrix.rows || {};
const kindNine = matrix.kindNineColumn || {};

// The doc's transcript of 0x18f0 (COMBAT.md:62-73), verbatim, row = attacker, col = target.
const DOC_ROWS = {
  1: [0, 20, 17, 15, 0, 25, 25, 35, 35],
  2: [35, 26, 20, 20, 0, 25, 25, 35, 35],
  3: [35, 20, 17, 15, 0, 25, 25, 35, 35],
  4: [0, 0, 0, 0, 0, 0, 0, 0, 0],
  5: [0, 18, 16, 14, 0, 10, 10, 5, 5],
  6: [5, 9, 8, 7, 0, 10, 10, 5, 5],
  7: [5, 0, 0, 0, 0, 100, 100, 25, 34],
  8: [34, 12, 10, 6, 0, 50, 50, 34, 25],
  9: [25, 10, 8, 5, 0, 50, 50, 25, 20],
};
const SEA = new Set(["submarine", "cruiser", "carrier"]);
const piece = (id, side, kind, x, y, extra = {}) => ({
  id, side, domain: SEA.has(kind) ? "sea" : "land", kind, x, y,
  path: [], pace: 1, facing: null, fighting: null, strength: 100, maxStrength: 100, ...extra,
});

export async function run(ctx) {
  // ---- s2 :49 — every tabulated pair, against config and against the EXE ----------------------
  for (let attacker = 1; attacker <= 9; attacker++) {
    eq(rows[String(attacker)] && rows[String(attacker)].length, 9,
      "measured.damageMatrix row " + attacker + " is not nine target columns");
    for (let target = 1; target <= 8; target++) {
      must(Number.isInteger(rows[String(attacker)][target]),
        "measured.damageMatrix cell [" + attacker + "][" + target + "] is not an integer");
    }
  }
  // The binary itself, when the reference tree is on this host: 0x341a0, 9 rows of 9.
  const root = resolveDataRoot();
  if (root) {
    const exe = path.join(root, "exe", "CHQ_unpacked.EXE");
    if (existsSync(exe)) {
      const bytes = readFileSync(exe);
      for (let attacker = 1; attacker <= 9; attacker++) {
        for (let target = 0; target <= 8; target++) {
          const at = 0x341a0 + attacker * 9 + target;
          must(bytes[at] === Number(rows[String(attacker)][target]),
            "config cell [" + attacker + "][" + target + "] is " + rows[String(attacker)][target] +
            ", EXE byte 0x" + at.toString(16) + " is " + bytes[at]);
        }
      }
      // 0x341a0+90 is a*9+9 with a=9: the byte a carrier-as-target reads for a carrier attacker.
      must(bytes[0x341a0 + 90] === Number(kindNine["9"]),
        "kindNineColumn[9] is " + kindNine["9"] + ", EXE byte 0x341fa is " + bytes[0x341a0 + 90]);
    }
  }
  // The doc's transcript disagrees with the binary at exactly the two cells D1/D2 name. If a third
  // cell ever moves this reds, because the deviation table would then be incomplete.
  const docErrors = [];
  for (let attacker = 1; attacker <= 9; attacker++) {
    for (let target = 0; target <= 8; target++) {
      if (DOC_ROWS[attacker][target] !== Number(rows[String(attacker)][target])) docErrors.push(attacker + "," + target);
    }
  }
  eq(docErrors, ["4,0", "9,0"],
    "COMBAT.md s2's table now disagrees with the EXE at " + JSON.stringify(docErrors) + "; D1/D2 are the only known cells");
  eq(DOC_ROWS[9][0], DEVIATIONS[0].doc, "COMBAT.md:72 no longer says D1's 25");
  eq(DOC_ROWS[4][0], DEVIATIONS[1].doc, "COMBAT.md:67 no longer says D2's 0");

  // The runtime's pairing call, for every kind the eras field (named kinds only: 4 is unused and
  // 5/6 are AI hulls with no remake actor). Target 9 is the a*9+9 out-of-row read, so it comes
  // from kindNineColumn and not from the row.
  const kinds = matrix.kinds || {};
  const fielded = Object.entries(kinds).map(([code, kind]) => [Number(code), String(kind)]);
  for (const [attackerCode, attackerKind] of fielded) {
    for (const [targetCode, targetKind] of fielded) {
      const defender = targetKind === "entrenched infantry"
        ? { kind: "infantry", domain: "land", entrenched: true }
        : { kind: targetKind, domain: SEA.has(targetKind) ? "sea" : "land" };
      const expected = targetCode === 9 ? Number(kindNine[String(attackerCode)]) : Number(rows[String(attackerCode)][targetCode]);
      eq(baseDamageFor(attackerKind, defender, cfg), expected,
        "s2 cell " + attackerCode + "->" + targetCode + " (" + attackerKind + " vs " + targetKind + ")");
    }
  }
  // Entrenchment is the kind-3 COLUMN, not a multiplier (s4 :179-181): 26 -> 20 against a tank,
  // 20 -> 15 against infantry. A separate factor would count it twice, so it must stay 1.
  eq(baseDamageFor("tank", { kind: "infantry", domain: "land" }, cfg), 26, "s4 tank -> infantry (kind 1)");
  eq(baseDamageFor("tank", { kind: "infantry", domain: "land", entrenched: true }, cfg), 20, "s4 tank -> entrenched (kind 3)");
  eq(baseDamageFor("infantry", { kind: "infantry", domain: "land" }, cfg), 20, "s4 infantry -> infantry (kind 1)");
  eq(baseDamageFor("infantry", { kind: "infantry", domain: "land", entrenched: true }, cfg), 15, "s4 infantry -> entrenched (kind 3)");
  eq(cfg.entrenchDamageFactor, 1, "s4 entrenchDamageFactor must be 1: the discount is the kind-3 column");
  // The dig-in terrains are DS:0x1996 bit 0x20 (s4 :173-174): plain, forest, mountain, oilfield,
  // desert, jungle. A city/base/capital/lake/polar/wasteland cell carries no bit, so no dig-in.
  eq([...digInIds()].sort((a, b) => a - b), [7, 8, 9, 10, 11, 12], "s4 dig-in terrain set (0x1996 bit 0x20)");

  const cells = (() => {
    try {
      return boardPayload().cells || null;
    } catch {
      return null;
    }
  })();
  if (!cells) {
    return ctx.skip("combat_vs_doc: no board extract, so the ordering arm and the s3/s5/s6 runtime " +
      "arms (they need a cell, a terrain name or a config read) did not run");
  }

  // ---- s2 :113 — the modifier chain in CODE ORDER: cover, then flank/rear ---------------------
  // decompiled.c 7032-7046 scales the matrix byte by the DEFENDER's terrain BEFORE 7064-7071
  // multiplies for flank/rear. Tank(2) -> entrenched infantry(3) is 20, covered to 13 on a city;
  // a rear hit then reads 26. Applying the multiplier first would read 40 covered to 27, so the
  // two orders are distinguishable by exactly one point.
  let cityCell = null;
  for (let i = 0; i < cells.length && !cityCell; i++) {
    if (cells[i] === 6) cityCell = { x: i % CELL_W, y: Math.floor(i / CELL_W) };
  }
  must(cityCell, "the extract has no city cell to put the defender on");
  let plainCell = null;
  for (let i = 0; i < cells.length && !plainCell; i++) {
    if (cells[i] === 8) plainCell = { x: i % CELL_W, y: Math.floor(i / CELL_W) };
  }
  must(plainCell, "the extract has no plain cell for the open-ground flank arm");
  eq(coverFor(20, 6, "infantry"), 13, "s2.1 20 on a city cell for infantry kinds 1/3 is 13");
  const attacker = piece("blue:tank", "blue", "tank", cityCell.x, cityCell.y, { facing: "w" });
  const dugIn = piece("red:foot", "red", "infantry", cityCell.x, cityCell.y, {
    facing: "w", fighting: "blue:third", entrenched: true,
  });
  const rear = damageFor(attacker, dugIn, cfg);
  must(rear.rear === true, "s2.2 the same-facing attack no longer reads as a rear hit");
  eq(rear.base, 20, "s2 cell 2->3 before cover");
  eq(rear.covered, 13, "s2.1 cover applies to the byte first (20 -> 13 on a city)");
  eq(rear.amount, 26, "s2.1 cover BEFORE rear: 13 x 2 = 26, not (20 x 2) covered = 27");
  // Facing each other is x1, and a 1v1 gets no bonus: the original needs the defender's own target
  // link to name a third piece (s2.2 :119-131).
  eq(damageFor({ ...attacker, facing: "e" }, { ...dugIn }, cfg).amount, 13,
    "s2.2 an opposed facing must take the plain covered hit");
  const duel = damageFor({ ...attacker, facing: "w" }, { ...dugIn, fighting: null }, cfg);
  must(!duel.flank && !duel.rear, "s2.2 a 1v1 produced a flank/rear bonus");
  // Perpendicular is the flank: 7070 is `local_8 += local_8/2`, so 13 reads 19 - the doc's "x1.5"
  // would read 19.5 and 20 would read 30.
  const flank = damageFor({ ...attacker, facing: "n" }, { ...dugIn }, cfg);
  must(flank.flank === true, "s2.2 the perpendicular attack no longer reads as a flank");
  eq(flank.amount, 19, "D13: flank is the integer form 13 + 13/2 = 19, not x1.5 = 19.5");
  eq(damageFor(
    piece("blue:tank2", "blue", "tank", plainCell.x, plainCell.y, { facing: "n" }),
    piece("red:foot2", "red", "infantry", plainCell.x, plainCell.y, { facing: "w", fighting: "blue:third", entrenched: true }),
    cfg,
  ).amount, 30, "s2.2 a flank on open ground (20) reads 30");

  // ---- s3 :139 — ranges are SQUARED thresholds (0x1956), not cell counts ----------------------
  // FUN_188b_0216 returns dx^2+dy^2. Every arm below names the (dx,dy) and the threshold it sits
  // against, with one cell inside and one outside each class boundary.
  const at = (x, y, kind, side = "red") => piece(side + ":" + kind, side, kind, x, y);
  const reach = (attackerPiece, defender) => candidatesFor(attackerPiece, [attackerPiece, defender]).length === 1;
  must(reach(at(100, 100, "tank", "blue"), at(102, 101, "infantry")) === true, "s3 land (2,1): d2=5 <= 5 must engage");
  must(reach(at(100, 100, "tank", "blue"), at(102, 102, "infantry")) === false, "s3 land (2,2): d2=8 > 5 must not engage");
  must(reach(at(100, 100, "tank", "blue"), at(103, 101, "infantry")) === false, "s3 land (3,1): d2=10 > 5 must not engage");
  // The sub's land column is 0 (s3 :150), so it never even acquires; against a hull the class-2 row
  // is 5.
  must(reach(at(100, 100, "submarine", "blue"), at(101, 101, "infantry")) === false, "s3 the sub acquired land (column 0)");
  must(reach(at(100, 100, "submarine", "blue"), at(102, 101, "cruiser")) === true, "s3 sub (2,1): d2=5 <= 5 must engage");
  must(reach(at(100, 100, "submarine", "blue"), at(102, 102, "cruiser")) === false, "s3 sub (2,2): d2=8 > 5 must not engage");
  must(reach(at(100, 100, "cruiser", "blue"), at(103, 101, "cruiser")) === true, "s3 cruiser (3,1): d2=10 <= 10 must engage");
  must(reach(at(100, 100, "cruiser", "blue"), at(102, 103, "cruiser")) === false, "s3 cruiser (2,3): d2=13 > 10 must not engage");
  must(reach(at(100, 100, "cruiser", "blue"), at(104, 100, "cruiser")) === false, "s3 cruiser (4,0): d2=16 > 10 must not engage");
  must(reach(at(100, 100, "carrier", "blue"), at(104, 101, "cruiser")) === true, "s3 carrier (4,1): d2=17 <= 17 must engage");
  must(reach(at(100, 100, "carrier", "blue"), at(103, 102, "cruiser")) === true, "s3 carrier (3,2): d2=13 <= 17 must engage");
  must(reach(at(100, 100, "carrier", "blue"), at(104, 102, "cruiser")) === false, "s3 carrier (4,2): d2=20 > 17 must not engage");
  must(reach(at(100, 100, "carrier", "blue"), at(105, 100, "cruiser")) === false, "s3 carrier (5,0): d2=25 > 17 must not engage");
  // The threshold itself is the matrix, read through the runtime: 5 / 10 / 17 by class pair.
  eq(engageRange2(at(100, 100, "tank", "blue"), at(102, 101, "infantry"), cfg), 5, "s3 0x1956 class 0 -> 0");
  eq(engageRange2(at(100, 100, "cruiser", "blue"), at(103, 101, "cruiser"), cfg), 10, "s3 0x1956 class 3 -> 3");
  eq(engageRange2(at(100, 100, "carrier", "blue"), at(104, 101, "cruiser"), cfg), 17, "s3 0x1956 class 4 -> 3");
  eq(engageRange2(at(100, 100, "submarine", "blue"), at(101, 101, "infantry"), cfg), 0, "s3 0x1956 class 2 -> land is 0");
  // and the distance it is compared with is the squared one, X wrapped at 160.
  eq(squaredDistance({ x: 100, y: 100 }, { x: 102, y: 102 }), 8, "s3 (2,2) is d2=8");
  eq(squaredDistance({ x: 2, y: 50 }, { x: 318, y: 50 }), 16, "s3 X wraps: (4,0) across the seam is d2=16");

  // ---- s2.3 — shore fire: the sequential clause and the squared range (PB-347) ----------------
  // decompiled.c 7082-7093 is SEQUENTIAL, not either/or: cap = strength - 30; if cap < 25 halve;
  // then amount = min(amount, cap) ALWAYS; fire only when 0 < amount. The range gate is the squared
  // distance (`2 < d^2`, FUN_188b_0216), so a (2,2) diagonal is in range and is capped.
  let waterCell = null;
  for (let i = 0; i < cells.length - 1 && !waterCell; i++) {
    const x = i % CELL_W;
    if (x < 4) continue;
    if (cells[i] === 0 && cells[i - 3] === 0) waterCell = { x, y: Math.floor(i / CELL_W) };
  }
  must(waterCell, "the extract has no open-water cells to fire ashore from");
  const ashore = (strength) => damageFor(
    piece("blue:cruiser", "blue", "cruiser", waterCell.x - 3, waterCell.y),
    piece("red:foot", "red", "infantry", waterCell.x, waterCell.y, { strength }),
    cfg,
  );
  const weak = ashore(20);
  must(weak.shoreFire === true, "s2.3 a cruiser 3 cells from land must be reading the shore clause");
  eq(weak.amount, 0,
    "s2.3 at strength 20 the cap is -10: halve the shot, then min(amount, cap) -> 0 (no shot)");
  const mid = ashore(50);
  eq(mid.amount, Math.min(mid.covered / 2, 20),
    "s2.3 at strength 50 the cap is 20: halve the covered shot, then cap it at 20");
  eq(ashore(100).amount, 12, "s2.3 at full strength the cap is 70, so the cruiser's 8->1 cell of 12 rides uncapped");
  // The refusal is at the resolve layer too: a non-positive shore result is not a 0-damage hit, it
  // is no shot at all (`if (0 < (int)local_8)`, decompiled.c 7082-7093).
  const noShotMatch = { round: 2, pieces: [
    piece("blue:cruiser", "blue", "cruiser", waterCell.x - 3, waterCell.y),
    piece("red:foot", "red", "infantry", waterCell.x, waterCell.y, { strength: 20 }),
  ] };
  const noShot = resolve(noShotMatch);
  eq(noShot.length, 0, "s2.3 a strength-20 shore target takes no shot event at resolve (base > 0 alone is not enough)");
  eq(noShotMatch.pieces[1].strength, 20, "s2.3 the strength-20 target is untouched, not damaged for 0");
  // (2,2) diagonal: Chebyshev 2 would miss the old gate; d2 = 8 > range2 2 is in range.
  const diagonal = damageFor(
    piece("blue:cruiser", "blue", "cruiser", waterCell.x - 2, waterCell.y - 2),
    piece("red:foot", "red", "infantry", waterCell.x, waterCell.y, { strength: 50 }),
    cfg,
  );
  must(squaredDistance({ x: waterCell.x - 2, y: waterCell.y - 2 }, waterCell) === 8,
    "s2.3 the (2,2) diagonal is d2=8, which the original's >2 test takes");
  must(diagonal.shoreFire === true, "s2.3 a (2,2) diagonal must read as a shore shot (d2 8 > range2 2)");
  eq(diagonal.amount, Math.min(diagonal.covered / 2, 20),
    "s2.3 the diagonal shot is capped like any shot beyond range2");

  // ---- s5 :186 — attrition, the floor, and the militia pair ----------------------------------
  // The 0x1996 bytes are the doc's per-PASS amounts; the port's rates are per ROUND stand-ins
  // (D9), so these arms grade the port's own unit and name the doc's figure.
  const drain = (terrain, strength, sites = []) => {
    const unit = piece("blue:foot", "blue", "infantry", 10, 10, { strength });
    const match = { round: 1, pieces: [unit], sites };
    const events = attritionStep(match, (p) => (Number(p.x) === 10 && Number(p.y) === 10 ? terrain : null));
    return { unit, events };
  };
  eq(drain("lake", 100).unit.strength, 99.5, "s5 lake: per-round rate 0.5 (doc: 3 per PASS, D9)");
  eq(drain("polar", 100).unit.strength, 99.5, "s5 polar: per-round rate 0.5 (doc: 5 per PASS, D9)");
  // The floor is literally strength-20 (9089-9093) and 20 is 20% of the 100 bar.
  eq(drain("lake", 20.2).unit.strength, 20, "s5 the 20% floor: 20.2 stays at 20, it does not go under");
  eq(drain("lake", 20).events.length, 0, "s5 a unit at the floor loses nothing more to terrain");
  eq(cfg.attritionFloor * cfg.maxStrength, 20, "s5 attritionFloor 0.2 x 100 is the strength-20 term");
  // Wasteland is the one terrain that can take a unit to zero (9044-9051).
  const waste = drain("wasteland", 0.5);
  eq(waste.unit.strength, 0, "s5 wasteland reaches 0 with no floor");
  must(waste.events.some((event) => event.type === "destroyed"), "s5 wasteland at 0 must destroy the piece");
  // D10: a site terrain with NO site row. The doc damages the cell (0xf4, 20/pass); the port's site
  // branch skips a cell with no site, so the unit is untouched.
  eq(drain("city", 100, []).events.length, 0,
    "D10: the port's city-with-no-site-row branch no longer skips; re-measure (doc: 20/PASS)");
  const enemySite = [{ id: 1, name: "Testville", kind: "city", owner: "red", x: 10, y: 10 }];
  eq(drain("city", 100, enemySite).unit.strength, 99.5, "s5 an enemy site drains (port 0.5/round; doc 20/PASS)");
  const ownSite = [{ id: 2, name: "Testville", kind: "city", owner: "blue", x: 10, y: 10 }];
  eq(drain("city", 100, ownSite).events.length, 0, "s5 an own site must not drain");

  // Militia (FUN_1c0d_00b4, 9056-9077): an enemy-OWNED site costs 2 per pass, an UNOWNED site 20.
  // PB-216/PB-288 put the militia on the OCCUPIED cell, which is the doc's "standing on" case, so
  // the two pieces below do not have to be fighting: the squat pays, the garrison does not.
  const militiaMatch = (siteOwner) => {
    const squat = piece("blue:foot", "blue", "infantry", 10, 10);
    const guard = piece("red:tank", "red", "tank", 14, 10);
    const match = {
      round: 2, pieces: [squat, guard],
      sites: [{ id: 9, name: "Testville", kind: "city", owner: siteOwner, x: 10, y: 10 }],
    };
    return { squat, match, events: resolve(match) };
  };
  const owned = militiaMatch("red");
  const paid = owned.events.find((event) => event.militia === true && event.target === "blue:foot");
  must(paid, "s5 militia: a piece standing on an enemy city must pay");
  eq(paid.amount, 2, "s5 militia: an enemy site costs 2 per beat (9056-9077)");
  eq(owned.squat.strength, 98, "s5 the militia's 2 is the only damage on a piece that is not fighting");
  eq(owned.squat.movePoints, undefined,
    "D12: the port still does not zero the occupant's move points; re-measure (doc: -10)");
  const neutral = militiaMatch(null);
  must(!neutral.events.some((event) => event.militia === true && event.target === "blue:foot"),
    "D11: the port's unowned-site militia no longer reads 0; re-measure (doc: 20)");
  eq(neutral.squat.strength, 100, "D11: an unowned site pays nothing in the port");

  // ---- s6 :233 — one air-strike case per target class -----------------------------------------
  // MEASURED-OVER-MANUAL. The measured source is FUN_1ac5_0dbe @ 1ac5:0dbe, decompiled.c
  // 8795-8814 (docs/re/COMBAT.md s6 :233-245, s9 item 1), after the aircraft survives the run in:
  // land (s>>1)+1; kinds 5-7 34; kinds 8/9 25. Manual p.25 prints "three strikes sink a ship";
  // that holds for kinds 5-7 only, a cruiser or carrier needs four (25 x 4), and the port follows
  // the measured code (room 3544 ruling 1). PB-348 made the runtime read the kind and the integer
  // formula; the four arms below used to pin the old shape.
  const strike = (target) => {
    const plane = { id: "blue:plane", side: "blue", domain: "air", kind: "aircraft", x: 80, y: 44, path: [], pace: 1 };
    const home = { id: "home", name: "Testville", kind: "city", owner: "blue", x: 80, y: 44 };
    const match = { round: 1, pieces: [plane, target], sites: [home], capitals: {}, sides: {} };
    const result = sendMission(match, "blue", "blue:plane", "strike", { x: target.x, y: target.y });
    must(!result.error, "s6 the strike was refused: " + result.error);
    return target;
  };
  eq(strike(piece("red:sub", "red", "submarine", 85, 44)).strength, 66,
    "s6 a submarine (kind 7) takes 34 and is three strikes from full (decompiled.c 8795-8814)");
  eq(strike(piece("red:cruiser", "red", "cruiser", 85, 44)).strength, 75,
    "s6 a cruiser (kind 8) takes 25, not the kind 5-7 amount (8795-8814, s9 item 1)");
  eq(strike(piece("red:carrier", "red", "carrier", 85, 44)).strength, 75,
    "s6 a carrier (kind 9) takes 25, four strikes from full");
  eq(strike(piece("red:foot", "red", "infantry", 85, 44)).strength, 49,
    "s6 land damage is (strength>>1)+1 = 51, so 100 leaves 49 - one point under half (s6 :237)");

  // The sea amount is chosen by the target's kind out of ONE table: the runtime map is built from
  // measured.combat.airStrike.shipDamage, so a second copy of 34/34/34/25/25 cannot drift from it.
  const runtimeShip = combatRules().airStrikeShipDamage;
  for (const kind of ["5", "6", "7", "8", "9"]) {
    eq(Number(runtimeShip[kind]), Number(measured.airStrike.shipDamage[kind]),
      "PB-348: combat.airStrikeShipDamage[" + kind + "] must be measured.combat.airStrike.shipDamage[" + kind + "]");
  }
  eq(JSON.stringify(Object.keys(runtimeShip).sort()), JSON.stringify(["5", "6", "7", "8", "9"]),
    "PB-348: the runtime's ship table carries exactly the five measured hull kinds");
  must(cfg.airStrikeSeaAmount === undefined && cfg.airStrikeLandFactor === undefined,
    "PB-348: the single-factor levers are retired from combatRules(), not merely unused");

  // The count the page gets wrong (s6 :239, s9 item 1): kinds 5-7 die on the third strike, a
  // cruiser or carrier on the fourth. Counted on one board, one hull at a time.
  const sinkIn = (kind) => {
    const plane = { id: "blue:plane", side: "blue", domain: "air", kind: "aircraft", x: 80, y: 44, path: [], pace: 1 };
    const home = { id: "home", name: "Testville", kind: "city", owner: "blue", x: 80, y: 44 };
    const hull = piece("red:" + kind, "red", kind, 85, 44);
    const match = { round: 1, pieces: [plane, hull], sites: [home], capitals: {}, sides: {} };
    const seen = [];
    for (let i = 0; i < 4; i += 1) {
      match.round = Number(match.round) + 1;
      plane.inactiveUntil = 0;
      plane.readyAnnounced = false;
      const result = sendMission(match, "blue", "blue:plane", "strike", { x: 85, y: 44 });
      must(!result.error, "s6 the " + kind + " strike was refused: " + result.error);
      seen.push(Number(hull.strength));
      if (!match.pieces.some((row) => row.id === hull.id)) return seen;
    }
    return seen;
  };
  eq(sinkIn("submarine").join(","), "66,32,0",
    "s6 a kind-7 hull leaves 66, 32, 0 over three strikes (34 each)");
  eq(sinkIn("cruiser").join(","), "75,50,25,0",
    "s6 a kind-8 cruiser leaves 75, 50, 25, 0 over FOUR strikes (25 each) - the count s9 item 1 exists to keep");
  eq(sinkIn("carrier").join(","), "75,50,25,0",
    "s6 a kind-9 carrier is the cruiser's class: four strikes, not three");
  eq(measured.airStrike.shipDamage["8"], 25, "s6 the doc's per-kind table still records 25 for kind 8");

  // ---- what this node leaves UNVERIFIED, by the doc's own marks --------------------------------
  // Printed once so the room row and the card can quote the list without re-deriving it.
  const unverified = [
    "D-017 per-round rates (s5/s7): attrition, repair, shotEveryRounds, pinRounds - speed-dependent, no per-round figure exists",
    "Q38 (s10): the crowded-board 2-5 point loss - 0 deltas in 60 s, not in config",
    "wasteland 34 live (s11): the 1942 board has no wasteland cell",
    "desert/jungle attrition live (s11): desert did not fire in three runs; jungle never run",
    "air strike live (s11): the event path never reached the damage call; s6 grades the port against decompiled.c, not a live leg",
    "ship-vs-land cap (s2.3): the sequential order and d^2 gate are code-vs-code (PB-347); config tag disassembly, still never live-measured in DOSBox",
    "kinds 4/5/6 (s2): unused or AI-side, no remake actor, so their rows are graded as data only",
  ];
  console.log("combat_vs_doc: " + DEVIATIONS.length + " deviations, " + unverified.length +
    " items UNVERIFIED; PB-347 fixed the s2.3 clause order and range unit, PB-348 the s6 per-kind sea amount and the land +1, the other rows stay open");
}
