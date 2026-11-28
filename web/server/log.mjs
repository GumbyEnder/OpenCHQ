// What the clock says. Owner: feedback node.
//
// A running round is dead time unless something reports it. The server already knows every
// event a round produced; this module turns those events into a short line per seat, and
// drops anything the seat could not have seen. The rule is the same one the view uses: an
// event at a cell is legible only if one of the seat's own pieces is within sight of it,
// and an event about the seat's own pieces always is. Nothing here invents a number — an
// amount is whatever the economy paid.

import { CELL_W } from "./board.mjs";
import { announceFromCities, millionsPerBillion, payEvery, sightCells } from "./rules.mjs";
import { isOilField } from "./sitetype.mjs";
import { countryName } from "./countries.mjs";
import { unitNoun, unitPhrase } from "../public/units.mjs";
import { resourceSpec } from "./resources.mjs";
import { forSeat } from "./view.mjs";
import { peaceActive } from "./peace.mjs";
import { actKey } from "../public/acts.mjs";

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

// PB-123: the identity of an overrun for grouping - side plus ROUND plus cell, so two seats losing
// a unit on one cell are two lines, two losses on one cell for one seat in one round are one line
// with a count, and a future caller that hands logLines a multi-round events array cannot aggregate
// two rounds into one count. The production caller (lobby.mjs:970) passes one tick's events, so the
// round term is inert today and pins the contract for tomorrow.
// PB-202: a shot pair's identity - the two pieces and the round - so a round's exchange is one
// line and a second round is a second line.
function shotKey(event) {
  return String((event && event.side) || "?") + ":" + String(event && event.pieceId) + ":" +
    String(event && event.target) + ":" + String(event && event.round);
}

