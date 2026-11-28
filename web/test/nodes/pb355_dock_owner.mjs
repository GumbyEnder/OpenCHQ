// pb355_dock_owner — PB-355 (a) and (b): a dock's owner is its PORT's owner, and the militia's
// pin is gated by kind while its damage is not.
//
// What fails if this node is removed:
//   - the dock row goes back to carrying only `port` and no `owner`  -> (a) reads 150 docks with
//     no owner key, and the militia legs charge a blue hull the neutral 20;
//   - the port is resolved against `base` (the pre-era asset list, which has no owner at all)
//     instead of the year's applied list                              -> (a) reads 150 divergences;
//   - the inheritance falls back to the port's COUNTRY when the town is absent that year
//     -> (d) the 1918 docks whose port is out of the year stop being null;
//   - a dock starts paying income of its own (a second attribution of the newly owned rows)
//     -> (e) the dock-nulled control reads a different purse;
//   - the militia pin stops asking the kind (FUN_1c0d_00b4, 9061-9063: the 0xfff6 store sits
//     inside `bVar1 < 7`)                                           -> (c)/(d) read a pinned
//     submarine and a cruiser that cannot be re-ordered, which Manual p.24 forbids;
//   - the militia DAMAGE starts asking the kind                     -> (c)/(d) read 0 where the
//     original pays 2 at an enemy port and 20 at an unowned one (local_4 = 0x82 is assigned
//     before the kind test, 9061).
//
// (b) to (d) are the militia legs, built from the BOARD ROWS ONLY - no openMatch, no seedOwners.
// That is the seam the card names: economy.seedOwners already synced docks at the bell, so a leg
// that opened a match first would stay green with the board row still empty and grade nothing.

import { boardPayload, bundledBoard, matchSites } from "../../server/board.mjs";
import { applyEra } from "../../server/era.mjs";
import { openMatch } from "../../server/match.mjs";
import { payoutFor, seedOwners } from "../../server/economy.mjs";
import { resolve } from "../../server/combat.mjs";
import { advance, pieceState } from "../../server/move.mjs";

export const name = "pb355_dock_owner";

const DOCK = /^docks?$/;
const isDock = (site) => Boolean(site) && DOCK.test(String(site.kind));
const asSide = (owner) => (owner === "blue" || owner === "red" ? owner : null);

