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
import { seaRoute } from "./lanes.mjs";
import { issueOrder, wrapDelta, wrapX, HOLD_STALL_ROUNDS } from "./move.mjs";
import {
  botAttackRangeCells,
  botThreatRadii,
  defaultOpponentLevel,
  dispatchRepeatPool,
  forceAdvantageUnits,
  isRefused,
  levelFiveGarrisonGate,
  opponentLevelOf,
  priceOf,
  spareActionPassCap,
} from "./rules.mjs";
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

function occupantAt(match, piece, x, y) {
  const wx = wrapX(x);
  return (match.pieces || []).find(
    (unit) => unit && unit.id !== piece.id && wrapX(unit.x) === wx && Number(unit.y) === Number(y)
  ) || null;
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
      // A piece never shares a cell with a friend. An enemy-held cell is reachable only as an
      // attack, so it enters the list only when calculate_combat's force edge clears (T-032 B4).
      const occupant = occupantAt(match, piece, x, y);
      if (occupant) {
        if (occupant.side === piece.side) continue;
        if (!landAttackAllowed(match, piece.side, { x, y })) continue;
      }
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
      out.push({ x, y, gap, defenders: friends, holder: holder.id,
        attackAllowed: landAttackAllowed(match, piece.side, { x, y }) });
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

function cellKey(cell) {
  return wrapX(cell.x) + "," + Number(cell.y);
}

// `0xe94c` as the port spends it: 3410-3416 for an army dispatch, 1649-1651 for the buy.
//   pool > 0  -> decrement, and the destination is NOT recorded, so the next iteration is free to
//                choose the same cell again (this is the repeat);
//   pool == 0 -> record the destination (3410-3412), and 3392-3400 then strike that cell out of the
//                next iteration's candidates (the 0xf at 3398) - this is the record.
// The buy passes no cell: it spends a repeat where there is one and records nothing otherwise.
// Nothing here refuses on the counter; the binary only ever tests it against zero.
export function spendRepeat(state, cell = null) {
  const key = cell ? cellKey(cell) : null;
  if (state.pool > 0) {
    state.pool -= 1;
    return { repeat: true, cell: key, recorded: false };
  }
  if (key) state.recorded.add(key);
  return { repeat: false, cell: key, recorded: Boolean(key) };
}

// Exported so the ring case can be driven directly: the endgame state is hard to reach through
// ordersFor, which picks a focus of its own first.
export function marchOne(match, side, piece, capital, events, options = {}) {
  // 3392-3400: a destination cell recorded this turn is struck out of the candidate table, so the
  // loop cannot pick it again. `skip` is that table's exclusion.
  const skip = options && options.skip instanceof Set ? options.skip : null;
  const all = approachCells(match, piece, capital);
  const cells = skip ? all.filter((cell) => !skip.has(cellKey(cell))) : all;
  if (cells.length === 0 && all.length > 0) {
    events.push(note(side, piece.id, "every approach cell beside the focus is already recorded this turn"));
    return null;
  }
  if (cells.length === 0) {
    // The ring is full: attack its weakest point rather than stand still. Units do not stack, so
    // there is no cell to queue on and no order to give except the one the engine calls an attack.
    // T-032 B4: an attack still needs calculate_combat's force edge, so a ringed capital with no
    // edge is a stall and says so instead of feeding pieces into a losing exchange.
    const ring = assaultCells(match, piece, capital);
    const targets = ring.filter((cell) => cell.attackAllowed);
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
        return { x: cell.x, y: cell.y };
      }
    }
    events.push(note(side, piece.id, targets.length
      ? "ringed, and no attack could be issued"
      : (ring.length ? "ringed, and no attack has the force edge" : "no approach cell beside the capital")));
    return null;
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
      // An approach cell that is enemy-held IS an attack: the engine treats the move as one, and
      // the event must say so (T-032 B4). Flagging only the full-ring branch left an attack that
      // reached a ring cell through the march path indistinguishable from a walk.
      const holder = occupantAt(match, piece, cell.x, cell.y);
      const assault = Boolean(holder && holder.side !== piece.side);
      events.push({ type: "bot_order", side, pieceId: piece.id, to: { x: cell.x, y: cell.y },
        path: result.path, ...(assault ? { assault: true, defenders: assaultCells(match, piece, capital)
          .find((row) => row.x === cell.x && row.y === cell.y)?.defenders ?? 0 } : {}) });
      return { x: cell.x, y: cell.y };
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
    if (skip && skip.has(cellKey(mid))) continue;
    // A staged mid-point is still a cell an order lands on; the force gate applies to it too.
    const occupant = occupantAt(match, piece, mid.x, mid.y);
    if (occupant && (occupant.side === piece.side || !landAttackAllowed(match, side, mid))) continue;
    let result;
    try {
      result = issueOrder(match, side, piece.id, mid.x, mid.y);
    } catch (err) {
      last = err && err.message ? err.message : err;
      continue;
    }
    if (result && result.ok && Array.isArray(result.path) && result.path.length > 0) {
      events.push({ type: "bot_order", side, pieceId: piece.id, to: mid, path: result.path, staged: true });
      return { x: mid.x, y: mid.y };
    }
    last = (result && result.error) || "no path";
  }
  events.push(note(side, piece.id, last));
}