function overrunKey(event) {
  const cell = cellOf(event);
  const round = Number.isFinite(Number(event.round)) ? Number(event.round) : "?";
  return String((event && event.side) || "?") + ":" + round + ":" + (cell ? cell.x + "," + cell.y : "-");
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

// PB-236: is the nation a gift landed in "large" enough for the manual's public announcement? The
// event carries the nation's own city count (`late.useTool` sets `cities` from `nationOf`), so the
// round log never re-counts the board and cannot disagree with the gift that made the line. A cut
// the config cannot supply returns null, and an unreadable cut announces nothing rather than
// guessing which side of it a nation sits on.
function largeNation(event) {
  const cut = announceFromCities();
  if (cut === null) return false;
  const cities = Number(event && event.cities);
  return Number.isFinite(cities) && cities >= cut;
}

// The nation's name for the announcement line. The baked country table is the same one the aid note
// uses, so the name a player reads here is the name the payer's own line carried.
function nationLabel(event) {
  const country = event && event.country !== null && event.country !== undefined ? Number(event.country) : null;
  const named = country === null ? null : countryName(country);
  return named || "A nation";
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
  // PB-200 AC4: a line's round is the event's OWN round when the event carries one. A tool or an
  // answer is used between rounds and drained into the next one, so the frame it arrives in is one
  // round ahead of the fact it reports - the shape that made a cease fire read as event r1 / log r2.
  // Events with no round field (an escort, a scramble, an income line built by a caller) keep the
  // frame's round, which is what every earlier card pinned.
  let lineTurn = turn;
  // PB-263: `tag` marks a line as a WARNING, and only a warning. The message level (manual p.32)
  // hides tagged lines and never hides untagged ones, so a payday, a capture or a fight keeps
  // reading at every level. The values are the levels' own vocabulary: "spotted", "threat",
  // "serious".
  // `key` is the act's identity, shared with the page (public/acts.mjs): the mover's own echo and
  // this delivered line are one row, not two, whichever lands first (PB-330).
  const push = (text, tag, key) => {
    if (!text) return;
    const line = { round: lineTurn, text };
    if (tag) line.tag = tag;
    if (key) line.key = key;
    lines.push(line);
  };

  // PB-316: a mission ordered on a held clock is delivered to both seats at the ORDER
  // (lobby.mjs missionOp -> deliverSeatLog) and its copies are still queued for the round's film
  // frame. The flush hands those stamped copies here as well, so `loggedOnOrder` is what keeps the
  // strike from reading a second time; the film still renders it, because film.mjs reads the events
  // appendFrame stored and this filter is local to the seat's log.
  const rows = (Array.isArray(events) ? events : []).filter((event) => !(event && event.loggedOnOrder === true));

  // PB-123: overrun events are grouped per cell per side before the loop, so two units lost on one
  // cell in one round read as ONE line with a count (the sighting shape), and the count cannot
  // drift if this log is rebuilt for the same round.
  const overruns = new Map();
  for (const event of rows) {
    if (!event || event.type !== "overrun") continue;
    const key = overrunKey(event);
    const row = overruns.get(key) || { count: 0 };
    row.count += 1;
    overruns.set(key, row);
  }
  const overrunDone = new Set();

  // PB-216: one overrun is one loss, and each seat reads it in its own voice. The event's `side`
  // is the seat that WON the overrun; `targetSide` is the seat that lost the piece. Two indexes
  // keep the round from saying it twice: the cells an overrun happened on (the winner no longer
  // also reads "an enemy unit was destroyed" for the piece it just ran over) and the losses the
  // `destroyed` event already named (the loser reads "lost an infantry" once, from that event).
  const overrunCells = new Set();
  const lostTold = new Set();
  const roundCellOf = (event) => {
    const cell = cellOf(event);
    if (!cell) return null;
    const at = Number.isFinite(Number(event && event.round)) ? Number(event.round) : "?";
    return at + ":" + cell.x + "," + cell.y;
  };
  for (const event of rows) {
    if (!event) continue;
    const at = roundCellOf(event);
    if (!at) continue;
    if (event.type === "overrun") overrunCells.add(at);
    else if (event.type === "destroyed") lostTold.add(String(event.side) + ":" + at);
  }

  // PB-202 AC3: every shot used to be dropped, so a fight left no line at all. One line per pair
  // per round, with the shots counted and the strength the target is left on.
  const shots = new Map();
  for (const event of rows) {
    // PB-211 (PM 8762 §1(b), card 8745 §2 AC1): the militia is a shot like any other and is
    // aggregated here. The gate used to sit in this pass AND in the emit branch; both are out
    // together, because either one alone keeps the city's owner from reading its own militia.
    if (!event || event.type !== "shot") continue;
    const key = shotKey(event);
    const row = shots.get(key) || { event, count: 0, amount: 0, strength: event.strength };
    row.count += 1;
    row.amount += Number(event.amount) || 0;
    row.strength = event.strength;
    shots.set(key, row);
  }
  const shotDone = new Set();

  for (const event of rows) {
    if (!event || !event.type) continue;
    const mine = event.side === side;
    const theirs = SIDES.includes(event.side) && event.side !== side;
    // PB-200 AC4: this event's own round, when it names one.
    const ownRound = event.round;
    lineTurn = ownRound !== null && ownRound !== undefined && ownRound !== "" && Number.isInteger(Number(ownRound))
      ? Number(ownRound)
      : turn;

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
          : "enemy troops " + distance + " cell" + (distance === 1 ? "" : "s") + " from " + name,
          // PB-263: the alarm carries the level's word. A capital is the object of the war
          // (manual p.18), so every threat to one is SERIOUS; a plain threat is an approach to a
          // friendly city that is not yet on its doorstep (tick.mjs marks those `serious: false`).
          event.serious === false ? "threat" : "serious");
        break;
      }
      case "income_skipped":
        if (!mine) break;
        // PB-156: two different reasons, two different lines. A pool that is short is the side's own
        // doing; a skipped payday after detonations is the sky's, and telling a player "the pool is
        // short" when their purse is full sends them looking in the wrong dialog.
        // PB-233 AC (b): the gate's line NAMES the cities it took (economy.pay builds the note), so
        // the player learns the rule from the log instead of only seeing a purse that did not fill.
        push(event.reason === "gate"
          ? (typeof event.note === "string" && event.note.trim()
            ? event.note
            : "no pay this round: the sky gate after " + (Number(event.detonated) || 0) + " detonations")
          : "no pay this round: the pool is short");
        break;
      case "capture": {
        // A baked dock/facility is named after its own cell ("Dock 260,46"): that is a coordinate
        // wearing a place's clothes, so it is not a name a player can use (PB-123, same filter
        // landmarks() already applies to sightings). When the only name is coordinate-shaped the
        // line names the kind and puts the place in a trailing clause: "a dock changed hands 3
        // cells west of Tobruk".
        const site = siteOf(match, event.site);
        const realName = usableName(event.name) || usableName(site && site.name);
        const cell = site || cellOf(event);
        const place = placeOf(match, cell, side);
        const name = realName || unnamedSitePhrase(site, event.kind, Boolean(place));
        const where = realName || !place ? "" : " " + place;
        const visible = legible(match, side, cell);
        if (event.side === side || (event.from === side && event.side !== side)) {
          // You always know a site you took or lost, even off the map's lit part.
          push(event.side === side ? "took " + name + where : name + " was lost" + where);
        } else if (visible) {
          push(name + " changed hands" + where);
        }
        break;
      }
      case "capture_reward": {
        // PB-155: taking a city or a base pays the capturer 2 b. Only the seat that was paid reads
        // the amount; the other side already has the capture line and nothing about its cash.
        if (!mine) break;
        const paid = amountOf(event);
        if (paid === null || paid <= 0) break;
        push("capture reward +" + billionsText(paid));
        break;
      }
      case "destroyed": {
        // A destroy event that names its site says why in the same line: an aircraft lost because its
        // air strip was taken reads as that, not as a bare "lost an aircraft at 80,99" (Manual p.10 is
        // the rule; economy.occupy emits the event inside the capture pass).
        // PB-123: the fallback is a PLACE, never the cell. A named event keeps its name; anything
        // else - no name, or a coordinate-shaped one - resolves through placeOf, and a board with
        // no usable landmark falls back to the bare vague sentence (D-028), which carries no digits.
        const named = usableName(event.name);
        const place = named ? null : placeOf(match, event, side);
        const where = named ? " at " + named : place ? " " + place : "";
        const why = event.cause === "capture" ? "; the air strip was captured" : "";
        // PB-346: cargo that dies at sea is the player's LAND piece. The event's `kind` is
        // "transport" (the hull the player never ordered), so a loss of an infantry they marched
        // read as "lost a transport" with nothing tying it back. Name the unit, then the hull.
        const cargo = event.cargoKind ? String(event.cargoKind) : null;
        if (mine && cargo) {
          push("lost your " + unitNoun(cargo) + " - it was cargo on a transport" + (where ? "," + where : "") + why);
        } else if (mine) push("lost " + (event.kind ? unitPhrase(event.kind) : "a unit") + where + why);
        // PB-216: the winner reads its own overrun line for the piece it ran over, so the generic
        // "an enemy unit was destroyed" on the same cell and round would be the same loss twice.
        else if (event.note === "Overrun." && overrunCells.has(roundCellOf(event))) break;
        else if (legible(match, side, event)) push("an enemy unit was destroyed" + where + why);
        break;
      }
      case "overrun": {
        // Two overrun events on one cell in one round are ONE line with the count and the place,
        // the same shape the sighting line uses (PM answer, frodo 6701). The count is taken from
        // the round's own events, not incremented per push, so the line cannot drift if the log is
        // rebuilt twice for the same round.
        const key = overrunKey(event);
        if (overrunDone.has(key)) break;
        overrunDone.add(key);
        const group = overruns.get(key);
        const count = group ? group.count : 1;
        const place = placeOf(match, event, side);
        const where = place ? " " + place : "";
        // PB-216: `mine` is the seat that WON the overrun - move.mjs has always written `side` that
        // way - so the old own-side line ("a unit was lost") spoke in the loser's voice to the
        // winner. The winner now reads what it ran over. The seat that lost the piece reads its own
        // loss from the `destroyed` event of the same round; this branch only speaks for it when
        // that event is not in the batch (an overrun held in an earlier round).
        const what = event.kind ? unitNoun(event.kind) : "unit";
        if (mine) {
          push((count === 1 ? "an enemy " + what + " was overrun" : count + " enemy units were overrun") + where);
        } else if (event.targetSide === side) {
          if (lostTold.has(String(side) + ":" + roundCellOf(event))) break;
          push((count === 1 ? "lost " + unitPhrase(event.kind) : "lost " + count + " units") + where);
        } else if (legible(match, side, event)) {
          push((count === 1 ? "an enemy unit was overrun" : count + " enemy units were overrun") + where);
        }
        break;
      }
      case "shot": {
        // PB-202 AC3: the line names both sides and the strength the target is left on. Before
        // this every shot was dropped, so a fight read as silence.
        const key = shotKey(event);
        if (shotDone.has(key)) break;
        const row = shots.get(key);
        if (!row) break;
        shotDone.add(key);
        // PB-208: a shot AT the seat's own piece is first-party news even when that piece is
        // already off the board. A killing hit removes the target before this log is built
        // (combat.mjs filters `doomed` after the exchange), and the removed piece was often the
        // only eye on its own cell, so `legible` read false and the very round that lost the unit
        // was the one round with no fight line. The event carries `targetSide` (combat.mjs) so the
        // reader is known from the shot itself, not from a board the dead piece has left.
        const onMe = row.event.targetSide === side;
        // PB-211 (PM 8762 §1(b), card 8745 §2 AC1/AC2): a city's militia is not a sighting, so the
        // sight test is DISABLED inside this branch. The two seats with first-party news are the
        // one whose city fired (`mine` - the event's `side` is the city's owner) and the one whose
        // piece took the 2 (`onMe`). Every other seat reads nothing: this is a widening of the
        // own-piece / own-action rule, never a blanket pass. The militia is what defends a city
        // (manual p.10, p.23), so its owner must read it shooting even at a cell it cannot see.
        const militia = row.event.militia === true;
        if (militia) {
          if (!mine && !onMe) break;
        } else if (!mine && !onMe && !legible(match, side, row.event)) break;
        const attackNoun = unitNoun(row.event.attackerKind);
        const targetNoun = unitNoun(row.event.targetKind);
        const who = mine ? "your " + attackNoun : "an enemy " + attackNoun;
        const whom = mine ? "an enemy " + targetNoun : "your " + targetNoun;
        const hits = row.count === 1 ? "a hit" : row.count + " hits";
        const amount = Math.round(row.amount * 100) / 100;
        const left = Number.isFinite(Number(row.strength))
          ? " (" + Math.round(Number(row.strength)) + " left)"
          : "";
        push(who + " landed " + hits + " on " + whom + " for " + amount + left);
        break;
      }
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
      case "engage":
        // PB-097b: an attack order that reached an enemy-held cell completes here. It is the
        // player's own unit doing the closing, so only the owner reads it; the enemy arm needs
        // sight, the same as any other enemy movement.
        // PB-318 (PM room 10144): the line used to read "a unit engaged the enemy at range", which
        // named neither side nor target. It now says whose unit and what kind it closed on, in the
        // same shape as the shot line - and no cell, no distance, no piece id. `kind`/`targetKind`
        // are written by move.mjs completeAsEngage; an event from before that falls back to "unit"
        // rather than inventing a noun, and always keeps the side.
        if (mine) push("your " + unitNoun(event.kind) + " engaged an enemy " + unitNoun(event.targetKind) + " at range");
        else if (legible(match, side, event)) push("an enemy " + unitNoun(event.kind) + " engaged your " + unitNoun(event.targetKind) + " at range");
        break;
      case "ready":
        if (mine) push("an aircraft is ready for a mission");
        break;
      case "transfer": {
        // PB-245 AC5: a peacetime transfer can be a ground or sea unit, not only a rebasing
        // aircraft, and at peace the other seat's units are invisible (p.31) - so the enemy arm
        // is gated on the war being on as well as on sight. A peacetime move the opponent can
        // read in the log would be the same leak the view closes.
        const air = String(event.kind ?? "") === "aircraft" || String(event.domain ?? "") === "air";
        // PB-330: the mover's own ack already wrote this act into the Log, so the delivered copy
        // carries the act's key and the page keeps the first of the two (one order, one row). The
        // enemy arm keeps no key: it never had an echo to collide with.
        if (mine) push(air ? "an aircraft rebased" : "a unit transferred", null, actKey("transfer", event.pieceId, event));
        else if (!peaceActive(match) && legible(match, side, event)) {
          push(air ? "an enemy aircraft rebased" : "an enemy unit transferred");
        }
        break;
      }
      case "embarked":
        // PB-346: this was the ONLY notice a player got, and it said neither which unit went aboard
        // nor what boarding costs. Name the unit and say what it is now: one hit sinks it.
        if (mine) {
          push("your " + unitNoun(event.kind || "unit") +
            " boarded a transport - cargo until it lands, and one hit sinks it");
        }
        break;
      case "landed":
        if (mine) push("your " + unitNoun(event.kind || "unit") + " landed");
        break;
      case "retired":
        break;
      case "oil_hold":
        // A unit that ran the budget dry stops where it stands (T-033). The order stays live, so
        // this is a stall, not a refusal, and it is said once per episode by move.mjs.
        if (mine) push("out of oil: that unit stopped");
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
      // PB-224 AC4: the satellite that spent its last booster fuel falls out of orbit, and the log
      // says so - a unit that disappears with no line is the kind of absence a player cannot read.
      case "satellite_down":
        if (mine) push("a recon satellite has burned its last booster fuel and fallen out of orbit");
        else if (legible(match, side, event)) push("an enemy satellite fell out of orbit");
        break;
      case "ceasefire": // an event written before PB-200: the old tool accepted on the spot
        if (mine) push("cease fire accepted; the war is over");
        break;
      // PB-200: an offer, a refusal and an agreement are three different facts, and each seat reads
      // them in its own voice. The offer is public (it was made to the other seat), so both sides get
      // a line; only the proposer reads the refusal as a refusal of its own offer.
      case "ceasefire_proposed":
        if (mine) push("cease fire proposed; your opponent must agree");
        else push("the enemy proposed a cease fire; answer it in the kit");
        break;
      case "ceasefire_declined":
        // `mine` is the seat reading the log; the event's `side` is the DECLINER (late.mjs files it
        // with side = the answering seat, by = the proposer). So the decliner owns the act.
        if (mine) push("you declined the cease fire; the war goes on");
        else push("your cease fire was declined; the war goes on");
        break;
      case "ceasefire_accepted":
        // PB-245: the war is at peace, not over (manual p.31).
        push("cease fire agreed; the war is at peace");
        break;
      case "peace_broken":
        // PB-245b AC2 (p.31-32): the seat that pressed Begin Hostilities reads what it did; the OTHER
        // seat reads the sentence naming the breaker, which is the one line p.31's "one message to
        // the other player" owes it. The sentence is carried on the event (peace.mjs), so the two
        // seats cannot read two different accounts of the same act.
        if (mine) push("you began hostilities; the war is on again");
        else push(String(event.note || "the peace is broken; the war is on again"));
        break;
      case "destination_set":
        // PB-245b AC4: only the owner reads the destination. The enemy is invisible at peace (p.31),
        // and a stored destination printed to the other seat would be the intent behind that
        // invisibility, which is the leak the view closes.
        // PB-330: same key as the mover's own echo (which carries the walk's round count), so the
        // two lines are one row.
        if (mine) push("a destination is set; it moves when the war begins", null, actKey("destination", event.pieceId, event));
        break;
      case "destination_launched": {
        // The war has begun, so the usual sight rule applies: the owner always reads its unit's
        // start, the other seat only when it can see the cell the unit starts from.
        const air = String(event.kind ?? "") === "aircraft";
        if (mine) push(air ? "an aircraft set off for its peacetime destination" : "a unit set off for its peacetime destination");
        else if (legible(match, side, event)) push("an enemy unit set off toward its peacetime destination");
        break;
      }
      case "destination_dropped":
        if (mine) push("a peacetime destination could not be walked and was dropped");
        break;
      case "aid":
        // PB-228: a gift buys a step for the city's nation, and it can be banked without turning
        // anything, so the line names the step it bought instead of implying a flip.
        if (mine) {
          const step = event.turned === "neutral" ? " (its nation went neutral)"
            : event.turned === "allied" ? " (its nation came over)" : "";
          push("aid reached " + (event.name || "a city") + step);
        } else if (largeNation(event) && legible(match, side, event)) {
          // PB-236 (manual p.30: "only large countries make it known that they have received
          // foreign aid"). A gift into a nation at or above the size cut is public, and the line
          // names the NATION and nothing else: not the giver, not the amount, not the standing it
          // moved. A gift into a smaller nation says nothing at all to the other seat, which is
          // the whole of the rule. The size test is deliberately independent of `cancelled` and
          // `turned`: a gift that cancelled a rival's banked one is announced by the nation's SIZE,
          // not by the cancel, so the log cannot leak a counter that the manual keeps quiet.
          //
          // Fog is the other gate and it is unchanged: `legible()` still decides whether this seat
          // knows the city at all, so "large and unseen" stays silent.
          push(nationLabel(event) + " reports receiving foreign aid");
        }
        break;
      case "bomb_hit": {
        // PB-157: the raider reads what it took; the owner reads the loss. The owner's branch is
        // the one that matters for the rule (125 M and +5 rounds), and it reads even if the site
        // is off the seat's lit map - a city you own is a city you know.
        const where = event.name ? " at " + event.name : "";
        if (mine) {
          const bits = [];
          if (Number(event.cash) > 0) bits.push(billionsText(event.cash) + " taken");
          if (Number(event.unready) > 0) bits.push("unready " + Number(event.unready) + " rounds");
          if (Number(event.oil) > 0) bits.push("oil loss queued");
          push("a bombing run hit" + where + (bits.length ? ": " + bits.join(", ") : ""));
        } else if (event.owner === side) {
          const bits = [];
          if (Number(event.cash) > 0) bits.push("lost " + billionsText(event.cash));
          if (Number(event.unready) > 0) bits.push("unready " + Number(event.unready) + " rounds");
          if (Number(event.oil) > 0) bits.push("oil cut next round");
          push("bombed" + where + (bits.length ? ": " + bits.join(", ") : ""));
        } else if (legible(match, side, event)) {
          push("a bombing run hit" + where);
        }
        break;
      }
      case "nuke":
        if (mine) push("a nuke was launched");
        else push("an enemy nuke was launched");
        break;
      case "nuke_warning":
        // Global news: the count is shared, so both seats read the same warning.
        push("the sky is dimming: " + (Number(event.detonated) || 0) + " detonations");
        break;
      case "nuclear_winter":
        push("nuclear winter: the war is over and neither side holds anything");
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
  //
  // PB-196: a sighting is news, not a heartbeat. The same cell is reported once, and again only
  // when the enemy MOVES to another cell or is LOST from sight and seen again. The memory is the
  // previous round's visible enemy cells per seat, kept ON THE MATCH: room.match is replaced by
  // tickMatch's copy every round, so a module-level Set would be discarded. It is refreshed on
  // every round, including a round with no events (the caller runs this builder for the clock,
  // not only for events), so "absent last round" really does mean "out of sight last round".
  if (!match.sightSeen || typeof match.sightSeen !== "object") match.sightSeen = {};
  const reported = Array.isArray(match.sightSeen[side]) ? match.sightSeen[side] : [];
  const reportedCells = new Set(reported);
  const seenCells = new Set();
  const visible = forSeat(match, side).pieces || [];
  for (const unit of visible) {
    if (unit.side === side) continue;
    const cell = { x: wrapX(unit.x), y: Number(unit.y) };
    // Deliberately a coordinate-shaped string: this is the SIGHT-DEDUPE KEY (one line per held
    // cell), never player text, and it is not folded into placeOf. Classified here so it is not an
    // unclassified coordinate producer (PB-123 / frodo 6969 item 4); the line a player reads comes
    // from sightText(), which resolves a place through placeOf.
    const id = cell.x + "," + cell.y;
    if (seenCells.has(id)) continue;
    seenCells.add(id);
    if (reportedCells.has(id)) continue;
    const count = visible.filter(
      (other) => other.side !== side && wrapX(other.x) === cell.x && Number(other.y) === cell.y
    ).length;
    lines.push({ round: turn, key: "sight:" + id, text: sightText(match, side, cell, count), tag: "spotted" });
  }
  match.sightSeen[side] = [...seenCells];

  return lines;
}

