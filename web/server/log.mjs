// What the clock says. Owner: feedback node.
//
// A running round is dead time unless something reports it. The server already knows every
// event a round produced; this module turns those events into a short line per seat, and
// drops anything the seat could not have seen. The rule is the same one the view uses: an
// event at a cell is legible only if one of the seat's own pieces is within sight of it,
// and an event about the seat's own pieces always is. Nothing here invents a number — an
// amount is whatever the economy paid.

import { CELL_W } from "./board.mjs";
import { payEvery, sightCells } from "./rules.mjs";
import { forSeat } from "./view.mjs";

const SIDES = ["blue", "red"];

function cellOf(event) {
  if (!event) return null;
  if (event.at && Number.isFinite(Number(event.at.x))) {
    return { x: Number(event.at.x), y: Number(event.at.y) };
  }
  if (Number.isFinite(Number(event.x)) && Number.isFinite(Number(event.y))) {
    return { x: Number(event.x), y: Number(event.y) };
  }
  return null;
}

// Chebyshev with the board's X wrap, the same arithmetic the sight filter uses.
function near(a, b) {
  const rawX = Math.abs(a.x - b.x);
  const dx = Math.min(rawX, CELL_W - rawX);
  return Math.max(dx, Math.abs(a.y - b.y));
}

function seenCells(match, side) {
  const cells = [];
  for (const unit of match.pieces || []) {
    if (unit.side !== side) continue;
    cells.push({ x: Number(unit.x), y: Number(unit.y) });
  }
  return cells;
}

// An event's cell is legible when a seat piece is within sight of it.
function legible(match, side, event) {
  const cell = cellOf(event);
  if (!cell) return false;
  const radius = sightCells();
  for (const from of seenCells(match, side)) {
    if (near(from, cell) <= radius) return true;
  }
  return false;
}

function siteOf(match, id) {
  return (match.sites || []).find((site) => site.id === id) || null;
}

function amountOf(event) {
  const value = Number(event && event.amount);
  return Number.isFinite(value) ? value : null;
}

// A round's worth of events, as one seat reads them. Order is the order things happened.
export function logLines(match, side, events, round) {
  const lines = [];
  const turn = Number.isFinite(Number(round)) ? Number(round) : Number(match && match.round) || 0;
  const every = Number(payEvery()) || 0;
  const push = (text) => {
    if (text) lines.push({ round: turn, text });
  };

  for (const event of Array.isArray(events) ? events : []) {
    if (!event || !event.type) continue;
    const mine = event.side === side;
    const theirs = SIDES.includes(event.side) && event.side !== side;

    switch (event.type) {
      case "income": {
        // Only your own payday. The enemy's purse is not yours to read.
        if (!mine) break;
        const paid = amountOf(event);
        if (paid === null) break;
        const from = Number(event.cities) || 0;
        push("paid " + paid + (from ? " from " + from + (from === 1 ? " city" : " cities") : ""));
        break;
      }
      case "threat": {
        // The alarm is for the seat whose capital is being approached, and only for it: the other
        // side gets its own alarm when the same happens to it.
        if (!mine) break;
        const name = event.name || "your capital";
        const distance = Number(event.distance);
        if (!Number.isFinite(distance)) break;
        push(distance === 0
          ? "enemy troops are on " + name
          : "enemy troops " + distance + " cell" + (distance === 1 ? "" : "s") + " from " + name);
        break;
      }
      case "income_skipped":
        if (mine) push("no pay this round: the pool is short");
        break;
      case "capture": {
        const site = siteOf(match, event.site);
        const name = event.name || (site && site.name) || "a site";
        const visible = legible(match, side, site || cellOf(event));
        if (event.side === side || (event.from === side && event.side !== side)) {
          // You always know a site you took or lost, even off the map's lit part.
          push(event.side === side ? "took " + name : name + " was lost");
        } else if (visible) {
          push(name + " changed hands");
        }
        break;
      }
      case "destroyed": {
        const cell = cellOf(event);
        const where = cell ? " at " + cell.x + "," + cell.y : "";
        if (mine) push("lost a unit" + where);
        else if (legible(match, side, event)) push("an enemy unit was destroyed" + where);
        break;
      }
      case "overrun":
        if (mine) push("overrun: a unit was lost at " + (cellOf(event) ? cellOf(event).x + "," + cellOf(event).y : "the front"));
        else if (legible(match, side, event)) push("an enemy unit was overrun");
        break;
      case "shot":
        // A shot is noise on its own: a fight is worth a line only when the seat can see it,
        // and the fight's result arrives as destroyed/overrun.
        break;
      case "escort": {
        // Your own escort always reads; the enemy's only when one of your pieces can see the spot.
        if (!mine) break;
        // The line names what formed. It does not print a cell, a distance or a rate: none of
        // those are known for an escort, and a made-up one would be worse than the sentence.
        push("a warship is escorting a transport");
        break;
      }

      case "scramble": {
        // A scramble is your own aeroplane going up: the enemy's is only news if you can see it.
        if (!mine && !legible(match, side, event)) break;
        push(mine ? "an aircraft scrambled to intercept" : "an enemy aircraft scrambled");
        break;
      }

      case "strike": {
        if (!mine && !legible(match, side, event)) break;
        push(mine ? "an aircraft flew a strike" : "an enemy strike went in");
        break;
      }

      case "blocked":
        if (mine) push("a unit could not step: the way was held");
        break;
      case "ready":
        if (mine) push("an aircraft is ready for a mission");
        break;
      case "embarked":
        if (mine) push("a unit boarded a transport");
        break;
      case "landed":
        if (mine) push("a unit landed");
        break;
      case "retired":
        break;
      case "dry":
        if (mine) push("out of fuel: units are not moving");
        break;
      case "refuel":
        if (mine) push("refuelled");
        break;
      case "intel":
        if (mine) push("intel revealed " + (Number(event.reveals) || 0) + " enemy unit(s); they know");
        break;
      case "intel_seen":
        if (mine) push("the enemy read your positions");
        break;
      case "satellite":
        if (mine) push("a satellite pass revealed " + (Number(event.reveals) || 0) + " enemy unit(s)");
        break;
      case "ceasefire":
        if (mine) push("cease fire accepted; nothing changes");
        break;
      case "aid":
        if (mine) push("aid reached " + (event.name || "a city"));
        else if (legible(match, side, event)) push("enemy aid reached a city");
        break;
      case "nuke":
        if (mine) push("a nuke was launched");
        else push("an enemy nuke was launched");
        break;
      case "win":
        push(event.side === side ? "you hold both capitals" : "the enemy holds both capitals");
        break;
      default:
        break;
    }
  }

  // Contact is the line that teaches the sight rule: an enemy piece the seat may see is
  // reported with its cell. The filter is not repeated here — the seat view already decided
  // what this side can see, concealing era included, so a hidden enemy cannot leak through
  // the log. It repeats while the enemy stays in sight, so the line carries a key and the
  // page shows it once.
  for (const unit of forSeat(match, side).pieces || []) {
    if (unit.side === side) continue;
    lines.push({
      round: turn,
      key: "sight:" + unit.id + ":" + unit.x + "," + unit.y,
      text: "an enemy is in sight at " + unit.x + "," + unit.y,
    });
  }

  return lines;
}
