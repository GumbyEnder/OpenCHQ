// pb355_dock_owner — PB-355 (a): a dock's owner is its PORT's owner, on the board row itself.
//
// What fails if this node is removed:
//   - the dock row goes back to carrying only `port` and no `owner`  -> (a) reads 150 docks with
//     no owner key, and the militia legs charge a blue transport the neutral 20;
//   - the port is resolved against `base` (the pre-era asset list, which has no owner at all)
//     instead of the year's applied list                              -> (a) reads 150 divergences;
//   - the inheritance falls back to the port's COUNTRY when the town is absent that year
//     -> (e) the 1918 docks whose port is out of the year stop being null;
//   - a dock starts paying income of its own (a second attribution of the newly owned rows)
//     -> (f) the dock-nulled control reads a different purse.
//
// (b) to (d) are the militia legs, built from the BOARD ROWS ONLY - no openMatch, no seedOwners.
// That is the seam the card names: economy.seedOwners already synced docks at the bell, so a leg
// that opened a match first would stay green with the board row still empty and grade nothing.

import { boardPayload, matchSites } from "../../server/board.mjs";
import { openMatch } from "../../server/match.mjs";
import { payoutFor, seedOwners } from "../../server/economy.mjs";
import { resolve } from "../../server/combat.mjs";

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

  const roster = (era) => {
    const list = matchSites(era, board);
    return { list, byId: new Map(list.map((site) => [String(site.id), site])), docks: list.filter(isDock) };
  };
  const portOf = (byId, dock) => (dock.port === undefined || dock.port === null ? null : byId.get(String(dock.port)) || null);
  const transport = (dock, strength = 100) => ({
    id: "blue:tr", side: "blue", kind: "transport", domain: "sea", transport: true, cargoKind: "infantry",
    x: dock.x, y: dock.y, path: [], pace: 1, facing: null, fighting: null, strength, maxStrength: 100,
  });
  const militiaOn = (list, dock, strength = 100) => {
    const boat = transport(dock, strength);
    const events = resolve({ round: 2, sites: list, pieces: [boat] });
    return { boat, rows: events.filter((event) => event && event.militia === true) };
  };

  // ---- (a) the board row carries its port's owner, for every 1942 dock -----------------------
  {
    const { list, byId, docks } = roster("1942");
    if (docks.length < 100) fail("pb355 (a): the 1942 board must paint a real dock set, got " + docks.length);
    const via = { blue: 0, red: 0, neutral: 0, absent: 0 };
    const divergent = [];
    for (const dock of docks) {
      if (!Object.hasOwn(dock, "owner")) {
        fail("pb355 (a): " + dock.id + " carries no owner key, so a transport on it pays the neutral 20"
          + " whatever port it serves");
      }
      if (dock.port === undefined || dock.port === null) {
        via.absent += 1;
        if (dock.owner !== null) fail("pb355 (a): " + dock.id + " has no port but reports owner " + dock.owner);
        continue;
      }
      const port = portOf(byId, dock);
      const want = port ? asSide(port.owner) : null;
      if (!port) via.absent += 1; else via[want === null ? "neutral" : want] += 1;
      if (asSide(dock.owner) !== want) {
        divergent.push(dock.id + " owner=" + dock.owner + " port=" + (port ? port.id + "(" + port.owner + ")" : "absent"));
      }
    }
    if (divergent.length) {
      fail("pb355 (a): " + divergent.length + " of " + docks.length
        + " 1942 docks do not report their port's owner: " + divergent.slice(0, 5).join("; "));
    }
    if (!via.blue || !via.red) {
      fail("pb355 (a): the 1942 board resolved no docks through each side (blue " + via.blue
        + ", red " + via.red + "), so this leg would grade nothing");
    }
    // The card names this cell: Archangel's dock, the one the measurement walked.
    const archangel = list.find((site) => site && site.id === 0);
    const named = docks.find((dock) => dock.x === 181 && dock.y === 12);
    if (!archangel || !named) fail("pb355 (a): the named cell dock:181:12 or its port is missing from the 1942 board");
    eq(asSide(named.owner), asSide(archangel.owner), "pb355 (a): dock:181:12 must carry Archangel's owner");
  }

  // ---- (b) a blue transport on its own port's dock: no row, no pin --------------------------
  {
    const { list, byId, docks } = roster("1942");
    const dock = docks.find((candidate) => asSide((portOf(byId, candidate) || {}).owner) === "blue");
    if (!dock) fail("pb355 (b): the 1942 board has no dock beside a blue port");
    const { boat, rows } = militiaOn(list, dock);
    if (rows.length) {
      fail("pb355 (b): a blue transport on " + dock.id + ", whose port is blue, took a militia row: "
        + JSON.stringify(rows[0]));
    }
    eq(boat.pinned, undefined, "pb355 (b): the friendly dock must not pin the transport");
    eq(boat.strength, 100, "pb355 (b): the friendly dock must take no strength");
  }

  // ---- (c) a blue transport on a red port's dock: 2 and a pin (D11's enemy value) -----------
  {
    const { list, byId, docks } = roster("1942");
    const dock = docks.find((candidate) => asSide((portOf(byId, candidate) || {}).owner) === "red");
    if (!dock) fail("pb355 (c): the 1942 board has no dock beside a red port");
    const { boat, rows } = militiaOn(list, dock);
    if (rows.length !== 1) fail("pb355 (c): an enemy-port dock must charge exactly once, got " + rows.length);
    eq(rows[0].amount, 2, "pb355 (c)/D11: an enemy-owned site's militia costs 2");
    eq(rows[0].side, "red", "pb355 (c): the row names the port's side");
    eq(rows[0].pinned, true, "pb355 (c)/D12: the enemy beat pins the occupant");
    eq(boat.strength, 98, "pb355 (c): 100 -> 98 on an enemy dock");
    eq(boat.pinned, true, "pb355 (c)/D12: the pin lands on the piece");
  }

  // ---- (d) an unowned port (1986) and an out-of-year port (1918) still pay the neutral 20 ---
  {
    const bare = roster("1986");
    const dock = bare.docks.find((candidate) => {
      const port = portOf(bare.byId, candidate);
      return port && asSide(port.owner) === null;
    });
    if (!dock) fail("pb355 (d): the 1986 board has no dock beside a neutral port");
    eq(asSide(dock.owner), null, "pb355 (d): a neutral port's dock must be unowned on the row");
    const { boat, rows } = militiaOn(bare.list, dock);
    if (rows.length !== 1) fail("pb355 (d): an unowned-port dock must charge the squatter, got " + rows.length);
    eq(rows[0].amount, 20, "pb355 (d)/D11: an unowned site's militia costs 20");
    eq(rows[0].side, null, "pb355 (d)/D11: an unowned site's militia names no side");
    eq(boat.strength, 80, "pb355 (d)/D11: 100 -> 80 on the unowned dock");
    eq(boat.pinned, true, "pb355 (d)/D12: the neutral beat pins too");

    const floored = militiaOn(bare.list, dock, 25);
    eq(floored.boat.strength, 20, "pb355 (d)/D11: the neutral 20 is floored at strength 20");
  }
  {
    // 1918 drops 96 of the towns the docks serve. Those docks must be null - not country-seeded -
    // because this row is the authority before seedOwners runs.
    const old = roster("1918");
    const orphan = old.docks.find((candidate) => candidate.port !== undefined
      && candidate.port !== null && !portOf(old.byId, candidate));
    if (!orphan) fail("pb355 (d): the 1918 board has no dock whose port the year drops, so the absent-port arm is ungraded");
    eq(asSide(orphan.owner), null, "pb355 (d): a dock whose port is out of the year must be unowned");
    const { boat, rows } = militiaOn(old.list, orphan);
    if (rows.length !== 1) fail("pb355 (d): an out-of-year port's dock must charge the squatter, got " + rows.length);
    eq(rows[0].amount, 20, "pb355 (d)/D11: an out-of-year port is an unowned site: 20");
    eq(rows[0].side, null, "pb355 (d): no port this year, no side to name");
    eq(boat.pinned, true, "pb355 (d)/D12: the neutral beat pins");
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
