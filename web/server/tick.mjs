// One running round, and the end of the match. Owner: A1.
//
// One call to tickMatch is one round: advance, resolve fights, take the sites the pieces stand
// on, run upkeep and pay, then look
// for a winner. Nothing here reads a clock, a timer or the wall time - the caller decides when
// a round happens, and roundSeconds lives in config/game.json. A held clock or a finished
// match returns before any module runs, so a held room cannot drift, burn fuel or pay income.
//
// The win condition is the archive's (1c0d:000c): the side that owns every capital in the era's
// set has won. The set is `match.capitalSet`, the file's subtype-1/2 rows joined to the live sites
// - not the two seats the page labels - and the holder is the site record's owner, which
// `economy.occupy` writes when troops take a capital's cell. The check runs when a capital changes
// hands, not every round: a capture is the only event that can complete the set, and that is what
// the original calls its routine from.

import { advance, attritionStep, repairStep } from "./move.mjs";
import { resolve, tickEntrench } from "./combat.mjs";
import { occupy, pay, upkeep } from "./economy.mjs";
import { tickAir } from "./air.mjs";
import { followEscorts } from "./escort.mjs";
import { holderOf as capitalHolder } from "./capitals.mjs";
import { CELL_W } from "./board.mjs";

const SIDES = ["blue", "red"];

// The alarm speaks when enemy troops are this close to a capital. Eight cells is the sight rule's
// own radius: inside it, the player can see them coming, so the log should not be quieter than the
// board.
const ALARM_CELLS = 8;

function capitalName(match, cell) {
  const site = (match.sites || []).find(
    (place) => place && place.kind === "capital" && place.x === cell.x && place.y === cell.y
  );
  return site ? site.name : null;
}

// The winner, or null. Read off the era's set alone: every capital owned by one side. A neutral
// capital blocks both sides, and a set the site list only partly carries decides nothing - the
// alternative is a win that is easier than the original's because a capital went missing.
// The caller reports the result; this does not change the match.
export function checkWin(match) {
  if (!match || !match.capitalSet) return null;
  const list = match.capitalSet.list;
  if (!Array.isArray(list) || !list.length) return null;
  if (Array.isArray(match.capitalSet.missing) && match.capitalSet.missing.length) return null;
  let winner = null;
  for (const capital of list) {
    const holder = capitalHolder(match, capital);
    if (!holder) return null;
    if (winner === null) winner = holder;
    else if (winner !== holder) return null;
  }
  return winner;
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
  // producing events; it only depends on them being called in this order: advance, attrition,
  // combat, entrench, repair, capture, air, upkeep, pay (T-003's order, from Manual p.20-25).
  for (const step of [advance, attritionStep, resolve, tickEntrench, repairStep, occupy, tickAir, upkeep, pay]) {
    const produced = step(match);
    if (Array.isArray(produced)) events.push(...produced);
  }

  // The alarm: enemy troops closing on a capital. A match can now be won, and the last ten rounds
  // of one used to be silent - the first news was the loss. This notices a new closest approach
  // and says so once, in that seat's own log.
  for (const side of SIDES) {
    const cell = match.capitals && match.capitals[side];
    if (!cell) continue;
    const name = capitalName(match, cell) || (side === "blue" ? "your capital" : "the enemy capital");
    let nearest = null;
    for (const piece of match.pieces || []) {
      if (!piece || piece.side === side || piece.domain !== "land") continue;
      const dx = Math.abs(Number(piece.x) - Number(cell.x));
      const dist = Math.max(Math.min(dx, CELL_W - dx), Math.abs(Number(piece.y) - Number(cell.y)));
      if (nearest === null || dist < nearest) nearest = dist;
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
    match.alarm[side] = { distance: nearest, round: match.round, name };
    events.push({ type: "threat", side, name, distance: nearest });
  }

  // The win is checked when a capital changes hands, not every round: the original calls its
  // check from the capture handler, and only a capture can complete the set. economy.occupy
  // writes the owner byte before it emits the event, so the check reads the new holder.
  //
  // Membership, not site kind, decides what counts: the file's capitals are subtype-1/2 rows, and
  // two of 1986's four capitals sit on sites the asset list calls a city (London, Tokyo), so a
  // capture of London emits kind "city" and still has to be able to end the match.
  const set = (match.capitalSet && match.capitalSet.list) || [];
  const tookCapital = events.some((event) =>
    event && event.type === "capture" &&
    set.some((capital) => Number(capital.siteId) === Number(event.site))
  );
  const winner = tookCapital ? checkWin(match) : null;
  if (winner) {
    match.winner = winner;
    match.over = true;
    match.clock = "held";
    events.push({ type: "win", side: winner });
  }

  return { match, events };
}