export async function run(ctx) {
  const { fail, skip } = ctx;
  const eq = (actual, expected, message) => {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) fail(message + ": " + a + " !== " + b);
  };

  const board = boardPayload();
  if (!board || (board.source !== "extract" && board.source !== "bundled") || !Array.isArray(board.cells)) {
    skip("pb355_dock_owner: the board carries no painted cells (no extract and no baked board), so there is no dock row to grade");
  }

  const roster = (era, payload = board) => {
    const list = matchSites(era, payload);
    return { list, byId: new Map(list.map((site) => [String(site.id), site])), docks: list.filter(isDock) };
  };
  const portOf = (byId, dock) => (dock.port === undefined || dock.port === null ? null : byId.get(String(dock.port)) || null);

  // A sea hull standing on the dock's own painted cell. `domain: "sea"` is the shape the match
  // uses (placement.domainOf), and it is what the pin predicate reads.
  const hull = (kind, dock, strength = 100) => ({
    id: "blue:" + kind, side: "blue", kind, domain: "sea", transport: false,
    x: dock.x, y: dock.y, path: [], pace: 1, facing: null, fighting: null, strength, maxStrength: 100,
  });
  // The remake's land hull afloat: `transport: true` is the original's kind 11, and 11 is outside
  // the same `bVar1 < 7` test the sea kinds are outside of.
  const cargoHull = (dock, strength = 100) => ({
    id: "blue:tr", side: "blue", kind: "transport", domain: "sea", transport: true, cargoKind: "infantry",
    x: dock.x, y: dock.y, path: [], pace: 1, facing: null, fighting: null, strength, maxStrength: 100,
  });
  const foot = (dock, strength = 100) => ({
    id: "blue:foot", side: "blue", kind: "infantry", domain: "land", transport: false,
    x: dock.x, y: dock.y, path: [], pace: 1, facing: null, fighting: null, strength, maxStrength: 100,
  });
  // An order the piece is holding, so "can keep moving" is readable from pieceState (move.mjs).
  const holding = (piece, dock) => {
    piece.path = [{ x: dock.x, y: dock.y + 1, pace: 1 }];
    return piece;
  };
  const resolveBeat = (list, piece, round = 2) => resolve({ round, sites: list, pieces: [piece] });
  const beat = (list, piece, round = 2) => resolveBeat(list, piece, round).filter((event) => event && event.militia === true);

  // ---- (a) the board row carries its port's POST-applyEra owner, for every 1942 dock ---------
  //
  // Two boards, because they are two reads of the same rule: the reference extract when it is
  // mounted, and the repo's baked board (the one a host without the extract serves). The census
  // line is the record - in particular the port-less count, which is REPORTED, never invented:
  // a dock with no port stays null and this arm does not guess a country for it.
  const census = (payload, label) => {
    const list = matchSites("1942", payload);
    const era = applyEra(Array.isArray(payload.sites) ? payload.sites : [], "1942");
    const eraById = new Map(era.map((site) => [String(site.id), site]));
    const baseById = new Map((Array.isArray(payload.sites) ? payload.sites : []).map((site) => [String(site.id), site]));
    const docks = list.filter(isDock);
    const counts = { docks: docks.length, withPort: 0, noPort: 0, blue: 0, red: 0, neutral: 0, portAbsent: 0, baseDivergent: 0 };
    const divergent = [];
    for (const dock of docks) {
      if (!Object.hasOwn(dock, "owner")) {
        fail("pb355 (a): " + dock.id + " carries no owner key, so a hull on it pays the neutral 20"
          + " whatever port it serves");
      }
      if (dock.port === undefined || dock.port === null) {
        counts.noPort += 1;
        if (dock.owner !== null) fail("pb355 (a): " + dock.id + " has no port but reports owner " + dock.owner);
        continue;
      }
      counts.withPort += 1;
      // The port resolved in the YEAR, not in the pre-era asset list: `base` carries no owner at
      // all, which is why a dock built from it is always null.
      const port = eraById.get(String(dock.port)) || null;
      if (!port) {
        counts.portAbsent += 1;
      } else if (asSide(port.owner) === null) {
        counts.neutral += 1;
      } else {
        counts[asSide(port.owner)] += 1;
      }
      const want = port ? asSide(port.owner) : null;
      if (asSide(dock.owner) !== want) {
        divergent.push(dock.id + " owner=" + dock.owner + " port=" + (port ? port.id + "(" + port.owner + ")" : "absent"));
      }
      const basePort = baseById.get(String(dock.port)) || null;
      if (asSide(basePort && basePort.owner) !== want) counts.baseDivergent += 1;
    }
    if (divergent.length) {
      fail("pb355 (a): " + divergent.length + " of " + docks.length
        + " 1942 docks do not report their port's owner: " + divergent.slice(0, 5).join("; "));
    }
    if (!counts.blue || !counts.red) {
      fail("pb355 (a): the 1942 board resolved no docks through each side (blue " + counts.blue
        + ", red " + counts.red + "), so this leg would grade nothing");
    }
    if (!counts.baseDivergent) {
      fail("pb355 (a): the pre-era list never disagrees with the year here, so the arm could not"
        + " tell a base-resolved dock from an era-resolved one");
    }
    console.log("pb355 (a) " + label + " 1942 census: " + JSON.stringify(counts));
    return { list, docks, counts };
  };
  const extractCensus = census(board, board.source);
  if (board.source !== "bundled") census(bundledBoard(), "bundled");
  {
    // The card names this cell: Archangel's dock, the one the measurement walked.
    const archangel = extractCensus.list.find((site) => site && site.id === 0);
    const named = extractCensus.docks.find((dock) => dock.x === 181 && dock.y === 12);
    if (!archangel || !named) fail("pb355 (a): the named cell dock:181:12 or its port is missing from the 1942 board");
    eq(asSide(named.owner), asSide(archangel.owner), "pb355 (a): dock:181:12 must carry Archangel's owner");
  }

  // ---- (b) a blue hull on its own port's dock: no row, no pin, and it keeps its order ---------
  for (const kind of ["submarine", "cruiser", "carrier"]) {
    const { list, byId, docks } = roster("1942");
    const dock = docks.find((candidate) => asSide((portOf(byId, candidate) || {}).owner) === "blue");
    if (!dock) fail("pb355 (b): the 1942 board has no dock beside a blue port");
    const boat = holding(hull(kind, dock), dock);
    const rows = beat(list, boat);
    if (rows.length) {
      fail("pb355 (b): a blue " + kind + " on " + dock.id + ", whose port is blue, took a militia row: "
        + JSON.stringify(rows[0]));
    }
    eq(boat.strength, 100, "pb355 (b): the friendly dock must take no strength from a " + kind);
    if (boat.pinned === true) fail("pb355 (b): the friendly dock pinned a " + kind);
    eq(pieceState(boat, { round: 2 }), "moving", "pb355 (b): a " + kind + " off a friendly dock keeps its order");
  }
  {
    // The land hull still pays nothing on its own port - the pin gate must not have made the
    // friendly branch kind-blind in the other direction.
    const { list, byId, docks } = roster("1942");
    const dock = docks.find((candidate) => asSide((portOf(byId, candidate) || {}).owner) === "blue");
    const walker = foot(dock);
    eq(beat(list, walker).length, 0, "pb355 (b): a friendly dock takes nothing from a land hull either");
    eq(walker.strength, 100, "pb355 (b): the friendly control's land hull is untouched");
  }

  // ---- (c) a blue hull on a RED port's dock: 2 and NO pin (Manual p.24) ----------------------
  for (const kind of ["submarine", "cruiser", "carrier"]) {
    const { list, byId, docks } = roster("1942");
    const dock = docks.find((candidate) => asSide((portOf(byId, candidate) || {}).owner) === "red");
    if (!dock) fail("pb355 (c): the 1942 board has no dock beside a red port");
    const boat = holding(hull(kind, dock), dock);
    const rows = beat(list, boat);
    if (rows.length !== 1) fail("pb355 (c): an enemy-port dock must charge a " + kind + " exactly once, got " + rows.length);
    eq(rows[0].amount, 2, "pb355 (c)/D11: an enemy-owned site's militia costs 2");
    eq(rows[0].side, "red", "pb355 (c): the row names the port's side");
    eq(rows[0].pinned, false, "pb355 (c)/D12: FUN_1c0d_00b4 9061-9063 puts the pin inside kind < 7, so the row must not say pinned");
    eq(boat.strength, 98, "pb355 (c): 100 -> 98 on an enemy dock");
    if (boat.pinned === true) fail("pb355 (c)/D12: Manual p.24 - a sea unit is never pinned; the " + kind + " is");
    eq(pieceState(boat, { round: 2 }), "moving", "pb355 (c)/D12: a " + kind + " can be re-ordered off an enemy dock");
    // Later ticks: the beat is every combat.shotEveryRounds and the hull is still not pinned.
    const later = beat(list, boat, 4);
    if (later.length !== 1) fail("pb355 (c): the second beat must charge the " + kind + ", got " + later.length);
    eq(boat.strength, 96, "pb355 (c): 98 -> 96 on the second beat");
    eq(later[0].pinned, false, "pb355 (c)/D12: the second beat still does not pin a " + kind);
    if (boat.pinned === true) fail("pb355 (c)/D12: the " + kind + " is pinned on a later tick");
    // G1: not just "reads moving" - it takes the order it is holding and steps it.
    const dest = { x: dock.x, y: dock.y + 1 < 136 ? dock.y + 1 : dock.y - 1, pace: 1 };
    boat.path = [dest];
    boat.credit = 99;
    advance({ round: 5, pieces: [boat], sites: list });
    eq([boat.x, boat.y], [dest.x, dest.y],
      "pb355 (c)/G1: a " + kind + " must take its next step after the militia beat");
  }
  {
    // The gate is kind, not a blanket removal: a LAND hull on the same enemy dock is still pinned.
    const { list, byId, docks } = roster("1942");
    const dock = docks.find((candidate) => asSide((portOf(byId, candidate) || {}).owner) === "red");
    const walker = holding(foot(dock), dock);
    const rows = beat(list, walker);
    if (rows.length !== 1) fail("pb355 (c): an enemy-port dock must charge a land hull once, got " + rows.length);
    eq(rows[0].amount, 2, "pb355 (c): the land hull pays the same 2");
    eq(rows[0].pinned, true, "pb355 (c)/D12: the land arm keeps the pin (kind < 7)");
    eq(walker.pinned, true, "pb355 (c)/D12: the land hull is held on an enemy dock");
    eq(pieceState(walker, { round: 2 }), "pinned", "pb355 (c)/D12: the land hull reads pinned");
  }
  {
    // Cargo on a land hull is kind 11 in the original and never pinned either.
    const { list, byId, docks } = roster("1942");
    const dock = docks.find((candidate) => asSide((portOf(byId, candidate) || {}).owner) === "red");
    const boat = holding(cargoHull(dock), dock);
    const rows = beat(list, boat);
    if (rows.length !== 1) fail("pb355 (c): an enemy-port dock must charge the cargo hull once, got " + rows.length);
    eq(rows[0].amount, 2, "pb355 (c): cargo pays the enemy 2");
    eq(rows[0].pinned, false, "pb355 (c)/D12: kind 11 is outside `bVar1 < 7`, so cargo is not pinned");
    if (boat.pinned === true) fail("pb355 (c)/D12: the cargo hull is pinned");
    eq(pieceState(boat, { round: 2 }), "moving", "pb355 (c)/D12: the cargo hull keeps its order");
  }

  // ---- (d) an unowned port (1986) and an out-of-year port (1918) still pay the neutral 20 ----
  {
    const bare = roster("1986");
    const dock = bare.docks.find((candidate) => {
      const port = portOf(bare.byId, candidate);
      return port && asSide(port.owner) === null;
    });
    if (!dock) fail("pb355 (d): the 1986 board has no dock beside a neutral port");
    eq(asSide(dock.owner), null, "pb355 (d): a neutral port's dock must be unowned on the row");
    for (const kind of ["submarine", "cruiser", "carrier"]) {
      const boat = holding(hull(kind, dock), dock);
      const rows = beat(bare.list, boat);
      if (rows.length !== 1) fail("pb355 (d): an unowned-port dock must charge a " + kind + ", got " + rows.length);
      eq(rows[0].amount, 20, "pb355 (d)/D11: an unowned site's militia costs 20");
      eq(rows[0].side, null, "pb355 (d)/D11: an unowned site's militia names no side");
      eq(rows[0].pinned, false, "pb355 (d)/D12: the unowned beat does not pin a " + kind);
      eq(boat.strength, 80, "pb355 (d)/D11: 100 -> 80 on the unowned dock");
      if (boat.pinned === true) fail("pb355 (d)/D12: the unowned dock pinned a " + kind);
      eq(pieceState(boat, { round: 2 }), "moving", "pb355 (d)/D12: a " + kind + " keeps its order on an unowned dock");
    }

    const walker = foot(dock);
    const land = beat(bare.list, walker);
    if (land.length !== 1) fail("pb355 (d): the unowned dock must charge a land hull once, got " + land.length);
    eq(walker.pinned, true, "pb355 (d)/D12: the land arm is still pinned on an unowned dock");

    // PB-356 retracts D11's floor: 0x199a is the 0xf4 row (0x80 set = no floor), so a 25-strength
    // hull goes to 5 and the next beat takes it to 0 and clears the slot. Manual p.10.
    const thin = hull("submarine", dock, 25);
    beat(bare.list, thin, 2);
    eq(thin.strength, 5, "pb355 (d)/D11: the unowned 20 is not floored - 25 -> 5, not 20");
    const shot = resolveBeat(bare.list, thin, 4);
    eq(thin.strength, 0, "pb355 (d)/D11: the second beat takes the 5 to 0");
    if (!shot.some((event) => event.type === "destroyed" && event.pieceId === "blue:submarine")) {
      fail("pb355 (d)/D11: the unowned 20 must remove the hull at 0, not leave it on the cell");
    }
  }
  {
    // 1918 drops 96 of the towns the docks serve. Those docks must be null - not country-seeded -
    // because this row is the authority before seedOwners runs.
    const old = roster("1918");
    const orphan = old.docks.find((candidate) => candidate.port !== undefined
      && candidate.port !== null && !portOf(old.byId, candidate));
    if (!orphan) fail("pb355 (d): the 1918 board has no dock whose port the year drops, so the absent-port arm is ungraded");
    eq(asSide(orphan.owner), null, "pb355 (d): a dock whose port is out of the year must be unowned");
    const boat = holding(hull("submarine", orphan), orphan);
    const rows = beat(old.list, boat);
    if (rows.length !== 1) fail("pb355 (d): an out-of-year port's dock must charge the squatter, got " + rows.length);
    eq(rows[0].amount, 20, "pb355 (d)/D11: an out-of-year port is an unowned site: 20");
    eq(rows[0].side, null, "pb355 (d): no port this year, no side to name");
    eq(rows[0].pinned, false, "pb355 (d)/D12: an out-of-year port's dock does not pin a sea hull");
    if (boat.pinned === true) fail("pb355 (d)/D12: the out-of-year dock pinned the submarine");
  }

  // ---- (e) income does not move: the newly owned dock rows pay nothing ----------------------
  {
    const live = openMatch("1942", matchSites("1942", board));
    seedOwners(live);
    const control = openMatch("1942", matchSites("1942", board));
    seedOwners(control);
    for (const site of control.sites) if (isDock(site)) site.owner = null;
    for (const side of ["blue", "red"]) {
      eq(payoutFor(live, side), payoutFor(control, side),
        "pb355 (e): a dock must not add a paying site to the " + side + " purse");
    }
    // And the docks still agree with their ports after the bell's own seed (PB-320's sync).
    const byId = new Map(live.sites.map((site) => [String(site.id), site]));
    const diverged = live.sites.filter(isDock).filter((dock) => {
      const port = portOf(byId, dock);
      return dock.port !== undefined && dock.port !== null && port && asSide(dock.owner) !== asSide(port.owner);
    });
    if (diverged.length) {
      fail("pb355 (e): seedOwners moved " + diverged.length + " docks off their port: "
        + diverged.slice(0, 5).map((dock) => dock.id).join(", "));
    }
  }
}
