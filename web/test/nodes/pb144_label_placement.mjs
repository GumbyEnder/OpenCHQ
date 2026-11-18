// PB-144: a capital's name plate must name the capital it is nearest to, and must not stand on an
// ordinary city's square.
//
// What the shipped build got wrong (measured live at 5f1c216, lobby fit 718x305, scale 2):
//   - 1942 Berlin's plate sat 18.0 px from Berlin's ring and 10.8 px from Paris's, so the nearest
//     ring to the word "Berlin" was Paris's. Paris's own plate was 18.0 / 14.3 from London, and in
//     the page it read as a name floating over the Atlantic;
//   - capital name plates covered ordinary city squares: 4 in 1918, 6 in 1942, 4 in 1986.
//
// Pinned here, through the real module and the real board payload:
//   A. base control - the pre-fix first-free placer, rebuilt in this file, reproduces 1942 Berlin at
//      18.0 vs Paris 10.8 and the 4 / 6 / 4 city count on today's data, so a red on the rows below
//      is a red on the reported defect and not on a coincidence;
//   B. every placed plate is no further from its own ring than from any other capital's, at 2, 4,
//      4.4, 6 and 8 px/cell in 1918, 1942 and 1986 - or it carries a leader line (AC1);
//   C. no plate intersects any capital ring box grown by the line width (PB-138's rule, AC2);
//   D. no capital plate covers an ordinary city square at any rung - 0 in all three eras (AC3);
//   E. no capital name is dropped: 3 / 6 / 4 at every rung (AC4);
//   F. the leader-line branch fires when no free spot can satisfy the gap rule, and paintCapitals
//      strokes the segment from the plate edge to the ring in the capital's own ink.

import { boardPayload } from "../../server/board.mjs";
import * as render from "../../public/render.mjs";

export const name = "pb144_label_placement";

const { capitalLabels, capitalRingBoxes, cellToPixel, paintCapitals } = render;

const LADDER = [2, 4, 4.4, 6, 8];
const BOARD_W = 320;
const BOARD_H = 136;
const EXPECTED_NAMES = { 1918: 3, 1942: 6, 1986: 4 };

function fail(message) {
  throw new Error("node test pb144_label_placement: " + message);
}

// The lobby frame the ticket measures: 718x305 CSS, whole board fitted with 64 px of margin.
function fitView() {
  const view = render.fitViewport(718, 305, BOARD_W, BOARD_H, 64);
  view.viewW = 718;
  view.viewH = 305;
  view.boardW = BOARD_W;
  return view;
}

// A whole-board view at one rung of the zoom ladder, so no capital is off canvas for a reason a
// camera position could explain (the pb138 pin's own ladder harness).
function ladderView(scale) {
  return {
    scale, left: 0, top: 0,
    viewW: Math.round(BOARD_W * scale), viewH: Math.round(BOARD_H * scale),
    boardW: BOARD_W, boardH: BOARD_H,
  };
}

function markersFor(payload, era) {
  const rows = ((payload.capitalsByEra || {})[era]) || [];
  return rows.map((row) => ({ name: String(row.name), x: Number(row.x), y: Number(row.y), color: "#c4473a" }));
}

function citiesFor(payload) {
  return (payload.sites || []).filter((site) => site && site.kind === "city");
}

// Nearest-point distance from a plate rect to a ring centre. Zero when the centre is inside the
// plate - the metric the ticket's measurement uses.
function plateGap(plate, px, py) {
  const dx = Math.max(plate.x - px, 0, px - (plate.x + plate.width));
  const dy = Math.max(plate.y - py, 0, py - (plate.y + plate.height));
  return Math.hypot(dx, dy);
}

// What the plate really fills: paintCapitals fills (x-2, y-1, w+4, h+2).
function plateRect(label) {
  return { x: label.x - 2, y: label.y - 1, width: label.width + 4, height: label.height + 2 };
}

function insideBox(px, py, box) {
  return px >= box.x && px <= box.x + box.width && py >= box.y && py <= box.y + box.height;
}