// Compass words for the direction from a landmark to the sighting. Y grows south on this board.
const COMPASS = ["east", "south-east", "south", "south-west", "west", "north-west", "north", "north-east"];

function wrapX(x) {
  return ((Number(x) % CELL_W) + CELL_W) % CELL_W;
}

// A baked dock/facility is named after its own cell ("Dock 260,46"): a map coordinate wearing a
// place's clothes. PB-121 rejected those for sightings; PB-123 rejects them for every emitter.
const COORDINATE_SHAPED = /\d+\s*,\s*\d+/;
// PB-186: the extract names the sites it has no string for after their own row ("site_72"). That is
// an internal id wearing a name's clothes, the same defect as a coordinate, so it is not a name a
// player can use - and the type-5 oil fields have no name in the original at all (PB-153).
const PLACEHOLDER_NAMED = /^site[_\s-]*\d+$/i;

function usableName(name) {
  if (name === null || name === undefined) return null;
  const text = String(name).trim();
  if (!text || COORDINATE_SHAPED.test(text) || PLACEHOLDER_NAMED.test(text)) return null;
  return text;
}

// The phrase for a site that has no usable name. Type 5 is the oil field (PB-153, one predicate in
// sitetype.mjs); "the" when a place clause follows ("the oil field 2 cells west of Jerusalem"),
// "an" when the board offers no landmark. Before this, an unnamed oil field read as "a facility",
// and the extract's placeholder row name reached the player as "took site_72".
function unnamedSitePhrase(site, kind, placed) {
  const word = String((site && site.kind) || kind || "site");
  if (isOilField(site) || word === "oilfield" || word === "well") {
    return (placed ? "the" : "an") + " oil field";
  }
  if (word === "docks") return "a dock";
  return "a " + word;
}


