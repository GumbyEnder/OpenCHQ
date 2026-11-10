// The match object. It lives in the server, in JavaScript; the page only draws what it is
// sent. This module owns the opening position for each era and the shape everything else
// reads. See docs/CONTRACTS.md.
//
// The opening is no longer one war for every year. Each era's capitals and site owners come from
// web/data/eras.json (baked from the running original, see docs/re/ERA_SETUP.md), so 1918 opens as
// France with Paris and London, 1942 has the USSR on the Allied side, and 1986 keeps Washington
// against Moscow. A side may hold more than one capital; `capitals` is a list per side.
//
// 2023 and ???? have no owner fixture: their capitals and owners are rolled from the match seed
// (2023 rule, FUN_23aa_0e1c) and the roll is labelled UNVERIFIED in the data. 2023 still opens
// with no pieces on purpose; every other era places a land piece on each of its capitals plus one
// ship at sea, which is the archive's opening.

import { SEATS } from "./board.mjs";
import { eraCapitals, eraTable, prepareEra } from "./era.mjs";
import { handicapDefault, opponentPool, roundSeconds, startPool } from "./rules.mjs";

export const ERAS = ["1918", "1942", "1986", "2023", "9999"];

// Ocean cells off the corridor. X wraps, Y does not.
export const SEAS = {
  blue: { x: 0, y: 15 },
  red: { x: 300, y: 70 },
};

export function eraOf(value) {
  const era = String(value ?? "1986");
  return ERAS.includes(era) ? era : "1986";
}

function piece(side, domain, x, y, id = `${side}:${domain}:${x},${y}`) {
  return { id, side, domain, kind: null, x, y, path: [], pace: 1, facing: null, fighting: null, shots: 0 };
}

// The board's own two seats, used only when an era has no table entry or no site list to roll
// against (a unit test that opens a match with no sites, or a host with no baked table).
function fallbackCapitals() {
  return {
    blue: [{ x: SEATS.blue.x, y: SEATS.blue.y, name: SEATS.blue.name, siteId: SEATS.blue.siteId ?? null, source: "board SEATS fallback" }],
    red: [{ x: SEATS.red.x, y: SEATS.red.y, name: SEATS.red.name, siteId: SEATS.red.siteId ?? null, source: "board SEATS fallback" }],
  };
}

function normaliseCapitals(capitals) {
  const out = { blue: [], red: [] };
  for (const side of ["blue", "red"]) {
    const rows = Array.isArray(capitals && capitals[side]) ? capitals[side] : [];
    out[side] = rows
      .filter((row) => row && Number.isInteger(Number(row.x)) && Number.isInteger(Number(row.y)))
      .map((row) => ({
        x: Number(row.x),
        y: Number(row.y),
        name: row.name ?? null,
        siteId: row.siteId ?? row.id ?? null,
        source: row.source ?? null,
      }));
  }
  return out;
}

// Opening pieces for one era: a land garrison on every capital this side starts with, and one
// ship at sea. 2023 places none.
export function openingPieces(era, capitals = null) {
  if (eraOf(era) === "2023") return [];
  const seats = capitals || fallbackCapitals();
  const out = [];
  for (const side of ["blue", "red"]) {
    const cells = Array.isArray(seats[side]) ? seats[side] : [];
    // The first garrison keeps the historical id (`blue:land`), so a caller or a test that names
    // the side's home army still finds it; extra capitals get a cell-suffixed id.
    cells.forEach((cell, index) => {
      const id = index === 0 ? `${side}:land` : `${side}:land:${cell.x},${cell.y}`;
      out.push(piece(side, "land", cell.x, cell.y, id));
    });
    out.push(piece(side, "sea", SEAS[side].x, SEAS[side].y, `${side}:sea`));
  }
  return out;
}

// One side's opening state. `cash` is passed in by openMatch because the two sides no longer open
// on the same number: the player's side gets the era's recovered pool, and the opponent's side gets
// the starting-money spinner (Manual p.17), which is the handicap and not the player's cash.
function sideState(era, cash = null) {
  return {
    cash: cash === null || cash === undefined ? startPool(era) : cash,
    fuel: null, // set from rules().fuel.reserve by economy; null means untouched
    dry: false,
    cities: [],
    wells: [],
    bought: 0,
  };
}

// A fresh match. Round 0 is held: no clock, no orders, no movement yet.
//
// `options.seed` fixes the 2023 / ???? roll. Without one the roll is deterministic (seed 0), which
// is what a test wants; the lobby passes a fresh random seed per room so two games differ.
// `options.handicapSide` names the side that is NOT the player, and `options.opponentPool` is the
// spinner value in billions. Without them both sides open on the recovered player pool.
export function openMatch(era, sites = [], options = {}) {
  const year = eraOf(era);
  const side = options && (options.handicapSide === "blue" || options.handicapSide === "red")
    ? options.handicapSide
    : null;
  const eraSpinner = side === null ? null : handicapDefault(year);
  const spinner = eraSpinner === null
    ? null
    : (options.opponentPool === undefined || options.opponentPool === null
      ? eraSpinner
      : Number(options.opponentPool));
  const opponentCash = side === null ? null : opponentPool(year, spinner);

  const prepared = prepareEra(Array.isArray(sites) ? sites : [], year, { seed: options.seed ?? 0 });
  let capitals = normaliseCapitals(prepared.capitals);
  if (!capitals.blue.length && !capitals.red.length) capitals = fallbackCapitals();

  return {
    era: year,
    seed: options.seed ?? 0,
    // What the table said, so the report and a test can tell a rolled opening from a fixture.
    eraSource: eraTable(year) ? (prepared.fixed ? "capture" : "rolled") : "fallback",
    round: 0,
    roundSeconds: roundSeconds(),
    clock: "held",
    pieces: openingPieces(year, capitals),
    capitals,
    sides: {
      blue: sideState(year, side === "blue" ? opponentCash : null),
      red: sideState(year, side === "red" ? opponentCash : null),
    },
    // What the slot actually holds, so the report and the Economy dialog can say what was set.
    handicap: side === null || spinner === null || !Number.isFinite(spinner)
      ? null
      : { side, billions: spinner, unit: "billion" },
    sites: prepared.sites.map((site) => ({
      id: site.id,
      name: site.name,
      x: site.x,
      y: site.y,
      kind: site.kind,
      // The era table's verdict for this site: null is a real answer (a neutral city).
      owner: site.owner === "blue" || site.owner === "red" ? site.owner : null,
      ...(site.type === undefined ? {} : { type: site.type }),
      ...(site.capitalSide === undefined ? {} : { capitalSide: site.capitalSide }),
      ...(site.eraSource === undefined ? {} : { eraSource: site.eraSource }),
      ...(site.source === undefined ? {} : { source: site.source }),
      // A dock or a well carries the country or region the asset list named, so ownership
      // seeds from the board rather than from a guess.
      ...(site.country_id === undefined ? {} : { country_id: site.country_id }),
      ...(site.region === undefined ? {} : { region: site.region }),
    })),
    foughtRound: -1,
    winner: null,
    over: false,
  };
}

// What a seat may see. The view module narrows this; until then the opening position is
// symmetric and both sides travel in the room view.
export function piecesFor(match, side = null) {
  if (!match || !Array.isArray(match.pieces)) return [];
  const list = side ? match.pieces.filter((unit) => unit.side === side) : match.pieces;
  return list.map((unit) => ({ ...unit }));
}

// Re-exported so a caller can ask what an era's capitals are without opening a match.
export { eraCapitals };