// The shipped tree's `collides`: a one-pixel slack on every side, so a plate one pixel clear of a
// ring still counts as covered by it.
function overlaps(a, b) {
  return a.x < b.x + b.width + 1 && b.x < a.x + a.width + 1
    && a.y < b.y + b.height + 1 && b.y < a.y + a.height + 1;
}

// --- base control: the placer exactly as it shipped at 5f1c216 ----------------------------------
// Four directions, three spreads, first free candidate wins, `occupied` carries capital ring boxes
// and other plates only - no scoring, and no knowledge of ordinary city markers.
function baseLabels(markers, view, occupiedIn = []) {
  const occupied = occupiedIn.slice();
  occupied.push(...capitalRingBoxes(markers, view));
  const fontPx = Math.max(9, Math.round(view.scale * 0.75));
  const perChar = Math.max(6, Math.round(fontPx * 0.62));
  const out = [];
  for (const marker of markers) {
    const name = String(marker.name || "");
    if (!name) continue;
    const at = cellToPixel(marker.x, marker.y, view);
    if (at.x < -8 || at.x > view.viewW + 8 || at.y < -8 || at.y > view.viewH + 8) continue;
    const r = Math.max(3, view.scale * 2.4);
    const width = name.length * perChar;
    const boxH = Math.round(fontPx * 1.15);
    const spread = [r + 3, r + 3 + 14 * 0.7, r + 3 + 14 * 1.4];
    let found = null;
    for (const d of spread) {
      const candidates = [
        { x: at.x + d, y: at.y - boxH / 2 },
        { x: at.x - d - width, y: at.y - boxH / 2 },
        { x: at.x - width / 2, y: at.y - d - boxH },
        { x: at.x - width / 2, y: at.y + d },
      ];
      for (const spot of candidates) {
        const box = { x: Math.round(spot.x), y: Math.round(spot.y), width, height: boxH };
        if (box.x < 2 || box.y < 2) continue;
        if (box.x + box.width > view.viewW - 2 || box.y + box.height > view.viewH - 2) continue;
        if (occupied.some((other) => overlaps(box, other))) continue;
        found = box;
        break;
      }
      if (found) break;
    }
    if (!found) continue;
    occupied.push(found);
    out.push({ ...found, name, at });
  }
  return out;
}

function cityCoverage(labels, cities, view) {
  const hits = [];
  for (const site of cities) {
    const at = cellToPixel(site.x, site.y, view);
    for (const label of labels) {
      if (insideBox(at.x, at.y, label)) hits.push((site.name || site.id) + " under " + label.name);
    }
  }
  return hits;
}

