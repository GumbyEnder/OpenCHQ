// PB-272 Show Paths (node id: pb272_show_paths).
//
// The manual (p.32, Menu Command Summary): "each unit's path is shown as a line on the screen (this
// works in zoom as well)"; p.21: "Pressing the key shows the target and travel path for all your
// units"; p.12: "You can only see the first three moves of an enemy unit".
//
// Three questions, all answerable without a browser:
//   1. Is the toggle real? Paint the same frame with the toggle off and on and count the own-unit
//      order lines the painter draws: 0 off, one per own unit with a destination on. The frame itself
//      must not move — the toggle is view state, not game state.
//   2. Is the hover path the room's own data? `hoverRoute` returns the route the server sent and
//      nothing else: a missing key and a tombstoned `[]` both draw nothing, an own unit keeps every
//      step it was given, and an enemy keeps the server's slice. The client holds NO cap — the pins
//      below assert the absence, so a later reader does not go looking for one to delete. Both
//      tombstone arms are here: the `[]` key draws nothing (§2), and a destroyed unit's line is
//      gone after the next delta (§2b), driven through the server's own `deltaBetween`.
//   3. Is it wired? The page binds `d`, has a NAV row, and passes both to the painter.
import { readFileSync } from "node:fs";
import { BOARD_H, BOARD_W, fitViewport, paintMatch } from "../../public/render.mjs";
import { hoverRoute } from "../../public/command.mjs";
import { themeById } from "../../public/themes.mjs";
import { deltaBetween } from "../../server/lobby.mjs";

export const name = "pb272_show_paths";

function eq(fail, label, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(label + ": got " + JSON.stringify(actual) + ", wanted " + JSON.stringify(expected));
  }
}

function ok(fail, label, value) {
  if (!value) fail(label);
}

function recorder() {
  const moves = [];
  const strokes = [];
  const ctx = {
    _stroke: "",
    lineWidth: 1,
    font: "",
    globalAlpha: 1,
    set strokeStyle(value) {
      this._stroke = value;
      strokes.push(value);
    },
    get strokeStyle() {
      return this._stroke;
    },
    set fillStyle(value) {
      this._fill = value;
    },
    get fillStyle() {
      return this._fill;
    },
    _fill: "",
    textAlign: "",
    textBaseline: "",
    save() {},
    restore() {},
    setLineDash() {},
    clearRect() {},
    beginPath() {},
    closePath() {},
    rect() {},
    arc() {},
    fill() {},
    fillRect() {},
    strokeRect() {},
    stroke() {},
    fillText() {},
    measureText() {
      return { width: 10 };
    },
    translate() {},
    scale() {},
    drawImage() {},
    moveTo(x, y) {
      moves.push({ x, y });
    },
    lineTo(x, y) {
      moves.push({ x, y });
    },
  };
  return { ctx, moves, strokes };
}

function board() {
  return {
    source: "extract",
    width: BOARD_W,
    height: BOARD_H,
    terrain: ["ocean", "plain", "city", "capital"],
    cells: new Array(BOARD_W * BOARD_H).fill(0),
  };
}

// Two own units with orders on the wire and one enemy with the server's 3-step slice — the shape
// `view.mjs` sends a seat.
function room() {
  return {
    you: "blue",
    round: 7,
    clock: "held",
    sites: [],
    pieces: [
      { id: "blue:land", side: "blue", kind: "infantry", domain: "land", x: 79, y: 44, strength: 20,
        path: [{ x: 80, y: 44 }, { x: 81, y: 45 }] },
      { id: "blue:sea", side: "blue", kind: "destroyer", domain: "sea", x: 60, y: 90, strength: 30,
        path: [{ x: 61, y: 90 }] },
      { id: "blue:air", side: "blue", kind: "fighter", domain: "air", x: 100, y: 60, strength: 10,
        path: [] },
      { id: "red:land", side: "red", kind: "infantry", domain: "land", x: 163, y: 38, strength: 18,
        path: [{ x: 164, y: 38 }, { x: 165, y: 39 }, { x: 166, y: 40 }] },
    ],
    routes: {
      "blue:land": [{ x: 80, y: 44 }, { x: 81, y: 45 }],
      "blue:sea": [{ x: 61, y: 90 }],
      "red:land": [{ x: 164, y: 38 }, { x: 165, y: 39 }, { x: 166, y: 40 }],
    },
  };
}

