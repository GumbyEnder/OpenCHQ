// PB-270 (D3): the unit ledger and rung 4 over LOSSES, not net alive.
//
// Why this module exists, measured (room 9607 §2, card PB-270 D3):
// `aliveStart - aliveEnd` is NEGATIVE wherever a side produces. At 1918 the blue aggregate read
// -460 and at 1986 both seats read (-1040/-1060); rung 4 fired on that number 40/280 rows at 1918
// and 160/280 at 1986, and at 1986 every rung-4 winner had a negative net, i.e. the side that
// BUILT more was awarded the attrition tiebreak. The PB-258 guard only asked whether the OPENING
// had pieces; production during the match still drove the net negative.
//
// What replaces it: a per-side ledger of unit COUNT, not of survivorship.
//   start    units alive at the opening snapshot
//   built    units this side produced (economy.buy returned ok)
//   lost     units of this side that are gone from play (record absent, or strength <= 0)
//   capturedOut / capturedIn  units that changed side while still alive
//   end      units alive at the end, owned by this side
// Identity, asserted on every row: start + built + capturedIn - lost - capturedOut === end.
// `lost` and `built` are non-negative by construction; there is no negative "losses" column.
//
// Rung 4 compares `lost` only. Production is not attrition, so a side that builds twelve units and
// loses none beats a side that builds none and loses three.

function strengthOf(piece) {
  return piece && Number(piece.strength) > 0 ? Number(piece.strength) : 0;
}

// `startSides` is a Map of String(piece.id) -> "blue"|"red" taken at the opening, before any order.
// `builtIds` is { blue: Set, red: Set } of ids economy.buy created for that side.
// `pieces` is the match's piece array at the end (dead records may or may not still be present).
export function unitLedger({ startSides, builtIds, pieces }) {
  const endById = new Map();
  for (const piece of pieces || []) {
    if (!piece) continue;
    if (strengthOf(piece) > 0) endById.set(String(piece.id), piece);
  }
  const built = { blue: new Set(builtIds && builtIds.blue ? builtIds.blue : []), red: new Set(builtIds && builtIds.red ? builtIds.red : []) };
  const out = {
    start: { blue: 0, red: 0 },
    built: { blue: 0, red: 0 },
    lost: { blue: 0, red: 0 },
    capturedOut: { blue: 0, red: 0 },
    capturedIn: { blue: 0, red: 0 },
    end: { blue: 0, red: 0 },
    identityFailures: [],
  };
  const origins = new Map();
  for (const [id, side] of startSides || []) origins.set(String(id), side);
  for (const side of ["blue", "red"]) {
    out.start[side] = 0;
    for (const [, originSide] of origins) if (originSide === side) out.start[side] += 1;
    out.built[side] = built[side].size;
  }
  const owned = { blue: [], red: [] };
  for (const [id, side] of origins) owned[side].push(id);
  for (const side of ["blue", "red"]) {
    for (const id of built[side]) owned[side].push(id);
  }
  for (const side of ["blue", "red"]) {
    for (const id of owned[side]) {
      const piece = endById.get(id);
      if (!piece) {
        out.lost[side] += 1;
      } else if (piece.side !== side) {
        out.capturedOut[side] += 1;
        out.capturedIn[piece.side] += 1;
      }
    }
    out.end[side] = (pieces || []).filter((piece) => piece && strengthOf(piece) > 0 && piece.side === side).length;
    const sum = out.start[side] + out.built[side] + out.capturedIn[side] - out.lost[side] - out.capturedOut[side];
    if (sum !== out.end[side]) {
      out.identityFailures.push({ side, expected: sum, end: out.end[side] });
    }
  }
  // Units that changed side are "in" for one seat and "out" for the other; the per-side numbers are
  // counts of unit records, so the sum over both seats is conserved except for builds and losses.
  out.net = { blue: out.built.blue - out.lost.blue, red: out.built.red - out.lost.red };
  out.lossesComparable = true;
  return out;
}

function lostFewer(a, b) {
  if (a === b) return null;
  return a < b ? "blue" : "red";
}

// The verdict rule, in one place so the harness and a node test read the same bytes.
//   1. capital-set win
//   2. cities TAKEN (end minus opening)
//   3. fewer capitals lost
//   4. fewer UNITS LOST (destroyed, not net alive)
//   5. draw
export function resolveVerdict({ over, winner, citiesTaken, capitalsLost, unitsLost }) {
  if (over && (winner === "blue" || winner === "red")) {
    return { verdict: winner, rung: "capital-set win" };
  }
  if (citiesTaken.blue !== citiesTaken.red) {
    return { verdict: citiesTaken.blue > citiesTaken.red ? "blue" : "red", rung: "cities taken" };
  }
  const fewer = lostFewer(capitalsLost.blue, capitalsLost.red);
  if (fewer) return { verdict: fewer, rung: "capitals lost" };
  if (unitsLost && unitsLost.blue !== unitsLost.red) {
    return { verdict: unitsLost.blue < unitsLost.red ? "blue" : "red", rung: "units lost" };
  }
  return { verdict: "draw", rung: "draw" };
}

// Distinct row objects across seeds, for the grid's n_eff column (PB-270 D2).
// A fingerprint names every column the verdict reads plus the unit ledger and the event counts.
// Seed and match index are EXCLUDED: the question is whether the seed changes the play, so a
// fingerprint that carries the seed would manufacture a difference for every seed.
export function rowFingerprint(row) {
  const units = row.units || {};
  return [
    row.levels ? row.levels.blue + "v" + row.levels.red : "",
    row.verdict,
    row.verdictRung,
    row.citiesEnd ? row.citiesEnd.blue + "/" + row.citiesEnd.red : "",
    row.citiesTaken ? row.citiesTaken.blue + "/" + row.citiesTaken.red : "",
    row.capitalsLost ? row.capitalsLost.blue + "/" + row.capitalsLost.red : "",
    units.lost ? units.lost.blue + "/" + units.lost.red : "",
    units.built ? units.built.blue + "/" + units.built.red : "",
    units.end ? units.end.blue + "/" + units.end.red : "",
    row.events ? [row.events.blue.buy, row.events.blue.order, row.events.blue.defend,
      row.events.red.buy, row.events.red.order, row.events.red.defend].join(",") : "",
    row.handicap ? row.handicap.step : "off",
  ].join("|");
}

export function distinctCount(rows) {
  return new Set((rows || []).map(rowFingerprint)).size;
}
