// Node pb126_capital_ink: only the era's own capitals may be painted in capital ink (PB-126).
//
// The terrain grid is one map for every year. buildGrid paints a capital-kind site's cell as
// capital ink once, from world.json, so at origin/web a fresh 1918 board drew two unlabelled yellow
// squares - Washington (79,44) and Moscow (183,25) - in an era whose capitals are London, Berlin and
// Paris, with no ring and no name to explain them (the report).
//
// The era table is the authority on whether a site is a capital this year, and capitalMarkers
// already reads it. eraGround downgrades every capital-ink cell that no marker stands on to the
// plain city the era calls it; 1942/1986/2023 must keep their real capitals' ink, which is the
// positive control that stops the fix from just blanking the colour.
//
// Measured through paintMatch - the page's own path - so the pin is on painted pixels, not on a
// helper's return value. Theme C is used because Classic (D) paints desert and capital the same
// #ffff55, which makes a colour count meaningless; C's capital ink is unique to capital cells
// (its coastal edge is a different colour, so a land cell still shows its terrain fill).
import { bundledBoard, matchSites } from "../../server/board.mjs";
import { capitalMarkers, eraGround, paintMatch } from "../../public/render.mjs";
import { terrainInk, themeById } from "../../public/themes.mjs";

export const name = "pb126_capital_ink";

function recorder() {
  const fills = [];
  const texts = [];
  const noop = () => {};
  const ctx = {
    fillStyle: "", strokeStyle: "", lineWidth: 1, font: "", globalAlpha: 1,
    fillRect(x, y, w, h) { fills.push({ x, y, w, h, color: String(this.fillStyle).toLowerCase() }); },
    clearRect: noop, beginPath: noop, closePath: noop, arc: noop, rect: noop, moveTo: noop,
    lineTo: noop, stroke: noop, fill: noop, save: noop, restore: noop,
    fillText(text) { texts.push(String(text)); },
    setLineDash: noop, translate: noop, clip: noop,
  };
  return { ctx, fills, texts };
}