// ---- capital defence (T-015 Part B) ---------------------------------------
//
// Ported from the two routines T-013 cited as missing. Both act on a SITE, not a piece:
// `FUN_107e_0bd6 @ 107e:0bd6` (decompiled.c 1126-1268) walks the 84 sites in ascending order of
// the site's score byte `0xea6e`, up to three actions a pass, and calls
//   FUN_107e_1612 @ 107e:1612 (decompiled.c 1607-1657) — buy a defender AT the site, and
//   FUN_107e_1750 @ 107e:1750 (decompiled.c 1661-1778) — send an existing land unit TO it.
// `0xea6e` is rewritten every AI turn from `FUN_107e_0fa4(site,0,0)` (decompiled.c 112-114,
// 1304-1602), the site's own threat score: every piece inside the site's radius adds strength/25,
// positive when it belongs to the site's owner and negative when it does not (decompiled.c
// 1487-1507, 1442-1465). A site of ours therefore scores negative when enemies near it outweigh its
// friends, and the defence routines only fire on a negative score (decompiled.c 1190).
const DEFEND_RADIUS_SITE = botThreatRadii().otherSite; // local_28 = 0xf, decompiled.c 1355-1356
const DEFEND_RADIUS_OWN_CITY = botThreatRadii().ownSite; // local_28 = 0x14 when our site kind < 3, 1352-1353
const DEFEND_RADIUS_CAPITAL = botThreatRadii().capital; // local_28 = 0x19 for the flagged site at 0xe47e, 1358-1359
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

// ---- opponent level and the force threshold (T-032 Part B) ----------------
//
// The level is a property of the seat, not of the caller: `match.opponentLevel` is stamped by the
// lobby (lobby.startBot) and survives a reload with the rest of the match. A missing field reads as
// the lobby's default, so a room opened before T-032 keeps playing the way it did.
export function botLevel(match) {
  const raw = match && (match.opponentLevel ?? (match.bot && match.bot.level));
  const level = opponentLevelOf(raw);
  return level === null ? defaultOpponentLevel() : level;
}

// A level-1 opponent never enters the AI pass at all: the original gates the turn hook on
// `1 < 0x1a0` (T-032 Part A, docs/re/AI.md section 1). Level 1 is the practice opponent, not a
// quiet version of level 2.
export function entersAiPass(level) {
  return Number(level) > 1;
}

function insideRange(a, b, cells) {
  return squaredDistance(a, b) <= cells * cells;
}

// calculate_combat's force sum: friendly strength minus hostile strength inside the attack
// radius, counted in strength units. Strength is 0..maxStrength in the remake, so the original's
// "more than 11 strength units" compares directly.
export function forceAdvantage(match, side, target) {
  if (!match || !Array.isArray(match.pieces) || !target) return 0;
  const range = botAttackRangeCells();
  let mine = 0;
  let theirs = 0;
  for (const piece of match.pieces) {
    if (!piece) continue;
    const strength = Number(piece.strength);
    if (!Number.isFinite(strength) || strength <= 0) continue;
    if (!insideRange(target, piece, range)) continue;
    if (piece.side === side) mine += strength;
    else theirs += strength;
  }
  return mine - theirs;
}