export async function run(ctx) {
  const payload = boardPayload();
  if (!payload || !Array.isArray(payload.sites) || !payload.sites.length || !payload.capitalsByEra) {
    ctx.skip("no board payload (no extract and no bundled board)");
    return;
  }
  const cities = citiesFor(payload);
  if (!cities.length) fail("the payload carries no kind:\"city\" sites; this pin has nothing to reserve");

  // --- A. base control, on the ticket's own numbers -------------------------------------------
  {
    const view = fitView();
    const markers = markersFor(payload, "1942");
    const base = baseLabels(markers, view);
    const berlin = base.find((label) => label.name === "Berlin");
    if (!berlin) fail("base control: 1942 Berlin was not placed at all - the control is not measuring the reported defect");
    const at = new Map(markers.map((marker) => [marker.name, cellToPixel(marker.x, marker.y, view)]));
    const ownGap = plateGap(berlin, at.get("Berlin").x, at.get("Berlin").y);
    const parisGap = plateGap(berlin, at.get("Paris").x, at.get("Paris").y);
    if (!(Math.abs(ownGap - 18) < 0.05)) {
      fail("base control: 1942 Berlin's own-ring gap is " + ownGap.toFixed(1) + ", not the 18.0 the ticket measured");
    }
    if (!(Math.abs(parisGap - 10.8) < 0.05)) {
      fail("base control: 1942 Berlin's Paris-ring gap is " + parisGap.toFixed(1) + ", not the 10.8 the ticket measured");
    }
    if (!(ownGap > parisGap)) fail("base control: Berlin is NOT nearer Paris than itself - the defect did not reproduce");
    const counts = {};
    for (const era of ["1918", "1942", "1986"]) {
      const labels = baseLabels(markersFor(payload, era), view);
      counts[era] = cityCoverage(labels, cities, view).length;
    }
    const want = { 1918: 4, 1942: 6, 1986: 4 };
    for (const era of Object.keys(want)) {
      if (counts[era] !== want[era]) {
        fail("base control: " + era + " covers " + counts[era] + " city squares, not the " + want[era] + " the ticket measured");
      }
    }
  }

  // --- B/C/D/E. the ladder, all three eras -----------------------------------------------------
  const fitCityCounts = {};
  for (const era of ["1918", "1942", "1986"]) {
    const markers = markersFor(payload, era);
    if (markers.length !== EXPECTED_NAMES[era]) fail(era + ": the era's capital set moved (" + markers.length + " markers)");
    for (const scale of LADDER) {
      const view = ladderView(scale);
      const labels = capitalLabels(markers, view, { sites: payload.sites });
      const at = new Map(markers.map((marker) => [marker.name, cellToPixel(marker.x, marker.y, view)]));

      // E. no name dropped.
      if (labels.length !== markers.length) {
        const missing = markers.map((m) => m.name).filter((n) => !labels.some((label) => label.name === n));
        fail(era + " @" + scale + ": dropped " + (markers.length - labels.length) + " capital name(s): " + missing.join(", "));
      }

      // B. the gap rule, or a leader line.
      for (const label of labels) {
        const own = at.get(label.name);
        const gapOwn = plateGap(label, own.x, own.y);
        let other = Infinity;
        let who = "";
        for (const marker of markers) {
          if (marker.name === label.name) continue;
          const point = at.get(marker.name);
          const gap = plateGap(label, point.x, point.y);
          if (gap < other) { other = gap; who = marker.name; }
        }
        if (gapOwn > other + 1e-9 && !label.leader) {
          fail(era + " @" + scale + ": " + label.name + " sits " + gapOwn.toFixed(1) + " px from its own ring and " +
            other.toFixed(1) + " px from " + who + "'s, with no leader line");
        }
      }

      // C. PB-138's rule still holds: no plate on any ring, grown by the line width.
      const rings = capitalRingBoxes(markers, view);
      for (const label of labels) {
        const plate = plateRect(label);
        for (const ring of rings) {
          const gap = plateGap(plate, ring.ringX, ring.ringY);
          const need = ring.ringR + Math.max(1, view.scale) / 2;
          if (gap < need - 1e-9) {
            fail(era + " @" + scale + ": the plate for " + label.name + " covers a ring (" + gap.toFixed(1) + " < " + need.toFixed(1) + ")");
          }
        }
      }

      // D. no ordinary city square under a capital plate.
      const hits = cityCoverage(labels, cities, view);
      if (hits.length) fail(era + " @" + scale + ": capital plate(s) cover city squares: " + hits.join("; "));
      if (scale === 2) fitCityCounts[era] = hits.length;
    }
  }
  for (const era of ["1918", "1942", "1986"]) {
    if (fitCityCounts[era] !== 0) fail(era + " at the fit zoom: city squares under a capital plate = " + fitCityCounts[era] + ", not 0");
  }

  // --- F. the leader branch is not dead code ---------------------------------------------------
  // A capital boxed into one free spot that is nearer its neighbour's ring than its own must carry
  // a leader line, and paintCapitals must stroke it from the plate's edge to the ring in that
  // capital's ink. Geometry found by sweeping two-capital layouts; nothing here reads the frame.
  {
    const view = ladderView(4);
    view.viewW = 80; view.viewH = 80;
    const markers = [
      { name: "Alpha", x: 10, y: 10, color: "#c4473a" },
      { name: "Beta", x: 12, y: 15, color: "#3a6ec4" },
    ];
    const labels = capitalLabels(markers, view, {});
    const beta = labels.find((label) => label.name === "Beta");
    if (!beta) fail("leader case: Beta was dropped instead of leader-lined");
    if (!beta.leader) fail("leader case: Beta's only free spot is nearer Alpha's ring, but it carries no leader flag");
    const strokes = [];
    const ctx = {
      strokeStyle: null, lineWidth: 0, font: "", textAlign: "", textBaseline: "", fillStyle: null,
      beginPath() { this._from = null; },
      arc() {},
      moveTo(x, y) { this._from = { x, y }; },
      lineTo(x, y) { if (this._from) strokes.push({ from: this._from, to: { x, y }, ink: this.strokeStyle }); },
      stroke() {},
      fillRect() {},
      fillText() {},
    };
    paintCapitals(ctx, markers, view, { labels, plate: "#101418", ink: "#ffffff" });
    const leader = strokes.find((segment) => segment.ink === "#3a6ec4");
    if (!leader) fail("leader case: paintCapitals stroked no segment in Beta's ink (" + JSON.stringify(strokes.map((s) => s.ink)) + ")");
    // Plate edge at one end, the ring's circumference at the other.
    const at = cellToPixel(12, 15, view);
    const r = Math.max(3, view.scale * 2.4);
    const endGap = Math.hypot(leader.to.x - at.x, leader.to.y - at.y);
    if (Math.abs(endGap - r) > 0.6) {
      fail("leader case: the segment ends " + endGap.toFixed(2) + " px from Beta's ring centre, not on it (" + r.toFixed(2) + ")");
    }
    const box = { x: beta.x, y: beta.y, width: beta.width, height: beta.height };
    const onEdge = leader.from.x >= box.x - 0.6 && leader.from.x <= box.x + box.width + 0.6
      && leader.from.y >= box.y - 0.6 && leader.from.y <= box.y + box.height + 0.6;
    const touchesEdge = Math.abs(leader.from.x - box.x) < 0.6 || Math.abs(leader.from.x - (box.x + box.width)) < 0.6
      || Math.abs(leader.from.y - box.y) < 0.6 || Math.abs(leader.from.y - (box.y + box.height)) < 0.6;
    if (!onEdge || !touchesEdge) {
      fail("leader case: the segment starts at " + JSON.stringify(leader.from) + ", which is not on Beta's plate edge");
    }
  }

  // --- G. the city reservation is what moves a plate, not luck ----------------------------------
  // One capital, one ordinary city square placed on the spot a lone capital takes (the first
  // "above" candidate). The plate must not stand on that square.
  {
    const view = fitView();
    const marker = { name: "Berlin", x: 161, y: 30, color: "#c4473a" };
    const at = cellToPixel(marker.x, marker.y, view);
    const r = Math.max(3, view.scale * 2.4);
    const fontPx = Math.max(9, Math.round(view.scale * 0.75));
    const perChar = Math.max(6, Math.round(fontPx * 0.62));
    const boxH = Math.round(fontPx * 1.15);
    const width = "Berlin".length * perChar;
    const above = {
      x: Math.round(at.x - width / 2), y: Math.round(at.y - (r + 3) - boxH), width, height: boxH,
    };
    const cx = above.x + above.width / 2;
    const cy = above.y + above.height / 2;
    const city = {
      id: 9001, kind: "city", name: "Trap",
      x: (cx - view.left) / view.scale - 0.5,
      y: (cy - view.top) / view.scale - 0.5,
    };
    const probe = cellToPixel(city.x, city.y, view);
    if (!insideBox(probe.x, probe.y, above)) fail("city trap: the trap cell is not inside the spot it is meant to block");
    const placed = capitalLabels([marker], view, { sites: [city] })[0];
    if (!placed) fail("city trap: the capital name was dropped instead of moved");
    if (insideBox(probe.x, probe.y, placed)) {
      fail("city trap: the plate still stands on the city square at " + JSON.stringify(probe));
    }
  }
}