export async function run(ctx) {
  const { fail } = ctx;
  const board = bundledBoard();
  if (!board) fail("world.json is missing, so there is no board to paint");
  // Theme C, not D: Classic paints desert and capital the same #ffff55, so a colour count cannot
  // tell a stray capital from the Sahara. C's capital #ffd166 is used by no other terrain.
  const theme = themeById("C");
  const cityInk = String(terrainInk(theme, "city")).toLowerCase();
  const capitalInk = String(terrainInk(theme, "capital")).toLowerCase();
  if (cityInk === capitalInk) fail("theme C paints city and capital the same ink: " + cityInk);
  const collision = (theme.terrain ? Object.entries(theme.terrain) : [])
    .filter(([name, ink]) => name !== "capital" && String(ink).toLowerCase() === capitalInk);
  if (collision.length) fail("theme C paints " + collision.map(([n]) => n).join(",") + " in capital ink");
  const w = board.width;
  const view = { left: 0, top: 0, scale: 1, viewW: board.width, viewH: board.height,
    boardW: board.width, boardH: board.height };
  const seats = { blue: { ...board.capitals.blue }, red: { ...board.capitals.red } };
  const roomFor = (era) => ({ era, round: 0, clock: "held", you: "blue",
    sites: matchSites(era), capitals: seats, pieces: [] });
  // Every fill at one cell, in paint order: terrain first, then any edge/overlay.
  const inksAt = (fills, x, y) => fills
    .filter((f) => f.x === x && f.y === y && f.w === 1 && f.h === 1)
    .map((f) => f.color);
  const countInk = (fills, ink) => fills.filter((f) => f.color === ink).length;
  const cellIndex = (x, y) => y * w + ((x % w) + w) % w;

  // --- 1918: the reported frame -------------------------------------------------
  const room1918 = roomFor("1918");
  const markers = capitalMarkers(board, room1918);
  const names = markers.map((m) => m.name).sort().join(",");
  if (names !== "Berlin,London,Paris") fail("1918 capital set is " + names);

  const ground = eraGround(board, room1918);
  if (ground.eraCorrected !== 2) fail("1918 eraGround corrected " + ground.eraCorrected + " cells, wanted 2");
  for (const [label, x, y] of [["Washington", 79, 44], ["Moscow", 183, 25]]) {
    const name = board.terrain[ground.cells[cellIndex(x, y)]];
    if (name !== "city") fail("1918 " + label + " cell is still " + name + ", wanted city");
  }

  const frame1918 = recorder();
  const painted1918 = paintMatch(frame1918.ctx, board, room1918, { view, own: "blue", theme });
  if (painted1918.mode !== "cells") fail("1918 frame painted " + painted1918.mode);
  for (const [label, x, y] of [["Washington", 79, 44], ["Moscow", 183, 25]]) {
    const inks = inksAt(frame1918.fills, x, y);
    if (!inks.includes(cityInk)) fail("1918 " + label + " (" + x + "," + y + ") is not city ink: " + JSON.stringify(inks));
    if (inks.includes(capitalInk)) fail("1918 " + label + " (" + x + "," + y + ") is still capital ink: " + JSON.stringify(inks));
  }
  const strayCapital = countInk(frame1918.fills, capitalInk);
  if (strayCapital !== 0) fail("1918 frame paints " + strayCapital + " capital-ink cells, wanted 0");
  // PB-120 does not regress: the three era capitals still ring and label, the fixed seats do not.
  if (painted1918.capitals !== 3) fail("1918 frame marks " + painted1918.capitals + " capitals, wanted 3");
  if (!frame1918.texts.includes("London")) fail("1918 frame never labels London");
  if (frame1918.texts.includes("Washington") || frame1918.texts.includes("Moscow")) {
    fail("1918 frame labels a fixed seat: " + JSON.stringify(frame1918.texts));
  }

  // --- the other eras keep their own capitals' ink (positive control) -------------
  for (const era of ["1942", "1986"]) {
    const room = roomFor(era);
    const g = eraGround(board, room);
    if (g.eraCorrected) fail(era + " eraGround corrected " + g.eraCorrected + " cells, wanted 0");
    const frame = recorder();
    const result = paintMatch(frame.ctx, board, room, { view, own: "blue", theme });
    // 1942 and 1986 both put Washington and Moscow on capital cells; London/Berlin/Paris/Tokyo are
    // type-1/2 capitals on city-kind cells, so their ground stays the original black city.
    const got = countInk(frame.fills, capitalInk);
    if (got !== 2) fail(era + " frame paints " + got + " capital-ink cells, wanted 2");
    if (result.capitals !== capitalMarkers(board, room).length) {
      fail(era + " frame marks " + result.capitals + " capitals");
    }
    const wash = inksAt(frame.fills, 79, 44);
    if (!wash.includes(capitalInk)) fail(era + " Washington lost its capital ink: " + JSON.stringify(wash));
  }

  // 2023 is rolled: no type-1/2 rows, so the marker set and the ink both come from the seats map.
  const room2023 = roomFor("2023");
  if (capitalMarkers(board, room2023).length !== 2) fail("2023 capital markers are not the two seats");
  const g2023 = eraGround(board, room2023);
  if (g2023.eraCorrected) fail("2023 eraGround corrected " + g2023.eraCorrected + " cells, wanted 0");
  const frame2023 = recorder();
  paintMatch(frame2023.ctx, board, room2023, { view, own: "blue", theme });
  for (const [label, x, y] of [["Washington", 79, 44], ["Moscow", 183, 25]]) {
    const inks = inksAt(frame2023.fills, x, y);
    if (!inks.includes(capitalInk)) fail("2023 " + label + " lost its capital ink: " + JSON.stringify(inks));
  }
}