export async function run(ctx) {
  const { fail } = ctx;

  // --- 1. the toggle gates the own-unit lines, and nothing else -------------------------------
  {
    const view = fitViewport(320, 136);
    const frame = room();
    const before = JSON.stringify(frame);
    const off = recorder();
    const paintedOff = paintMatch(off.ctx, board(), frame, {
      view, own: "blue", theme: themeById("C"), showPaths: false,
    });
    eq(fail, "the toggle off draws no own-unit path", paintedOff.pending, 0);
    eq(fail, "the toggle off still draws every badge", paintedOff.groups, 4);
    ok(fail, "the toggle does not touch the frame", before === JSON.stringify(frame));

    const on = recorder();
    const paintedOn = paintMatch(on.ctx, board(), frame, {
      view, own: "blue", theme: themeById("C"), showPaths: true,
    });
    // Two own units hold a destination; the third has an empty path, so it draws no line.
    eq(fail, "the toggle on draws one line per own unit with a destination", paintedOn.pending, 2);
    eq(fail, "the toggle does not change the badges either", paintedOn.groups, paintedOff.groups);
    eq(fail, "the toggle adds no layer", paintedOn.layers, paintedOff.layers);
    ok(fail, "the toggle on actually strokes the board", on.strokes.length > off.strokes.length);
  }

  // --- 2. the hover path is the room's data, uncapped and tombstone-aware ---------------------
  {
    const frame = room();
    eq(fail, "no key draws nothing", hoverRoute({ id: "blue:ghost", x: 1, y: 1 }, frame.routes), null);
    eq(fail, "a tombstoned [] draws nothing", hoverRoute({ id: "blue:dead", x: 1, y: 1 }, { "blue:dead": [] }), null);
    eq(fail, "an empty routes map draws nothing", hoverRoute({ id: "blue:land", x: 79, y: 44 }, {}), null);
    eq(fail, "no piece draws nothing", hoverRoute(null, frame.routes), null);
    // Own: every step the server sent. The card's property is that the client never re-caps; a 7-step
    // own route has to come back with 7 steps.
    const ownSteps = [{ x: 80, y: 44 }, { x: 81, y: 45 }, { x: 82, y: 45 }, { x: 83, y: 46 },
      { x: 84, y: 46 }, { x: 85, y: 47 }, { x: 86, y: 47 }];
    const own = hoverRoute({ id: "blue:land", x: 79, y: 44 }, { "blue:land": ownSteps });
    eq(fail, "an own hover keeps every step", own.path.length, 7);
    eq(fail, "the hover line starts at the unit", own.from, { x: 79, y: 44 });
    eq(fail, "the hover line ends at the last step", own.to, { x: 86, y: 47 });
    // Enemy: the server's 3-step slice, passed through — no client slice anywhere in the way.
    const foe = hoverRoute({ id: "red:land", x: 163, y: 38 }, frame.routes);
    eq(fail, "an enemy hover carries the server's three steps", foe.path.length, 3);
    const holes = hoverRoute({ id: "blue:land", x: 79, y: 44 },
      { "blue:land": [{ x: 80, y: 44 }, null, { x: "nope", y: 2 }, { x: 82, y: 45 }] });
    eq(fail, "a malformed step is dropped, not drawn as NaN", holes.path, [{ x: 80, y: 44 }, { x: 82, y: 45 }]);
  }

  // --- 2b. tombstone, second arm: a destroyed own unit's line is gone after the next delta ----
  // PM 9671 §1. The first arm (a `[]` key draws nothing) is above; this is the same route after the
  // unit dies, through production code end to end: the delta comes from `deltaBetween` (the shadow
  // shape `setSeatShadow` writes), it is merged the way `applyDelta` merges it, and the painter and
  // `hoverRoute` are the shipped ones.
  {
    const before = room();
    const shadow = (frame) => ({
      round: frame.round,
      clock: frame.clock,
      note: frame.note,
      seat: JSON.stringify(undefined),
      capitals: JSON.stringify(undefined),
      capitalList: JSON.stringify(undefined),
      ownership: JSON.stringify(undefined),
      pieces: Object.fromEntries((frame.pieces || []).map((piece) => [piece.id, JSON.stringify(piece)])),
      routes: Object.fromEntries(Object.entries(frame.routes || {})
        .map(([id, steps]) => [id, JSON.stringify(steps)])),
      sites: Object.fromEntries((frame.sites || []).map((site) => [site.id, site.owner ?? null])),
    });
    // The next round: blue:land was destroyed, so it is in neither view.pieces nor view.routes.
    const after = {
      ...before,
      round: before.round + 1,
      pieces: before.pieces.filter((piece) => piece.id !== "blue:land"),
      routes: Object.fromEntries(Object.entries(before.routes).filter(([id]) => id !== "blue:land")),
    };
    const delta = deltaBetween(shadow(before), after);
    eq(fail, "the delta tombstones the destroyed unit's route", delta.routes["blue:land"], []);
    eq(fail, "the delta also reports the piece gone", delta.gone, ["blue:land"]);

    // The premise, so the assertion is not vacuous: the frame the page already held still draws it.
    ok(fail, "the pre-delta frame still draws the line",
      hoverRoute({ id: "blue:land", x: 79, y: 44 }, before.routes) !== null);

    // applyDelta's three lines for pieces, gone and routes (app.js, `function applyDelta`).
    const byId = new Map((before.pieces || []).map((piece) => [piece.id, piece]));
    for (const id of delta.gone || []) byId.delete(id);
    const merged = { ...before, pieces: [...byId.values()], routes: { ...before.routes, ...delta.routes } };
    eq(fail, "a destroyed own unit's line is gone after the next delta",
      hoverRoute({ id: "blue:land", x: 79, y: 44 }, merged.routes), null);
    eq(fail, "the dead unit's piece is off the board too",
      merged.pieces.some((piece) => piece.id === "blue:land"), false);
    const afterDelta = recorder();
    const paintedAfter = paintMatch(afterDelta.ctx, board(), merged, {
      view: fitViewport(320, 136), own: "blue", theme: themeById("C"), showPaths: true,
    });
    eq(fail, "the painter draws one line fewer after the delta", paintedAfter.pending, 1);
  }

  // --- 3. painting a hover path: a layer, and the enemy line is exactly from + 3 --------------
  {
    const view = fitViewport(320, 136);
    const frame = room();
    const foe = hoverRoute({ id: "red:land", x: 163, y: 38 }, frame.routes);
    const c = recorder();
    const painted = paintMatch(c.ctx, board(), frame, {
      view, own: "blue", theme: themeById("C"), showPaths: false, hoverPath: foe,
    });
    ok(fail, "a hover path is drawn", painted.hoverPath > 0);
    ok(fail, "a hover path adds its layer", painted.layers.includes("hoverPath"));
    const path = hoverRoute({ id: "red:land", x: 163, y: 38 }, frame.routes).path;
    eq(fail, "the enemy hover line is the unit plus its three steps", [foe.from, ...path].length, 4);
  }

  // --- 4. the wiring, pinned in the source (a page pin, not a prose claim) --------------------
  {
    const app = readFileSync(new URL("../../public/app.js", import.meta.url), "utf8");
    const render = readFileSync(new URL("../../public/render.mjs", import.meta.url), "utf8");
    ok(fail, "the page binds d to Show Paths", /event\.key === "d" \|\| event\.key === "D"\) return toggleShowPaths\(\)/.test(app));
    ok(fail, "the page keeps the toggle off on first load", /let showPaths = false;/.test(app));
    ok(fail, "the page passes the toggle to the painter", /\n\s+showPaths,\n/.test(app));
    ok(fail, "the page passes the hover path to the painter", /hoverPath: room \? hoverRoute\(hoverPiece, room\.routes\) : null/.test(app));
    // The merge §2b applies by hand: a delta's routes OVERWRITE by key, so the server's `[]`
    // replaces the dead unit's steps instead of merging beside them.
    ok(fail, "the page merges a delta's routes by overwrite", /const routes = \{ \.\.\.\(room\.routes \|\| \{\}\), \.\.\.\(delta\.routes \|\| \{\}\) \};/.test(app));
    ok(fail, "the strip has a Show Paths row", /id = "showPathsBtn"/.test(app));
    ok(fail, "the strip has a Satellite Mode row", /id = "satelliteModeBtn"/.test(app));
    ok(fail, "the Satellite row calls the existing view switch", /setViewMode\(viewMode === "satellites" \? "terrain" : "satellites"\)/.test(app));
    ok(fail, "the painter gates the own-unit lines on the toggle", /opts\.showPaths \? paintPendingOrders/.test(render));
    // The property the card preserves, asserted as an ABSENCE: no route is sliced in the client and
    // there is no 3-step constant on the page side.
    ok(fail, "no client-side cap on a route", !/routes\[[^\]]*\]\s*\.\s*slice/.test(app) && !/slice\(0,\s*3\)/.test(app) && !/slice\(0,\s*3\)/.test(render));
    ok(fail, "the page never calls the server's cap accessor", !/enemyRouteSteps\s*\(/.test(app) && !/enemyRouteSteps\s*\(/.test(render));
  }
}
