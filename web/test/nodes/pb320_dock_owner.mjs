// PB-320: a dock's owner always follows its port's owner, and no unit captures a dock.
//
// RE: the capture handler FUN_1c0d_02ce (decompiled.c 9114-9265) flips the owner byte
// (site + 0x1102) of a record in the 84-site table. Docks are not in that table - board.mjs
// builds them from terrain id 1 (150 painted cells), and docs/re/PLACEMENT.md records that as
// DERIVED, not a recovered rule. Manual l.709 names only cities, bases and oil fields as
// capturable. So no dock line can come from a real capture, and a dock has no owner of its own:
// it follows the city it serves.
//
// What this pins:
//   (a) at the bell, every 1942 dock that has a port carries the port's owner (the old seed left
//       all 150 neutral, so the first unit to walk over one "took" it);
//   (b) a red ship parked on a blue city's dock flips nothing and emits no capture;
//   (c) when a land unit takes a city, its docks follow in the same pass, silently - one capture
//       event, the city's, and no "dock changed hands" line;
//   (d) a board-built dock with no port (a test fixture) is not occupiable either.
//
// Mutants this file is meant to catch:
//   - DOCK_KINDS back inside occupiable()          -> (b)/(d) read a dock capture;
//   - the seed sync deleted                        -> (a) reads 150 divergences;
//   - the occupy sync deleted                      -> (c) reads a stale blue/red dock;
//   - the occupy sync made noisy (a capture event) -> (c) reads a second line.
import { matchSites } from "../../server/board.mjs";
import { openMatch } from "../../server/match.mjs";
import { occupy, seedOwners } from "../../server/economy.mjs";
import { logLines } from "../../server/log.mjs";

export const name = "pb320_dock_owner";

const DOCK = /^docks?$/;

function piece(id, side, kind, x, y, domain = "land") {
  return { id, side, kind, domain, x, y, path: [], pace: 1, strength: 100, maxStrength: 100 };
}

function room1942() {
  const match = openMatch("1942", matchSites("1942"));
  seedOwners(match);
  match.round = 10;
  match.pieces = [];
  return match;
}

function portOf(match, dock) {
  if (dock.port === undefined || dock.port === null) return null;
  return match.sites.find((site) => site && String(site.id) === String(dock.port)) || null;
}

const docksOf = (match) => match.sites.filter((site) => site && DOCK.test(String(site.kind)));
const captures = (events) => (Array.isArray(events) ? events : []).filter((e) => e && e.type === "capture");
const dockCaptures = (events) => captures(events).filter((e) => DOCK.test(String(e.kind)));
const dockLines = (lines) => lines.filter((line) => /dock/i.test(line.text) && /changed hands/i.test(line.text));

