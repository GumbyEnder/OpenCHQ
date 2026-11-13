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
import { siteAtCell } from "./siteindex.mjs";

// The alarm speaks when enemy troops are this close to a capital. Eight cells is the sight rule's
// own radius: inside it, the player can see them coming, so the log should not be quieter than the
// board.
const ALARM_CELLS = 8;

function capitalName(match, cell) {
  // Indexed, not searched: this ran a 84-row find twice per room per round inside the alarm.
  const site = siteAtCell(match.sites, cell.x, cell.y);
  return site && site.kind === "capital" ? site.name : null;
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

// Which of this round's capital captures actually completed the set.
//
// A round can take two capitals (measured: Paris and Tokyo fell in the same round of the T-010
// sweep), and the site loop visits them in id order, not in capture order. Naming the last one the
// loop happened to emit would blame a capital whose fall changed nothing. So walk the round's
// captures backwards from the finished board: restore the side a capture took the capital from and
// ask whether the winner still holds every capital. The first restore that leaves the winner short
// is the capture that decided the match.
function decisiveCapture(match, captures, winner) {
  const list = (match.capitalSet && Array.isArray(match.capitalSet.list)) ? match.capitalSet.list : [];
  const owners = new Map(list.map((capital) => [String(capital.siteId), capitalHolder(match, capital)]));
  let decisive = captures.length ? captures[captures.length - 1] : null;
  for (let i = captures.length - 1; i >= 0; i--) {
    const event = captures[i];
    const before = event.from === "blue" || event.from === "red" ? event.from : null;
    owners.set(String(event.site), before);
    const complete = list.every((capital) => owners.get(String(capital.siteId)) === winner);
    if (!complete) {
      decisive = event;
      break;
    }
  }
  return decisive;
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
  // and says so once, in that seat's own log. One pass over the pieces answers both seats: the
  // bench pays this on every room every round, and a per-side walk was half of it twice over.
  const capBlue = match.capitals && match.capitals.blue;
  const capRed = match.capitals && match.capitals.red;
  if (capBlue || capRed) {
    const bx = capBlue ? Number(capBlue.x) : 0;
    const by = capBlue ? Number(capBlue.y) : 0;
    const rx = capRed ? Number(capRed.x) : 0;
    const ry = capRed ? Number(capRed.y) : 0;
    let nearBlue = null; // nearest enemy of blue = nearest red land piece
    let nearRed = null;
    for (const piece of match.pieces || []) {
      if (!piece || piece.domain !== "land") continue;
      const px = Number(piece.x);
      const py = Number(piece.y);
      if (capBlue && piece.side !== "blue") {
        const dx = Math.abs(px - bx);
        const dist = Math.max(dx > CELL_W / 2 ? CELL_W - dx : dx, Math.abs(py - by));
        if (nearBlue === null || dist < nearBlue) nearBlue = dist;
      }
      if (capRed && piece.side !== "red") {
        const dx = Math.abs(px - rx);
        const dist = Math.max(dx > CELL_W / 2 ? CELL_W - dx : dx, Math.abs(py - ry));
        if (nearRed === null || dist < nearRed) nearRed = dist;
      }
    }
    const approaches = [["blue", capBlue, nearBlue], ["red", capRed, nearRed]];
    for (const [side, cell, nearest] of approaches) {
      if (!cell) continue;
      const name = capitalName(match, cell) || (side === "blue" ? "your capital" : "the enemy capital");
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
  }

  // The win is checked when a capital changes hands, not every round: the original calls its
  // check from the capture handler, and only a capture can complete the set. economy.occupy
  // writes the owner byte before it emits the event, so the check reads the new holder.
  //
  // Membership, not site kind, decides what counts: the file's capitals are subtype-1/2 rows, and
  // two of 1986's four capitals sit on sites the asset list calls a city (London, Tokyo), so a
  // capture of London emits kind "city" and still has to be able to end the match.
  const set = (match.capitalSet && match.capitalSet.list) || [];
  const capitalCaptures = events.filter((event) =>
    event && event.type === "capture" &&
    set.some((capital) => Number(capital.siteId) === Number(event.site))
  );
  const winner = capitalCaptures.length ? checkWin(match) : null;
  if (winner) {
    // The reason, not only the fact. A player who is told "you won" but not which capital fell
    // cannot check the claim against the board, and a match that ends without a nameable cause is
    // the same as a match that ends by accident. `winReason` is written onto the match, so a
    // reload and a reconnect read the same sentence the tick that ended it did.
    const last = decisiveCapture(match, capitalCaptures, winner);
    match.winner = winner;
    match.over = true;
    match.clock = "held";
    match.winReason = {
      kind: "capitals",
      side: winner,
      siteId: last ? Number(last.site) : null,
      name: last ? String(last.name || "") : "",
      from: last ? (last.from || null) : null,
      round: match.round,
    };
    events.push({
      type: "win",
      side: winner,
      site: match.winReason.siteId,
      name: match.winReason.name,
      from: match.winReason.from,
      round: match.round,
    });
  }

  return { match, events };
}