// The seat's own cities and capitals are the landmarks a player reads first. When the enemy is
// nearer a named site the seat does not hold (the board draws every site's name), that site is the
// better answer - "3 cells east of Moscow" says more than "90 cells east of Boston" - so all named
// sites are candidates and an own city wins a tie. A board with no names gets a bare sighting.
function landmarks(match, side) {
  const out = [];
  for (const site of match.sites || []) {
    // PB-186: the same name predicate, so a placeholder row ("site_64") is never a landmark either -
    // otherwise the fix moves the token from the capture line into "3 cells east of site_64".
    if (!site || !usableName(site.name)) continue;
    out.push({ site, own: site.owner === side && (site.kind === "city" || site.kind === "capital") });
  }
  return out;
}

function sightText(match, side, cell, count) {
  const subject = count === 1 ? "an enemy is" : count + " enemy units are";
  const place = placeOf(match, cell, side);
  return place ? subject + " in sight " + place : subject + " in sight";
}

// PB-123: ONE place predicate, called where a name is produced rather than where it is printed, so
// a fourth emitter inherits the rule instead of repeating the defect. It returns a digit-free
// locative phrase ("at Smolensk", "3 cells east of Tobruk") or null when the board has no usable
// landmark - never a cell, never "the front". Callers that need a bare name strip the "at ".
export function placeOf(match, target, side) {
  const cell = cellOf(target);
  if (!cell) return null;
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
  if (!best) return null;
  if (best.distance === 0) {
    // The landmark list already refuses unusable names, so this cannot be null on the shipped path;
    // it is the guard that keeps a future caller from printing "at null" if that filter moves.
    const at = usableName(best.site.name);
    return at ? "at " + at : null;
  }
  const turn = ((Math.atan2(best.dy, best.dx) + 2 * Math.PI) % (2 * Math.PI)) / (Math.PI / 4);
  const direction = COMPASS[Math.round(turn) % 8];
  return best.distance + " cell" + (best.distance === 1 ? "" : "s") + " " + direction + " of " +
    usableName(best.site.name);
}
