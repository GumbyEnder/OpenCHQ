// The empty seat's orders. Owner: A7. See docs/CONTRACTS.md.
//
// In a bot room the empty seat marches its army toward the player's capital and sails its ship
// once when its path is empty. Who is a bot is the caller's decision: the seat table on the
// match records `kind`, and this module only reads it. It never guesses a bot from an empty
// seat, a username, or a room mode, because a human seat's orders are the human's to send.
//
// The module asks the movement module for every path. It never invents a route: land orders go
// through move.issueOrder, whose destinations are the cells beside the opposing capital (the
// capital itself is held by its garrison, and a walker never enters a held cell). A ship's
// target comes from lanes.seaRoute. Both of those are other agents' files and may still be
// stubs, so every call is wrapped: a refusal becomes a note, never a crash.

import { CELL_H, CELL_W, boardPayload, resolveDataRoot } from "./board.mjs";
import { laneGraph, seaRoute } from "./lanes.mjs";
import { issueOrder, wrapDelta, wrapX } from "./move.mjs";
import { isRefused, priceOf } from "./rules.mjs";
import { buy, seedOwners } from "./economy.mjs";
import { placementMask } from "./placement.mjs";

const SIDES = new Set(["blue", "red"]);

function opposite(side) {
  return side === "blue" ? "red" : "blue";
}

function hasPath(piece) {
  return Array.isArray(piece.path) && piece.path.length > 0;
}

// Bot-ness is only ever read from an explicit record on the match. Anything else is "unknown",
// and an unknown seat is ordered because the caller already decided to ask for bot orders.
function seatKind(match, side) {
  const seats = match && match.seats;
  const seat = seats && typeof seats === "object" ? seats[side] : null;
  if (seat && typeof seat.kind === "string") return seat.kind;

  if (match && match.botSide) return match.botSide === side ? "bot" : "human";
  if (match && match.bot === side) return "bot";
  if (match && Array.isArray(match.bots)) return match.bots.includes(side) ? "bot" : null;

  return null;
}

let cellsCache;
function cells() {
  if (cellsCache !== undefined) return cellsCache;
  try {
    const payload = boardPayload();
    cellsCache = Array.isArray(payload.cells) ? payload.cells : null;
  } catch {
    cellsCache = null;
  }
  return cellsCache;
}

function terrainAt(x, y) {
  const grid = cells();
  if (!grid) return null;
  return grid[Number(y) * CELL_W + wrapX(x)] ?? null;
}

function heldByOther(match, piece, x, y) {
  const wx = wrapX(x);
  return (match.pieces || []).some(
    (unit) => unit.id !== piece.id && wrapX(unit.x) === wx && Number(unit.y) === Number(y)
  );
}

// The cells a walker can finish on beside the capital, nearest the army first. The capital
// itself is skipped: its garrison holds it, and a piece stops one short of a shared cell.
function approachCells(match, piece, capital) {
  const dx = Math.sign(wrapDelta(capital.x, piece.x));
  const dy = Math.sign(Number(piece.y) - Number(capital.y));
  const candidates = [];
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      if (ox === 0 && oy === 0) continue;
      const x = wrapX(capital.x + ox);
      const y = Number(capital.y) + oy;
      if (y < 0 || y >= CELL_H) continue;
      if (heldByOther(match, piece, x, y)) continue;
      const id = terrainAt(x, y);
      if (id !== null && isRefused(id)) continue;
      const gap = Math.max(Math.abs(wrapDelta(piece.x, x)), Math.abs(Number(piece.y) - y));
      const approach = (ox === -dx && oy === -dy) ? -1 : 0;
      candidates.push({ x, y, gap, approach });
    }
  }
  candidates.sort((a, b) => a.approach - b.approach || a.gap - b.gap);
  return candidates;
}

