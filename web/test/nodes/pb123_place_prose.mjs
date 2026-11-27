// Node test: PB-123 - a player-facing line names a PLACE, never a map cell.
// Owner: feedback node.
//
// What fails if this is removed:
//   - somebody puts the cell fallback back at any of the three emitters (destroyed, overrun,
//     capture) -> the mutated site prints "180,31" again and the line below reds by name
//   - somebody "fixes" overrun by printing nothing (the old enemy branch) -> a bare
//     "an enemy unit was overrun" has no place, so the place assertion reds while the
//     no-digits assertion would have stayed green
//   - somebody makes the sight line drop its place -> PB-121's bar is re-run here
//
// The events come from the real tickMatch/advance path, not from hand-built literals: a synthetic
// event shape that no module emits would prove nothing about the emitter.

import { openMatch } from "../../server/match.mjs";
import { issueOrder } from "../../server/move.mjs";
import { tickMatch } from "../../server/tick.mjs";
import { logLines } from "../../server/log.mjs";
import { boardPayload } from "../../server/board.mjs";

export const name = "pb123_place_prose";

const COORDINATES = /\d+\s*,\s*\d+/;
// A place phrase is either "at <Name>" or "<n> cells <direction> of <Name>", and it must carry a
// capitalised name. "the front" and a bare sentence are not places.
const PLACE = / (at [A-Z][\w'.-]*|\d+ cells? [a-z-]+ of [A-Z][\w'.-]*)/;

function piece(id, side, kind, x, y, extra = {}) {
  return {
    id, side, domain: "land", kind, x, y, path: [], pace: 1, strength: 100, maxStrength: 100,
    facing: null, fighting: null, shots: 0, transport: false, entrenched: false, pinned: false,
    ...extra,
  };
}

function texts(lines) {
  return lines.map((line) => line.text);
}

function only(fail, lines, why) {
  if (lines.length !== 1) fail("pb123: " + why + " - expected one line, got " + JSON.stringify(texts(lines)));
  return lines[0].text;
}

function noCell(fail, text, why) {
  if (COORDINATES.test(text)) fail("pb123: " + why + " - the line prints a map cell: " + text);
}

function hasPlace(fail, text, why) {
  if (!PLACE.test(text)) fail("pb123: " + why + " - the line names no place: " + text);
}

// A board with two named landmarks either side of a working cell, so a place always exists.
function board() {
  const sites = boardPayload().sites || [];
  const host = sites.find((site) => site.kind === "city");
  return { cell: { x: Number(host.x), y: Number(host.y) }, sites };
}

function scene(siteList, pieces) {
  const match = openMatch("1942", []);
  match.clock = "running";
  match.sites = siteList;
  match.pieces = pieces;
  return match;
}

