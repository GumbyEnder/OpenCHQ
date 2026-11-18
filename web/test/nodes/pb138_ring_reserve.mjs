// PB-138: a capital's ring is reserved before any name is placed, so no plate paints over it.
//
// The defect (measured live at dac478a, lobby fit, no room): London's label plate sits right of
// London, Berlin is 13 cells east on the same row, and `paintCapitals` fills every plate after
// stroking every ring. `capitalLabels` reserved only other labels' boxes, so Berlin's ring - the
// only ownership cue a capital has at the fit zoom - was entirely covered.
//
// Pinned here through the real module, on the ladder the ticket carries (2, 4, 4.4, 6, 8 px/cell;
// 2 is the live lobby fit - the map canvas is 718x305 CSS inside a 1440x900 window):
//   1. every placed capital plate is clear of every capital ring, grown by half the line width
//      and by the plate's own bleed, at all five rungs and in both eras' capital sets;
//   2. London is still labelled, and no two capital labels overlap each other;
//   3. the rule is general - a capital near an edge and a ring partly off screen obey it too;
//   4. base control: the pre-fix first candidate for London (r + 3 right of the ring, plate drawn)
//      DOES cross Berlin's ring at 2, 4 and 4.4, and does not at 6 and 8. So a pin on this row is
//      red on the base tree by construction, and green here because the ring is reserved.
//
// The mutant control (drop the `capitalRingBoxes` push from `capitalLabels`) lives beside this file
// as an applied-to-a-copy run, not as a branch: harness script and both logs are named in the
// ticket. It prints the Berlin collision at rung 2, which is the row this pin claims.
//
// No DOM, no fetch: capitalLabels is pure over markers + view.

// Namespace import, not a named one: on a tree without this fix `capitalRingBoxes` does not exist,
// and a named import would die as a SyntaxError - an error that says nothing about the collision.
// With a namespace import the base control fails on the measured hit it is supposed to carry.
import * as render from "../../public/render.mjs";

const { capitalLabels, capitalRingBoxes, cellToPixel } = render;

export const name = "pb138_ring_reserve";

function fail(message) {
  throw new Error("node test pb138_ring_reserve: " + message);
}

// 1918 and 1942 carry the same capital cells (Berlin's position is era-independent), so one marker
// set covers both eras for geometry. Colors are the era's capital ink.
function capitals(color = "#c4473a") {
  return [
    { name: "London", x: 148, y: 30, color },
    { name: "Berlin", x: 161, y: 30, color },
    { name: "Paris", x: 150, y: 33, color },
    { name: "Rome", x: 158, y: 36, color },
    { name: "Moscow", x: 183, y: 25, color },
  ];
}

function viewAt(scale, { w = 320, h = 136 } = {}) {
  return {
    scale, left: 0, top: 0,
    viewW: Math.round(w * scale), viewH: Math.round(h * scale),
    boardW: 320, boardH: 136,
  };
}

// The plate exactly as paintCapitals fills it.
function plateRect(label) {
  return { x: label.x - 2, y: label.y - 1, width: label.width + 4, height: label.height + 2 };
}

// Nearest-point distance from a circle's centre to a rect: < r + halfStroke means the disc's ink
// and the rect share pixels.
function rectDiscGap(rect, cx, cy) {
  const nx = Math.min(Math.max(cx, rect.x), rect.x + rect.width);
  const ny = Math.min(Math.max(cy, rect.y), rect.y + rect.height);
  return Math.hypot(cx - nx, cy - ny);
}

