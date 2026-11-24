// The recon satellite as an OWNED, PERSISTENT UNIT. Owner: PB-224 (PM 8905 §2, ruled 2026-11-24).
//
// The manual's satellite is not a one-shot reveal. p.12 (L326-328): "Press Satellite. You'll see
// your satellite (in blue) over the Atlantic... The red satellite is over Europe." You select your
// own satellite and give it a destination. p.29 (L924-937): satellites are "purchased like any other
// unit", they move much faster than ground units, each move burns booster fuel, sweeping
// "ultimately knock[s] your satellite out of the sky", and its recon radius exposes every enemy unit
// except submarines (L326, L329, L936). p.29 L924: Show Satellites draws the insert box.
//
// WHY THIS IS NOT IN `match.pieces`
// The unit flies ABOVE the board. Everything that walks `match.pieces` is a ground/sea/air piece:
// movement collides on cells, combat pairs neighbours, `economy.occupy` captures the site a piece
// stands on, and the bot shops on what it can see. A satellite standing in `pieces` would block a
// cell, be shot at, and capture a city by orbiting over it. So its record is the manual's unit
// shape (id, side, kind, x, y, radius, fuel, orbit) kept in `match.satellites`, and this module is
// the ONLY writer. The view ships both sides' satellites to both seats: the original shows you the
// blue one over the Atlantic AND the red one over Europe at the same time (p.12), so an orbiting
// satellite is public information; only what it SEES is gated.
//
// Every number is a named STAND-IN in config `satellite` (see its `note`). Nothing here invents a
// radius, a speed or a fuel count of its own.

import { CELL_H, CELL_W } from "./board.mjs";
import { priceOf, rosterFor, rules } from "./rules.mjs";

const KIND = "reconSat";
const DOMAIN = "sat";

// Config, with a fallback that is still a labelled stand-in rather than a silent zero. A missing or
// malformed key falls back to the same number the config documents, so a host with a trimmed config
// plays the documented rule instead of a satellite with radius 0 that sees nothing.
// The resolved rules, memoised on the config object identity the same way `rules()` is: tickSatellites
// asks for these every room every round, and rebuilding a per-era map and two cells per room per
// round cost ~5% of the tick headroom the load test floors at 10x.
let cachedConfig = null;
let cachedRules = null;

export function satelliteRules() {
  const cfg = (rules() && rules().satellite) || {};
  if (cachedConfig === cfg && cachedRules) return cachedRules;
  const pick = (key, fallback) => {
    const value = Number(cfg[key]);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  };
  // startPerSide is a per-era map, not one number (PM 8913 §2): 1 for 1986 and 2023, where the
  // manual makes satellites an era feature (p.16 L439, p.29 L924), and 0 for every other era. A
  // scalar in a trimmed config is read as the 1986/2023 answer rather than silently turning the
  // opening off; any era not named starts with none.
  const perSide = cfg.startPerSide && typeof cfg.startPerSide === "object" && !Array.isArray(cfg.startPerSide)
    ? Object.fromEntries(Object.entries(cfg.startPerSide)
      .map(([era, count]) => [String(era), Math.max(0, Math.floor(Number(count) || 0))]))
    : (Number.isFinite(Number(cfg.startPerSide)) && Number(cfg.startPerSide) > 0
      ? { "1986": Math.floor(Number(cfg.startPerSide)), "2023": Math.floor(Number(cfg.startPerSide)) }
      : {});
  // The p.12 frame: blue over the Atlantic, red over Europe. The fallback cells are the same named
  // stand-ins the config carries, so a trimmed config plays the documented opening, not a blank map.
  const cells = cfg.startCells && typeof cfg.startCells === "object" ? cfg.startCells : {};
  const cell = (side, fallbackX, fallbackY) => {
    const at = cells[side] || {};
    const x = Number(at.x);
    const y = Number(at.y);
    return {
      x: Number.isFinite(x) ? Math.round(x) : fallbackX,
      y: Number.isFinite(y) ? Math.round(y) : fallbackY,
    };
  };
  const out = {
    scanRadius: Math.max(1, Math.floor(pick("scanRadius", 6))),
    speedCells: Math.max(1, Math.floor(pick("speedCells", 12))),
    fuelCapacity: Math.max(1, Math.floor(pick("fuelCapacity", 3))),
    fuelPerMove: Math.max(1, Math.floor(pick("fuelPerMove", 1))),
    startPerSide: perSide,
    startCells: { blue: cell("blue", 116, 38), red: cell("red", 158, 31) },
    killRadius: Math.max(1, Math.floor(pick("killRadius", 6))),
  };
  cachedRules = out;
  cachedConfig = cfg;
  return out;
}

