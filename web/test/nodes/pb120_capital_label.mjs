// PB-120: the label on a capital takes its name from the site row on that cell, never from the
// fixed seat pair — and a resumed room keeps the era's `type` join, so it draws the era's own
// capitals instead of falling through to the fallback at all.
//
// Two defects met in the PM's reconnect frame ("Reconnected. The match is where you left it."):
//   1. rooms.mjs rebuilt a stored match's sites from board statics that carried name/x/y/kind but
//      not the era's `type`, so a resumed 1918 room arrived with 184 untyped sites. The page's
//      capitalMarkers() then took the CELL from room.capitals (the era's) and the NAME from
//      CAPITAL_SEATS (Washington/Moscow) — the reported pair over Britain and the Low Countries.
//   2. even with the type join intact, any frame whose sites lack type-1/2 rows named the fixed
//      pair instead of the site on the cell.
//
// Pinned here:
//   A. a type-stripped 1918 view names London@148,30 and Berlin@161,30 (RED at b6ae541);
//   B. the real save -> load path (saveRoom/loadRooms, the deploy-resume row shape) keeps `type`,
//      and the resumed 1918 seat's capitalLabels set is London@148,30, Berlin@161,30, Paris@150,34;
//   C. 2023 has no type-1/2 rows by design; until a capture says otherwise it draws the two fixed
//      cells from the site rows on them — Washington@79,44 and Moscow@183,25.
//
// The cell lookup is the authority; `room.capitals[side].name` (board payloads carry one) is the
// next tier; the fixed pair's name survives only for a page with neither a room nor a board, which
// is PB-073's pre-room frame and is pinned in pb073_capital_withhold.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { boardPayload, matchSites } from "../../server/board.mjs";
import { openMatch } from "../../server/match.mjs";
import { forSeat } from "../../server/view.mjs";
import { capitalMarkers } from "../../public/render.mjs";

export const name = "pb120_capital_label";

function fail(message) {
  throw new Error("node test pb120_capital_label: " + message);
}

function labelSet(markers) {
  return markers.map((m) => `${m.name}@${m.x},${m.y}`).join(" ");
}

function stripType(sites) {
  // The resume shape before the fix: the static rebuild kept name/x/y/kind and dropped `type`.
  return sites.map((site) => {
    const { type, ...rest } = site;
    return rest;
  });
}

export async function run(ctx) {
  const board = boardPayload();
  if (!board || !Array.isArray(board.sites) || !board.sites.length) {
    ctx.skip("no board extract or bundled board");
    return;
  }

  // --- A. type-stripped 1918 view: the name follows the cell, not the fixed pair ---------------
  const sites1918 = matchSites("1918", board);
  const caps1918 = sites1918.filter((s) => Number(s.type) === 1 || Number(s.type) === 2);
  if (caps1918.length !== 3) fail("1918's era table carries " + caps1918.length + " capital rows, expected 3");
  const stripped = stripType(sites1918);
  const room = {
    sites: stripped,
    capitals: { blue: { x: 148, y: 30 }, red: { x: 161, y: 30 } },
    pieces: [],
  };
  const strippedMarkers = capitalMarkers(board, room);
  if (labelSet(strippedMarkers) !== "London@148,30 Berlin@161,30") {
    fail("a type-stripped 1918 view draws " + labelSet(strippedMarkers) +
      ", expected London@148,30 Berlin@161,30 (never Washington/Moscow)");
  }

  // --- B. the resume row: saveRoom -> loadRooms keeps `type`, and the seat labels all three ----
  const dataDir = mkdtempSync(path.join(tmpdir(), "pb120-"));
  const previous = process.env.OPENCHQ_WEB_DATA;
  process.env.OPENCHQ_WEB_DATA = dataDir;
  let rooms;
  try {
    // db.mjs reads OPENCHQ_WEB_DATA at import, so the module is loaded after the temp dir is set.
    rooms = await import("../../server/rooms.mjs");
    const match = openMatch("1918", matchSites("1918", board));
    match.clock = "running";
    const id = "pb120-resume";
    rooms.saveRoom({
      id,
      mode: "bot",
      era: "1918",
      clock: match.clock,
      note: "",
      resume: true,
      speed: 1,
      seats: { blue: { kind: "human", username: "pb120a" }, red: { kind: "bot", username: "bot" } },
      match,
    });
    const rows = rooms.loadRooms();
    const row = rows.find((r) => r.id === id);
    if (!row) fail("saveRoom/loadRooms did not round-trip the room row");

    const resumed = row.match;
    const typed = resumed.sites.filter((s) => Number(s.type) === 1 || Number(s.type) === 2);
    if (typed.length !== 3) {
      fail("a resumed 1918 row carries " + typed.length + " typed capital rows, expected 3 " +
        "(the resume rebuild dropped the era's type join)");
    }
    // Per-id parity with the room's own opening for every id the row and the opening share. The
    // row rebuilds from the 84-row asset list, so it also carries ids the year's own opening
    // dropped (a separate, unmeasured resume gap), and it carries no dock/well rows; neither is
    // this ticket's subject. What must match, id by id, is the era's `type` join.
    const live = openMatch("1918", matchSites("1918", board));
    const liveById = new Map(live.sites.map((s) => [String(s.id), s]));
    let shared = 0;
    for (const site of resumed.sites) {
      const opened = liveById.get(String(site.id));
      if (!opened) continue;
      shared += 1;
      if ((opened.type === undefined ? "-" : opened.type) !== (site.type === undefined ? "-" : site.type)) {
        fail("site " + site.id + " resumed with type " + (site.type === undefined ? "none" : site.type) +
          ", the opening has " + (opened.type === undefined ? "none" : opened.type));
      }
    }
    if (shared < 25) fail("only " + shared + " resumed ids are shared with the opening; the comparison measured nothing");

    const resumedMarkers = capitalMarkers(board, forSeat(resumed, "blue"));
    if (labelSet(resumedMarkers) !== "London@148,30 Berlin@161,30 Paris@150,34") {
      fail("the resumed 1918 seat draws " + labelSet(resumedMarkers) +
        ", expected London@148,30 Berlin@161,30 Paris@150,34");
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.OPENCHQ_WEB_DATA;
    else process.env.OPENCHQ_WEB_DATA = previous;
  }

  // --- C. 2023: no capital rows by design, fixed cells named from their own site rows ----------
  const table = JSON.parse(
    await (await import("node:fs/promises")).readFile(new URL("../../data/eras.json", import.meta.url), "utf8"),
  );
  const rows2023 = (table.eras && table.eras["2023"] && table.eras["2023"].sites) || [];
  const caps2023 = rows2023.filter((r) => r.type === 1 || r.type === 2);
  if (caps2023.length !== 0) {
    fail("2023's era table now carries " + caps2023.length + " capital rows; this leg's premise moved");
  }
  const view2023 = forSeat(openMatch("2023", matchSites("2023", board)), "blue");
  const markers2023 = capitalMarkers(board, view2023);
  if (labelSet(markers2023) !== "Washington@79,44 Moscow@183,25") {
    fail("2023 draws " + labelSet(markers2023) + ", expected Washington@79,44 Moscow@183,25 " +
      "(site rows on the era's seat cells; original 2023 capitals are UNVERIFIED)");
  }
}
