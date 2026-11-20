// Node test: docks and oil fields must exist as sites (graph node site_assets).
//
// What breaks if this feature is removed: a 1986 room's site list carries 84 cities,
// capitals and facilities and nothing else, so no ship can be bought (there is no dock) and
// no well can change hands (there is no oilfield). A room without the extract would also
// have to keep opening with an empty list instead of throwing.
//
// PB-153 moved the oil field from the sketched world.json `well` rows to the type-5 `facility`
// sites. This node pins the reversed rule: a sketched well is draw-only and is NOT captured,
// while a type-5 facility is taken by a ground unit standing on it.

import { matchSites } from "../../server/board.mjs";
import { openMatch } from "../../server/match.mjs";
import { buy, capture, occupy, upkeep } from "../../server/economy.mjs";

export const name = "site_assets";

const DOCK = (site) => site.kind === "dock" || site.kind === "docks";
const WELL = (site) => site.kind === "oilfield" || site.kind === "well";

export async function run(ctx) {
  const { fail, base } = ctx;
  const must = (cond, message) => {
    if (!cond) fail(message);
  };

  const boardRes = await fetch(base + "/api/board");
  if (boardRes.status !== 200) fail("board status " + boardRes.status);
  const board = await boardRes.json();
  if (board.source !== "extract") {
    ctx.skip("site_assets: no board extract on this host (set OPENCHQ_DATA or OPENCHQ_EXTRACT); got " + board.source);
  }
  const paintedDocks = board.cells.filter((id) => id === 1).length;
  must(paintedDocks > 0, "the painted terrain has no dock cells (id 1)");

  // ---- a real 1986 room carries docks and wells on its site list -----------------------
  const me = await ctx.register("SiteAssets");
  const socket = ctx.socket(me.token);
  await new Promise((resolve) => socket.ws.addEventListener("open", resolve));
  await socket.wait((m) => m.op === "welcome", "welcome");
  const before = socket.box.length;
  socket.send({ op: "bot", era: "1986", side: "blue" });
  const roomMsg = await socket.wait(
    (m) => m.op === "room" && m.room && m.room.mode === "bot",
    "1986 room",
    before
  );
  const room = roomMsg.room;
  must(Array.isArray(room.sites), "the room view has no site list");
  const docks = room.sites.filter(DOCK);
  const wells = room.sites.filter(WELL);
  must(docks.length > 0, "a 1986 room has no dock site: " + room.sites.length + " sites");
  must(wells.length > 0, "a 1986 room has no well site: " + room.sites.length + " sites");
  if (docks.length !== paintedDocks) {
    fail("docks on the match list " + docks.length + " do not match the painted cells " + paintedDocks);
  }
  for (const site of docks) {
    must(Number.isInteger(site.x) && Number.isInteger(site.y), "dock without a cell: " + JSON.stringify(site));
    must(site.id !== undefined && site.id !== null, "dock without an id: " + JSON.stringify(site));
    must(Boolean(site.name), "dock without a name: " + JSON.stringify(site));
  }
  const wellAt = board.cells[wells[0].y * board.width + wells[0].x];
  must(wellAt !== undefined, "well sits off the board: " + JSON.stringify(wells[0]));
  // The asset list's cities and capitals are still there, unchanged, next to the new sites.
  const baseNames = new Set(room.sites.map((site) => site.name));
  must(baseNames.has("Washington") && baseNames.has("Moscow"), "the capitals fell off the site list");
  for (const site of room.sites) {
    must(!Object.hasOwn(site, "production"), "a site carries an invented production rating: " + JSON.stringify(site));
  }
  socket.send({ op: "leave" });
  socket.close();

  // ---- a cruiser is bought at a dock, and a well is captured by standing on it -------------
  const match = openMatch("1986", matchSites("1986", board));
  must(match.sites.length >= room.sites.length, "the merge dropped sites: " + match.sites.length);
  upkeep(match); // seeds every dock and well with the country the board names

  const blueDock = match.sites.find(
    (site) => DOCK(site) && site.owner === "blue" &&
      !match.pieces.some((piece) => Number(piece.x) === Number(site.x) && Number(piece.y) === Number(site.y))
  );
  must(blueDock, "no friendly dock to buy a cruiser at");
  // A hull goes onto a friendly berth: a dock's own cell, or - under D-025 (T-021) - the water
  // cell beside a coastal city, base or capital. Ask the placement module for the cells it accepts
  // and for the cell the hull actually lands on, then put the cruiser there.
  const { canPlace, placementMask } = await import("../../server/placement.mjs");
  const mask = placementMask(match, "blue", "cruiser", board);
  must(mask && !mask.error, "no placement mask for a cruiser: " + JSON.stringify(mask));
  // A click goes to the CLICKED cell (lobby sends the cell the player hit); the module resolves
  // the water cell the hull lands on. Buying at the resolved berth cell instead would re-ask
  // canPlace about a cell that is not a site you hold (e.g. the neutral dock beside Reykjavik).
  let berth = null;
  let click = null;
  for (let id = 0; id < mask.mask.length && !berth; id++) {
    if (!mask.mask[id]) continue;
    const x = id % mask.width;
    const y = (id - x) / mask.width;
    const ok = canPlace(match, "blue", "cruiser", x, y, board);
    must(ok && !ok.error, "a highlighted berth was refused: " + JSON.stringify(ok));
    berth = ok.place;
    click = { x, y };
  }
  must(berth, "the board offers no berth for a cruiser");
  // Fund the fixture: a cruiser costs 10 billion (manual p.28) and the stand-in startPool is 9,
  // which T-001 deliberately left alone, so an unfunded seat cannot buy a hull.
  match.sides.blue.cash = 100000;
  const ship = buy(match, "blue", "cruiser", click.x, click.y, board);
  must(ship && ship.ok === true, "a cruiser in coastal water was refused: " + JSON.stringify(ship));
  must(ship.piece.domain === "sea", "the berth produced a " + ship.piece.domain + " piece");
  must(ship.piece.x === berth.x && ship.piece.y === berth.y, "the cruiser did not land on its berth");

  // PB-153 reversed the old rule this node used to pin: a world.json `well` is a hand-placed sketch,
  // draw-only. It keeps its display owner, and no rule may read it — standing on one captures
  // nothing. There are two paths that could take it, and the reversal has to hold on both:
  //   upkeep() -> capture()  (the path the old assertion used, now subtype-driven)
  //   occupy()               (the pass that takes cities, docks and type-5 facilities)
  // The original's oil field is the type-5 `facility` site (ids 64-83), and THAT is taken by a
  // ground unit standing on it.
  const redWell = match.sites.find((site) => WELL(site) && site.owner === "red");
  must(redWell, "no Red sketched well on the merged list");
  const walker = match.pieces.find((piece) => piece.id === "blue:land");
  must(walker, "the opening blue land piece is missing");
  const wellOwnerBefore = redWell.owner;
  walker.x = redWell.x;
  walker.y = redWell.y;
  const wellEvents = upkeep(match);
  must(
    !wellEvents.some((event) => event.type === "capture" && event.site === redWell.id),
    "upkeep captured a sketched well (PB-153: wells are not captured): " +
      JSON.stringify(wellEvents.filter((e) => e.type === "capture"))
  );
  must(redWell.owner === wellOwnerBefore, "a sketched well changed hands in upkeep: " + redWell.owner);
  const occupyEvents = occupy(match);
  must(
    !occupyEvents.some((event) => event.type === "capture" && event.site === redWell.id),
    "occupy captured a sketched well (PB-153: wells are not captured): " +
      JSON.stringify(occupyEvents.filter((e) => e.type === "capture"))
  );
  must(redWell.owner === wellOwnerBefore, "a sketched well changed hands in occupy: " + redWell.owner);

  // The real oil asset: a type-5 facility, taken by a ground unit. Site 64 is the RE-E6 probe
  // site; fall back to any free red-held facility if a rolled list ever moves it.
  const occupied = new Set(match.pieces.map((piece) => piece.x + "," + piece.y));
  const field = match.sites.find(
    (site) => site.kind === "facility" && site.owner === "red" && !occupied.has(site.x + "," + site.y)
  );
  must(field, "no free Red facility to take");
  walker.x = field.x;
  walker.y = field.y;
  const fieldEvents = upkeep(match);
  must(
    fieldEvents.some((event) => event.type === "capture" && event.site === field.id && event.side === "blue"),
    "standing on a type-5 facility did not capture it: " +
      JSON.stringify(fieldEvents.filter((e) => e.type === "capture"))
  );
  must(field.owner === "blue", "the captured facility still belongs to " + field.owner);
  // PB-156: the same rule on the other path. upkeep() above took the field; hand it back and let
  // occupy() — the pass that cities and docks go through — take it, or say so out loud.
  field.owner = "red";
  must(occupy(match).some((event) => event.type === "capture" && event.site === field.id && event.side === "blue") && field.owner === "blue", "occupy() did not take a type-5 facility, and m4 stayed red on it");
  // capture() refuses a city, so the new sites did not blunt the rule
  const city = match.sites.find((site) => site.kind === "city");
  must(city, "the merged list has no city");
  must(capture(match, "red", city.x, city.y).length === 0, "a city was captured as if it were a well");

  // ---- a room with no extract still opens with an empty site list ----------------------
  const emptyBoard = { source: "missing", sites: [], cells: null, wells: [] };
  const emptySites = matchSites("1986", emptyBoard);
  must(Array.isArray(emptySites) && emptySites.length === 0, "a missing extract invented sites: " + JSON.stringify(emptySites));
  const bare = openMatch("1986", emptySites);
  must(Array.isArray(bare.sites) && bare.sites.length === 0, "a room with no extract threw or invented sites");
  must(bare.pieces.length === 4, "a room with no extract lost its opening pieces: " + bare.pieces.length);
}
