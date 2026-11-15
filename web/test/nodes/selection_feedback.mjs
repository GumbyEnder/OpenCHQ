// selection_feedback - the selected piece is visible, selection is cancellable, and the route
// preview never draws a seam-wrapped streak (T-030, PB-051/PB-052/PB-053).
//
// What fails if this is removed:
//   - selectionMarkFor returns null (or a ring inside the badge) -> the selected piece looks exactly
//     like an unselected one, which is PB-051
//   - the paint drops the dark casing -> the accent ring sits on the badge's own pale face and reads
//     as nothing at the world fit, where the badge is smallest
//   - routePolyline wraps each point instead of unwrapping the run -> a 319 -> 0 step is drawn as a
//     line across the whole map, the zig-zag PM saw on a 94-round sea route (PB-053)
//   - routeSpan is measured on the wrapped points -> the same leg reads as one map width long and
//     AC5 cannot be pinned

import { badgeGroups, badgePx } from "../../public/badges.mjs";
import { cellToPixel, routePolyline, routeSpan, paintSelectionMark, selectionMarkFor, makeView } from "../../public/render.mjs";
import { routeRequest } from "../../public/command.mjs";

const BOARD_W = 320;
const BOARD_H = 136;

function viewAt(scale) {
  return makeView({ scale, left: 0, top: 0, viewW: BOARD_W * scale, viewH: BOARD_H * scale, boardW: BOARD_W, boardH: BOARD_H });
}

const BLUE_INF = { id: "blue:infantry:1", side: "blue", kind: "infantry", domain: "land", x: 79, y: 44, strength: 100, maxStrength: 100 };
const BLUE_TANK = { id: "blue:tank:2", side: "blue", kind: "tank", domain: "land", x: 200, y: 60, strength: 100, maxStrength: 100 };
const RED_INF = { id: "red:infantry:9", side: "red", kind: "infantry", domain: "land", x: 60, y: 30, strength: 100, maxStrength: 100 };

// A stub 2d context that records the calls the painter makes. Enough surface for the badge writer
// and the mark; the point is which stroke colours and widths were issued, not a pixel buffer.
function recordingContext() {
  const ops = [];
  const ctx = {
    ops,
    globalAlpha: 1,
    strokeStyle: "",
    fillStyle: "",
    lineWidth: 1,
    font: "",
    textAlign: "",
    textBaseline: "",
    beginPath() { ops.push({ op: "beginPath" }); },
    moveTo(x, y) { ops.push({ op: "moveTo", x, y }); },
    lineTo(x, y) { ops.push({ op: "lineTo", x, y }); },
    rect(x, y, w, h) { ops.push({ op: "rect", x, y, w, h }); },
    arc(x, y, r) { ops.push({ op: "arc", x, y, r }); },
    closePath() { ops.push({ op: "closePath" }); },
    stroke() { ops.push({ op: "stroke", style: String(ctx.strokeStyle), width: Number(ctx.lineWidth), alpha: Number(ctx.globalAlpha) }); },
    fill() { ops.push({ op: "fill", style: String(ctx.fillStyle) }); },
    fillRect() {},
    strokeRect() {},
    clearRect() {},
    fillText() {},
    drawImage() {},
    save() { ops.push({ op: "save" }); },
    restore() { ops.push({ op: "restore" }); },
    translate() {},
    scale() {},
  };
  return ctx;
}

export const name = "selection_feedback";