// When the ring around the capital is full, waiting is not a plan.
//
// Units do not stack, so a capital whose eight neighbours are all occupied leaves the march with
// nothing to stand on. A 400-round bot run logged 26,834 "no approach cell beside the capital"
// skips, which is a bot that has stopped thinking rather than a siege. That number came from a
// harness that is not in local/, so this change carries no re-measured before/after: the run needs
// reproducing before anyone claims the skips are gone. An occupied cell is not off limits
// to an order - the engine treats a move onto an enemy cell as an attack - so the army attacks the
// weakest point of the ring instead of queueing behind it. The rule is the engine's own overrun
// arithmetic: the cell with the fewest enemy pieces beside it is the one a group can break.
export function assaultCells(match, piece, capital) {
  const out = [];
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      if (ox === 0 && oy === 0) continue;
      const x = wrapX(capital.x + ox);
      const y = Number(capital.y) + oy;
      if (y < 0 || y >= CELL_H) continue;
      const holder = (match.pieces || []).find(
        (unit) => unit && unit.x === x && unit.y === y && unit.id !== piece.id && unit.side !== piece.side,
      );
      if (!holder) continue;
      const friends = (match.pieces || []).filter(
        (other) => other && other.side === holder.side && other.id !== holder.id &&
          Math.max(Math.abs(wrapDelta(other.x, x)), Math.abs(Number(other.y) - y)) <= 1,
      ).length;
      const gap = Math.max(Math.abs(wrapDelta(piece.x, x)), Math.abs(Number(piece.y) - y));
      out.push({ x, y, gap, defenders: friends, holder: holder.id });
    }
  }
  out.sort((a, b) => a.defenders - b.defenders || a.gap - b.gap);
  return out;
}

function note(side, pieceId, reason) {
  return { type: "bot_skip", side, pieceId, reason: String(reason || "refused") };
}

function routeTarget(route) {
  if (!Array.isArray(route) || route.length === 0) return null;
  for (let i = route.length - 1; i >= 0; i--) {
    const step = route[i];
    if (step && Number.isInteger(step.x) && Number.isInteger(step.y)) return { x: step.x, y: step.y };
  }
  return null;
}

function dataRootFor(match) {
  if (match && typeof match.dataRoot === "string" && match.dataRoot) return match.dataRoot;
  // lanes.mjs takes the data root explicitly; the board module knows where the extract is.
  try {
    return resolveDataRoot() || "";
  } catch {
    return "";
  }
}

// Concentration. A line that marches evenly at a capital grinds and never breaks - measured:
// 1200 rounds, 27 kills, no winner, because overrun needs surplus and an even front has none.
// So the bot picks ONE point of the enemy line - the enemy piece with the fewest enemy friends
// beside it - and the whole army converges there. That is behaviour, not a rule, so it costs
// no fidelity: the same pieces, the same orders, aimed better.
export function focusTarget(match, side, foe, capital) {
  const enemies = (match.pieces || []).filter((unit) => unit && unit.side === foe);
  if (enemies.length === 0) return capital;
  const mine = (match.pieces || []).filter((unit) => unit && unit.side === side);
  const friends = (cell) => enemies.filter((other) => other.id !== cell.id && Math.max(Math.abs(wrapDelta(other.x, cell.x)), Math.abs(Number(other.y) - Number(cell.y))) <= 1).length;

  let best = null;
  let bestCost = Infinity;
  for (const enemy of enemies) {
    // Distance from the army's centre of mass, so the choice is one the army can reach.
    let sum = 0;
    for (const piece of mine) sum += Math.max(Math.abs(wrapDelta(piece.x, enemy.x)), Math.abs(Number(piece.y) - Number(enemy.y)));
    const cost = friends(enemy) * 1000 + (mine.length ? sum / mine.length : 0);
    if (cost < bestCost) {
      bestCost = cost;
      best = enemy;
    }
  }
  return best ? { x: best.x, y: best.y } : capital;
}

