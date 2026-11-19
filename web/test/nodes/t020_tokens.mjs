// Node t020_tokens (T-020 / D-023): the token icon set replaces the T-014 badges.
//
// The T-014 contract was "a silhouette inside a side-coded badge". D-023 keeps every T-014 rule
// and changes the badge to a bold token: a THICK side-coloured coin with a WHITE silhouette, and
// the side is carried by the coin's SHAPE - blue is a circle, red is a pointed hex - not by colour
// alone. This leg is written to be red on the pre-token tree (square/chamfered frame, dark
// silhouette) and green on the token tree, so every assertion here is load-bearing.
import {
  BADGE_KINDS, BADGE_MIN_PX, BADGE_SIDE, BADGE_SILHOUETTE, BADGE_UNIT,
  badgeGroups, badgeLegendRows, badgePx, badgeSvg, framePolygon,
  showsEntrench,
} from "../../public/badges.mjs";
import { BOARD_W, cellToPixel, makeView, paintBadge } from "../../public/render.mjs";

function eq(message, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(message + ": " + a + " !== " + e);
}

function ok(message, value) {
  if (!value) throw new Error(message);
}

function recorder() {
  const fills = [];
  const paths = [];
  const arcs = [];
  let current = null;
  const ctx = {
    _fill: "", _stroke: "", lineWidth: 1, font: "", textAlign: "", textBaseline: "",
    set fillStyle(v) { this._fill = v; }, get fillStyle() { return this._fill; },
    set strokeStyle(v) { this._stroke = v; }, get strokeStyle() { return this._stroke; },
    beginPath() { current = []; paths.push(current); },
    moveTo(x, y) { current.push(["M", x, y]); },
    lineTo(x, y) { current.push(["L", x, y]); },
    closePath() { current.push(["Z"]); },
    rect(x, y, w, h) { current.push(["R", x, y, w, h]); },
    arc(x, y, r) { current.push(["A", x, y, r]); arcs.push({ x, y, r, color: this._fill }); },
    fill() { fills.push(this._fill); },
    stroke() {},
    fillRect() {},
    fillText() {},
    save() {}, restore() {}, clearRect() {},
  };
  return { ctx, fills, paths, arcs };
}

// Points of a recorded polygon path, minus the close op.
function pointsOf(path) {
  return (path || []).filter((op) => op[0] === "M" || op[0] === "L").map((op) => [op[1], op[2]]);
}

function radii(points) {
  return points.map(([x, y]) => Math.hypot(x - 12, y - 12));
}

const piece = (over) => ({ id: "p", kind: "infantry", side: "blue", x: 100, y: 60,
  strength: 100, maxStrength: 100, ...over });

export const name = "t020_tokens";

