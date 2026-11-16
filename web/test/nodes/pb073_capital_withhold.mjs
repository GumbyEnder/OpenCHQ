// PB-073: the enemy capital is not drawn outside sight in the concealed era.
//
// The page painted the enemy capital's ring and name in era 9999 whatever the seat had been sent.
// Mechanism (frodo's read of the served build, reproduced here): a rolled era carries no type-1/2
// capital rows, so `capitalMarkers` fell through to a capitals map - and it read the BOARD payload,
// which is unfiltered and names both seats, instead of the seat's own `room.capitals`, from which
// forSeat has already removed a capital the seat may not see. The marker then paints after the fog,
// so it was never dimmed.
//
// Pinned here, all measured through the real modules:
//   1. forSeat blue in 9999 at round 0 omits the enemy capital from `capitals`;
//   2. capitalMarkers over that room draws NO red marker and never names the enemy capital;
//   3. the same board payload with no room still yields both fixed seats (the pre-room page);
//   4. once the enemy capital has been seen, the view carries it and the marker comes back;
//   5. a file era's own type-1/2 rows still win (PB-022), and 1942 still shows both seats.
//
// The paint-level half of the pin - no SCHEMATIC.red stroke operation anywhere in the concealed
// frame - lives in web/test/nodes/render.mjs, driven through paintMatch with a recording context.

import { matchSites } from "../../server/board.mjs";
import { openMatch } from "../../server/match.mjs";
import { seedOwners } from "../../server/economy.mjs";
import { forSeat } from "../../server/view.mjs";
import { capitalMarkers } from "../../public/render.mjs";

export const name = "pb073_capital_withhold";

function fail(message) {
  throw new Error("node test pb073_capital_withhold: " + message);
}

// The board payload as the page receives it: unfiltered, both seats, extract or bundled board.
function boardPayload(match) {
  const out = { capitals: {} };
  for (const side of ["blue", "red"]) {
    const point = match.capitals && match.capitals[side];
    if (point) out.capitals[side] = { name: point.name ? String(point.name) : undefined, x: point.x, y: point.y };
  }
  return out;
}

function names(markers) {
  return markers.map((marker) => String(marker.name)).sort();
}

function sides(markers) {
  return markers.map((marker) => marker.side).sort();
}

export async function run() {
  // --- 1. the seat view withholds the enemy capital -------------------------
  const concealed = openMatch("9999", matchSites("9999"));
  seedOwners(concealed);
  concealed.round = 0;
  const blue = forSeat(concealed, "blue");
  if (!blue.capitals || !blue.capitals.blue) {
    fail("9999 blue view has no own capital: " + JSON.stringify(blue.capitals));
  }
  if (blue.capitals.red) {
    fail("9999 blue view leaked the enemy capital: " + JSON.stringify(blue.capitals.red));
  }

  // --- 2. the marker set over that room carries no red ----------------------
  const board = boardPayload(concealed);
  if (!board.capitals.red) fail("the board payload lost its red seat, so this pin proves nothing");
  const concealedMarkers = capitalMarkers(board, blue);
  if (sides(concealedMarkers).join(",") !== "blue") {
    fail("concealed markers are " + JSON.stringify(sides(concealedMarkers)) + ", expected blue only (PB-073)");
  }
  const enemyName = String((concealed.capitals && concealed.capitals.red && concealed.capitals.red.name) || "Moscow");
  if (names(concealedMarkers).includes(enemyName)) {
    fail("the enemy capital's name " + enemyName + " still reaches the frame in era 9999");
  }

  // --- 3. no room: the pre-room page keeps its fixed seats ------------------
  const preRoom = capitalMarkers(board);
  if (names(preRoom).join(",") !== "Moscow,Washington") {
    fail("a page with no room lost the fixed seats: " + JSON.stringify(names(preRoom)));
  }
  // The board map must be READ, not merely coincide with the fixed seats: 9999's rolled capitals
  // happen to sit on the seat coordinates, so a payload that differs is the only way to see the
  // tier. A mutant that drops the board branch has to red here (frodo's PB-022 positive pin).
  const moved = { capitals: { blue: { name: "Alpha", x: 5, y: 6 }, red: { name: "Beta", x: 7, y: 8 } } };
  const movedMarkers = capitalMarkers(moved);
  if (JSON.stringify(movedMarkers.map((m) => [m.name, m.x, m.y])) !== JSON.stringify([["Alpha", 5, 6], ["Beta", 7, 8]])) {
    fail("the pre-room page ignored the board's capitals: " + JSON.stringify(movedMarkers));
  }
  // ...and a page with no board at all still gets the two fixed seats.
  const bareMarkers = capitalMarkers(undefined);
  if (JSON.stringify(bareMarkers.map((m) => [m.name, m.x, m.y])) !== JSON.stringify([["Washington", 79, 44], ["Moscow", 183, 25]])) {
    fail("a page with no board lost the fixed seats: " + JSON.stringify(bareMarkers));
  }

  // --- 4. once the enemy capital has been seen, the marker returns --------
  const found = openMatch("9999", matchSites("9999"));
  seedOwners(found);
  found.round = 0;
  found.seen = { blue: true };
  const afterSighting = forSeat(found, "blue");
  if (!afterSighting.capitals || !afterSighting.capitals.red) {
    fail("a sighted enemy capital is still withheld from the view");
  }
  const sightedMarkers = capitalMarkers(boardPayload(found), afterSighting);
  if (sides(sightedMarkers).join(",") !== "blue,red") {
    fail("a sighted enemy capital is still not drawn: " + JSON.stringify(sides(sightedMarkers)));
  }

  // --- 5. the file eras are untouched -------------------------------------
  const open = openMatch("1942", matchSites("1942"));
  seedOwners(open);
  open.round = 0;
  const openView = forSeat(open, "blue");
  const openMarkers = capitalMarkers(boardPayload(open), openView);
  if (!openMarkers.length) fail("1942 drew no capital markers at all");
  if (new Set(sides(openMarkers)).size !== 2) {
    fail("1942 no longer draws both seats: " + JSON.stringify(sides(openMarkers)));
  }
}