export async function run({ fail, skip, register, socket, waitUntil, config }) {
  // ---- AC1: the mark exists at the world fit and both zooms, on both sides -------------------
  for (const scale of [2, 4, 8]) {
    const view = viewAt(scale);
    for (const piece of [BLUE_INF, RED_INF]) {
      const groups = badgeGroups([piece], scale, 14);
      const mark = selectionMarkFor(groups, view, { selectedId: piece.id, badgeMinPx: 14 });
      if (!mark) {
        fail("no selection mark at scale " + scale + " for " + piece.side);
        continue;
      }
      const halfBadge = badgePx(scale, 14) / 2;
      if (!(mark.half > halfBadge)) {
        fail("the selection mark at scale " + scale + " (" + mark.half + " px) does not sit outside the "
          + "badge (" + halfBadge + " px): it would be drawn under the icon");
      }
      if (!(mark.half < halfBadge + 12)) {
        fail("the selection mark at scale " + scale + " is " + (mark.half - halfBadge) + " px outside the badge, further than the ring should reach");
      }
    }
  }

  // Nothing selected is nothing drawn, and an id that is not on the board is not a mark either.
  {
    const groups = badgeGroups([BLUE_INF], 4, 14);
    if (selectionMarkFor(groups, viewAt(4), { badgeMinPx: 14 })) fail("a mark was drawn with nothing selected");
    if (selectionMarkFor(groups, viewAt(4), { selectedId: "blue:gone", badgeMinPx: 14 })) fail("a mark was drawn for an id that is not in the groups");
  }

  // The paint issues a dark casing and an accent stroke, at the pulse's low phase as well as high:
  // a still screenshot must carry the mark wherever the breathing happens to be.
  for (const pulse of [0, 0.5, 0.99]) {
    const ctx = recordingContext();
    const view = viewAt(2);
    const groups = badgeGroups([BLUE_INF], 2, 14);
    const mark = paintSelectionMark(ctx, groups, view, { selectedId: BLUE_INF.id, badgeMinPx: 14, selectedPulse: pulse });
    if (!mark) fail("paintSelectionMark drew nothing at pulse " + pulse);
    const strokes = ctx.ops.filter((op) => op.op === "stroke");
    const casing = strokes.find((s) => s.style === "#0b0f14" && s.width >= 3);
    const accent = strokes.find((s) => s.style === "#ffe066" && s.width >= 1.5);
    if (!casing) fail("no dark casing stroke at pulse " + pulse + ": " + JSON.stringify(strokes));
    if (!accent) fail("no accent (bright) stroke at pulse " + pulse + ": " + JSON.stringify(strokes));
  }

  // ---- AC5: a seam crossing is one cell, not the map ------------------------------------------
  {
    const view = viewAt(2);
    const crossing = {
      from: { x: 316, y: 60 },
      path: [{ x: 317, y: 60 }, { x: 318, y: 60 }, { x: 319, y: 60 }, { x: 0, y: 60 }, { x: 1, y: 60 }],
      to: { x: 2, y: 60 },
    };
    const points = routePolyline(crossing, view);
    const unwrapped = points.some((p) => p.x >= BOARD_W || p.x < 0);
    if (!unwrapped) fail("a route that crosses x=0 was not unwrapped past the seam: " + JSON.stringify(points));
    const span = routeSpan(crossing, view);
    if (span.maxCells > BOARD_W / 2) {
      fail("a seam crossing was drawn " + span.maxCells.toFixed(1) + " cells long (half the map is " + BOARD_W / 2 + ")");
    }
    // The old trace (each point wrapped on its own) is the shape that loses the game: 319 -> 0 is
    // 319 cells. Name it here so the size of the defect is in the test, not only in the report.
    let wrappedMax = 0;
    for (let i = 1; i < points.length; i++) {
      const d = Math.abs(points[i].cellX - points[i - 1].cellX);
      if (d > wrappedMax) wrappedMax = d;
    }
    if (!(wrappedMax > BOARD_W / 2)) fail("the wrapped control did not span the map, so this test could not bite");
  }

  // ---- AC5 on real plans: 5+ long routes, one of them across the seam ------------------------
  const player = await register("SelFeedback");
  const sock = socket(player.token);
  try {
    await new Promise((resolve, reject) => {
      sock.ws.addEventListener("open", resolve, { once: true });
      sock.ws.addEventListener("error", reject, { once: true });
    });
    await sock.wait((m) => m.op === "welcome", "welcome");
    sock.send({ op: "fullframes", on: true });
    sock.send({ op: "bot", era: "1942", side: "blue" });
    const start = await sock.wait((m) => m.op === "room" && m.room && m.room.mode === "bot", "1942 bot room");
    const pieces = (start.room.pieces || []).filter((p) => String(p.side) === String(start.room.you));
    const ships = pieces.filter((p) => p.domain === "sea");
    if (!ships.length) skip("the 1942 opening has no ship to plan a sea route from");

    const view = viewAt(2);
    const candidates = [];
    for (const ship of ships.slice(0, 4)) {
      for (let i = 1; i <= 8; i++) {
        const target = { x: (Number(ship.x) + i * 37) % BOARD_W, y: Math.max(2, Math.min(BOARD_H - 3, Math.round(Number(ship.y) + (i % 3 - 1) * 14))) };
        let mark = sock.box.length;
        sock.send(routeRequest(ship, target));
        let reply = null;
        try {
          reply = await sock.wait((m) => m.op === "route" && String(m.piece) === String(ship.id), "route " + ship.id + " -> " + target.x + "," + target.y, mark);
        } catch (err) {
          continue;
        }
        if (!reply || reply.error || !Array.isArray(reply.path) || reply.path.length === 0) continue;
        const span = routeSpan(reply, view);
        const points = routePolyline(reply, view);
        candidates.push({
          piece: ship.id, target, rounds: Number(reply.rounds) || 0, span,
          crossing: points.some((p) => p.x >= BOARD_W || p.x < 0),
        });
      }
    }
    if (candidates.length < 5) {
      fail("only " + candidates.length + " long sea routes came back from the 1942 opening; AC5 asks for at least 5");
    }
    const longest = candidates.slice().sort((a, b) => b.rounds - a.rounds);
    const sample = longest.slice(0, Math.max(5, Math.min(8, longest.length)));
    for (const route of sample) {
      if (!(route.span.maxCells <= BOARD_W / 2)) {
        fail("route " + route.piece + " -> " + route.target.x + "," + route.target.y + " (" + route.rounds
          + " rounds) draws a hop of " + route.span.maxCells.toFixed(1) + " cells; half the map is " + BOARD_W / 2);
      }
    }
    if (!sample.some((route) => route.crossing)) {
      fail("none of the sampled routes crosses the x seam, so the seam case was not exercised on a real plan");
    }
    const longestRounds = sample[0].rounds;
    if (!(longestRounds >= 40)) fail("the longest sampled route is only " + longestRounds + " rounds, so 'long' was not exercised");
    sock.send({ op: "leave" });
  } finally {
    sock.close();
  }
}