// Exported so the ring case can be driven directly: the endgame state is hard to reach through
// ordersFor, which picks a focus of its own first.
export function marchOne(match, side, piece, capital, events) {
  const cells = approachCells(match, piece, capital);
  if (cells.length === 0) {
    // The ring is full: attack its weakest point rather than stand still. Units do not stack, so
    // there is no cell to queue on and no order to give except the one the engine calls an attack.
    const targets = assaultCells(match, piece, capital);
    for (const cell of targets.slice(0, 3)) {
      let result;
      try {
        result = issueOrder(match, side, piece.id, cell.x, cell.y);
      } catch (err) {
        continue;
      }
      if (result && result.ok) {
        events.push({ type: "bot_order", side, pieceId: piece.id, to: { x: cell.x, y: cell.y },
          path: result.path || [], assault: true, defenders: cell.defenders });
        return;
      }
    }
    events.push(note(side, piece.id, targets.length
      ? "ringed, and no attack could be issued"
      : "no approach cell beside the capital"));
    return;
  }
  let last = "no path";
  // At most a handful of tries: the nearest face first, then the rest of the ring.
  for (const cell of cells.slice(0, 4)) {
    let result;
    try {
      result = issueOrder(match, side, piece.id, cell.x, cell.y);
    } catch (err) {
      last = err && err.message ? err.message : err;
      continue;
    }
    if (result && result.ok && Array.isArray(result.path) && result.path.length > 0) {
      events.push({ type: "bot_order", side, pieceId: piece.id, to: { x: cell.x, y: cell.y }, path: result.path });
      return;
    }
    last = (result && result.error) || "no path";
  }
  // A very long straight march can exceed the walker's 100-cost limit (RULES.md section 2), and
  // the original refuses such an order with a warning rather than bending the line. A bot still has
  // to close the distance, so it marches in stages: half the gap, then a quarter, then an eighth.
  // This is a bot decision, not a movement rule: the engine still walks straight.
  for (const fraction of [0.5, 0.25, 0.125]) {
    const mid = {
      x: wrapX(piece.x + Math.round(wrapDelta(piece.x, capital.x) * fraction)),
      y: Math.max(0, Math.min(CELL_H - 1, Number(piece.y) + Math.round((Number(capital.y) - Number(piece.y)) * fraction))),
    };
    if (mid.x === wrapX(piece.x) && mid.y === Number(piece.y)) continue;
    let result;
    try {
      result = issueOrder(match, side, piece.id, mid.x, mid.y);
    } catch (err) {
      last = err && err.message ? err.message : err;
      continue;
    }
    if (result && result.ok && Array.isArray(result.path) && result.path.length > 0) {
      events.push({ type: "bot_order", side, pieceId: piece.id, to: mid, path: result.path, staged: true });
      return;
    }
    last = (result && result.error) || "no path";
  }
  events.push(note(side, piece.id, last));
}

// ---- capital defence (T-015 Part B) ---------------------------------------
//
// Ported from the two routines T-013 cited as missing. Both act on a SITE, not a piece:
// `FUN_107e_0bd6 @ 107e:0bd6` (decompiled.c 1124-1302) walks the 84 sites in ascending order of
// the site's score byte `0xea6e`, up to three actions a pass, and calls
//   FUN_107e_1612 @ 107e:1612 (decompiled.c 1607-1657) — buy a defender AT the site, and
//   FUN_107e_1750 @ 107e:1750 (decompiled.c 1661-1778) — send an existing land unit TO it.
// `0xea6e` is rewritten every AI turn from `FUN_107e_0fa4(site,0,0)` (decompiled.c 112-114,
// 1304-1602), the site's own threat score: every piece inside the site's radius adds strength/25,
// positive when it belongs to the site's owner and negative when it does not (decompiled.c
// 1487-1507, 1442-1465). A site of ours therefore scores negative when enemies near it outweigh its
// friends, and the defence routines only fire on a negative score (decompiled.c 1190).
const DEFEND_RADIUS_SITE = 15; // local_28 = 0xf, decompiled.c 1355-1356
const DEFEND_RADIUS_OWN_CITY = 20; // local_28 = 0x14 when our site kind < 3, 1352-1353
const DEFEND_RADIUS_CAPITAL = 25; // local_28 = 0x19 for the flagged site at 0xe47e, 1358-1359
const DEFEND_REACH = 0x9c4; // local_18 starts at 2500 = 50 cells squared, decompiled.c 1687-1688
const DEFEND_MIN = 8; // "8 < local_8": closer than 3 cells is already a fight, 1720
const DEFEND_MIN_INFANTRY = 0x18; // and 0x18 for kind 3 (infantry), same line

// Squared distance with X wrapping at the half-width, which is what the original's
// calculate_distance @ 188b:0216 does (COMBAT.md section 1: dx*dx+dy*dy, X wraps at 0xa0).
function squaredDistance(a, b) {
  let dx = Math.abs(Number(a.x) - Number(b.x));
  if (dx > CELL_W / 2) dx = CELL_W - dx;
  const dy = Number(a.y) - Number(b.y);
  return dx * dx + dy * dy;
}

function threatRadius(site) {
  if (site.kind === "capital") return DEFEND_RADIUS_CAPITAL;
  if (site.kind === "city" || site.kind === "base") return DEFEND_RADIUS_OWN_CITY;
  return DEFEND_RADIUS_SITE;
}

// `FUN_107e_0fa4(site, 0, 0)` reduced to its return value: the signed weight of the pieces near a
// site, relative to the site's owner. UNVERIFIED: the original also folds in each piece's distance
// and its approach route (decompiled.c 1521-1560); this port keeps the sign and the radius, which
// is what the two defence routines branch on.
export function siteThreat(match, site) {
  const limit = threatRadius(site) ** 2 + 1; // uVar5 = local_28*local_28 + 1, decompiled.c 1352
  let score = 0;
  for (const piece of match.pieces || []) {
    if (!piece) continue;
    const strength = Number(piece.strength);
    if (!Number.isFinite(strength) || strength <= 0) continue;
    if (squaredDistance(site, piece) >= limit) continue;
    const weight = Math.floor(strength / 25); // strength / 0x19, decompiled.c 1501
    score += piece.side === site.owner ? weight : -weight;
  }
  return score;
}