// A land attack is ordered only with a force advantage strictly greater than 11 strength units
// inside 30 cells (calculate_combat, T-032 A4). Moving onto an enemy-held cell IS an attack in
// this engine, so the gate sits on the order, not on a separate attack verb.
export function landAttackAllowed(match, side, target) {
  if (!target) return false;
  if (!Number.isFinite(Number(target.x)) || !Number.isFinite(Number(target.y))) return false;
  return forceAdvantage(match, side, target) > forceAdvantageUnits();
}

// select_combat_targets: ships and air target only ships and air, never land (T-032 A4). A ship's
// target set is the enemy's ships; an aircraft may also strike enemy ships. Land pieces are never
// in the set, so a bot cruiser cannot be ordered to sail at a city.
export function selectCombatTargets(match, side) {
  if (!match || !Array.isArray(match.pieces)) return [];
  const enemy = match.pieces.filter((piece) => piece &&
    piece.side !== side && (piece.domain === "sea" || piece.domain === "air"));
  const out = [];
  for (const attacker of match.pieces) {
    if (!attacker || attacker.side !== side) continue;
    if (attacker.domain !== "sea" && attacker.domain !== "air") continue;
    const allowed = enemy
      .filter((target) => (attacker.domain === "sea" ? target.domain === "sea" : true))
      .map((target) => ({ attacker, target, distance: Math.round(Math.sqrt(squaredDistance(attacker, target))) }))
      .sort((a, b) => a.distance - b.distance);
    if (allowed.length) out.push(allowed[0]);
  }
  return out;
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

// A dug-in land piece standing on one of its own side's capitals is that capital's garrison. The
// march below is the remake's own behaviour, not a ported routine, so this is a behaviour rule and
// not a fidelity claim: measured on 37b7537 and on this branch before this line existed, red's
// Paris garrison marched east from round 1 and the capital sat empty from r1 on, which makes
// "garrisoned capitals hold" unobservable in a live match. The original's dug-in infantry stays on
// the city and fights there (duel-original.txt). Keep it home.
//
// The cell set is built once per call because the march asks this per piece per pass and the 1000-room
// bench pays for anything that walks `match.sites` each time (sites ~600, capitals ~30).
export function capitalCells(match, side) {
  const cells = new Set();
  const list = match && match.capitalSet && Array.isArray(match.capitalSet.list) ? match.capitalSet.list : [];
  if (!list.length || !Array.isArray(match.sites)) return cells;
  const byId = new Map();
  for (const place of match.sites) {
    if (place) byId.set(Number(place.id), place);
  }
  for (const capital of list) {
    const site = byId.get(Number(capital && capital.siteId));
    if (!site || site.owner !== side) continue;
    cells.add(Number(site.x) + "," + Number(site.y));
  }
  return cells;
}

export function holdsOwnCapital(match, side, piece, cells = null) {
  if (!piece || piece.domain !== "land" || piece.entrenched !== true) return false;
  const held = cells || capitalCells(match, side);
  return held.has(Number(piece.x) + "," + Number(piece.y));
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

// Send units to the most threatened sites, most threatened first: nearest idle land unit between 3
// and 50 cells away (decompiled.c 1727-1728 picks the smallest adjusted distance and rejects
// anything beyond 2500 or closer than 9 squared). ONE site costs ONE of the pass's three actions
// and sends exactly ONE unit: `FUN_107e_1750` orders a single unit onto the site's own cell
// (1770-1773) and returns 1, and 0bd6 adds 1 to its counter for the call (1192). The e94c repeat
// allowance is NOT spent here — it belongs to the army pass (ai_turn_process, 3230-3422) and to the
// buy (1649-1651). A site cell its own garrison already stands on refuses the order, so the
// fallback is the nearest free neighbour — a bot decision, not a combat rule.
export function defendSites(match, side, events, threatened = null, limit = 1) {
  const claimed = new Set();
  const rows = threatened || threatenedSites(match, side);
  const budget = Math.max(0, Math.floor(Number(limit) || 0));
  const perSite = 1;
  if (rows.length === 0 || budget === 0) return { claimed, actions: 0 };
  // Built once per pass: the candidate filter asks per piece.
  const held = capitalCells(match, side);
  let actions = 0;

  // 0bd6 walks the sites in score order and acts on each threatened one until its three successful
  // actions run out (decompiled.c 1174-1203). One dispatch to a site is one action and one unit
  // (1192, 1770-1773); the level does not enter this loop.
  for (const row of rows) {
    const site = row.site;
    const candidates = (match.pieces || [])
      .filter((piece) => piece && piece.side === side && piece.domain === "land" &&
        !hasPath(piece) && Number(piece.strength) > 0 && !claimed.has(piece.id))
      // A dug-in garrison standing on its own capital is not a spare defender: sending it at a
      // threatened neighbour empties the capital, and a lone tank then walks in. Measured live on
      // ad71410: Paris' garrison left at r6 and the tank took Paris at r20
      // (local/t015-shots/t015-garrison-handcheck.json); pinned in nodes/t015_capital.mjs 3b.
      .filter((piece) => !holdsOwnCapital(match, side, piece, held))
      .map((piece) => ({ piece, d2: squaredDistance(piece, site) }))
      // `8 < local_8`, and `0x18 < local_8` for kind 3 (infantry) — decompiled.c 1720.
      .filter((candidate) => candidate.d2 > (candidate.piece.kind === "infantry" ? DEFEND_MIN_INFANTRY : DEFEND_MIN) &&
        candidate.d2 <= DEFEND_REACH)
      .sort((a, b) => a.d2 - b.d2);
    if (candidates.length === 0) continue;

    const targets = [{ x: site.x, y: site.y }];
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        if (ox === 0 && oy === 0) continue;
        const y = Number(site.y) + oy;
        if (y < 0 || y >= CELL_H) continue;
        targets.push({ x: wrapX(Number(site.x) + ox), y });
      }
    }

    let sent = 0;
    for (const { piece, d2 } of candidates) {
      if (sent >= perSite) break;
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
            threat: row.threat, distance: Math.round(Math.sqrt(d2)),
            to: target, path: result.path,
          });
          claimed.add(piece.id);
          sent += 1;
          break;
        }
      }
      // The original rescores the sites it touched after acting (decompiled.c 1235-1237) and only
      // acts on a site whose score is still negative (1190). Break as soon as the site is no longer
      // under threat, so one answered site cannot take a second action.
      if (sent > 0 && siteThreat(match, site) >= 0) break;
    }
    if (sent > 0) actions += 1;
    if (actions >= budget) break;
  }
  return { claimed, actions };
}