export function satellitesFor(match) {
  return match && Array.isArray(match.satellites) ? match.satellites : [];
}

function listOf(match) {
  if (!match) return null;
  if (!Array.isArray(match.satellites)) match.satellites = [];
  return match.satellites;
}

export function satelliteById(match, id) {
  const list = satellitesFor(match);
  const wanted = String(id ?? "");
  return list.find((sat) => String(sat.id) === wanted) || null;
}

export function otherSide(side) {
  return side === "blue" ? "red" : "blue";
}

function eraHasSatellites(match) {
  return rosterFor(match && match.era).includes(KIND);
}

// Chebyshev distance with the board's cylindrical X, the same shape view.distance uses. Y does not
// wrap. Exported so a test can pin the radius edge without re-implementing it.
export function satelliteDistance(a, b) {
  const rawX = Math.abs(Number(a.x) - Number(b.x));
  const dx = Math.min(rawX, CELL_W - rawX);
  const dy = Math.abs(Number(a.y) - Number(b.y));
  return Math.max(dx, dy);
}

// The step list from here to there. The satellite flies over water, mountains and units alike, so
// the line is the whole route: no terrain cost, no lane graph, no collision. X wraps the short way.
function flightLine(from, to) {
  let dx = Number(to.x) - Number(from.x);
  if (dx > CELL_W / 2) dx -= CELL_W;
  if (dx < -CELL_W / 2) dx += CELL_W;
  const dy = Number(to.y) - Number(from.y);
  const steps = Math.max(Math.abs(dx), Math.abs(dy));
  const out = [];
  if (steps === 0) return out;
  const x0 = Number(from.x);
  const y0 = Number(from.y);
  for (let i = 1; i <= steps; i++) {
    const x = ((Math.round(x0 + (dx * i) / steps) % CELL_W) + CELL_W) % CELL_W;
    const y = Math.round(y0 + (dy * i) / steps);
    out.push({ x, y, pace: 1 });
  }
  return out;
}

// One record shape for the bought piece and the start-of-match piece, so a ruled change to the unit
// (a new field, a different fuel default) cannot land in one path and miss the other.
function satelliteRecord({ id, side, x, y, round, cfg }) {
  return {
    id,
    side,
    domain: DOMAIN,
    kind: KIND,
    x,
    y,
    path: [],
    pace: 1,
    facing: null,
    fighting: null,
    shots: 0,
    // The manual's shape: position (x/y), radius, fuel, orbit (p.29 L924-937).
    radius: cfg.scanRadius,
    fuel: cfg.fuelCapacity,
    fuelCapacity: cfg.fuelCapacity,
    orbit: true,
    boughtRound: Number(round) || 0,
  };
}

// --- the opening position ----------------------------------------------------------------------
//
// PM 8913 §2: a 1986 or 2023 start opens with one satellite per side ALREADY in orbit; every other
// era opens with none. p.12 (L326-328) is the only frame that shows a starting pair (blue over the
// Atlantic, red over Europe) and it is a tutorial, so both the count and the cells are STAND-INS
// (config `satellite.startPerSide` / `satellite.startCells`) and the DOSBox check is still owed.
// The id is `<side>:reconSat:setup`, outside the `<side>:<kind>:<n>` purchase namespace (seat.bought
// starts at 0), so the opening pair can never collide with a bought unit.
export function startSatellites(era) {
  const year = String(era ?? "");
  const cfg = satelliteRules();
  const count = Math.max(0, Math.floor(Number(cfg.startPerSide[year]) || 0));
  if (count <= 0 || !rosterFor(year).includes(KIND)) return [];
  const out = [];
  for (const side of ["blue", "red"]) {
    const cell = cfg.startCells[side];
    if (!cell) continue;
    for (let i = 0; i < count; i++) {
      out.push(satelliteRecord({
        id: `${side}:${KIND}:setup${i ? ":" + i : ""}`,
        side,
        x: cell.x,
        y: cell.y,
        round: 0,
        cfg,
      }));
    }
  }
  return out;
}

