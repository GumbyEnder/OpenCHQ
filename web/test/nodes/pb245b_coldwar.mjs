// Node test: PB-245b — the cold war (manual printed p.31-32).
//
// The page, verbatim (/mnt/nas/host-ops/openchq/pb245/manual-p31-p32.txt):
//   "At the start of the 1986 and 2023 scenarios, and at any time during those scenarios that both
//   players agree, peacetime conditions prevail. At the start of the game, this is called the cold
//   war."
//   "Duration: Peace lasts for a pre-set amount of time, depending upon the scenario. A counter in
//   Monitor One tells you how much time remains in mandatory peace; after that, either player can
//   start the war by pressing Begin Hostilities/Cease Fire."
//   "Units may be produced normally, but need not be placed in cities; units may not be produced in
//   or transferred to neutral or enemy territory."
//   "Starting Destinations: A unit can be given a destination to which it will start to move the
//   moment war begins. To give a unit a destination, select it twice, then select its destination.
//   Destinations do not have to be within friendly territory. Air missions cannot be predetermined."
//   p.32 War Status: "allows you to begin hostilities, but only after the mandatory time has elapsed."
//
// Arms, one per acceptance criterion. Every arm is written so that CUTTING the rule reds it:
//   AC1  the scenario opens at peace (1986 and 2023), both seats read it at round 0, and the counter
//        is the config's own number - {} means no forced wait, a set number means exactly that wait
//   AC2  Begin Hostilities is refused while the counter runs and allowed after it, both seats leave
//        the peace, and the OTHER seat reads one line naming the side that broke it
//   AC3  at peace a bought land unit stands on any friendly ground, off a city; neutral and enemy
//        ground are refused with p.31's sentence (and the same off-city cell is refused at war)
//   AC4  a starting destination is stored, queues nothing, may sit outside friendly territory, is
//        refused for aircraft, and launches for BOTH seats the moment the war begins
//   AC5  1918 and 1942 still open at war (p.31 names only 1986 and 2023)

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { openMatch } from "../../server/match.mjs";
import { matchSites, boardPayload } from "../../server/board.mjs";
import { forSeat } from "../../server/view.mjs";
import { logLines } from "../../server/log.mjs";
import {
  COLD_WAR_ERAS,
  mandatoryRoundsForEra,
  openingPeace,
  peaceOf,
  resumeWar,
} from "../../server/peace.mjs";
import {
  DESTINATION_AIR,
  DESTINATION_AT_WAR,
  launchStartingDestinations,
  setStartingDestination,
} from "../../server/move.mjs";
import { PEACE_PRODUCTION_REFUSED, canPlace, placementMask } from "../../server/placement.mjs";
import { buy } from "../../server/economy.mjs";
import { cellsHeldBy, ownerAt } from "../../server/territory.mjs";
import { resetRules } from "../../server/rules.mjs";
import { tickMatch } from "../../server/tick.mjs";

export const name = "pb245b_coldwar";

function fail(message) {
  throw new Error(message);
}

function eq(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(label + ": expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
  }
}

function ok(value, label) {
  if (!value) fail(label);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const shippedPath = path.resolve(here, "..", "..", "..", "config", "game.json");

// The two unprinted numbers, set explicitly for the arms that need them (p.31 prints neither).
const MANDATORY = { "1986": 3, "2023": 2 };

function withPeaceConfig(fn, mandatory = MANDATORY) {
  const shipped = JSON.parse(readFileSync(shippedPath, "utf8"));
  const dir = mkdtempSync(path.join(tmpdir(), "openchq-pb245b-"));
  const file = path.join(dir, "game.json");
  // T-035: the money tick replaced the retired multiplier; these files set it explicitly.
  shipped.peace = { ...(shipped.peace || {}), mandatoryRounds: { ...mandatory }, cashPerTick: 250, ticksPerSecond: 2 };
  writeFileSync(file, JSON.stringify(shipped, null, 2));
  const before = process.env.OPENCHQ_CONFIG;
  process.env.OPENCHQ_CONFIG = file;
  resetRules();
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.OPENCHQ_CONFIG; else process.env.OPENCHQ_CONFIG = before;
    resetRules();
  }
}

function fresh(era = "1986") {
  const match = openMatch(era, matchSites(era));
  match.clock = "running";
  return match;
}