// A bot that only ever moves its opening two pieces is a bot a reviewer cannot see acting, and
// it can never press an advantage. It buys when it can afford to, and every purchase is reported
// as a bot_buy event so the server log and the owner's debug view both show it.
//
// NO PRODUCTION CAP. The original has none - 0bd6 and the buy routine FUN_107e_1612 read no piece
// count, only money, a free slot and the site - and T-032 AC5 allows only the e94c lever plus the
// level-5 gate. The earlier `unitCap 6` was a browser pacing choice and is withdrawn, not raised.

// A free unit slot: `FUN_1ac5_0008 @ 1ac5:0008` (decompiled.c 8105-8136). For a combat kind it
// scans the 100 unit records at 0x906 for the first zero byte (8115) and returns 0xff when every
// record is taken (8118, 8132-8133). `FUN_107e_1612` refuses the buy on that 0xff (1629) before it
// even chooses the site. The remake keeps one record per piece, so the gate is the table's bound -
// not a production cap: nothing tells the bot to stay under a count, the board simply fills.
export const UNIT_RECORDS = 100;

export function hasFreeUnitSlot(match) {
  const pieces = match && Array.isArray(match.pieces) ? match.pieces : [];
  return pieces.length < UNIT_RECORDS;
}

// A dug-in piece of ours standing on `site`'s own cell. The level-5 garrison-buy exclusion
// (T-032 A7, marked STAND-IN in config) is the one gate beyond the e94c repeat pool.
function siteHasGarrison(match, side, site) {
  if (!site) return false;
  return (match.pieces || []).some((piece) => piece && piece.side === side &&
    piece.domain === "land" && piece.entrenched === true &&
    Number(piece.x) === Number(site.x) && Number(piece.y) === Number(site.y));
}