// --- buy ---------------------------------------------------------------------------------------
//
// AC1: buying reconSat creates a satellite piece owned by that side, at the picked point. There is
// no placement rule to satisfy: the manual's satellite is given a point on the satellite map, not a
// friendly city (p.29), so the only checks are the era, the purse and the cell.
export function buySatellite(match, side, x, y) {
  if (!match) return { error: "There is no match to buy into." };
  if (match.over) return { error: "The match is over." };
  if (side !== "blue" && side !== "red") return { error: `Unknown side: ${side}.` };
  if (!eraHasSatellites(match)) return { error: "There are no satellites in this era." };
  const seat = match.sides && match.sides[side];
  if (!seat) return { error: `Unknown side: ${side}.` };
  const cfg = satelliteRules();

  const px = Number(x);
  const py = Number(y);
  if (!Number.isInteger(px) || !Number.isInteger(py)) return { error: "A satellite needs a whole cell." };
  if (py < 0 || py >= CELL_H) return { error: "That point is off the map." };
  const wx = ((px % CELL_W) + CELL_W) % CELL_W;

  const price = priceOf(KIND);
  if (!Number.isFinite(price)) return { error: "There is no price for a recon satellite." };
  if (!Number.isFinite(Number(seat.cash)) || Number(seat.cash) < price) {
    return { error: `Not enough in ${side}'s pool for a recon satellite.` };
  }
  seat.cash = Number(seat.cash) - price;

  const list = listOf(match);
  // Same id namespace a purchase uses (`<side>:<kind>:<n>`, from seat.bought), so a satellite can
  // never collide with a bought unit or a setup piece.
  seat.bought = Number(seat.bought || 0) + 1;
  let serial = seat.bought;
  let id = `${side}:${KIND}:${serial}`;
  while (list.some((sat) => sat.id === id) || (match.pieces || []).some((unit) => unit.id === id)) {
    serial += 1;
    seat.bought = serial;
    id = `${side}:${KIND}:${serial}`;
  }

  const sat = satelliteRecord({ id, side, x: wx, y: py, round: match.round, cfg });
  list.push(sat);
  return { ok: true, satellite: sat, piece: sat, price };
}

// --- order -------------------------------------------------------------------------------------
//
// AC2: select plus destination moves it, faster than land or sea (the rate is satellite.speedCells,
// applied in tickSatellites; land walks 1-2 cells a round, a hull 3).
// AC4: each move spends fuel; the move that spends the last unit is still flown, and the satellite
// is then removed with a log line.
// The read-only plan the page hovers with: same validations, same line, nothing written.
export function planSatellite(match, side, id, toX, toY) {
  if (!match) return { error: "There is no match." };
  if (match.over) return { error: "The match is over." };
  const sat = satelliteById(match, id);
  if (!sat) return { error: "No such satellite: " + String(id ?? "") + "." };
  if (sat.side !== side) return { error: `That satellite belongs to ${sat.side}.` };
  const cfg = satelliteRules();
  if (Number(sat.fuel) < cfg.fuelPerMove) return { error: "That satellite has no booster fuel left." };
  const px = Number(toX);
  const py = Number(toY);
  if (!Number.isInteger(px) || !Number.isInteger(py)) return { error: "An order needs whole cells." };
  if (py < 0 || py >= CELL_H) return { error: "The destination is off the map." };
  const wx = ((px % CELL_W) + CELL_W) % CELL_W;
  if (Number(sat.x) === wx && Number(sat.y) === py) return { error: "That satellite is already over that cell." };
  const path = flightLine(sat, { x: wx, y: py });
  return { ok: true, path, rounds: Math.max(1, Math.ceil(path.length / cfg.speedCells)) };
}

export function orderSatellite(match, side, id, toX, toY) {
  if (!match) return { error: "There is no match." };
  if (match.over) return { error: "The match is over." };
  const sat = satelliteById(match, id);
  if (!sat) return { error: "No such satellite: " + String(id ?? "") + "." };
  if (sat.side !== side) return { error: `That satellite belongs to ${sat.side}.` };
  if (sat.orbit !== true) return { error: "That satellite is no longer in orbit." };
  const cfg = satelliteRules();
  if (Number(sat.fuel) < cfg.fuelPerMove) return { error: "That satellite has no booster fuel left." };

  const px = Number(toX);
  const py = Number(toY);
  if (!Number.isInteger(px) || !Number.isInteger(py)) return { error: "An order needs whole cells." };
  if (py < 0 || py >= CELL_H) return { error: "The destination is off the map." };
  const wx = ((px % CELL_W) + CELL_W) % CELL_W;
  if (Number(sat.x) === wx && Number(sat.y) === py) return { error: "That satellite is already over that cell." };

  const path = flightLine(sat, { x: wx, y: py });
  if (!path.length) return { error: "That satellite is already over that cell." };
  sat.path = path;
  sat.pace = 1;
  sat.fuel = Number(sat.fuel) - cfg.fuelPerMove;
  // The last boost is a boost: the piece finishes the move it paid for and falls after it.
  sat.expiring = Number(sat.fuel) <= 0;
  return {
    ok: true,
    path: path.map((step) => ({ ...step })),
    rounds: Math.max(1, Math.ceil(path.length / cfg.speedCells)),
    fuel: sat.fuel,
  };
}

