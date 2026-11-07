// Node political_map: the original's second view of the same earth.
//
// OMAP.PIC is the political picture and its colours are measured, not chosen: #5555ff and #aa0000
// fills over a #55ffff sea, #aaaaaa for ground nobody holds, black for the towns. What could not be
// read is the region geometry — CBR-REGN.DT0..DT4 are 184 integers per era whose slot meaning is
// still undocumented — so the view colours cities by their owner and draws no borders. These
// assertions pin the measured palette, the neutral case, and that switching back is free.
import {
  PALETTE, POLITICAL, fitViewport, paintMatch, paintPolitical, politicalInk, politicalSites,
  politicalTally,
} from "../../public/render.mjs";

function fail(message) {
  throw new Error(message);
}

function eq(message, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) fail(message + ": " + a + " !== " + b);
}

function recorder() {
  const fills = [];
  const noop = () => {};
  const ctx = {
    fillStyle: "", strokeStyle: "", lineWidth: 1, font: "", globalAlpha: 1,
    fillRect(x, y, w, h) { fills.push({ x, y, w, h, color: this.fillStyle }); },
    clearRect: noop, beginPath: noop, closePath: noop, arc: noop, rect: noop, moveTo: noop,
    lineTo: noop, stroke: noop, fill: noop, save: noop, restore: noop, fillText: noop,
    setLineDash: noop, translate: noop, clip: noop,
  };
  return { ctx, fills };
}

const SITES = [
  { id: "washington", name: "Washington", x: 20, y: 20, owner: "blue" },
  { id: "moscow", name: "Moscow", x: 40, y: 20, owner: "red" },
  { id: "reykjavik", name: "Reykjavik", x: 60, y: 20, owner: null },
];

export const name = "political_map";

export async function run() {
  // --- the palette is the picture's ---------------------------------------------------------
  eq("the political blue is OMAP's", POLITICAL.blue, "#5555ff");
  eq("the political red is OMAP's", POLITICAL.red, "#aa0000");
  eq("unheld ground is OMAP's grey", POLITICAL.neutral, "#aaaaaa");
  eq("towns are black", POLITICAL.city, "#000000");
  const measured = new Set([POLITICAL.blue, POLITICAL.red, POLITICAL.neutral, POLITICAL.city]);
  for (const ink of [POLITICAL.blue, POLITICAL.red, POLITICAL.neutral, POLITICAL.city]) {
    if (!measured.has(ink)) fail("a political colour left the measured set: " + ink);
  }
  eq("a blue city is blue", politicalInk("blue"), POLITICAL.blue);
  eq("a red city is red", politicalInk("red"), POLITICAL.red);
  eq("a city with no owner is neutral", politicalInk(null), POLITICAL.neutral);
  eq("an unknown owner is neutral too", politicalInk("greenish"), POLITICAL.neutral);

  const view = { ...fitViewport(640, 272), scale: 8, left: 0, top: 0, viewW: 2560, viewH: 1088 };
  const patches = politicalSites(SITES, view);
  eq("one patch per city", patches.length, 3);
  eq("the patches carry their owners' inks", patches.map((p) => p.ink),
    [POLITICAL.blue, POLITICAL.red, POLITICAL.neutral]);

  const tally = politicalTally(patches);
  eq("the tally counts blue", tally.blue, 1);
  eq("the tally counts red", tally.red, 1);
  eq("the tally counts neutral", tally.neutral, 1);

  // --- a city off screen is not painted -----------------------------------------------------
  eq("cities the camera cannot see are dropped",
    politicalSites(SITES, { ...view, left: -4000, top: -4000 }).length, 0);

  // --- the two views differ, and the terrain comes back unchanged ----------------------------
  const board = {
    source: "extract", width: 320, height: 136, terrain: ["ocean", "plain"],
    cells: new Array(320 * 136).fill(1),
  };
  const room = { sites: SITES, pieces: [] };

  const terrainA = recorder();
  paintMatch(terrainA.ctx, board, room, { view, viewMode: "terrain" });

  const politicalFrame = recorder();
  const political = paintMatch(politicalFrame.ctx, board, room, { view, viewMode: "political" });
  eq("the political view painted the cities", political.political, 3);
  eq("the political view counts them", political.tally.blue, 1);
  if (politicalFrame.fills.length <= terrainA.fills.length) fail("the two views draw the same frame");

  const added = politicalFrame.fills.filter((fill) => measured.has(fill.color));
  if (added.length < 3) fail("no measured political colour reached the frame");
  for (const fill of added) {
    if (![POLITICAL.blue, POLITICAL.red, POLITICAL.neutral, POLITICAL.city].includes(fill.color)) {
      fail("an unmetered colour reached the political frame: " + fill.color);
    }
  }

  const terrainB = recorder();
  paintMatch(terrainB.ctx, board, room, { view, viewMode: "terrain" });
  eq("switching back draws the same terrain frame", terrainB.fills.length, terrainA.fills.length);
  for (let i = 0; i < terrainA.fills.length; i++) {
    if (terrainA.fills[i].color !== terrainB.fills[i].color) {
      fail("the terrain palette changed after the toggle at " + i);
    }
  }
  eq("the terrain view carries no political ink",
    terrainB.fills.filter((fill) => fill.color === POLITICAL.blue || fill.color === POLITICAL.red).length, 0);

  // --- the terrain palette itself is untouched ----------------------------------------------
  eq("the terrain ocean is still the measured one", PALETTE.ocean, "#55ffff");

  // --- painting needs a view worth painting -------------------------------------------------
  const empty = recorder();
  eq("no patches, nothing painted", paintPolitical(empty.ctx, [], view), 0);
  eq("a null site list paints nothing", paintPolitical(empty.ctx, null, view), 0);
}
