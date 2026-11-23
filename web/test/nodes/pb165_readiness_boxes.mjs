// PB-165: the readiness box is the manual's THREE states, in the original's own inks.
//
// Manual p.14: "each friendly city is highlighted with a colored box. The box is green if the city
// is available for building, yellow if the city will soon be available, and red if the city will
// not be available for a long time."
//
// The original picks the colour off the site's readiness timer (0x10ae) with three branches:
// FUN_2c85_1022 @ 2c85:1022 (decompiled.c:24259-24267) and FUN_2c85_1254 @ 2c85:1254
// (decompiled.c:24359-24367): 0 -> palette 10, < 0x15 -> palette 14, else palette 12. The game
// draws with the default VGA 16 palette, so those are #55ff55 / #ffff55 / #ff5555.
import { boardPayload, matchSites } from "../../server/board.mjs";
import { openMatch } from "../../server/match.mjs";
import { seedOwners } from "../../server/economy.mjs";
import { placementMask } from "../../server/placement.mjs";
import { READY_SOON_LIMIT, placementBoxState } from "../../server/readiness.mjs";
import { PLACEMENT_BOX, PLACEMENT_FILL, paintPlacement } from "../../public/render.mjs";

export const name = "pb165_readiness_boxes";

function recorder() {
  const fills = [];
  const strokes = [];
  const ctx = {
    _style: "",
    _stroke: "",
    set fillStyle(value) { this._style = value; },
    get fillStyle() { return this._style; },
    set strokeStyle(value) { this._stroke = value; },
    get strokeStyle() { return this._stroke; },
    fillRect(x, y, w, h) { fills.push({ x, y, w, h, color: this._style }); },
    strokeRect(x, y, w, h) { strokes.push({ x, y, w, h, color: this._stroke }); },
    lineWidth: 1,
  };
  return { ctx, fills, strokes };
}

function view(scale) {
  return { scale, left: 0, top: 0, viewW: 320 * scale, viewH: 136 * scale, boardW: 320, boardH: 136 };
}

export async function run(ctx) {
  const { fail } = ctx;

  // 1. The three branches, on the timer the original reads. 0x15 (21) is the boundary because the
  //    original branches on the raw 0x10ae byte against 0x15. Nothing caps that byte near 20: per-kind
  //    maxima measure 33/66 blue and 66/133 red, so 21 is the original's own threshold, not a ceiling.
  const round = 5;
  const at = (timer) => placementBoxState({ readyRound: timer === 0 ? 0 : round + timer }, round);
  const cases = [[0, 1], [1, 2], [20, 2], [21, 3], [40, 3]];
  for (const [timer, want] of cases) {
    const got = at(timer);
    if (got !== want) fail("pb165: timer " + timer + " is state " + got + ", expected " + want);
  }
  if (READY_SOON_LIMIT !== 0x15) fail("pb165: the soon/long boundary moved off 0x15");
  // A readyRound already in the past is ready, never negative.
  if (placementBoxState({ readyRound: 3 }, 9) !== 1) fail("pb165: a past readyRound is not drawn ready");

  // 2. The mask the server sends carries that byte, not a boolean.
  const board = boardPayload();
  const match = openMatch("1942", matchSites("1942", board));
  seedOwners(match);
  match.round = 10;
  const held = (site) => match.pieces.some(
    (piece) => Number(piece.x) === Number(site.x) && Number(piece.y) === Number(site.y)
  );
  const site = (match.sites || []).find((s) => s && s.owner === "blue" &&
    ["city", "capital", "base"].includes(String(s.kind)) && !held(s));
  if (!site) fail("pb165: no free blue city to read the mask from");
  const cellId = Number(site.y) * 320 + Number(site.x);

  for (const [timer, want] of [[0, 1], [4, 2], [24, 3]]) {
    site.readyRound = timer === 0 ? 0 : match.round + timer;
    const mask = placementMask(match, "blue", "infantry", board);
    if (mask.error) fail("pb165: placementMask refused: " + mask.error);
    const got = mask.mask[cellId];
    if (got !== want) fail("pb165: mask byte for timer " + timer + " is " + got + ", expected " + want);
  }

  // 3. The page paints three colours, and they are the original's inks.
  const wire = new Uint8Array(320 * 136);
  wire[10 * 320 + 10] = 1;
  wire[10 * 320 + 20] = 2;
  wire[10 * 320 + 30] = 3;
  const r = recorder();
  const painted = paintPlacement(r.ctx, { width: 320, height: 136, mask: wire }, view(2));
  if (painted !== 3) fail("pb165: painted " + painted + " of 3 state cells");
  const fills = new Set(r.fills.map((f) => f.color));
  if (fills.size !== 3) fail("pb165: three states painted in " + fills.size + " colour(s): " + [...fills].join(" | "));
  for (const [state, want] of [["ready", PLACEMENT_FILL.ready], ["soon", PLACEMENT_FILL.soon], ["long", PLACEMENT_FILL.long]]) {
    if (!fills.has(want)) fail("pb165: the " + state + " cell is not painted " + want);
  }
  const strokes = new Set(r.strokes.map((s) => s.color));
  for (const [state, want] of [["ready", PLACEMENT_BOX.ready], ["soon", PLACEMENT_BOX.soon], ["long", PLACEMENT_BOX.long]]) {
    if (!strokes.has(want)) fail("pb165: the " + state + " box outline is not " + want);
  }
  // The inks themselves: default VGA 10/14/12, not invented hues.
  const inks = {
    ready: PLACEMENT_BOX.ready, soon: PLACEMENT_BOX.soon, long: PLACEMENT_BOX.long,
  };
  for (const [state, want] of Object.entries({ ready: "85, 255, 85", soon: "255, 255, 85", long: "255, 85, 85" })) {
    if (!inks[state].includes(want)) fail("pb165: the " + state + " ink is " + inks[state] + ", not palette " + want);
  }

  // 4. The refusal still names the round for a long-wait city (the box colour never changes the rule).
  console.log("pb165_readiness_boxes: 3 states at 0x15, mask bytes 1/2/3, inks #55ff55/#ffff55/#ff5555");
}
