// Node unit_icons (T-014): the badge contract.
//
// The old node pinned the 3x3 marker the original drew on its map (chq_0021.png): every unit the
// same block, identity only in the panels. This page has no monitor strip, so T-014 moved identity
// onto the board - one original silhouette per kind inside a side-coded badge, never smaller than
// 14 px, with one badge per footprint and a stack disc on a crowd. These assertions pin that
// contract: the kind list, the side cue that survives colour-blindness, the size floor, grouping,
// state precedence, the entrench rule the runtime actually obeys (infantry only), hover text, the
// shared SVG legend, and the painter the page really calls.
import {
  BADGE_CELLS, BADGE_DOMAIN, BADGE_INTERIOR, BADGE_KINDS, BADGE_LABEL, BADGE_MIN_PX,
  BADGE_SIDE, BADGE_SILHOUETTE, BADGE_UNIT, ENTRENCH_KINDS, badgeForPiece, badgeGroups,
  badgeHoverText, badgeLegendRows, badgePx, badgeSilhouette, badgeState, badgeSvg, badgeTops,
  framePolygon, insetPolygon, selectedRing, showsEntrench, strengthBand,
} from "../../public/badges.mjs";
import {
  BOARD_W, badgeAt, badgeFootprint, cellToPixel, makeView, paintBadge, paintPieces,
  paintSiteTicks, renderBadgeSprite, statusLine,
} from "../../public/render.mjs";

function eq(message, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(message + ": " + a + " !== " + e);
}

function ok(message, value) {
  if (!value) throw new Error(message);
}

// The six canvas calls the painter is allowed to use, recorded. Anything the painter calls that is
// not here throws, which is how a browser-only call sneaks into a node test and gets caught.
function recorder() {
  const fills = [];
  const fillsRect = [];
  const paths = [];
  const strokes = [];
  const images = [];
  let current = null;
  const ctx = {
    _fill: "",
    _stroke: "",
    lineWidth: 1,
    font: "",
    set fillStyle(value) { this._fill = value; },
    get fillStyle() { return this._fill; },
    set strokeStyle(value) { this._stroke = value; },
    get strokeStyle() { return this._stroke; },
    beginPath() { current = []; paths.push(current); },
    moveTo(x, y) { useCall(this, "moveTo"); current.push(["M", x, y]); },
    lineTo(x, y) { useCall(this, "lineTo"); current.push(["L", x, y]); },
    closePath() { useCall(this, "closePath"); current.push(["Z"]); },
    rect(x, y, w, h) { useCall(this, "rect"); current.push(["R", x, y, w, h]); },
    arc(x, y, r) { useCall(this, "arc"); current.push(["A", x, y, r]); },
    fill() { useCall(this, "fill"); fills.push(this._fill); },
    stroke() { useCall(this, "stroke"); strokes.push(this._stroke); },
    fillRect(x, y, w, h) { useCall(this, "fillRect"); fillsRect.push({ x, y, w, h, color: this._fill }); },
    fillText() { useCall(this, "fillText"); },
    drawImage(image, x, y, w, h) { images.push({ image, x, y, w, h }); },
    save() {}, restore() {}, clearRect() {},
  };
  function useCall(target, name) {
    if (!target || !name) throw new Error("canvas call out of context");
  }
  return { ctx, fills, fillsRect, paths, strokes, images };
}

// The pixels a path actually covers, so "one badge width" is measured on the drawing and not on a
// constant the test could get wrong the same way the code did.
function pathBox(path) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const op of path) {
    for (let i = 1; i + 1 < op.length; i += 2) {
      const x = op[i];
      const y = op[i + 1];
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
  }
  return { w: maxX - minX, h: maxY - minY };
}

const piece = (over) => ({ id: "p", kind: "infantry", side: "blue", x: 100, y: 60,
  strength: 100, maxStrength: 100, ...over });

export const name = "unit_icons";