function landOnly(board) {
  return (x, y) => Number(board.cells[y * board.width + x]) > 2;
}

function heldGroundCell(match, side, board) {
  const land = landOnly(board);
  const sites = new Set((match.sites || []).map((site) => Number(site.x) + "," + Number(site.y)));
  for (const [x, y] of cellsHeldBy(match, side)) {
    if (!land(x, y)) continue;
    if (sites.has(x + "," + y)) continue;
    return { x, y };
  }
  return null;
}

// The NEAREST cell matching a predicate. Distance is Chebyshev with the board's X wrap, the same
// measure the walker's own reach uses, so a fixture never picks a cell whose line crosses a
// wasteland the preview would refuse (a destination that cannot be planned is refused at set time
// by design, so the arm has to aim somewhere the unit could actually walk).
function nearestCell(board, pred, from = null) {
  let best = null;
  let bestGap = Infinity;
  for (let y = 0; y < board.height; y++) {
    for (let x = 0; x < board.width; x++) {
      const hit = pred(x, y);
      if (!hit) continue;
      const gap = from
        ? Math.max(Math.min(Math.abs(x - Number(from.x)), board.width - Math.abs(x - Number(from.x))), Math.abs(y - Number(from.y)))
        : y * board.width + x;
      if (gap < bestGap) {
        bestGap = gap;
        best = { x, y, ...(hit === true ? {} : hit) };
      }
    }
  }
  return best;
}

function hostileGroundCell(match, side, board, from = null) {
  const land = landOnly(board);
  return nearestCell(board, (x, y) => {
    if (!land(x, y)) return false;
    const owner = ownerAt(match, x, y);
    return owner && owner !== side ? { owner } : false;
  }, from);
}

function neutralGroundCell(match, board, from = null) {
  const land = landOnly(board);
  return nearestCell(board, (x, y) => land(x, y) && !ownerAt(match, x, y), from);
}

// The nearest cell of a side's own ground that is not a site cell.
function heldGroundCellNear(match, side, board, from) {
  const land = landOnly(board);
  const sites = new Set((match.sites || []).map((site) => Number(site.x) + "," + Number(site.y)));
  return nearestCell(board, (x, y) => land(x, y) && !sites.has(x + "," + y) && ownerAt(match, x, y) === side, from);
}