function botBuy(match, side, events, urgentSite = null) {
  const seat = match.sides && match.sides[side];
  if (!seat) return false;
  const level = botLevel(match);
  // Level-5 gate (STAND-IN, T-032 A7): do not buy a defender at a site its own dug-in garrison
  // already holds. Level 5 is the only level that carries the gate.
  if (level >= 5 && levelFiveGarrisonGate() && urgentSite && siteHasGarrison(match, side, urgentSite)) {
    return false;
  }
  const price = priceOf("infantry");
  if (!Number.isFinite(price) || !Number.isFinite(seat.cash) || seat.cash < price) return false;

  // 1629, in the original's order: paused/film (1620), money on the 40-divisor scale (1621-1627),
  // the price byte (1628), then the free slot. A full board refuses the buy outright.
  if (!hasFreeUnitSlot(match)) {
    events.push({
      type: "bot_skip", side,
      reason: "no free unit slot: FUN_1ac5_0008(0) == 0xff (decompiled.c 1629; table 8115-8133)",
    });
    return false;
  }

  let board;
  try {
    board = boardPayload();
  } catch {
    return false;
  }
  // Ownership is what placement reads, and the economy seeds it lazily.
  try {
    seedOwners(match);
  } catch {
    return false;
  }
  let mask;
  try {
    mask = placementMask(match, side, "infantry", board);
  } catch {
    return false;
  }
  if (mask.error || !mask.mask) return false;

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
  if (!target) return false;

  let bought;
  try {
    bought = buy(match, side, "infantry", target.x, target.y, board);
  } catch {
    return false;
  }
  if (bought && bought.ok) {
    events.push({ type: "bot_buy", side, kind: "infantry", at: { x: bought.piece.x, y: bought.piece.y }, pieceId: bought.piece.id });
    return true;
  }
  return false;
}

// PB-250: how many CITIES a seat holds. The manual's cease-fire question is about ground held, so
// a city or a capital counts and a base/dock/oilfield does not; `sites` carries one row per named
// place with the owner that last took it, which is the same table the board draws.
const CITY_KINDS = new Set(["city", "capital"]);

export function citiesHeld(match, side) {
  if (!match || !SIDES.has(side) || !Array.isArray(match.sites)) return 0;
  let held = 0;
  for (const site of match.sites) {
    if (!site || site.owner !== side) continue;
    if (CITY_KINDS.has(String(site.kind))) held += 1;
  }
  return held;
}

