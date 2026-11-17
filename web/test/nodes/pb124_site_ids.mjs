// PB-124: a room row records WHICH sites the room has, so a resume restores that list and not the
// board's picture list. Before this, every deploy drained the rooms and every live match came back
// thinner: 1918 184 -> 84 sites (all 150 docks and 9 oil wells gone), 1942 228 -> 84, 2023
// 271 -> 84. The knock-on is play, not cosmetics - `roomView.shop.seaRefusal` counts berths, so a
// side whose ports were docks was refused every hull after a deploy, and the 1918 room gained 59
// cities the year does not hold as neutral, occupiable ground.
//
// Pinned here:
//   A. saveRoom -> loadRooms gives 0 lost and 0 gained ids for 1918, 1942 and 2023, in the saved
//      order, with the dock count intact (RED at d2871d6: 159 lost / 59 gained on 1918);
//   B. after a resume, a side that holds a dock can buy a hull: the lobby's own sea-refusal
//      expression counts berths and economy.buy actually places a cruiser (RED at d2871d6, where
//      the dock is gone and the buy is refused);
//   C. a row with no `siteIds` (written before this change) still loads, from the era's roster.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { boardPayload, matchSites } from "../../server/board.mjs";
import { openMatch } from "../../server/match.mjs";
import { friendlySites } from "../../server/placement.mjs";
import { shopFor } from "../../server/shop.mjs";

export const name = "pb124_site_ids";

function fail(message) {
  throw new Error("node test pb124_site_ids: " + message);
}

const SEA_REFUSAL = "You hold no coastal city or dock, so a hull cannot be bought.";

export async function run(ctx) {
  const board = boardPayload();
  if (!board || !Array.isArray(board.sites) || !board.sites.length) {
    ctx.skip("no board extract or bundled board");
    return;
  }

  const dataDir = mkdtempSync(path.join(tmpdir(), "pb124-"));
  const previous = process.env.OPENCHQ_WEB_DATA;
  process.env.OPENCHQ_WEB_DATA = dataDir;
  try {
    // db.mjs reads OPENCHQ_WEB_DATA at import, so the module is loaded after the temp dir is set.
    const rooms = await import("../../server/rooms.mjs");
    const economy = await import("../../server/economy.mjs");

    // --- A. membership survives the save -> load round trip, per era ------------------------
    for (const era of ["1918", "1942", "2023"]) {
      const launched = matchSites(era, board);
      if (launched.length <= (board.sites || []).length) {
        fail("the " + era + " launch roster is " + launched.length + " sites, which is not bigger " +
          "than the " + (board.sites || []).length + "-row asset list; this leg's premise moved");
      }
      const match = openMatch(era, launched);
      match.clock = "running";
      const id = "pb124-resume-" + era;
      rooms.saveRoom({
        id,
        mode: "bot",
        era,
        clock: match.clock,
        note: "",
        resume: true,
        speed: 1,
        seats: { blue: { kind: "human", username: "pb124a" }, red: { kind: "bot", username: "bot" } },
        match,
      });
      const row = rooms.loadRooms().find((r) => r.id === id);
      if (!row) fail("saveRoom/loadRooms did not round-trip the " + era + " room row");

      const before = launched.map((s) => String(s.id));
      const after = row.match.sites.map((s) => String(s.id));
      const lost = before.filter((x) => !after.includes(x));
      const gained = after.filter((x) => !before.includes(x));
      if (lost.length || gained.length) {
        fail("a resumed " + era + " room lost " + lost.length + " and gained " + gained.length +
          " site ids (" + before.length + " -> " + after.length + ", e.g. lost " +
          JSON.stringify(lost.slice(0, 3)) + " gained " + JSON.stringify(gained.slice(0, 3)) + ")");
      }
      if (before.length !== after.length || before.some((x, i) => x !== after[i])) {
        fail("a resumed " + era + " room holds the right ids in a different order (" +
          before.length + " ids); the row must rebuild the list it saved");
      }
      const docksBefore = launched.filter((s) => s.kind === "dock").length;
      const docksAfter = row.match.sites.filter((s) => s.kind === "dock").length;
      if (docksBefore !== docksAfter) {
        fail("a resumed " + era + " room kept " + docksAfter + " of its " + docksBefore + " docks");
      }
      if (docksBefore === 0) fail("the " + era + " launch roster carries no docks; this leg measured nothing");
      rooms.deleteRoom(id);
    }

    // --- B. a resumed room's dock still buys a hull ------------------------------------------
    const launched = matchSites("1918", board);
    const match = openMatch("1918", launched);
    match.clock = "running";
    const dock = match.sites.find((s) => s.kind === "dock");
    if (!dock) fail("the 1918 launch has no dock to hold");
    dock.owner = "blue";
    const id = "pb124-buy";
    rooms.saveRoom({
      id,
      mode: "bot",
      era: "1918",
      clock: match.clock,
      note: "",
      resume: true,
      speed: 1,
      seats: { blue: { kind: "human", username: "pb124b" }, red: { kind: "bot", username: "bot" } },
      match,
    });
    const resumed = rooms.loadRooms().find((r) => r.id === id).match;
    // The lobby's own expression (lobby.mjs roomView): a side with no berth gets every hull row
    // refused rather than arming a unit that can never be placed.
    const berths = friendlySites(resumed, "blue", "sea", board);
    const shop = shopFor("1918", { seaRefusal: berths === 0 ? SEA_REFUSAL : "" });
    const refused = shop.filter((r) => r.domain === "sea" && r.refused).map((r) => r.kind);
    if (berths === 0 || refused.length) {
      fail("after a resume the dock-holding side has " + berths + " sea berths and " + refused.length +
        " refused hull rows " + JSON.stringify(refused) + "; a lost dock is a side that cannot build ships");
    }
    if (resumed.sides && resumed.sides.blue) resumed.sides.blue.cash = 200000;
    const piecesBefore = resumed.pieces.length;
    const bought = economy.buy(resumed, "blue", "cruiser", dock.x, dock.y, board);
    if (!bought || bought.error) {
      fail("a resumed 1918 room refused a cruiser at its own dock " + dock.id + ": " +
        JSON.stringify(bought && bought.error));
    }
    if (resumed.pieces.length !== piecesBefore + 1) {
      fail("the cruiser buy reported success but the piece count stayed at " + piecesBefore);
    }
    rooms.deleteRoom(id);

    // --- C. a pre-PB-124 row (no siteIds) still loads from the era's roster -------------------
    const legacy = rooms.unpackMatch({
      era: "1918",
      round: 1,
      siteOwners: { blue: [], red: [] },
      sitesUnready: [],
      siteReadyRounds: {},
      pieces: [],
      sides: {},
    });
    if (!legacy || !Array.isArray(legacy.sites) || !legacy.sites.length) {
      fail("a row written before PB-124 (no siteIds) loaded no sites at all");
    }
    const eraIds = new Set(matchSites("1918", board).map((s) => String(s.id)));
    const outside = legacy.sites.filter((s) => !eraIds.has(String(s.id))).length;
    if (outside) {
      fail("a row with no siteIds rebuilt " + outside + " ids the 1918 era roster does not hold");
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.OPENCHQ_WEB_DATA;
    else process.env.OPENCHQ_WEB_DATA = previous;
  }
}
