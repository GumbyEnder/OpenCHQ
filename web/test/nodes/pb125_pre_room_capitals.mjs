// Node pb125_pre_room_capitals: a frame with an era but no room draws THAT era's capitals, in the
// era owner's ink (PB-125).
//
// The defect this pins: capitalMarkers() had one fallback for every frame without a room, and it
// read board.capitals - the archive's fixed pair, Washington blue / Moscow red - then painted the
// seat's side colour unconditionally. So a 1942 lobby painted a RED ring on Moscow while 1942's own
// rows say Moscow is BLUE, and the same cell changed colour the moment the match loaded. The fix
// makes the fallback read the same era table a match reads (board.capitalsByEra, built by
// eraCapitals()) and paints NEUTRAL where there is no owner byte at all.
//
// Positive controls, so the pin cannot be satisfied by blanking every ring: 1986's Moscow is
// genuinely RED (the one year the fixed pair is right), 1942's Berlin and Tokyo are RED, and a
// seated view is untouched (PB-073/PB-120 keep their paths).
import { boardPayload, matchSites, eraCapitals, CAPITAL_ERA_YEARS } from "../../server/board.mjs";
import { capitalMarkers, CAPITAL_NEUTRAL } from "../../public/render.mjs";
import { SCHEMATIC } from "../../public/paint.mjs";

export const name = "pb125_pre_room_capitals";

const key = (c) => `${c.name}@${c.x},${c.y}:${c.side || "none"}`;

