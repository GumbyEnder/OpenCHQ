// Node test for PB-224: the recon satellite is an OWNED, PERSISTENT UNIT.
//
// PM 8905 §2 (ruled 2026-11-24) ordered PB-224 first: the recon satellite as a unit, then PB-231's
// killer on top of it. The manual: p.12 L326-328 (a satellite per side, over the Atlantic/Europe,
// selected and given a destination), p.29 L924-937 (bought like any other unit, much faster than
// ground units, booster fuel per move, sweeping eventually knocks it out of the sky; its radius
// exposes every enemy unit except submarines), p.29 L924 (Show Satellites).
//
// The card's acceptance criteria, one arm each:
//   AC1 buy creates a satellite piece owned by that side at the picked point
//   AC2 select + destination moves it, faster than land or sea
//   AC3 each round, enemies inside its radius are revealed, never submarines (PB-222 held)
//   AC4 each move spends fuel; at 0 the satellite is removed, with a log line
//   AC5 the opponent's satellite is visible on the Show Satellites view
//   AC6 these tests, plus a live leg (the leg is the shipped run, not this file)
//
// Every number is read from config `satellite`, which labels all of them STAND-INS (see its note).

import { CELL_H } from "../../server/board.mjs";
import { openMatch } from "../../server/match.mjs";
import { forSeat } from "../../server/view.mjs";
import { cellsPerRound } from "../../server/rules.mjs";
import { logLines } from "../../server/log.mjs";
import { buySatellite, orderSatellite, satelliteRules, tickSatellites } from "../../server/satellite.mjs";
import { paintSatelliteInset, paintSatelliteRings } from "../../public/render.mjs";

export const name = "pb224_satellite_unit";

function fail(message) {
  throw new Error("node test pb224_satellite_unit: " + message);
}

function eq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) fail(label + ": " + a + " !== " + b);
}

function unit(id, side, kind, domain, x, y) {
  return { id, side, domain, kind, x, y, path: [], pace: 1, facing: null, fighting: null, shots: 0, movedRound: -1 };
}

function fresh(era = "1986") {
  const match = openMatch(era, []);
  match.clock = "running";
  match.sides.blue.cash = 50000;
  match.sides.red.cash = 50000;
  match.round = 5;
  match.sites = [
    { id: 10, name: "New York", x: 80, y: 40, kind: "city", owner: "blue" },
    { id: 12, name: "Kiev", x: 200, y: 40, kind: "city", owner: "red" },
  ];
  match.capitalSet = { era, source: "fixture", list: [], missing: [] };
  match.pieces = [];
  // The start-of-match pair is its own arm below; a buy arm starts from an empty satellite map so
  // the pick and the id counter are measured against nothing but the purchase.
  match.satellites = [];
  return match;
}

// A ctx that records what the painter was asked to draw. The canvas is pixels; the node has no
// canvas, and this file's job is to pin what the layer DRAWS, not to re-implement a rasteriser.
function recordingCtx() {
  const calls = { arcs: 0, text: [], rects: 0, layers: [] };
  return {
    calls,
    save() { calls.layers.push("save"); },
    restore() { calls.layers.push("restore"); },
    beginPath() {},
    stroke() {},
    fill() {},
    arc() { calls.arcs += 1; },
    fillRect() { calls.rects += 1; },
    strokeRect() { calls.rects += 1; },
    fillText(text) { calls.text.push(String(text)); },
    set strokeStyle(value) { calls.strokeStyle = value; },
    set fillStyle(value) { calls.fillStyle = value; },
    set lineWidth(value) { calls.lineWidth = value; },
    set globalAlpha(value) { calls.globalAlpha = value; },
    set font(value) { calls.font = value; },
    set textBaseline(value) { calls.textBaseline = value; },
    setLineDash() {},
  };
}