export async function run(ctx) {
  const { fail } = ctx;
  const { cell, sites } = board();

  // ---- 1. destroyed: no name, own side, wherever it happened ------------------------------
  {
    const sites2 = [
      { id: "near", name: "Kursk", kind: "city", x: cell.x, y: cell.y, owner: null },
      { id: "far", name: "Tobruk", kind: "city", x: cell.x + 8, y: cell.y + 5, owner: null },
    ];
    const match = scene(sites2, [piece("blue:scout", "blue", "infantry", cell.x, cell.y)]);
    const lines = logLines(match, "blue", [{ type: "destroyed", side: "blue", x: cell.x + 3, y: cell.y + 2, round: 4 }], 4);
    const text = only(fail, lines, "own loss with no name must produce one line");
    noCell(fail, text, "own loss with no name");
    hasPlace(fail, text, "own loss with no name");
  }

  // ---- 2. destroyed: a coordinate-shaped name is not a name --------------------------------
  {
    const match = scene([{ id: "dock1", name: "Dock " + (cell.x + 2) + "," + cell.y, kind: "dock", x: cell.x, y: cell.y, owner: null }],
      [piece("blue:scout", "blue", "infantry", cell.x, cell.y)]);
    const lines = logLines(match, "blue", [{
      type: "destroyed", side: "blue", x: cell.x + 2, y: cell.y, name: "Dock 999,888", round: 5,
    }], 5);
    const text = only(fail, lines, "own loss with a coordinate-shaped name must produce one line");
    noCell(fail, text, "own loss with a coordinate-shaped name");
    if (/999|888/.test(text)) fail("pb123: a coordinate-shaped name reached the sentence: " + text);
  }

  // ---- 3. destroyed: enemy losses follow the sight rule, and carry a place ------------------
  {
    const match = scene([{ id: "near", name: "Kursk", kind: "city", x: cell.x, y: cell.y, owner: null }],
      [piece("blue:scout", "blue", "infantry", cell.x, cell.y)]);
    const seen = logLines(match, "blue", [{ type: "destroyed", side: "red", x: cell.x + 1, y: cell.y, round: 6 }], 6);
    const text = only(fail, seen, "an enemy loss inside sight must be reported");
    noCell(fail, text, "enemy loss inside sight");
    hasPlace(fail, text, "enemy loss inside sight");
    const blind = logLines(match, "blue", [{ type: "destroyed", side: "red", x: cell.x + 80, y: cell.y + 60, round: 6 }], 6);
    if (blind.length !== 0) fail("pb123: an enemy loss out of sight reached the seat: " + JSON.stringify(texts(blind)));
  }

  // ---- 4. overrun: one line per cell per round, with the count and the place ---------------
  {
    const match = scene([{ id: "near", name: "Kursk", kind: "city", x: cell.x, y: cell.y, owner: null }],
      [piece("blue:scout", "blue", "infantry", cell.x, cell.y)]);
    const two = logLines(match, "blue", [
      { type: "overrun", side: "blue", x: cell.x + 3, y: cell.y, round: 7 },
      { type: "overrun", side: "blue", x: cell.x + 3, y: cell.y, round: 7 },
    ], 7);
    const text = only(fail, two, "two overruns on one cell in one round must be one line");
    // PB-216: this arm's `side` is the seat that WON the overrun, so the line is the winner's -
    // "a unit was lost" spoke in the loser's voice and is gone. The count and the place are what
    // this node is about and both are still pinned here.
    if (!/2 enemy units were overrun/.test(text)) fail("pb123: the overrun line does not carry the count: " + text);
    noCell(fail, text, "own overrun line");
    hasPlace(fail, text, "own overrun line");

    const one = logLines(match, "blue", [{ type: "overrun", side: "blue", x: cell.x + 3, y: cell.y, round: 7 }], 7);
    if (!/an enemy unit was overrun/.test(only(fail, one, "a single overrun must produce one line"))) {
      fail("pb123: a single overrun must read as one unit: " + JSON.stringify(texts(one)));
    }

    // The enemy branch used to print no place at all, so "no digits" passed on a useless line.
    const enemyText = only(fail, logLines(match, "blue", [{ type: "overrun", side: "red", x: cell.x + 2, y: cell.y, round: 8 }], 8),
      "an enemy overrun inside sight must be reported");
    noCell(fail, enemyText, "enemy overrun line");
    hasPlace(fail, enemyText, "enemy overrun line");
    const enemyTwo = only(fail, logLines(match, "blue", [
      { type: "overrun", side: "red", x: cell.x + 2, y: cell.y, round: 9 },
      { type: "overrun", side: "red", x: cell.x + 2, y: cell.y, round: 9 },
    ], 9), "two enemy overruns on one cell in one round must be one line");
    if (!/2 enemy units were overrun/.test(enemyTwo)) fail("pb123: the enemy overrun count is wrong: " + enemyTwo);

    // Two seats losing a unit on the same cell are two groups: the other seat's events never
    // inflate this seat's count.
    const bothSides = logLines(match, "red", [
      { type: "overrun", side: "blue", x: cell.x + 3, y: cell.y, round: 10 },
      { type: "overrun", side: "red", x: cell.x + 3, y: cell.y, round: 10 },
    ], 10);
    // PB-216: the line now speaks for the seat that won the overrun, so red's own event reads as
    // what red ran over. The pin here is still "one line, not two".
    if (bothSides.length !== 1 || !/an enemy unit was overrun/.test(bothSides[0].text)) {
      fail("pb123: the other seat's overrun inflated this seat's line: " + JSON.stringify(texts(bothSides)));
    }
  }

  // ---- 5. capture: a dock named after its cell is not a place -------------------------------
  {
    const docksite = { id: "dock2", name: "Dock " + (cell.x + 6) + "," + (cell.y + 1), kind: "dock", x: cell.x + 6, y: cell.y + 1, owner: "red" };
    const match = scene([docksite, { id: "name", name: "Kursk", kind: "city", x: cell.x, y: cell.y, owner: null }],
      [piece("blue:scout", "blue", "infantry", cell.x, cell.y)]);
    const taken = only(fail, logLines(match, "blue", [{ type: "capture", site: "dock2", name: docksite.name, kind: "dock", side: "blue", from: "red" }], 11),
      "a capture you made must be reported");
    noCell(fail, taken, "own capture of a coordinate-named dock");
    hasPlace(fail, taken, "own capture of a coordinate-named dock");
    const seen = only(fail, logLines(match, "blue", [{ type: "capture", site: "dock2", name: docksite.name, kind: "dock", side: "red", from: null }], 12),
      "a capture inside sight must be reported");
    noCell(fail, seen, "enemy capture inside sight");
    hasPlace(fail, seen, "enemy capture inside sight");
  }

  // ---- 6. a board with no usable landmark falls back to the bare D-028 sentence, graded
  //         SEPARATELY for destroyed and for overrun (6835) -----------------------------------
  {
    const bare = scene([{ id: "anon", name: "Dock " + (cell.x + 1) + "," + cell.y, kind: "dock", x: cell.x, y: cell.y, owner: null }],
      [piece("blue:scout", "blue", "infantry", cell.x, cell.y)]);
    const lines = logLines(bare, "blue", [
      { type: "destroyed", side: "blue", x: cell.x + 3, y: cell.y, round: 13 },
      { type: "overrun", side: "blue", x: cell.x + 3, y: cell.y, round: 13 },
      { type: "overrun", side: "red", x: cell.x + 1, y: cell.y, round: 13 },
      { type: "capture", site: "anon", name: "Dock 1,2", kind: "dock", side: "blue", from: "red" },
    ], 13);
    if (lines.length !== 4) fail("pb123: the no-landmark board lost a line: " + JSON.stringify(texts(lines)));
    const bareTexts = texts(lines);
    for (const text of bareTexts) {
      if (/\d+\s*,\s*\d+/.test(text)) fail("pb123: the no-landmark fallback prints a map cell: " + text);
      if (/\d+ cells? /.test(text)) fail("pb123: the no-landmark fallback invents a distance: " + text);
    }
    // Destroyed and overrun fall back DIFFERENTLY and are graded on their own full sentence, not
    // on the shared no-digits bar. The old overrun literal (" at the front") carries no digits, so
    // a digits-only bar passes an invented place; the bare rendering is the whole sentence, place
    // clause included, and each branch is asserted separately (6835, frodo 6969 item 3).
    const destroyedBare = bareTexts.find((text) => /^lost /.test(text));
    if (destroyedBare !== "lost a unit") {
      fail("pb123: destroyed's no-landmark fallback is not the bare D-028 sentence: " + JSON.stringify(destroyedBare));
    }
    // PB-216: both overrun events here are read by the seat that did NOT lose the unit (blue won
    // the first, the second names no targetSide), so both lines are the winner's bare sentence.
    const overrunBare = bareTexts.find((text) => /overrun/.test(text) && text === "an enemy unit was overrun");
    if (!overrunBare) {
      fail("pb123: overrun's no-landmark fallback invented a place clause: " + JSON.stringify(bareTexts));
    }
    // The shape the PM asked for: ONE predicate, importable, used by every emitter. A base tree
    // without it fails here by name instead of crashing on the import, so the leg reds on the
    // defect rather than on a module error.
    const { placeOf } = await import("../../server/log.mjs");
    if (typeof placeOf !== "function") {
      fail("pb123: log.mjs exports no placeOf - the shared place predicate is missing");
    } else if (placeOf(bare, { x: cell.x, y: cell.y }, "blue") !== null) {
      fail("pb123: placeOf invented a place on a board with no usable landmark");
    }
  }

  // ---- 7. fog: a loss off the seat's lit area produces nothing ------------------------------
  {
    const match = scene([{ id: "near", name: "Kursk", kind: "city", x: cell.x, y: cell.y, owner: null }],
      [piece("blue:scout", "blue", "infantry", cell.x, cell.y)]);
    const far = { x: cell.x + 90, y: cell.y + 40 };
    const dark = logLines(match, "blue", [
      { type: "destroyed", side: "red", x: far.x, y: far.y, round: 14 },
      { type: "overrun", side: "red", x: far.x, y: far.y, round: 14 },
      { type: "capture", site: "gone", name: "Nowhere", kind: "city", side: "red", from: null, x: far.x, y: far.y },
    ], 14);
    if (dark.length !== 0) fail("pb123: a loss in the dark reached the seat: " + JSON.stringify(texts(dark)));
  }

  // ---- 8. the real path: destroyed and overrun out of advance/tickMatch --------------------
  {
    const match = scene(sites.slice(0, 0).concat([
      { id: "k1", name: "Kursk", kind: "city", x: cell.x, y: cell.y, owner: null },
    ]), []);
    match.sites = [{ id: "k1", name: "Kursk", kind: "city", x: cell.x, y: cell.y, owner: null }];
    match.pieces = [
      piece("blue:atk", "blue", "tank", cell.x + 1, cell.y),
      piece("red:def", "red", "infantry", cell.x + 2, cell.y, { strength: 40 }),
      piece("blue:scout", "blue", "infantry", cell.x, cell.y),
    ];
    issueOrder(match, "blue", "blue:atk", cell.x + 2, cell.y);
    const seen = { destroyed: 0, overrun: 0 };
    for (let round = 0; round < 8 && (seen.destroyed === 0 || seen.overrun === 0); round += 1) {
      const { events } = tickMatch(match);
      if (!Array.isArray(events)) break;
      for (const event of events) {
        if (event.type === "destroyed") seen.destroyed += 1;
        if (event.type === "overrun") seen.overrun += 1;
      }
      for (const side of ["blue", "red"]) {
        for (const line of logLines(match, side, events, match.round)) {
          if (COORDINATES.test(line.text)) {
            fail("pb123: the real path printed a map cell (" + side + ", round " + match.round + "): " + line.text);
          }
        }
      }
      if (seen.overrun > 0) {
        const blue = texts(logLines(match, "blue", events, match.round));
        // PB-216: the line speaks for the seat that won the overrun and names what it ran over;
        // the "overrun:" prefix is gone.
        const overrunLines = blue.filter((text) => /was overrun/.test(text));
        if (overrunLines.length !== 1) {
          fail("pb123: the real path produced " + seen.overrun + " overrun events and " + overrunLines.length + " lines");
        }
        hasPlace(fail, overrunLines[0], "the real path's overrun line");
      }
    }
    if (seen.destroyed === 0) fail("pb123: the real path produced no destroyed event, so nothing was tested");
    if (seen.overrun === 0) fail("pb123: the real path produced no overrun event, so nothing was tested");
  }

  // ---- 9. the real path: a city capture names its place. A dock capture is no longer produced by
  // the engine (PB-320: docks follow their city and are never taken), but an older film's event
  // still has to render without a cell - the prose arm below feeds one directly. ----------------
  {
    const match = scene([
      { id: "dock3", name: "Dock " + cell.x + "," + cell.y, kind: "dock", x: cell.x, y: cell.y, owner: "red" },
      { id: "k2", name: "Smolensk", kind: "city", x: cell.x + 4, y: cell.y + 2, owner: null },
    ], [piece("blue:atk", "blue", "tank", cell.x + 4, cell.y + 2), piece("blue:scout", "blue", "infantry", cell.x + 1, cell.y)]);
    const { events } = tickMatch(match);
    const captures = (events || []).filter((event) => event.type === "capture");
    if (captures.length !== 1) fail("pb123: the occupy pass produced " + captures.length + " capture events, expected 1");
    const line = only(fail, logLines(match, "blue", events, match.round).filter((entry) => /took|changed hands|was lost/.test(entry.text)),
      "the real capture must be reported once");
    noCell(fail, line, "the real capture line");
    if (!/Smolensk/.test(line)) fail("pb123: the real capture line does not name the city it took: " + line);

    const dockEvent = { type: "capture", site: "dock3", name: "Dock " + cell.x + "," + cell.y, kind: "dock", side: "blue", from: "red" };
    const dockLine = only(fail, logLines(match, "blue", [dockEvent], 9), "a dock event from an older film must still render once");
    noCell(fail, dockLine, "the older film's dock line");
    hasPlace(fail, dockLine, "the older film's dock line");
  }

  // ---- 10. PB-121's bar re-run: every sighting line still names a place --------------------
  {
    const match = scene([{ id: "k3", name: "Kursk", kind: "city", x: cell.x, y: cell.y, owner: null }], []);
    match.pieces = [
      piece("blue:scout", "blue", "infantry", cell.x, cell.y),
      piece("red:a", "red", "infantry", cell.x + 1, cell.y),
      piece("red:b", "red", "infantry", cell.x + 2, cell.y + 1),
      piece("blue:far", "blue", "infantry", cell.x + 5, cell.y + 5),
    ];
    let sights = 0;
    for (let round = 0; round < 3; round += 1) {
      const { events } = tickMatch(match);
      for (const line of logLines(match, "blue", events || [], match.round)) {
        if (!/in sight/.test(line.text)) continue;
        sights += 1;
        noCell(fail, line.text, "a sighting line");
        hasPlace(fail, line.text, "a sighting line");
      }
    }
    if (sights === 0) fail("pb123: no sighting line was produced, so PB-121's bar was not re-run");
  }
}