// PB-250: does the bot ACCEPT a cease fire that was proposed to it?
//
// PORT DECISION, not a recovered rule. The original's AI both offers and answers a cease fire -
// docs/re/AI.md:369-375 carries "Do you want a cease fire? (y/n)" and the answer "No cease fire" -
// but the trigger that makes it say yes is unresolved (AI.md:441; it needs disassembly and is
// recorded UNVERIFIED on PB-250). So the shipped rule is stated here instead of guessed at:
//
//   THE BOT ACCEPTS ONLY WHEN IT HOLDS FEWER CITIES THAN THE PROPOSER.
//
// A side behind on ground wants the shooting to stop; a side level or ahead declines and fights
// on. It is deterministic - no RNG, no clock, no seat name - so a leg can pin both answers by
// moving one city, and a replay of the same board always answers the same way.
export function botCeasefireAnswer(match, side) {
  if (!match || !SIDES.has(side)) return false;
  const truce = match.ceasefire && typeof match.ceasefire === "object" ? match.ceasefire : null;
  const by = truce && (truce.by === "blue" || truce.by === "red") ? truce.by : null;
  if (!by || by === side) return false;
  return citiesHeld(match, side) < citiesHeld(match, by);
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

  // T-032 B2: the turn hook is gated on 1 < 0x1a0. Level 1 is not a slow opponent, it is the
  // practice opponent that never acts: no orders, no buys, one note so the room can say why.
  const level = botLevel(match);
  if (!entersAiPass(level)) {
    events.push({ type: "bot_skip", side, level, reason: "level 1 stands still: the AI pass is gated on 1 < 0x1a0" });
    return events;
  }

  const mine = match.pieces.filter((piece) => piece && piece.side === side);
  // A site of ours under attack is answered before the march, and answered by a unit the march
  // then leaves alone (that is what the original's per-site pass does: 0bd6, decompiled.c 1186-1213).
  const threatened = threatenedSites(match, side);
  // 0bd6 allows THREE successful actions a pass at every level: `local_c` is one shared counter,
  // read against 3 at nine places (1194, 1197, 1208, 1211, 1217, 1241, 1246, 1249, 1253) and
  // incremented at 1188, 1192, 1195, 1199, 1209, 1213, 1218, 1222, 1226, 1244, 1247, 1251 (+3),
  // 1254 and 1265; the combat tail is gated at 4 (1220, 1224, 1228, 1256, `4 - local_c` at
  // 1257/1262/1264). Nothing in 1126-1268 reads 0xe94c or 0x1a0.
  const budget = spareActionPassCap();
  // 0xe94c for this turn: set only when 1 < 0x1a0 (decompiled.c 13231-13232, 15157-15158), so a
  // level-1 seat never even sets it. It is how many army dispatches may repeat a destination cell
  // before that cell is recorded and struck out of the candidate table (3392-3400, 3410-3412), not
  // the pass allowance above.
  const repeat = { pool: dispatchRepeatPool(level), recorded: new Set() };
  let spent = 0;
  // Reinforce first, so a unit bought this round can march this round. The buy goes to the
  // threatened site when there is one (FUN_107e_1612) and spends one pass action; it also spends a
  // repeat where one is left and never refuses on the counter (1649-1651).
  if (spent < budget && botBuy(match, side, events, threatened.length ? threatened[0].site : null)) {
    spent += 1;
    spendRepeat(repeat);
  }
  const defence = defendSites(match, side, events, threatened, budget - spent);
  const claimed = defence.claimed;
  spent += defence.actions;
  // One focus for the whole army: a weak point of the enemy line once there is contact, the
  // capital until then.
  const focus = focusTarget(match, side, foe, capital);
  const garrisonCells = capitalCells(match, side);
  // 3385: the army pass asks the same table before a dispatch and returns on 0xff - a full board is
  // a pass with no dispatch, not a dispatch that fails. 0bd6's buy already refused at 1629, and the
  // sea targeting below is 0bd6's tail (1224), outside this routine, so it still runs.
  const armyTableFull = !hasFreeUnitSlot(match);
  if (armyTableFull) {
    events.push({
      type: "bot_skip", side,
      reason: "the army pass returns at 3385: no free unit record (FUN_1ac5_0008 == 0xff; table 8115-8133)",
    });
  }

  // The army marches on the player's capital. A piece already on a path keeps it; the army is
  // re-ordered only once it has arrived, so an order is not re-issued every round.
  //
  // PB-197: "already on a path" is not the same as "making progress". A unit held for more than
  // HOLD_STALL_ROUNDS rounds - the per-step counter advance() keeps - is re-planned onto a fresh
  // goal instead of reporting "moving" forever. marchOne picks the nearest free approach cell, so a
  // destination that is still held is skipped and another one is chosen.
  for (const piece of mine) {
    if (armyTableFull) break;
    if (piece.domain !== "land") continue;
    if (claimed.has(piece.id)) continue;
    if (hasPath(piece)) {
      if (Number(piece.holdRounds || 0) <= HOLD_STALL_ROUNDS) continue;
      piece.holdRounds = 0;
      piece.path = [];
      events.push({
        type: "bot_replan",
        side,
        pieceId: piece.id,
        round: Number(match.round) || 0,
        reason: "held for more than " + HOLD_STALL_ROUNDS + " rounds",
      });
    }
    // The capital's own dug-in garrison holds its cell; see holdsOwnCapital.
    if (holdsOwnCapital(match, side, piece, garrisonCells)) continue;
    const destination = marchOne(match, side, piece, focus, events, { skip: repeat.recorded });
    if (!destination) continue;
    const step = spendRepeat(repeat, destination);
    // Say which branch ran, so a leg can count repeats and records apart from each other.
    const filed = events[events.length - 1];
    if (filed && filed.type === "bot_order" && filed.pieceId === piece.id) {
      filed.repeat = step.repeat;
      filed.recorded = step.recorded;
      filed.repeatPool = repeat.pool;
    }
  }

  // select_combat_targets: a ship is pointed only at the enemy's ships. Sailing at a capital is a
  // land attack, and the archive never gives a ship one (T-032 B4). With no enemy hull afloat the
  // ship holds, and says so.
  const seaTargets = selectCombatTargets(match, side).filter((row) => row.attacker.domain === "sea");
  const seaTargetFor = new Map(seaTargets.map((row) => [row.attacker.id, row.target]));
  for (const piece of mine) {
    if (piece.domain !== "sea") continue;
    if (hasPath(piece)) continue;

    const enemyShip = seaTargetFor.get(piece.id) || null;
    if (!enemyShip) {
      events.push(note(side, piece.id, "no enemy ship to engage"));
      continue;
    }
    const seaTarget = { x: Number(enemyShip.x), y: Number(enemyShip.y) };

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