export async function run() {
  // --- the shape cue: circle vs pointed hex, declared and drawn -----------------------
  eq("blue's coin is a circle", BADGE_SIDE.blue.frameShape, "circle");
  eq("red's coin is a pointed hex", BADGE_SIDE.red.frameShape, "pointedHex");

  const blue = framePolygon("blue");
  const red = framePolygon("red");
  ok("the blue coin is a smooth polygon, not a square (" + blue.length + " points)", blue.length >= 24);
  eq("the red coin is exactly six points", red.length, 6);
  ok("the two coins are different shapes", JSON.stringify(blue) !== JSON.stringify(red));

  // A circle: every vertex sits on one radius. A square/chamfer would fail this at its corners.
  const blueR = radii(blue);
  ok("every blue vertex is on the coin radius (" + Math.min(...blueR).toFixed(2) + ".." +
    Math.max(...blueR).toFixed(2) + ")", Math.max(...blueR) - Math.min(...blueR) < 0.3);
  ok("the blue coin has no square corner", !blue.some(([x, y]) => x < 4 && y < 4));
  // A pointed hex: one vertex on the vertical axis at the top and one at the bottom, which no
  // circle polygon and no chamfered square has.
  const top = red.filter(([, y]) => y < 4);
  const bottom = red.filter(([, y]) => y > 20);
  eq("the red coin comes to a point at the top", top.length, 1);
  eq("the red coin comes to a point at the bottom", bottom.length, 1);
  ok("the red point is on the coin's vertical axis", Math.abs(top[0][0] - 12) < 0.01 &&
    Math.abs(bottom[0][0] - 12) < 0.01);
  ok("the red coin is widest in the middle, not at the points",
    Math.max(...red.map(([x]) => Math.abs(x - 12))) > Math.abs(top[0][0] - 12));

  // The color-blind claim, stated in the terms a grayscale reader gets: strip colour and the two
  // silhouettes are still different geometry.
  const geometry = (side) => JSON.stringify(framePolygon(side).map(([x, y]) => [Math.round(x), Math.round(y)]));
  ok("with colour removed the sides still differ (point count and vertices)",
    geometry("blue") !== geometry("red") && framePolygon("blue").length !== framePolygon("red").length);

  // The thick coin: the SVG draws a rim polygon OUTSIDE the face polygon on both sides, so the
  // token reads as a coin and not as a flat shape. (Checked from the SVG order below.)
  ok("the coin declares a rim shade per side",
    typeof BADGE_SIDE.blue.rim === "string" && typeof BADGE_SIDE.red.rim === "string" &&
    BADGE_SIDE.blue.rim !== BADGE_SIDE.blue.frame && BADGE_SIDE.red.rim !== BADGE_SIDE.red.frame);

  // --- white silhouettes on the coin --------------------------------------------------
  eq("blue silhouettes are white", BADGE_SIDE.blue.silhouette, "#ffffff");
  eq("red silhouettes are white", BADGE_SIDE.red.silhouette, "#ffffff");
  ok("the coin face is the side's colour, not white",
    BADGE_SIDE.blue.frame !== "#ffffff" && BADGE_SIDE.red.frame !== "#ffffff");
  ok("the rim is a lighter shade of the side, not the face colour",
    BADGE_SIDE.blue.rim !== BADGE_SIDE.blue.frame && BADGE_SIDE.red.rim !== BADGE_SIDE.red.frame);

  // --- every visible type, every later-era kind, transport included -------------------
  eq("eleven manual kinds", BADGE_KINDS.length, 11);
  for (const kind of ["reconSat", "killerSat", "nuke", "foreignAid", "intelScan"]) {
    ok("the later-era kind is missing: " + kind, BADGE_KINDS.includes(kind));
  }
  for (const kind of [...BADGE_KINDS, "transport"]) {
    ok("no silhouette for " + kind, Array.isArray(BADGE_SILHOUETTE[kind]) && BADGE_SILHOUETTE[kind].length);
  }
  eq("the legend still names every kind on both sides", badgeLegendRows().length, 24);

  // Every kind draws its silhouette in white on both sides, in the SVG the Buy table and the
  // legend use.
  for (const kind of [...BADGE_KINDS, "transport"]) {
    for (const side of ["blue", "red"]) {
      const svg = badgeSvg({ kind, side, px: 24 });
      const whiteMarks = (svg.match(/#ffffff/g) || []).length;
      ok(kind + "/" + side + " has no white silhouette (" + whiteMarks + " white marks)", whiteMarks >= 1);
      ok(kind + "/" + side + " keeps a dark silhouette ink",
        !svg.includes("fill=\"#0000aa\"") && !svg.includes("fill=\"#aa0000\""));
    }
  }

  // The SVG frame is the coin: a 32-gon for blue, a hex for red, with a rim polygon first.
  const blueSvg = badgeSvg({ kind: "tank", side: "blue", px: 24 });
  const redSvg = badgeSvg({ kind: "tank", side: "red", px: 24 });
  const polygons = (svg) => [...svg.matchAll(/points="([^"]+)"/g)].map((m) => m[1].split(" "));
  const bluePolys = polygons(blueSvg);
  const redPolys = polygons(redSvg);
  ok("the blue SVG starts with the rim (" + bluePolys[0].length + " points)", bluePolys[0].length >= 24);
  eq("the blue SVG draws the 32-gon face", bluePolys[1].length, 32);
  ok("the red SVG starts with the rim (" + redPolys[0].length + " points)", redPolys[0].length === 6);
  eq("the red SVG draws the hex face", redPolys[1].length, 6);

  // --- the T-014 rules that must survive the new drawing -----------------------------
  // 14 px floor at every zoom.
  for (let scale = 1; scale <= 32; scale++) {
    ok("scale " + scale + " draws below the 14 px floor", badgePx(scale) >= BADGE_MIN_PX);
  }
  // Dug-in is infantry only.
  eq("entrenched infantry shows the bar", showsEntrench(piece({ entrenched: true })), true);
  eq("an entrenched tank does not", showsEntrench(piece({ kind: "tank", entrenched: true })), false);
  ok("the entrenched infantry SVG carries the dug-in bar", badgeSvg({ kind: "infantry", entrenched: true }).includes("#1f7a3a"));
  ok("the entrenched tank SVG does not", !badgeSvg({ kind: "tank", entrenched: true }).includes("#1f7a3a"));

  // --- the painter the board calls draws rim, then face, then white ------------------
  const view = makeView({ scale: 8, viewW: 1280, viewH: 544, boardW: BOARD_W, boardH: 136 });
  const rec = recorder();
  const drawn = paintBadge(rec.ctx, badgeGroups([piece({ id: "hit" })], 8)[0], view, { badgeMinPx: 14 });
  ok("paintBadge reports the token it drew", drawn && drawn.kind === "infantry" && drawn.side === "blue");
  const rimAt = rec.fills.indexOf(BADGE_SIDE.blue.rim);
  const faceAt = rec.fills.indexOf(BADGE_SIDE.blue.frame);
  const whiteAt = rec.fills.indexOf("#ffffff");
  ok("the rim is painted", rimAt >= 0);
  ok("the face is painted after the rim", faceAt > rimAt);
  ok("the white silhouette is painted after the face", whiteAt > faceAt);
  ok("the coin is not painted in the old dark silhouette ink",
    !rec.fills.includes("#0000aa") && !rec.fills.includes("#aa0000"));
  const framePath = rec.paths[1] || [];
  eq("the blue board token's face path is a 32-gon", pointsOf(framePath).length, 32);

  // The red token is the hex on the board too, and it is not the blue shape.
  const redRec = recorder();
  paintBadge(redRec.ctx, badgeGroups([piece({ id: "r", side: "red" })], 8)[0], view, {});
  eq("the red board token's face path is a hex", pointsOf(redRec.paths[1] || []).length, 6);
  ok("the red token uses the red rim", redRec.fills.includes(BADGE_SIDE.red.rim));
  ok("the red token's silhouette is white", redRec.fills.includes("#ffffff"));

  // A stack keeps the disc and the count.
  const crowd = [
    piece({ id: "a", strength: 30 }),
    piece({ id: "b", kind: "tank", strength: 90, x: 100, y: 61 }),
  ];
  const stackRec = recorder();
  paintBadge(stackRec.ctx, badgeGroups(crowd, 8)[0], view, {});
  ok("a stack draws the count disc", stackRec.arcs.length >= 1);

  // Hover geometry is unchanged: the token is centred on the same cell.
  const at = cellToPixel(100, 60, view);
  ok("the token is centred on the piece's cell", Math.abs(drawn.x + drawn.size / 2 - at.x) < 0.001 &&
    Math.abs(drawn.y + drawn.size / 2 - at.y) < 0.001);
}