export async function run() {
  // --- the eleven manual kinds plus the transport state -------------------------------
  eq("eleven kinds, the manual's list", BADGE_KINDS.length, 11);
  eq("the manual's order is the legend's order", BADGE_KINDS.slice(0, 4),
    ["infantry", "tank", "submarine", "cruiser"]);
  for (const kind of [...BADGE_KINDS, "transport"]) {
    ok("no label for " + kind, typeof BADGE_LABEL[kind] === "string" && BADGE_LABEL[kind].length > 2);
    ok("no silhouette for " + kind, Array.isArray(badgeSilhouette(kind)) && badgeSilhouette(kind).length > 0);
  }
  eq("the legend names every kind on both sides", badgeLegendRows().length, (11 + 1) * 2);
  eq("the legend's first row is blue infantry", badgeLegendRows()[0], {
    kind: "infantry", side: "blue", label: "Infantry", transport: false,
  });

  // --- no two kinds are the same picture ----------------------------------------------
  const signatures = new Map();
  for (const kind of [...BADGE_KINDS, "transport"]) {
    const signature = JSON.stringify(BADGE_SILHOUETTE[kind]);
    ok("killerSat and reconSat share a silhouette", !(kind === "killerSat" && signature === JSON.stringify(BADGE_SILHOUETTE.reconSat)));
    ok("the transport reuses " + kind, !signatures.has(signature));
    signatures.set(signature, kind);
  }
  eq("twelve distinct silhouettes", signatures.size, 12);

  // --- side is colour AND frame geometry ----------------------------------------------
  const blueFrame = framePolygon("blue");
  const redFrame = framePolygon("red");
  eq("blue is a square", blueFrame.length, 4);
  eq("red cuts its corners", redFrame.length, 8);
  ok("the two frames are not the same polygon", JSON.stringify(blueFrame) !== JSON.stringify(redFrame));
  ok("the sides differ in colour", BADGE_SIDE.blue.frame !== BADGE_SIDE.red.frame);
  ok("the interiors differ by domain", BADGE_INTERIOR.land !== BADGE_INTERIOR.sea &&
    BADGE_INTERIOR.sea !== BADGE_INTERIOR.air);
  for (const side of ["blue", "red"]) {
    const inset = insetPolygon(framePolygon(side), 0.9);
    eq("the interior keeps the frame's point count on " + side, inset.length, framePolygon(side).length);
    eq("the selected ring keeps it too on " + side, selectedRing(side).length, framePolygon(side).length);
    ok("the interior sits inside the frame on " + side,
      Math.abs(inset[0][0] - 12) < Math.abs(framePolygon(side)[0][0] - 12));
  }
  for (const side of ["blue", "red"]) {
    const svg = badgeSvg({ kind: "tank", side, px: 24 });
    ok("blue svg is a square polygon", side !== "blue" || svg.includes('points="3,3 21,3 21,21 3,21"'));
    ok("red svg is the chamfered polygon", side !== "red" || svg.includes('points="7,3 17,3 21,7 21,17 17,21 7,21 3,17 3,7"'));
  }
  ok("blue and red differ beyond hue", badgeSvg({ kind: "tank", side: "blue" }) !==
    badgeSvg({ kind: "tank", side: "red" }));

  // --- the size floor: 14 px at every zoom, no 3x3 fallback ---------------------------
  eq("the floor is the PM's", BADGE_MIN_PX, 14);
  eq("the badge keeps the block's three-cell footprint when zoomed", BADGE_CELLS, 3);
  eq("the drawing box is 24 units", BADGE_UNIT, 24);
  for (let scale = 1; scale <= 32; scale++) {
    const px = badgePx(scale);
    ok("scale " + scale + " draws below the floor (" + px + ")", px >= BADGE_MIN_PX);
    if (scale >= 5) eq("scale " + scale + " is three cells", px, scale * 3);
  }
  eq("the whole-world fit is the floor", badgePx(1), 14);
  eq("4 px a cell still hits the floor", badgePx(4), 14);
  eq("a retina floor is honoured", badgePx(4, 28), 28);
  eq("a nonsense scale does not go below one cell", badgePx(0, 0), 14);

  // --- one badge per footprint, same side only, strongest face ------------------------
  const crowd = [
    piece({ id: "a", kind: "infantry", strength: 30 }),
    piece({ id: "b", kind: "tank", strength: 90, x: 100, y: 61 }),
    piece({ id: "c", kind: "infantry", strength: 60, x: 101, y: 60 }),
  ];
  const crowded = badgeGroups(crowd, 4);
  eq("three friendly pieces on one footprint are one badge", crowded.length, 1);
  eq("the disc counts all three", crowded[0].count, 3);
  eq("the face is the strongest piece", crowded[0].top.id, "b");
  eq("the badge reads as the face's kind", crowded[0].kind, "tank");
  ok("the group's anchor sits on the footprint",
    Math.abs(crowded[0].x - 100.33) < 0.5 && Math.abs(crowded[0].y - 60.33) < 0.5);
  eq("only faces are painted as tops", [...badgeTops(crowded)], ["b"]);

  const mixed = badgeGroups([piece({ id: "u" }), piece({ id: "e", side: "red" })], 4);
  eq("the two sides never join one badge", mixed.length, 2);
  const spread = badgeGroups([piece({ id: "p1", x: 10 }), piece({ id: "p2", x: 30 })], 4);
  eq("badges a board-width apart stay apart", spread.length, 2);
  const lonely = badgeGroups([piece({ id: "solo" })], 4)[0];
  eq("a lone badge stands on its own cell", [lonely.x, lonely.y], [100, 60]);
  eq("a lone badge has no disc", lonely.count, 1);
  eq("bad groups are ignored", badgeGroups([null, {}, piece({ id: "ok" })], 4).length, 1);

  // --- transport is a state, not a twelfth shop kind ---------------------------------
  const boarded = badgeForPiece(piece({ kind: "infantry", domain: "land", atSea: true }));
  eq("a land unit at sea draws the transport state", [boarded.kind, boarded.shapeKind, boarded.domain],
    ["transport", "transport", "sea"]);
  const ashore = badgeForPiece(piece({ kind: "infantry", domain: "land" }));
  eq("the same unit ashore draws its own kind", [ashore.kind, ashore.shapeKind], ["infantry", "infantry"]);
  eq("a cruiser keeps the sea interior", badgeForPiece(piece({ kind: "cruiser" })).domain, "sea");
  eq("a satellite keeps the air interior", badgeForPiece(piece({ kind: "reconSat" })).domain, "air");
  const unknown = badgeForPiece(piece({ kind: "mystery" }));
  eq("an untyped piece is named as a unit, not a wrong kind", unknown.kind, "unit");
  ok("an untyped piece gets the placeholder square", JSON.stringify(unknown.silhouette) !==
    JSON.stringify(BADGE_SILHOUETTE.infantry));
  eq("the placeholder is no kind's silhouette", [...signatures.values()].includes("unit"), false);

  // --- state precedence: selected beats combat beats moving ---------------------------
  eq("selection wins", badgeState(piece({ id: "x", fighting: true, path: [[1, 1]] }), { selectedId: "x" }), "selected");
  eq("combat beats movement", badgeState(piece({ fighting: true, path: [[1, 1]] })), "combat");
  eq("a path is movement", badgeState(piece({ path: [[1, 1]] })), "moving");
  eq("moving true is movement", badgeState(piece({ moving: true })), "moving");
  eq("an idle piece is idle", badgeState(piece()), "idle");
  eq("a different piece being selected does not select this one", badgeState(piece({ id: "a" }), { selectedId: "b" }), "idle");

  // --- strength band, the bar's three colours -----------------------------------------
  eq("full strength is green", strengthBand(100, 100).colour, "#2f9e44");
  eq("half is still green", strengthBand(50, 100).colour, "#2f9e44");
  eq("49% is amber", strengthBand(49, 100).colour, "#d98410");
  eq("25% is amber", strengthBand(25, 100).colour, "#d98410");
  eq("under a quarter is red", strengthBand(24, 100).colour, "#c92a2a");
  eq("the bar is the exact fraction sent", strengthBand(37, 100).fraction, 0.37);
  eq("no max, no bar", strengthBand(50, 0), null);
  eq("no strength, no bar", strengthBand(undefined, 100), null);

  // --- only infantry digs in (PM change 1, room 3946; Q4/COMBAT.md) -------------------
  eq("the runtime's entrench kinds", [...ENTRENCH_KINDS], ["infantry"]);
  eq("entrenched infantry shows the bar", showsEntrench(piece({ entrenched: true })), true);
  eq("an entrenched tank does not", showsEntrench(piece({ kind: "tank", entrenched: true })), false);
  eq("dig-in is not a kind change on the page", showsEntrench(piece({ kind: "infantry", entrenched: false })), false);
  ok("the entrenched SVG carries the green bar", badgeSvg({ kind: "infantry", entrenched: true }).includes('fill="#1f7a3a"'));
  ok("the entrenched tank SVG does not", !badgeSvg({ kind: "tank", entrenched: true }).includes('fill="#1f7a3a"'));

  // --- hover names the type and the strength ------------------------------------------
  eq("hover names type and strength", badgeHoverText(lonely), "Infantry · strength 100/100");
  eq("hover on a dug-in unit says so", badgeHoverText(badgeGroups([piece({ entrenched: true })], 4)[0]),
    "Infantry · strength 100/100 · dug in");
  eq("hover on a transport names the state",
    badgeHoverText(badgeGroups([piece({ atSea: true, domain: "land" })], 4)[0]),
    "Transport (land unit at sea) · strength 100/100");
  const stackText = badgeHoverText(crowded[0]);
  ok("hover on a stack lists every piece strongest first", stackText ===
    "3 units: Tank 90/100, Infantry 60/100, Infantry 30/100");
  eq("hover on nothing says nothing", badgeHoverText(null), "");

  // --- the painter the page calls -------------------------------------------------------
  const view = makeView({ scale: 4, viewW: 1280, viewH: 544, boardW: BOARD_W, boardH: 136 });
  const drawn = recorder();
  const drew = paintBadge(drawn.ctx, badgeGroups([piece({ id: "hit" })], 4)[0], view, { badgeMinPx: 14 });
  ok("paintBadge reports the badge it drew", drew && drew.kind === "infantry" && drew.size === 14 &&
    drew.side === "blue" && drew.count === 1);
  ok("the frame is painted in the side's colour", drawn.fills.includes(BADGE_SIDE.blue.frame));
  ok("the interior is painted for the domain", drawn.fills.includes(BADGE_INTERIOR.land));
  ok("the silhouette is painted in the side's dark", drawn.fills.includes(BADGE_SIDE.blue.dark));
  ok("the strength bar is painted", drawn.fillsRect.some((r) => r.color === "#2f9e44"));
  const framePath = drawn.paths.find((path) => path.length >= 4 && path.some((op) => op[0] === "Z"));
  ok("the frame path is closed", Boolean(framePath));
  const frameBox = pathBox(framePath);
  eq("the frame is 18/24 of a 14 px badge", [Math.round(frameBox.w), Math.round(frameBox.h)], [11, 11]);
  const small = recorder();
  paintBadge(small.ctx, badgeGroups([piece({ id: "small" })], 1)[0], makeView({ scale: 1 }), { badgeMinPx: 14 });
  const smallBox = pathBox(small.paths.find((path) => path.length >= 4 && path.some((op) => op[0] === "Z")));
  eq("a 1 px cell still draws an 11 px frame, not a 3x3 block", [Math.round(smallBox.w), Math.round(smallBox.h)], [11, 11]);

  // The page's path: the sprite cache paints the static half once and the frame blits it.
  const blit = recorder();
  paintBadge(blit.ctx, badgeGroups([piece({ id: "blit" })], 4)[0], view,
    { badgeMinPx: 14, badgeSprites: { get: () => ({ tag: "sprite" }) } });
  eq("a cached badge is one blit at the badge box", blit.images.length, 1);
  eq("the blit is the badge's size at its own corner", [blit.images[0].w, blit.images[0].h], [14, 14]);
  eq("a blitted badge does not repaint the frame as paths", blit.fills.length, 0);
  const spriteDrawn = recorder();
  eq("the sprite painter fills the badge box", renderBadgeSprite(spriteDrawn.ctx, { kind: "tank", side: "red", size: 28 }), 28);
  ok("the sprite carries the red frame", spriteDrawn.fills.includes(BADGE_SIDE.red.frame));
  ok("the sprite carries the land interior", spriteDrawn.fills.includes(BADGE_INTERIOR.land));
  ok("the sprite carries the silhouette", spriteDrawn.fills.includes(BADGE_SIDE.red.dark));
  eq("the sprite's frame is drawn at the canvas origin",
    Math.round(pathBox(spriteDrawn.paths.find((path) => path.some((op) => op[0] === "Z"))).w), 21);

  const red = recorder();
  paintBadge(red.ctx, badgeGroups([piece({ side: "red" })], 4)[0], view, {});
  ok("the red badge uses the red frame", red.fills.includes(BADGE_SIDE.red.frame));
  ok("the red badge does not use the blue frame", !red.fills.includes(BADGE_SIDE.blue.frame));

  const many = recorder();
  const groups = paintPieces(many.ctx, crowd, view, {});
  eq("paintPieces paints one badge for the crowd", groups.length, 1);
  ok("the crowd's badge is painted once", many.fills.filter((c) => c === BADGE_SIDE.blue.frame).length === 1);

  // --- hit testing: hover finds the badge the frame drew ------------------------------
  const centre = cellToPixel(100, 60, view);
  eq("a pointer on the badge hits it", badgeAt([piece({ id: "hit" })], view, centre.x, centre.y).top.id, "hit");
  eq("a pointer off the badge misses", badgeAt([piece({ id: "hit" })], view, centre.x + 12, centre.y), null);
  const stack = badgeGroups(crowd, 4);
  eq("a pointer on a stack hits the whole group",
    badgeAt(crowd, view, cellToPixel(stack[0].x, stack[0].y, view).x, cellToPixel(stack[0].x, stack[0].y, view).y,
      { groups: stack }).count, 3);

  // --- the city under a badge keeps its tick (AC7) -----------------------------------
  const sites = [
    { x: 100, y: 60, type: 1 },
    { x: 10, y: 10, type: 2 },
  ];
  eq("a garrisoned city is re-stamped", paintSiteTicks(recorder().ctx, sites, groups, view), 1);
  eq("a badge-free map stamps nothing", paintSiteTicks(recorder().ctx, sites, [], view), 0);
  eq("the footprint covers the cells the badge body reaches",
    JSON.stringify(badgeFootprint(stack[0], view)),
    JSON.stringify({ x0: stack[0].x - 1.75, x1: stack[0].x + 1.75, y0: stack[0].y - 1.75, y1: stack[0].y + 1.75 }));

  // --- the footer says what the seat can see (PM change 2) ----------------------------
  const room = {
    you: "blue", round: 0, clock: "held", era: "1942",
    pieces: Array.from({ length: 43 }, (_, i) => piece({ id: "i" + i, side: i < 29 ? "blue" : "red" })),
  };
  eq("the footer names in-sight, own and enemy", statusLine({}, room, { mode: "cells" }),
    "Cell grid from the map extract · 43 pieces in sight · 29 yours · 14 the other side · 1942 · round 0 · clock held");
  eq("one piece is singular", statusLine({}, { ...room, pieces: [piece()] }, { mode: "cells" })
    .includes("1 piece in sight"), true);
  eq("no map, no piece count", statusLine({}, room, { mode: "schematic" }).includes("pieces in sight"), false);
}