export async function run(ctx) {
  const { fail } = ctx;

  // ---- (a) the bell: every dock carries its port's owner --------------------------------
  {
    const match = room1942();
    const docks = docksOf(match);
    if (docks.length !== 150) fail("pb320 (a): the 1942 board must carry 150 docks, got " + docks.length);
    let noPort = 0;
    const divergent = [];
    for (const dock of docks) {
      const port = portOf(match, dock);
      if (!port) { noPort += 1; continue; }
      if (dock.owner !== port.owner) {
        divergent.push(dock.id + " owner=" + dock.owner + " port=" + port.id + "(" + port.owner + ")");
      }
    }
    if (noPort) fail("pb320 (a): " + noPort + " docks have no port on the 1942 board");
    if (divergent.length) {
      fail("pb320 (a): " + divergent.length + " docks do not follow their port at the bell: " + divergent.slice(0, 5).join("; "));
    }
    const istanbul = match.sites.find((site) => site && site.name === "Istanbul");
    if (!istanbul || istanbul.owner !== "blue") fail("pb320 (a): Istanbul must open blue, got " + (istanbul && istanbul.owner));
  }

  // ---- (b) a ship on an enemy dock captures nothing -------------------------------------
  {
    const match = room1942();
    const istanbul = match.sites.find((site) => site && site.name === "Istanbul");
    const dock = docksOf(match).find((site) => portOf(match, site) === istanbul);
    if (!dock) fail("pb320 (b): Istanbul has no dock on the 1942 board");
    const before = dock.owner;
    match.pieces = [piece("red:ship:1", "red", "cruiser", dock.x, dock.y, "sea")];
    const events = occupy(match);
    if (dock.owner !== before) fail("pb320 (b): a red cruiser on a blue dock flipped it " + before + " -> " + dock.owner);
    if (istanbul.owner !== "blue") fail("pb320 (b): Istanbul changed owner without a land capture: " + istanbul.owner);
    if (dockCaptures(events).length) fail("pb320 (b): a ship emitted a dock capture: " + JSON.stringify(dockCaptures(events)));
    const own = logLines(match, "red", events, match.round);
    const foe = logLines(match, "blue", events, match.round);
    if (dockLines(own).length || dockLines(foe).length) {
      fail("pb320 (b): a ship printed a dock line: " + JSON.stringify(dockLines(own).concat(dockLines(foe))));
    }
  }

  // ---- (c) the city capture carries its docks, silently --------------------------------
  {
    const match = room1942();
    const seoul = match.sites.find((site) => site && site.name === "Seoul");
    if (!seoul || seoul.owner !== "red") fail("pb320 (c): Seoul must open red, got " + (seoul && seoul.owner));
    const itsDocks = docksOf(match).filter((site) => portOf(match, site) === seoul);
    if (!itsDocks.length) fail("pb320 (c): Seoul has no dock on the 1942 board");
    match.pieces = [piece("blue:inf:1", "blue", "infantry", seoul.x, seoul.y)];
    const events = occupy(match);
    if (seoul.owner !== "blue") fail("pb320 (c): a blue infantry on red Seoul did not take it: " + seoul.owner);
    for (const dock of itsDocks) {
      if (dock.owner !== "blue") fail("pb320 (c): " + dock.id + " did not follow Seoul to blue (owner " + dock.owner + ")");
    }
    const caps = captures(events);
    if (caps.length !== 1) fail("pb320 (c): the pass must emit exactly one capture (Seoul), got " + JSON.stringify(caps));
    if (dockCaptures(events).length) fail("pb320 (c): the city capture emitted a dock capture too: " + JSON.stringify(dockCaptures(events)));
    const lines = logLines(match, "blue", events, match.round);
    const took = lines.find((line) => /^took Seoul\b/.test(line.text));
    if (!took) fail("pb320 (c): the blue seat read no 'took Seoul' line: " + JSON.stringify(lines.map((l) => l.text)));
    if (dockLines(lines).length) fail("pb320 (c): the city capture printed a dock line: " + JSON.stringify(dockLines(lines)));
    const foeLines = logLines(match, "red", events, match.round);
    if (!foeLines.some((line) => /^Seoul was lost\b/.test(line.text))) {
      fail("pb320 (c): the red seat read no 'Seoul was lost' line: " + JSON.stringify(foeLines.map((l) => l.text)));
    }
    if (dockLines(foeLines).length) fail("pb320 (c): the loser read a dock line: " + JSON.stringify(dockLines(foeLines)));

    // A second pass with nobody on the city changes nothing.
    match.pieces = [];
    const idle = occupy(match);
    if (captures(idle).length) fail("pb320 (c): an empty pass fired a capture: " + JSON.stringify(captures(idle)));
    for (const dock of itsDocks) if (dock.owner !== "blue") fail("pb320 (c): " + dock.id + " left blue with nobody on Seoul");
  }

  // ---- (d) a dock with no port is still not occupiable ---------------------------------
  {
    const match = openMatch("1986", []);
    match.sites = [
      { id: 1, name: "Port", kind: "dock", owner: "blue", x: 10, y: 10 },
      { id: 2, name: "Town", kind: "city", type: 4, owner: "red", x: 50, y: 50 },
    ];
    match.pieces = [piece("red:inf:2", "red", "infantry", 10, 10), piece("blue:inf:2", "blue", "infantry", 50, 50)];
    match.round = 3;
    const events = occupy(match);
    const dock = match.sites[0];
    if (dock.owner !== "blue") fail("pb320 (d): a port-less dock flipped to " + dock.owner);
    if (dockCaptures(events).length) fail("pb320 (d): a port-less dock emitted a capture");
    if (match.sites[1].owner !== "blue") fail("pb320 (d): the city arm of the fixture did not take");
  }
}