function overlaps(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function ringHits(markers, view, labels) {
  const r = Math.max(3, view.scale * 2.4);
  const half = Math.max(1, view.scale) / 2;
  const hits = [];
  for (const label of labels) {
    const plate = plateRect(label);
    for (const marker of markers) {
      const at = cellToPixel(marker.x, marker.y, view);
      const gap = rectDiscGap(plate, at.x, at.y);
      if (gap < r + half) {
        hits.push({
          label: label.name, ring: marker.name, scale: view.scale,
          gap: Math.round(gap * 100) / 100, need: Math.round((r + half) * 100) / 100,
        });
      }
    }
  }
  return hits;
}

const LADDER = [2, 4, 4.4, 6, 8];

export async function run(ctx) {
  const markers = capitals();

  // --- 1 + 2: the ladder, both eras' sets ---------------------------------------------------
  for (const era of ["1918", "1942"]) {
    for (const scale of LADDER) {
      const view = viewAt(scale);
      const labels = capitalLabels(markers, view, {});
      if (!labels.length) fail(era + " @" + scale + ": no capital label was placed at all");
      const london = labels.find((label) => label.name === "London");
      if (!london) fail(era + " @" + scale + ": London is not labelled");
      const hits = ringHits(markers, view, labels);
      if (hits.length) {
        fail(era + " @" + scale + " px/cell: a plate covers a ring: " + JSON.stringify(hits));
      }
      for (let i = 0; i < labels.length; i += 1) {
        for (let j = i + 1; j < labels.length; j += 1) {
          if (overlaps(plateRect(labels[i]), plateRect(labels[j]))) {
            fail(era + " @" + scale + ": labels overlap: " + labels[i].name + " / " + labels[j].name);
          }
        }
      }
      // The reservation is what makes it true: the exported ring boxes must cover the ink.
      const boxes = capitalRingBoxes(markers, view);
      if (boxes.length !== markers.length) fail("capitalRingBoxes dropped a capital at " + scale);
      const berlin = boxes[1];
      const at = cellToPixel(161, 30, view);
      const reach = Math.max(3, view.scale * 2.4) + Math.max(1, view.scale) / 2;
      if (berlin.ringX !== at.x || berlin.ringY !== at.y) fail("berlin ring box is not on berlin");
      if (berlin.width / 2 < reach) fail("berlin ring box is smaller than the ring's ink at " + scale);
    }
  }

  // --- 3: edges ----------------------------------------------------------------------------
  // A ring partly off the canvas: the box is not clipped, and nothing may be placed on the ink that
  // is on it. x=319 is the seam column; y=0 puts the ring's top half off screen.
  const edgeMarkers = [
    { name: "Seam", x: 319, y: 0, color: "#c4473a" },
    { name: "Corner", x: 318, y: 2, color: "#c4473a" },
    { name: "Right", x: 317, y: 10, color: "#c4473a" },
  ];
  for (const scale of LADDER) {
    const view = viewAt(scale);
    const labels = capitalLabels(edgeMarkers, view, {});
    const hits = ringHits(edgeMarkers, view, labels);
    if (hits.length) fail("edge case @" + scale + ": a plate covers an off-screen ring: " + JSON.stringify(hits));
    const boxes = capitalRingBoxes(edgeMarkers, view);
    const off = boxes.find((box) => box.y < 0 || box.x + box.width > view.viewW || box.y + box.height > view.viewH);
    if (!off) fail("edge @" + scale + ": an off-canvas ring's box was clipped to the canvas");
  }

  // --- 4: base control, the mechanism the pin claims ---------------------------------------
  // The pre-fix placement: London's name at its first candidate, r + 3 to the right, with the plate
  // drawn at the same coordinates. That rect must cross Berlin's ring at 2, 4 and 4.4 and clear it
  // at 6 and 8 - the ladder the ticket carries - or this pin is not measuring the reported defect.
  const baseRed = [2, 4, 4.4];
  for (const scale of LADDER) {
    const view = viewAt(scale);
    const london = cellToPixel(148, 30, view);
    const berlin = cellToPixel(161, 30, view);
    const r = Math.max(3, view.scale * 2.4);
    const fontPx = Math.max(9, Math.round(view.scale * 0.75));
    const perChar = Math.max(6, Math.round(fontPx * 0.62));
    const width = "London".length * perChar;
    const height = Math.round(fontPx * 1.15);
    const old = {
      x: Math.round(london.x + r + 3), y: Math.round(london.y - height / 2), width, height,
    };
    const gap = rectDiscGap(plateRect(old), berlin.x, berlin.y);
    const crosses = gap < r + Math.max(1, view.scale) / 2;
    const want = baseRed.includes(scale);
    if (crosses !== want) {
      fail("base control @" + scale + ": pre-fix plate " + (crosses ? "crosses" : "clears") +
        " Berlin's ring (gap " + Math.round(gap * 100) / 100 + "), expected " + (want ? "a crossing" : "clear"));
    }
  }

  if (ctx && typeof ctx.fail !== "function") fail("ctx is not the harness context");
}