// The sites of ours the AI would act on this pass, most threatened first. Only a negative score
// counts: the original gates both defence routines on `0xea6e < 0` (decompiled.c 1190).
export function threatenedSites(match, side) {
  const out = [];
  for (const site of match.sites || []) {
    if (!site || site.owner !== side) continue;
    const threat = siteThreat(match, site);
    if (threat < 0) out.push({ site, threat });
  }
  out.sort((a, b) => a.threat - b.threat);
  return out;
}

// Send one unit to the most threatened site: nearest idle land unit between 3 and 50 cells away
// (decompiled.c 1727-1728 picks the smallest adjusted distance and rejects anything beyond 2500
// or closer than 9 squared). The original issues one order per pass and marks the site defended.
// A site cell its own garrison already stands on refuses the order, so the fallback is the nearest
// free neighbour — a bot decision, not a combat rule.
export function defendSites(match, side, events, threatened = null) {
  const claimed = new Set();
  const rows = threatened || threatenedSites(match, side);
  if (rows.length === 0) return claimed;
  const { site } = rows[0];

  const candidates = (match.pieces || [])
    .filter((piece) => piece && piece.side === side && piece.domain === "land" &&
      !hasPath(piece) && Number(piece.strength) > 0)
    .map((piece) => ({ piece, d2: squaredDistance(piece, site) }))
    // `8 < local_8`, and `0x18 < local_8` for kind 3 (infantry) — decompiled.c 1720.
    .filter((row) => row.d2 > (row.piece.kind === "infantry" ? DEFEND_MIN_INFANTRY : DEFEND_MIN) &&
      row.d2 <= DEFEND_REACH)
    .sort((a, b) => a.d2 - b.d2);
  if (candidates.length === 0) return claimed;

  const targets = [{ x: site.x, y: site.y }];
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      if (ox === 0 && oy === 0) continue;
      const y = Number(site.y) + oy;
      if (y < 0 || y >= CELL_H) continue;
      targets.push({ x: wrapX(Number(site.x) + ox), y });
    }
  }

  for (const { piece, d2 } of candidates) {
    for (const target of targets) {
      let result;
      try {
        result = issueOrder(match, side, piece.id, target.x, target.y);
      } catch (err) {
        continue;
      }
      if (result && result.ok && Array.isArray(result.path) && result.path.length > 0) {
        events.push({
          type: "bot_defend", side, pieceId: piece.id, site: site.id ?? site.name ?? null,
          threat: rows[0].threat, distance: Math.round(Math.sqrt(d2)),
          to: target, path: result.path,
        });
        claimed.add(piece.id);
        return claimed;
      }
    }
  }
  return claimed;
}

// A bot that only ever moves its opening two pieces is a bot a reviewer cannot see acting, and
// it can never press an advantage. It buys when it can afford to, up to this many pieces, and
// every purchase is reported as a bot_buy event so the server log and the owner's debug view
// both show it.
// The cap counts what the bot PRODUCED, not what it owns: an era that opens with the original's
// army (1942: 29-31 pieces) already sits over any total-piece cap, and counting the army would stop
// the bot buying forever (T-013b).
const BOT_UNIT_CAP = 6;

