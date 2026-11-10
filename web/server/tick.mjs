// One running round, and the end of the match. Owner: A1.
//
// One call to tickMatch is one round: advance, resolve fights, take the sites the pieces stand
// on, run upkeep and pay, then look
// for a winner. Nothing here reads a clock, a timer or the wall time - the caller decides when
// a round happens, and roundSeconds lives in config/game.json. A held clock or a finished
// match returns before any module runs, so a held room cannot drift, burn fuel or pay income.
//
// The win condition is the archive's: the side that holds both capitals has won. A capital is
// held by the side standing on it, or, when nobody stands there, by the owner the site record
// already carries (economy.capture writes that). No new number, cell or cost is invented here.

import { advance } from "./move.mjs";
import { resolve } from "./combat.mjs";
import { occupy, pay, upkeep } from "./economy.mjs";
import { tickAir } from "./air.mjs";
import { followEscorts } from "./escort.mjs";
import { CELL_W } from "./board.mjs";

const SIDES = ["blue", "red"];

// The alarm speaks when enemy troops are this close to a capital. Eight cells is the sight rule's
// own radius: inside it, the player can see them coming, so the log should not be quieter than the
// board.
const ALARM_CELLS = 8;

// A capital site is either the asset list's own capital kind, or a cell the era named as a
// capital (1918 Paris and London are cities in the asset list and capitals in the scenario).
function isCapitalSite(site) {
  return Boolean(site) && (site.kind === "capital" || site.capitalSide === "blue" || site.capitalSide === "red");
}

function siteOnCell(match, cell) {
  return (match.sites || []).find(
    (place) => place && Number(place.x) === Number(cell.x) && Number(place.y) === Number(cell.y) && isCapitalSite(place)
  ) || null;
}

function capitalName(match, cell) {
  const site = siteOnCell(match, cell);
  return site ? site.name : null;
}

// One side's capitals. Older rows carried a single cell per side, so both shapes are read.
export function capitalsOf(match, side) {
  const row = match && match.capitals ? match.capitals[side] : null;
  if (Array.isArray(row)) return row.filter(Boolean);
  return row ? [row] : [];
}

function otherSide(side) {
  return side === "blue" ? "red" : "blue";
}

// Which side holds one capital cell. A piece standing on the cell is the freshest fact; a
// cell two sides stand on is contested and belongs to nobody. With nobody standing there the
// site record's owner decides, and an unowned capital is held by nobody.
function holderOf(match, cell) {
  if (!cell) return null;
  const standing = new Set();
  for (const piece of match.pieces || []) {
    if (!piece) continue;
    if (piece.x !== cell.x || piece.y !== cell.y) continue;
    // A capital is taken by troops on the ground. A ship in the harbour is not holding the
    // capital: a played match ended at round 27 because a blue destroyer sailed onto Moscow and
    // checkWin counted it as the red capital changing hands.
    if (piece.domain !== "land") continue;
    if (piece.embarked) continue;
    if (SIDES.includes(piece.side)) standing.add(piece.side);
  }
  if (standing.size === 1) return [...standing][0];
  if (standing.size > 1) return null;
  const site = siteOnCell(match, cell);
  if (site && SIDES.includes(site.owner)) return site.owner;
  return null;
}

// null until one side holds every capital of the other side. The caller reports the result; this
// does not change the match.
//
// A side's own capitals are not won by holding them: the win condition is the enemy's ground. In
// 1918 blue holds Paris and London and red holds Berlin; blue wins by taking Berlin, red by taking
// both Paris and London. With one capital a side this is the old "both capitals" rule.
export function checkWin(match) {
  if (!match || !match.capitals) return null;
  for (const side of SIDES) {
    const targets = capitalsOf(match, otherSide(side));
    if (!targets.length) continue;
    if (targets.every((cell) => holderOf(match, cell) === side)) return side;
  }
  return null;
}

export function tickMatch(match) {
  if (!match) return { match, events: [] };
  // A finished match is frozen: no movement, no income, no fuel. A held clock is paused the
  // same way. Both return the match untouched, before any module can mutate it.
  if (match.over) return { match, events: [] };
  if (match.clock !== "running") return { match, events: [] };

  match.round = Number.isInteger(match.round) ? match.round + 1 : 1;

  const events = [];
  // An escort order is given between rounds; its line belongs to the round that follows it.
  if (Array.isArray(match.pendingEvents) && match.pendingEvents.length) {
    events.push(...match.pendingEvents);
    match.pendingEvents = [];
  }
  // An escort holds station before its transport moves, so the ship trails the transport rather
  // than chasing the cell it just left.
  followEscorts(match);
  // Modules that are still stubs return [] (or nothing). A round does not depend on them
  // producing events; it only depends on them being called in this order.
  for (const step of [advance, resolve, occupy, tickAir, upkeep, pay]) {
    const produced = step(match);
    if (Array.isArray(produced)) events.push(...produced);
  }

  // The alarm: enemy troops closing on a capital. A match can now be won, and the last ten rounds
  // of one used to be silent - the first news was the loss. This notices a new closest approach
  // and says so once, in that seat's own log. A side may hold several capitals, so the closest of
  // them is the one reported.
  for (const side of SIDES) {
    let cell = null;
    let name = null;
    let nearest = null;
    for (const capital of capitalsOf(match, side)) {
      let closest = null;
      for (const piece of match.pieces || []) {
        if (!piece || piece.side === side || piece.domain !== "land") continue;
        const dx = Math.abs(Number(piece.x) - Number(capital.x));
        const dist = Math.max(Math.min(dx, CELL_W - dx), Math.abs(Number(piece.y) - Number(capital.y)));
        if (closest === null || dist < closest) closest = dist;
      }
      if (closest === null) continue;
      if (nearest === null || closest < nearest) {
        nearest = closest;
        cell = capital;
        name = capitalName(match, capital) || (side === "blue" ? "your capital" : "an enemy capital");
      }
    }
    if (nearest === null) continue;
    if (!match.alarm) match.alarm = {};
    const was = match.alarm[side];
    // Quiet at the far end of the board, and each new close approach is said once, not every round.
    if (nearest > ALARM_CELLS) {
      if (was) match.alarm[side] = null;
      continue;
    }
    if (was && was.distance <= nearest) continue;
    match.alarm[side] = { distance: nearest, round: match.round, name, x: cell.x, y: cell.y };
    events.push({ type: "threat", side, name, distance: nearest, at: { x: cell.x, y: cell.y } });
  }

  const winner = checkWin(match);
  if (winner) {
    match.winner = winner;
    match.over = true;
    match.clock = "held";
    // The message names every capital that changed hands: with more than one enemy capital,
    // "both capitals" is no longer a sentence that tells the player what happened.
    const taken = capitalsOf(match, otherSide(winner))
      .map((capital) => capitalName(match, capital) || `${capital.x},${capital.y}`);
    events.push({ type: "win", side: winner, capitals: taken });
  }

  return { match, events };
}