export async function run() {
  // ---- the shipped file still invents no length -------------------------------------------
  {
    const shipped = JSON.parse(readFileSync(shippedPath, "utf8"));
    eq(shipped.peace && shipped.peace.mandatoryRounds, {}, "the shipped config prints no mandatory length (p.31 prints none)");
    eq([...COLD_WAR_ERAS], ["1986", "2023"], "p.31 names exactly 1986 and 2023 for the cold war");
  }

  // ---- AC1: 1986 and 2023 open at peace; both seats read it; the counter is the config ------
  {
    // AC5 sits in the same loop on purpose: the two older scenarios must be the ONLY absence.
    for (const era of ["1918", "1942", "1986", "2023"]) {
      const match = fresh(era);
      const blue = forSeat(match, "blue");
      const red = forSeat(match, "red");
      const cold = era === "1986" || era === "2023";
      eq(Boolean(match.peace && match.peace.active), cold, era + ": the opening peace state follows p.31's list");
      eq(Boolean(blue.peace && blue.peace.active), cold, era + ": blue reads the opening peace");
      eq(Boolean(red.peace && red.peace.active), cold, era + ": red reads the opening peace");
      eq([blue.over, red.over], [false, false], era + ": the cold war is not an ending");
      eq(match.round, 0, era + ": the deal is round 0");
      if (!cold) continue;
      // The shipped config prints no length: no forced wait, and the counter says zero.
      eq(blue.peace.remaining, 0, era + ": with config {} there is no mandatory wait");
      eq(blue.peace.canResume, true, era + ": with config {} Begin Hostilities is legal at round 0");
      eq(blue.peace.coldWar, true, era + ": the page can label it the cold war");
      eq(blue.peace.by, null, era + ": nobody proposed this peace - the scenario started it");
    }
    // The same scenarios under a config that DOES set a length: the number is the config's.
    for (const era of ["1986", "2023"]) {
      withPeaceConfig(() => {
        const match = fresh(era);
        eq(mandatoryRoundsForEra(era), MANDATORY[era], era + ": the mandatory length is read from config");
        const seat = forSeat(match, "blue");
        eq(seat.peace.remaining, MANDATORY[era], era + ": the counter shows the config's rounds at round 0");
        eq(seat.peace.canResume, false, era + ": the counter holds Begin Hostilities while it runs");
      });
    }
    // A scenario the config names but p.31 does not: the length does not open a cold war.
    withPeaceConfig(() => {
      eq(openingPeace("1942"), null, "a config length cannot open a scenario p.31 never named");
    });
  }

  withPeaceConfig(() => {
    // ---- AC2: the counter gate, both seats, and the one line to the other seat --------------
    {
      const match = fresh("1986");
      const early = resumeWar(match, "blue", 0);
      ok(early.error, "Begin Hostilities at round 0 is refused while the counter runs");
      eq(early.remaining, MANDATORY["1986"], "the refusal names the rounds left");
      eq(peaceOf(match).active, true, "a refused Begin Hostilities changes nothing");

      const late = resumeWar(match, "red", MANDATORY["1986"]);
      ok(late && late.ok, "Begin Hostilities is legal the round the counter reaches zero: " + JSON.stringify(late && late.error));
      eq(peaceOf(match).active, false, "the war is on again");
      eq(peaceOf(match).brokenBy, "red", "the state names the side that began hostilities");
      const event = late.events[0];
      eq(event.type, "peace_broken", "the event is the broken peace");
      const mine = logLines(match, "red", late.events, match.round);
      const theirs = logLines(match, "blue", late.events, match.round);
      ok(mine.length > 0 && theirs.length > 0, "both seats read a line");
      eq(mine[0].text, "you began hostilities; the war is on again", "the acting seat reads its own act");
      ok(/Red has broken the peace/.test(theirs[0].text),
        "the other seat's line names the breaker: " + theirs[0].text);
      eq(forSeat(match, "blue").peace.active, false, "the other seat reads the war too");
      ok(resumeWar(match, "blue", 9).error, "a war that is not at peace cannot be resumed again");
    }

    // ---- AC3: a peacetime purchase stands on any friendly ground ---------------------------
    {
      const board = boardPayload();
      const match = fresh("1986");
      const off = heldGroundCell(match, "blue", board);
      ok(off, "the fixture finds friendly ground off a city");
      // The war arm: the same cell is NOT a placement cell while the war is on.
      const war = fresh("1942");
      const warOff = heldGroundCell(war, "blue", board);
      ok(warOff, "the wartime fixture finds friendly ground off a city");
      ok(canPlace(war, "blue", "infantry", warOff.x, warOff.y, board).error,
        "at war the same off-city ground is refused (the peace rule is the thing being cut)");

      const mask = placementMask(match, "blue", "infantry", board);
      ok(mask.ok, "the peacetime mask builds");
      eq(mask.mask[off.y * mask.width + off.x], 1, "friendly ground is offered ready at peace");
      const placed = canPlace(match, "blue", "infantry", off.x, off.y, board);
      eq(placed.error, undefined, "friendly ground passes the placement rule at peace: " + placed.error);
      eq(placed.site, null, "the cell is not a site - the unit is placed off a city");
      const purchase = buy(match, "blue", "infantry", off.x, off.y, board);
      eq(purchase.error, undefined, "the purchase lands on friendly ground: " + purchase.error);
      eq([purchase.piece.x, purchase.piece.y], [off.x, off.y], "the piece stands where it was bought");

      const hostile = hostileGroundCell(match, "blue", board);
      ok(hostile, "the fixture finds enemy ground");
      const enemy = canPlace(match, "blue", "infantry", hostile.x, hostile.y, board);
      ok(enemy.error && enemy.error.includes(PEACE_PRODUCTION_REFUSED),
        "enemy ground is refused with p.31's sentence: " + enemy.error);
      const neutral = neutralGroundCell(match, board, match.pieces.find((piece) => piece.side === "blue"));
      ok(neutral, "the fixture finds neutral ground");
      const neu = canPlace(match, "blue", "infantry", neutral.x, neutral.y, board);
      ok(neu.error && neu.error.includes(PEACE_PRODUCTION_REFUSED),
        "neutral ground is refused with p.31's sentence: " + neu.error);
      // p.31 relaxes the CITY rule, not the water rule: a land unit still cannot stand at sea.
      const sea = canPlace(match, "blue", "infantry", 13, 0, board);
      ok(sea.error && /water/.test(sea.error), "the open sea is refused as water: " + sea.error);
    }

    // ---- AC4: starting destinations --------------------------------------------------------
    {
      const board = boardPayload();
      const match = fresh("1986");
      const soldier = (match.pieces || []).find((piece) => piece && piece.side === "blue"
        && piece.kind !== "aircraft" && piece.domain !== "air");
      ok(soldier, "the fixture has a blue ground piece");
      // A destination OUTSIDE friendly territory is the point of the sentence. Nearest one.
      const hostile = hostileGroundCell(match, "blue", board, soldier);
      ok(hostile, "the fixture finds enemy ground");
      const done = setStartingDestination(match, "blue", soldier.id, hostile.x, hostile.y);
      eq(done.error, undefined, "a destination outside friendly territory is accepted: " + done.error);
      eq(done.to, { x: hostile.x, y: hostile.y }, "the destination is stored");
      eq(soldier.startingDestination, { x: hostile.x, y: hostile.y }, "the piece carries it");
      eq(Array.isArray(soldier.path) ? soldier.path.length : 0, 0, "nothing is queued while the peace stands");
      eq(match.round, 0, "setting a destination spends no round");
      const seat = forSeat(match, "blue");
      const mirror = seat.pieces.find((piece) => piece.id === soldier.id);
      eq(mirror.destination, { x: hostile.x, y: hostile.y }, "the owner reads its destination");
      // The other seat reads nothing: the enemy is invisible at peace.
      const enemySeat = forSeat(match, "red");
      ok(!enemySeat.pieces.some((piece) => piece.id === soldier.id), "the enemy does not see the piece at peace");

      // Air missions cannot be predetermined, even though the same op names a piece.
      const plane = { id: "blue:plane:test", side: "blue", kind: "aircraft", domain: "air", x: 79, y: 44, path: [] };
      match.pieces.push(plane);
      const air = setStartingDestination(match, "blue", plane.id, hostile.x, hostile.y);
      eq(air.error, DESTINATION_AIR, "an aircraft may not be given a destination (p.31)");

      // The war begins: both seats' destinations launch, and the mover walks on the same press.
      const redPiece = (match.pieces || []).find((piece) => piece && piece.side === "red"
        && piece.kind !== "aircraft" && piece.domain !== "air");
      ok(redPiece, "the fixture has a red ground piece");
      const redTarget = heldGroundCellNear(match, "blue", board, redPiece);
      ok(redTarget, "the fixture finds a blue ground cell for the red destination");
      const redDone = setStartingDestination(match, "red", redPiece.id, redTarget.x, redTarget.y);
      eq(redDone.error, undefined, "the other seat may set one too: " + redDone.error);

      // This block carries the config's length (3 rounds), so the press lands on the round the
      // counter reaches zero - the same gate AC2 measures, reused here so the launch is not a
      // special case that only works when the peace never held.
      match.round = MANDATORY["1986"];
      const begin = resumeWar(match, "blue", match.round);
      ok(begin && begin.ok, "the war begins once the counter has elapsed: " + JSON.stringify(begin && begin.error));
      const launch = launchStartingDestinations(match);
      eq(launch.launched, 2, "both seats' destinations launch on one press: " + JSON.stringify(launch.events));
      ok(soldier.path.length > 0, "the blue unit now has a path");
      ok(redPiece.path.length > 0, "the red unit now has a path");
      eq(soldier.startingDestination, null, "the stored destination is consumed");
      ok(launch.events.some((event) => event.type === "destination_launched" && /set off/i.test(event.note || "")),
        "the launch carries its own line");
      // "starts to move the moment war begins": one tick walks it a step.
      const before = { x: soldier.x, y: soldier.y };
      tickMatch(match);
      ok(soldier.x !== before.x || soldier.y !== before.y,
        "the unit moved on the first round of the war (" + before.x + "," + before.y + ")");

      // A destination set while the war is on is refused - the gesture is peacetime-only.
      const again = setStartingDestination(match, "blue", soldier.id, hostile.x, hostile.y);
      eq(again.error, DESTINATION_AT_WAR, "a destination is a peacetime order");
    }
  });
}