// --- the round ---------------------------------------------------------------------------------
//
// AC3: each round, enemy units inside the scan radius are revealed, never submarines. The stamp is
// `revealedRound`, the same field the intel bar uses, so `view.visibleEnemy` sends the piece for the
// round it was scanned. PB-222's rule (a satellite never carries a submarine) is kept here, at the
// piece, instead of in the old worldwide tool.
function revealFrom(match, sat, cfg, events) {
  const round = Number(match.round) || 0;
  const radius = cfg.scanRadius;
  const sx = Number(sat.x);
  const sy = Number(sat.y);
  let reveals = 0;
  for (const unit of match.pieces || []) {
    if (!unit || unit.side === sat.side) continue;
    // L326/L329/L936: submarines are always hidden from air and satellite scanning.
    if (unit.kind === "submarine") continue;
    // Chebyshev with the board's cylindrical X, inlined and with the Y band first: this runs for
    // every piece for every satellite every round, inside the tick budget the load test floors.
    const dy = Math.abs(Number(unit.y) - sy);
    if (dy > radius) continue;
    const rawX = Math.abs(Number(unit.x) - sx);
    const dx = rawX < CELL_W - rawX ? rawX : CELL_W - rawX;
    if ((dx > dy ? dx : dy) > radius) continue;
    unit.revealedRound = round;
    reveals += 1;
  }
  if (reveals > 0) {
    events.push({
      type: "satellite",
      side: sat.side,
      pieceId: sat.id,
      x: sat.x,
      y: sat.y,
      round,
      reveals,
      radius: cfg.scanRadius,
    });
  }
  return reveals;
}

// One running round for every satellite in orbit: fly, look, and fall if the last boost is spent.
// Tick order is inside tickMatch, so a held clock or a finished match never reaches here.
export function tickSatellites(match) {
  const events = [];
  if (!match || match.over) return events;
  const list = listOf(match);
  if (!list.length) return events;
  const cfg = satelliteRules();
  const down = [];
  for (const sat of list) {
    if (!sat || sat.orbit !== true) continue;
    const speed = cfg.speedCells;
    let stepped = 0;
    while (Array.isArray(sat.path) && sat.path.length > 0 && stepped < speed) {
      const next = sat.path.shift();
      sat.x = next.x;
      sat.y = next.y;
      stepped += 1;
    }
    sat.movedRound = stepped > 0 ? Number(match.round) || 0 : sat.movedRound;
    if (Array.isArray(sat.path) && sat.path.length === 0) sat.arrivedRound = Number(match.round) || 0;
    // The radius is carried per piece and re-read from config each round, so a config edit moves the
    // runtime and a satellite bought under an older number does not keep a stale one forever.
    sat.radius = cfg.scanRadius;
    revealFrom(match, sat, cfg, events);
    const spent = sat.expiring === true || Number(sat.fuel) <= 0;
    if (spent && (!Array.isArray(sat.path) || sat.path.length === 0)) down.push(sat);
  }
  for (const sat of down) {
    const at = list.indexOf(sat);
    if (at >= 0) list.splice(at, 1);
    sat.orbit = false;
    events.push({
      type: "satellite_down",
      side: sat.side,
      pieceId: sat.id,
      x: sat.x,
      y: sat.y,
      round: Number(match.round) || 0,
      reason: "fuel",
    });
  }
  return events;
}

// The payload shape. Both sides' satellites travel (p.12 shows both), so nothing here is filtered by
// seat; what a satellite SEES is still gated by `revealedRound` in view.forSeat.
export function satelliteView(match) {
  return satellitesFor(match).map((sat) => ({
    id: sat.id,
    side: sat.side,
    domain: DOMAIN,
    kind: KIND,
    x: sat.x,
    y: sat.y,
    path: Array.isArray(sat.path) ? sat.path.map((step) => ({ ...step })) : [],
    pace: sat.pace,
    radius: sat.radius,
    fuel: sat.fuel,
    fuelCapacity: sat.fuelCapacity,
    orbit: sat.orbit !== false,
  }));
}