function botBuy(match, side, events, urgentSite = null) {
  const seat = match.sides && match.sides[side];
  if (!seat) return;
  if (Number(seat.bought || 0) >= BOT_UNIT_CAP) return;
  const price = priceOf("infantry");
  if (!Number.isFinite(price) || !Number.isFinite(seat.cash) || seat.cash < price) return;

  let board;
  try {
    board = boardPayload();
  } catch {
    return;
  }
  // Ownership is what placement reads, and the economy seeds it lazily.
  try {
    seedOwners(match);
  } catch {
    return;
  }
  let mask;
  try {
    mask = placementMask(match, side, "infantry", board);
  } catch {
    return;
  }
  if (mask.error || !mask.mask) return;

  // Prefer a cell near a site this side holds, so the new unit joins the war rather than
  // appearing in a corner. Mask byte 1 is a ready city or base; 2 is a friendly site that is
  // still unready, and a bot obeys the same readiness rule as the player (T-011 AC6).
  // When a site of ours is under threat, the original buys AT that site instead
  // (FUN_107e_1612, decompiled.c 1644-1657), so the threatened site is the anchor.
  const sites = urgentSite ? [urgentSite]
    : (match.sites || []).filter((site) => site && site.owner === side);
  let target = null;
  let best = Infinity;
  for (let id = 0; id < mask.mask.length; id++) {
    if (mask.mask[id] !== 1) continue;
    const x = id % CELL_W;
    const y = (id - x) / CELL_W;
    let gap = 0;
    for (const site of sites) {
      const dx = Math.abs(Number(site.x) - x);
      gap = Math.max(Math.min(dx, CELL_W - dx), Math.abs(Number(site.y) - y));
      if (gap < best) {
        best = gap;
        target = { x, y };
      }
    }
    if (!sites.length && !target) target = { x, y };
  }
  if (!target) return;

  let bought;
  try {
    bought = buy(match, side, "infantry", target.x, target.y, board);
  } catch {
    return;
  }
  if (bought && bought.ok) {
    events.push({ type: "bot_buy", side, kind: "infantry", at: { x: bought.piece.x, y: bought.piece.y }, pieceId: bought.piece.id });
  }
}

export function ordersFor(match, side) {
  const events = [];
  if (!match || !SIDES.has(side)) return events;
  if (!Array.isArray(match.pieces)) return events;
  if (match.over) return events;

  if (seatKind(match, side) === "human") {
    events.push({ type: "bot_skip", side, reason: "seat is human; the caller sends its orders" });
    return events;
  }

  const foe = opposite(side);
  const capital = match.capitals && match.capitals[foe];
  if (!capital || !Number.isInteger(capital.x) || !Number.isInteger(capital.y)) return events;

  const mine = match.pieces.filter((piece) => piece && piece.side === side);
  // A site of ours under attack is answered before the march, and answered by a unit the march
  // then leaves alone (that is what the original's per-site pass does: 0bd6, decompiled.c 1186-1213).
  const threatened = threatenedSites(match, side);
  // Reinforce first, so a unit bought this round can march this round. The buy goes to the
  // threatened site when there is one (FUN_107e_1612).
  botBuy(match, side, events, threatened.length ? threatened[0].site : null);
  const claimed = defendSites(match, side, events, threatened);
  // One focus for the whole army: a weak point of the enemy line once there is contact, the
  // capital until then.
  const focus = focusTarget(match, side, foe, capital);

  // The army marches on the player's capital. A piece already on a path keeps it; the army is
  // re-ordered only once it has arrived, so an order is not re-issued every round.
  for (const piece of mine) {
    if (piece.domain !== "land") continue;
    if (hasPath(piece)) continue;
    if (claimed.has(piece.id)) continue;
    marchOne(match, side, piece, focus, events);
  }

  // One sail: a ship that already has a path is left alone. Only an idle ship is routed. The
  // destination is a lane waypoint near the enemy capital - not the enemy ship's own cell,
  // which its crew occupies - so the sail is a real lane route rather than a refused order.
  const waypoints = (() => {
    try {
      return laneGraph(dataRootFor(match)).waypoints || [];
    } catch {
      return [];
    }
  })();
  const nearestLane = (target) => {
    let best = null;
    let bestDist = Infinity;
    for (const point of waypoints) {
      const dx = Math.abs(point.x - target.x);
      const wrap = Math.min(dx, 320 - dx);
      const dist = Math.max(wrap, Math.abs(point.y - target.y));
      if (dist < bestDist) {
        bestDist = dist;
        best = point;
      }
    }
    return best;
  };
  const seaTarget = nearestLane(capital) || { x: capital.x, y: capital.y };
  for (const piece of mine) {
    if (piece.domain !== "sea") continue;
    if (hasPath(piece)) continue;

    let route = null;
    try {
      route = seaRoute(dataRootFor(match), { x: piece.x, y: piece.y }, seaTarget);
    } catch {
      route = null;
    }

    // The lane lookup may snap the target onto water. If it has nothing yet, ask the movement
    // module for the target directly and let it refuse rather than inventing a route.
    const target = routeTarget(route) || seaTarget;
    let result;
    try {
      result = issueOrder(match, side, piece.id, target.x, target.y);
    } catch (err) {
      events.push(note(side, piece.id, err && err.message ? err.message : err));
      continue;
    }
    if (result && result.ok && Array.isArray(result.path) && result.path.length > 0) {
      events.push({ type: "bot_order", side, pieceId: piece.id, to: target, path: result.path });
    } else {
      events.push(note(side, piece.id, (result && result.error) || "no route"));
    }
  }

  return events;
}