export async function run(ctx) {
  const cfg = satelliteRules();
  const VIEW = { scale: 4, boardW: 320, boardH: 136, viewW: 640, viewH: 300, left: 0, top: 0 };

  // --- AC1: the buy creates an owned piece at the picked point ------------------------------
  {
    const match = fresh();
    const before = match.sides.blue.cash;
    const bought = buySatellite(match, "blue", 100, 40);
    if (bought.error) fail("a 1986 blue satellite was refused: " + bought.error);
    const sat = bought.satellite;
    eq("the satellite is blue's", sat.side, "blue");
    eq("the satellite's kind", sat.kind, "reconSat");
    eq("the satellite's domain", sat.domain, "sat");
    eq("the satellite sits where it was picked", [sat.x, sat.y], [100, 40]);
    eq("the satellite opens in orbit", sat.orbit, true);
    eq("the satellite's radius is the config's", sat.radius, cfg.scanRadius);
    eq("the satellite's fuel is the config's capacity", [sat.fuel, sat.fuelCapacity], [cfg.fuelCapacity, cfg.fuelCapacity]);
    eq("the satellite was charged at the reconSat price", match.sides.blue.cash, before - bought.price);
    // It flies ABOVE the board: no ground piece, so no cell is blocked and no city can be captured
    // by orbiting over it (the reason the record lives in match.satellites).
    eq("the buy added no ground piece", match.pieces.length, 0);
    // Red buys its own; each side owns its piece, and the ids do not collide.
    const red = buySatellite(match, "red", 100, 40);
    if (red.error) fail("the same cell was refused to red's satellite: " + red.error);
    if (red.satellite.id === sat.id) fail("the two sides share one satellite id: " + sat.id);
    eq("red owns the second satellite", red.satellite.side, "red");

    // Refusals: an era without satellites, a cell off the map, an empty purse.
    if (!buySatellite(fresh("1942"), "blue", 100, 40).error) fail("1942 sold a recon satellite");
    if (!buySatellite(fresh(), "blue", 100, CELL_H + 1).error) fail("a satellite was placed off the map");
    const poor = fresh();
    poor.sides.blue.cash = 0;
    if (!buySatellite(poor, "blue", 100, 40).error) fail("a satellite was bought with an empty pool");
  }

  // --- AC2: it moves faster than land or sea -----------------------------------------------
  {
    const match = fresh();
    const bought = buySatellite(match, "blue", 40, 40);
    if (bought.error) fail("satellite: " + bought.error);
    const tank = cellsPerRound({ kind: "tank", domain: "land" });
    const hull = cellsPerRound({ kind: "cruiser", domain: "sea" });
    if (!(cfg.speedCells > tank)) fail("the satellite is not faster than a tank: " + cfg.speedCells + " <= " + tank);
    if (!(cfg.speedCells > hull)) fail("the satellite is not faster than a hull: " + cfg.speedCells + " <= " + hull);

    // A 24-cell move: a satellite flies it in ceil(24/speed) rounds; the tank needs 24/2 = 12.
    const order = orderSatellite(match, "blue", bought.satellite.id, 64, 40);
    if (order.error) fail("the satellite order was refused: " + order.error);
    eq("the order flies the whole line", order.path.length, 24);
    const rounds = Math.ceil(24 / cfg.speedCells);
    eq("the quoted rounds are the satellite's speed", order.rounds, rounds);
    if (!(rounds < Math.ceil(24 / tank))) fail("the satellite's 24-cell move is not quicker than a tank's");

    // One round of ticks moves exactly speedCells cells and then stops (a held clock never reaches
    // the tick, which is tickMatch's own guard, not this module's).
    tickSatellites(match);
    eq("one round moves the speed's worth of cells", bought.satellite.x, 40 + cfg.speedCells);
    if (!(bought.satellite.x > 40)) fail("the satellite did not move");
    // An order for another side's satellite is refused, and so is a destination on its own cell.
    if (!orderSatellite(match, "red", bought.satellite.id, 0, 0).error) fail("red ordered blue's satellite");
    if (!orderSatellite(match, "blue", bought.satellite.id, bought.satellite.x, bought.satellite.y).error) {
      fail("a satellite was ordered onto the cell it already stands on");
    }
  }

  // --- AC3: the radius reveals, the submarine never does ------------------------------------
  {
    const match = fresh();
    match.pieces = [
      unit("red:near", "red", "infantry", "land", 103, 40),
      unit("red:edge", "red", "tank", "land", 100 + cfg.scanRadius, 40),
      unit("red:out", "red", "infantry", "land", 100 + cfg.scanRadius + 1, 40),
      unit("red:sub", "red", "submarine", "sea", 100, 40),
      // Blue's own piece is parked FAR away on purpose: within sightCells (8) of red:out it would
      // be on the wire by ordinary sight, and this arm must fail if a reveal is what put it there.
      unit("blue:own", "blue", "infantry", "land", 10, 10),
    ];
    const bought = buySatellite(match, "blue", 100, 40);
    if (bought.error) fail("satellite: " + bought.error);
    const events = tickSatellites(match);
    const pass = events.find((event) => event.type === "satellite");
    if (!pass) fail("the satellite produced no pass event: " + JSON.stringify(events));
    eq("the pass reveals the near unit and the edge unit, never the sub or the far one or blue's own",
      pass.reveals, 2);
    const seen = forSeat(match, "blue").pieces.map((piece) => piece.id).sort();
    eq("the seat's frame carries exactly the revealed enemies plus its own piece", seen,
      ["blue:own", "red:edge", "red:near"]);
    if (match.pieces.find((piece) => piece.id === "red:sub").revealedRound !== undefined) {
      fail("the pass stamped the submarine");
    }
    if (match.pieces.find((piece) => piece.id === "red:out").revealedRound !== undefined) {
      fail("the pass stamped a unit outside the radius");
    }
    // The reveal lives one round, exactly like the old satellite stamp: the round after the pass it
    // is gone. Without this a stale stamp would reveal the board for the rest of the match.
    match.round += 1;
    const next = forSeat(match, "blue");
    if (next.pieces.some((piece) => piece.id === "red:near")) fail("the reveal outlived its own round");
    if (!next.satellites.some((sat) => sat.id === bought.satellite.id)) fail("the satellite vanished from the frame");
  }

  // --- AC3b: a pass reveals ENEMIES only; a friendly piece inside the radius is not a reveal ----
  // The skip is `unit.side === sat.side`. Without it the pass stamps friendly pieces with
  // revealedRound, which is a stamp the frame then reads as an intel reveal on your own unit.
  {
    const match = fresh();
    const friend = unit("blue:friend", "blue", "infantry", "land", 202, 60);
    match.pieces = [
      friend,
      unit("red:far", "red", "infantry", "land", 300, 120),
    ];
    const bought = buySatellite(match, "blue", 200, 60);
    if (bought.error) fail("satellite: " + bought.error);
    const events = tickSatellites(match);
    if (events.some((event) => event.type === "satellite")) {
      fail("a pass with no enemy in radius still emitted a satellite event: " + JSON.stringify(events));
    }
    if (friend.revealedRound !== undefined) fail("the pass stamped a friendly piece: " + friend.revealedRound);
  }

  // --- AC4: fuel per move, and the last boost falls out of orbit -----------------------------
  {
    const match = fresh();
    const bought = buySatellite(match, "blue", 20, 40);
    if (bought.error) fail("satellite: " + bought.error);
    const sat = bought.satellite;
    let moves = 0;
    let down = null;
    while (sat.orbit !== false && moves < 10) {
      const order = orderSatellite(match, "blue", sat.id, sat.x + 2, 40);
      if (order.error) fail("move " + (moves + 1) + " was refused early: " + order.error);
      moves += 1;
      eq("move " + moves + " spent exactly fuelPerMove", order.fuel, cfg.fuelCapacity - cfg.fuelPerMove * moves);
      const events = tickSatellites(match);
      down = events.find((event) => event.type === "satellite_down") || down;
    }
    eq("the satellite is removed after fuelCapacity moves", moves, cfg.fuelCapacity);
    if (!down) fail("the satellite fell out of orbit with no event");
    eq("the down event names the piece", down.pieceId, bought.satellite.id);
    eq("the down event's reason", down.reason, "fuel");
    const ownerLine = logLines(match, "blue", [down], match.round).map((line) => line.text).join(" ");
    if (!/fallen out of orbit|fuel/i.test(ownerLine)) fail("no log line for the satellite that fell: " + ownerLine);
    // And a satellite with no fuel cannot be ordered at all (belt and braces: the piece is gone here,
    // so this arm uses a fresh one whose tank is already dry).
    const dry = fresh();
    const dryBought = buySatellite(dry, "blue", 20, 40);
    dryBought.satellite.fuel = 0;
    if (!orderSatellite(dry, "blue", dryBought.satellite.id, 30, 40).error) {
      fail("a satellite with an empty tank accepted an order");
    }
  }

  // --- AC5: both sides' satellites are visible, and the Show Satellites layer draws them -----
  {
    const match = fresh();
    const blue = buySatellite(match, "blue", 60, 30);
    const red = buySatellite(match, "red", 260, 100);
    if (blue.error || red.error) fail("a satellite was refused: " + (blue.error || red.error));
    const blueSees = forSeat(match, "blue").satellites.map((sat) => sat.id).sort();
    const redSees = forSeat(match, "red").satellites.map((sat) => sat.id).sort();
    eq("blue sees both satellites (manual p.12: the blue one and the red one)", blueSees,
      [blue.satellite.id, red.satellite.id].sort());
    eq("red sees both satellites", redSees, [blue.satellite.id, red.satellite.id].sort());
    if (blueSees.some((id) => String(id).includes("undefined"))) fail("a satellite id is missing");

    // The Show Satellites layer: one ring per satellite, and the insert box names each one's fuel.
    const painter = recordingCtx();
    const rings = paintSatelliteRings(painter, forSeat(match, "blue").satellites, VIEW, {});
    eq("one ring per satellite", rings, 2);
    eq("each ring is one arc", painter.calls.arcs, 2);
    const box = recordingCtx();
    const rows = paintSatelliteInset(box, forSeat(match, "blue").satellites, VIEW, {});
    eq("the insert box lists every satellite", rows, 2);
    if (!box.calls.text.includes("SATELLITES")) fail("the insert box has no heading: " + box.calls.text.join("|"));
    const joined = box.calls.text.join(" ");
    if (!joined.includes("blue") || !joined.includes("red")) fail("the insert box does not name both sides: " + joined);
    if (!/fuel \d+\/\d+/.test(joined)) fail("the insert box does not carry fuel: " + joined);

    // A satellite that moved is at its new cell in the frame, and the ring follows the payload.
    const movedOrder = orderSatellite(match, "blue", blue.satellite.id, 80, 30);
    if (movedOrder.error) fail("the Show Satellites move was refused: " + movedOrder.error);
    tickSatellites(match);
    const moved = forSeat(match, "blue").satellites.find((sat) => sat.id === blue.satellite.id);
    eq("the frame carries the satellite's new cell", [moved.x, moved.y], [blue.satellite.x, blue.satellite.y]);
  }
}