export async function run(ctx) {
  const { fail } = ctx;
  const board = boardPayload();
  if (!board || !Array.isArray(board.sites) || !board.sites.length) {
    fail("the board payload carries no sites, so this leg would measure nothing");
  }
  if (!board.capitalsByEra || typeof board.capitalsByEra !== "object") {
    fail("the board payload carries no capitalsByEra: the pre-room fallback has no era source to read");
  }
  for (const year of CAPITAL_ERA_YEARS) {
    if (!Array.isArray(board.capitalsByEra[year])) {
      fail(`capitalsByEra has no array for ${year}`);
    }
  }

  // 1. The payload's per-era rows ARE the era table's type-1/2 rows, owner included.
  for (const year of CAPITAL_ERA_YEARS) {
    const want = matchSites(year, board)
      .filter((site) => Number(site.type) === 1 || Number(site.type) === 2)
      .map((site) => `${site.name}@${site.x},${site.y}:${site.owner || "none"}`)
      .sort();
    const got = board.capitalsByEra[year].map((c) => `${c.name}@${c.x},${c.y}:${c.side || "none"}`).sort();
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      fail(`capitalsByEra[${year}] is not the era's own type-1/2 rows: got ${JSON.stringify(got)} wanted ${JSON.stringify(want)}`);
    }
  }

  // 2. THE DEFECT: a 1942 pre-room frame. Moscow must be BLUE (its era owner), and the red ring the
  // report measured at (183,25) must be gone.
  const lobby1942 = capitalMarkers(board, null, "1942");
  const moscow = lobby1942.find((c) => c.name === "Moscow");
  if (!moscow) fail("the 1942 pre-room frame lost Moscow entirely: " + JSON.stringify(lobby1942.map(key)));
  if (moscow.side !== "blue" || moscow.color !== SCHEMATIC.blue) {
    fail(`a 1942 pre-room frame paints Moscow side=${moscow.side || "none"} ink=${moscow.color}; 1942's row says blue and ink ${SCHEMATIC.blue} — this is the PB-125 defect`);
  }
  if (moscow.x !== 183 || moscow.y !== 25) fail("the 1942 Moscow marker is on the wrong cell: " + key(moscow));
  const moscowRed = lobby1942.filter((c) => c.x === 183 && c.y === 25 && c.color === SCHEMATIC.red);
  if (moscowRed.length) fail("a red ring is still drawn at 183,25 in 1942");
  for (const [nm, side] of [["Berlin", "red"], ["Tokyo", "red"], ["London", "blue"]]) {
    const m = lobby1942.find((c) => c.name === nm);
    if (!m) fail(`the 1942 pre-room frame lost ${nm}: ` + JSON.stringify(lobby1942.map(key)));
    if (m.side !== side) fail(`1942 pre-room ${nm} reads ${m.side}; the era row says ${side}`);
  }

  // 3. The same cell must not change colour when the room arrives (AC2). The in-room path is the
  // frame's own: a room carrying the era's site rows.
  const room1942 = { era: "1942", sites: matchSites("1942", board) };
  const inRoom = capitalMarkers(board, room1942);
  const roomMoscow = inRoom.find((c) => c.name === "Moscow");
  if (!roomMoscow) fail("the 1942 in-room frame lost Moscow");
  if (roomMoscow.color !== moscow.color) {
    fail(`Moscow changes colour between the lobby (${moscow.color}) and the match (${roomMoscow.color}) — PB-125 AC2`);
  }
  if (JSON.stringify(inRoom.map(key).sort()) !== JSON.stringify(lobby1942.map(key).sort())) {
    fail("the 1942 lobby and match draw different capital sets: " + JSON.stringify([lobby1942.map(key), inRoom.map(key)]));
  }

  // 4. Positive control: 1986's Moscow IS red, so this is data, not a blanket recolour.
  const lobby1986 = capitalMarkers(board, null, "1986");
  const moscow86 = lobby1986.find((c) => c.name === "Moscow");
  if (!moscow86 || moscow86.side !== "red" || moscow86.color !== SCHEMATIC.red) {
    fail("1986's Moscow is not red in the pre-room frame: " + JSON.stringify(moscow86));
  }

  // 5. 1918: the era's own three capitals, and NEITHER fixed seat labelled as a capital.
  const lobby1918 = capitalMarkers(board, null, "1918");
  const names18 = lobby1918.map((c) => c.name).sort();
  if (JSON.stringify(names18) !== JSON.stringify(["Berlin", "London", "Paris"])) {
    fail("the 1918 pre-room frame does not draw the era's own capitals: " + JSON.stringify(names18));
  }
  if (lobby1918.some((c) => c.x === 79 && c.y === 44) || lobby1918.some((c) => c.x === 183 && c.y === 25)) {
    fail("1918's pre-room frame still marks Washington/Moscow as capitals");
  }

  // 6. Eras whose capitals roll at launch draw none pre-room.
  for (const year of ["2023", "9999"]) {
    const markers = capitalMarkers(board, null, year);
    if (markers.length !== 0) {
      fail(`era ${year} has no file capitals, but the pre-room frame draws ${JSON.stringify(markers.map(key))}`);
    }
  }

  // 7. AC3: with no era at all the fixed pair keeps its cells and names, NEUTRAL ink, no side claim.
  const noEra = capitalMarkers(board, null, "");
  if (JSON.stringify(noEra.map((c) => [c.name, c.x, c.y])) !== JSON.stringify([["Washington", 79, 44], ["Moscow", 183, 25]])) {
    fail("a frame with no era lost the fixed seats: " + JSON.stringify(noEra.map(key)));
  }
  if (noEra.some((c) => c.color !== CAPITAL_NEUTRAL)) {
    fail("a frame with no era paints a side ink it has no owner byte for: " + JSON.stringify(noEra.map((c) => [c.name, c.color])));
  }

  // 8. The era is read off the payload too, because that is how the lobby reaches render.mjs.
  const payloadEra = capitalMarkers({ ...board, era: "1942" }, null);
  if (JSON.stringify(payloadEra.map(key).sort()) !== JSON.stringify(lobby1942.map(key).sort())) {
    fail("the pre-room frame ignores board.era: " + JSON.stringify(payloadEra.map(key)));
  }

  // 9. eraCapitals() is the one projection: no era rows (an empty site list) answers an empty set,
  // never a fixed pair.
  if (eraCapitals([], "1942").length !== 0) fail("eraCapitals invented capitals from an empty site list");
}
