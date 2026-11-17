// PB-108 — a badge stands for a CELL, not for a pixel radius (PM 6484, restated 2026-11-17).
//
// What breaks if this is removed: badgeGroups() merged every same-side piece whose device-pixel
// centres were closer than one badge width, then anchored a merged group at the MEAN cell. At the
// whole-world fit one badge is 14 px while a cell is 1 px, so friends nine cells apart collapsed into
// one badge reading "2 units" and the anchor sat on a half-cell no unit stood on. A walker held one
// short of a held destination (PB-104) then always looked like a stack, and the hover misstated the
// server's own cells.
//
// The rules pinned here are the contract's, not the implementation's:
//   1. same side, 1..9 cells apart -> 2 badges at every zoom, one unit each;
//   2. a true same-cell stack -> ONE badge carrying its count;
//   3. every group's anchor is a cell a piece in that group occupies, at every zoom;
//   7. the hover names only the pieces on that cell.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { badgeGroups, badgeHoverText, badgePx } from "../../public/badges.mjs";

const SOURCE = fileURLToPath(new URL("../../public/badges.mjs", import.meta.url));

export const name = "pb108_cell_badge";

const SCALES = [1, 2, 4, 8, 16, 24];

function unit(id, x, y, extra = {}) {
  return {
    id, side: "blue", kind: "tank", domain: "land", x, y,
    strength: 50, maxStrength: 100, transport: false, entrenched: false,
    pinned: false, repairing: false, fighting: null, ...extra,
  };
}

function anchorsOnGroupCells(group) {
  return group.pieces.some((piece) => Number(piece.x) === Number(group.x) && Number(piece.y) === Number(group.y));
}

export async function run(ctx) {
  const fail = ctx.fail;

  // The licence text is part of the fix (PB-108 notes): the radius merge's charter must not survive
  // in a comment beside code that no longer does it, or the next reader restores the defect.
  const src = readFileSync(SOURCE, "utf8");
  const forbidden = [
    ["the radius merge's overlap test", /Math\.abs\(group\.px/],
    ["the mean-cell anchor", /group\.px \/ cell/],
    ["the old charter comment", /One badge per footprint \(PM ruling, room 3946\)/],
    ["a mean-cell comment", /the group's mean cell/],
  ];
  for (const [what, pattern] of forbidden) {
    if (pattern.test(src)) {
      fail("PB-108: badges.mjs still carries " + what + " (" + pattern + ")");
      return;
    }
  }

  // AC1 + AC3 + AC7: two friends a gap apart are two badges, each on its own cell, each hover one unit.
  for (const scale of SCALES) {
    for (let gap = 1; gap <= 9; gap++) {
      const a = unit("a", 10, 10);
      const b = unit("b", 10 + gap, 10);
      const groups = badgeGroups([a, b], scale, 14);
      if (groups.length !== 2) {
        fail("PB-108: " + gap + " cells apart at scale " + scale + " drew " + groups.length +
          " badge(s), wanted 2 (one per cell) — a pixel radius must not merge two cells");
        return;
      }
      for (const g of groups) {
        if (Number(g.count) !== 1) {
          fail("PB-108: a one-cell badge at gap " + gap + " scale " + scale + " carries count " + g.count);
          return;
        }
        if (!anchorsOnGroupCells(g)) {
          fail("PB-108: a badge at gap " + gap + " scale " + scale + " anchors at " + g.x + "," + g.y +
            ", a cell no piece in the group occupies");
          return;
        }
        const hover = badgeHoverText(g);
        if (/\b2 units\b/.test(hover) || /\b[3-9] units\b/.test(hover)) {
          fail("PB-108: the hover at gap " + gap + " scale " + scale + " names more than one unit: " + JSON.stringify(hover));
          return;
        }
      }
    }
  }

  // AC2: a true same-cell stack stays one badge with its count, at every zoom, anchored on the cell.
  for (const scale of SCALES) {
    const stack = [unit("s1", 20, 30, { strength: 20 }), unit("s2", 20, 30, { strength: 80 }),
      unit("s3", 20, 30, { strength: 40 })];
    const groups = badgeGroups(stack, scale, 14);
    if (groups.length !== 1) {
      fail("PB-108: a true same-cell stack at scale " + scale + " drew " + groups.length + " badges, wanted 1");
      return;
    }
    const g = groups[0];
    if (Number(g.count) !== 3 || g.pieces.length !== 3) {
      fail("PB-108: the same-cell stack carries count " + g.count + " at scale " + scale + ", wanted 3");
      return;
    }
    if (Number(g.x) !== 20 || Number(g.y) !== 30) {
      fail("PB-108: the same-cell stack anchors at " + g.x + "," + g.y + ", not its cell 20,30");
      return;
    }
    if (g.top.id !== "s2") {
      fail("PB-108: the stack's face is " + g.top.id + ", not the strongest piece s2");
      return;
    }
    const hover = badgeHoverText(g);
    if (!/^3 units: /.test(hover)) {
      fail("PB-108: the same-cell stack's hover no longer names three units: " + JSON.stringify(hover));
      return;
    }
  }

  // AC2 control: the two sides in one cell are two badges — a fight must show both.
  {
    const blue = unit("blue", 5, 5);
    const red = unit("red", 5, 5, { side: "red" });
    for (const scale of SCALES) {
      const groups = badgeGroups([blue, red], scale, 14);
      if (groups.length !== 2) {
        fail("PB-108: two sides on one cell at scale " + scale + " drew " + groups.length + " badge(s), wanted 2");
        return;
      }
    }
  }

  // AC3 sweep: arbitrary groups, every anchor must be a cell one of its own pieces stands on, and a
  // group's count must equal the pieces of that side on its anchor cell.
  let checked = 0;
  for (const scale of SCALES) {
    for (let seed = 1; seed <= 40; seed++) {
      let state = seed * 2654435761 % 4294967296;
      const next = () => { state = (state * 1664525 + 1013904223) % 4294967296; return state / 4294967296; };
      const pieces = [];
      for (let i = 0; i < 12; i++) {
        pieces.push(unit("p" + i, 3 + Math.floor(next() * 6), 3 + Math.floor(next() * 4),
          { side: next() < 0.5 ? "blue" : "red" }));
      }
      const groups = badgeGroups(pieces, scale, 14);
      for (const g of groups) {
        if (!anchorsOnGroupCells(g)) {
          fail("PB-108: sweep seed " + seed + " scale " + scale + " anchored a badge at " + g.x + "," + g.y +
            " with no such piece in the group");
          return;
        }
        const sameCell = pieces.filter((p) => (p.side === "red" ? "red" : "blue") === g.side &&
          Number(p.x) === Number(g.x) && Number(p.y) === Number(g.y)).length;
        if (Number(g.count) !== sameCell) {
          fail("PB-108: sweep seed " + seed + " scale " + scale + " badge count " + g.count +
            " != " + sameCell + " pieces on its cell");
          return;
        }
        checked += 1;
      }
    }
  }

  // The size ladder the ticket quotes is unchanged by grouping: 14/14/14/24/48/72 px at 1/2/4/8/16/24.
  const ladder = SCALES.map((scale) => badgePx(scale, 14)).join("/");
  if (ladder !== "14/14/14/24/48/72") {
    fail("PB-108: badgePx ladder moved: " + ladder);
    return;
  }

  console.log("pb108_cell_badge: 1..9-cell friends stay 2 badges at every zoom, a same-cell stack stays " +
    "one badge with its count, " + checked + " swept group anchors all sit on their own cell; ladder " + ladder);
}
