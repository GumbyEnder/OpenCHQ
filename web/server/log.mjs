// What the clock says. Owner: feedback node.
//
// A running round is dead time unless something reports it. The server already knows every
// event a round produced; this module turns those events into a short line per seat, and
// drops anything the seat could not have seen. The rule is the same one the view uses: an
// event at a cell is legible only if one of the seat's own pieces is within sight of it,
// and an event about the seat's own pieces always is. Nothing here invents a number — an
// amount is whatever the economy paid.

import { CELL_W } from "./board.mjs";
import { millionsPerBillion, payEvery, sightCells } from "./rules.mjs";
import { unitPhrase } from "../public/units.mjs";
import { resourceSpec } from "./resources.mjs";
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

// Money is integer millions inside the server and billions everywhere a player reads it (Manual
// p.27). The round log used to print the raw millions - "paid 650" for a 0.65 billion payday - which
// read as 650 billion beside a pool that shows 0.65b (T-007 AC8).
function billionsText(millions) {
  const value = Number(millions);
  if (!Number.isFinite(value)) return "";
  const per = Number(millionsPerBillion()) || 1000;
  const text = (value / per).toFixed(3).replace(/\.?0+$/, "");
  return (text === "" || text === "-0" ? "0" : text) + "b";
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
        push("paid " + billionsText(paid) + (from ? " from " + from + (from === 1 ? " city" : " cities") : ""));
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
        // A destroy event that names its site says why in the same line: an aircraft lost because its
        // air strip was taken reads as that, not as a bare "lost an aircraft at 80,99" (Manual p.10 is
        // the rule; economy.occupy emits the event inside the capture pass).
        const named = event.name ? " at " + event.name : "";
        const where = named || (cell ? " at " + cell.x + "," + cell.y : "");
        const why = event.cause === "capture" ? "; the air strip was captured" : "";
        if (mine) push("lost " + (event.kind ? unitPhrase(event.kind) : "a unit") + where + why);
        else if (legible(match, side, event)) push("an enemy unit was destroyed" + where + why);
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
      case "transfer":
        if (mine) push("an aircraft rebased");
        else if (legible(match, side, event)) push("an enemy aircraft rebased");
        break;
      case "embarked":
        if (mine) push("a unit boarded a transport");
        break;
      case "landed":
        if (mine) push("a unit landed");
        break;
      case "retired":
        break;
      case "dry": {
        // Name the resource that actually ran out. Saying "out of fuel" when the steel meter
        // emptied sent the owner looking at a fuel figure that was still 9,900.
        if (!mine) break;
        const kind = String(event.kind || "fuel");
        const spec = resourceSpec(kind);
        const stops = !spec || spec.blocksMovement !== false;
        push("out of " + kind + (stops ? ": units are not moving" : ""));
        break;
      }
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
      case "win": {
        // The set is the era's, not two fixed seats: 1918 is won by holding London, Berlin and
        // Paris, and neither of those last two is 62 or 63. Report the size the match actually
        // decided on, so the last line the player reads agrees with the rule that ended it.
        const size = match && match.capitalSet && Array.isArray(match.capitalSet.list)
          ? match.capitalSet.list.length
          : 0;
        const set = size ? "every capital (" + size + " of " + size + ")" : "every capital";
        // The reason travels with the fact. The tick records the capital whose fall completed the
        // set; a win line that leaves it out is the sentence that made a real win look like an
        // accident in the T-010 sweep.
        const last = event.name
          ? "; " + event.name + " fell" + (Number.isInteger(Number(event.round)) ? " at round " + Number(event.round) : "") + " last"
          : "";
        push((event.side === side ? "you hold " : "the enemy holds ") + set + last);
        break;
      }
      default:
        break;
    }
  }

  // Contact is the line that teaches the sight rule: an enemy piece the seat may see is
  // reported by PLACE, never by map coordinate (PB-121; PB-044 / T-021 AC8: player text names
  // places, and a bare "at 1,64" is a map-internal fact a player cannot use). The filter is not
  // repeated here — the seat view already decided what this side can see, concealing era
  // included, so a hidden enemy cannot leak through the log.
  //
  // One line per held CELL, not per piece: two enemy units on one cell are one sighting, and the
  // line says how many. The key is the cell, so the page says it once while the enemy stays
  // there instead of repeating the same line every round.
  const seenCells = new Set();
  const visible = forSeat(match, side).pieces || [];
  for (const unit of visible) {
    if (unit.side === side) continue;
    const cell = { x: wrapX(unit.x), y: Number(unit.y) };
    const id = cell.x + "," + cell.y;
    if (seenCells.has(id)) continue;
    seenCells.add(id);
    const count = visible.filter(
      (other) => other.side !== side && wrapX(other.x) === cell.x && Number(other.y) === cell.y
    ).length;
    lines.push({ round: turn, key: "sight:" + id, text: sightText(match, side, cell, count) });
  }

  return lines;
}

// Compass words for the direction from a landmark to the sighting. Y grows south on this board.
const COMPASS = ["east", "south-east", "south", "south-west", "west", "north-west", "north", "north-east"];

function wrapX(x) {
  return ((Number(x) % CELL_W) + CELL_W) % CELL_W;
}

// The seat's own cities and capitals are the landmarks a player reads first. When the enemy is
// nearer a named site the seat does not hold (the board draws every site's name), that site is the
// better answer - "3 cells east of Moscow" says more than "90 cells east of Boston" - so all named
// sites are candidates and an own city wins a tie. A board with no names gets a bare sighting.
function landmarks(match, side) {
  const out = [];
  for (const site of match.sites || []) {
    if (!site || !site.name) continue;
    // A baked dock/facility is named after its own cell ("Dock 174,41"). That is a map
    // coordinate wearing a place's clothes, so it is not a landmark (PB-121).
    if (/\d+\s*,\s*\d+/.test(site.name)) continue;
    out.push({ site, own: site.owner === side && (site.kind === "city" || site.kind === "capital") });
  }
  return out;
}

function sightText(match, side, cell, count) {
  const subject = count === 1 ? "an enemy is" : count + " enemy units are";
  let best = null;
  for (const { site, own } of landmarks(match, side)) {
    const rawX = wrapX(cell.x) - wrapX(site.x);
    const dx = rawX > CELL_W / 2 ? rawX - CELL_W : rawX < -CELL_W / 2 ? rawX + CELL_W : rawX;
    const dy = Number(cell.y) - Number(site.y);
    const distance = Math.max(Math.abs(dx), Math.abs(dy));
    if (!best || distance < best.distance || (distance === best.distance && own && !best.own)) {
      best = { site, dx, dy, distance, own };
    }
  }
  if (!best || best.distance === 0) {
    return best ? subject + " in sight at " + best.site.name : subject + " in sight";
  }
  const turn = ((Math.atan2(best.dy, best.dx) + 2 * Math.PI) % (2 * Math.PI)) / (Math.PI / 4);
  const direction = COMPASS[Math.round(turn) % 8];
  return subject + " in sight " + best.distance + " cell" + (best.distance === 1 ? "" : "s") +
    " " + direction + " of " + best.site.name;
}
