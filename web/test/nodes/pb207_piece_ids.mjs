// Node test: PB-207 — one id names one piece.
//
// The card's leading hypothesis is an identity collision: `red:infantry:2` naming two real pieces,
// which the id-keyed delta merge (web/public/app.js applyDelta) and the id-keyed shadow
// (web/server/lobby.mjs deltaBetween, `pieceSigs[piece.id]`) would then draw as ONE id hopping
// between two cells every round, with a strength that belongs to whichever row was applied last.
//
// The producer side of that claim is pinned here. Two creation paths exist — `openingPieces`
// (web/server/match.mjs) and `buy` (web/server/economy.mjs) — and every literal they emit must be
// unique inside match.pieces. If this test ever fails, PB-207's mechanism is real and the page-vs-
// server frame comparison is no longer the discriminator; if it passes, the collision has no
// producer in this tree and a live alternation needs a different explanation.
//
// What breaks if this feature is removed: a second piece could be created under an existing id, a
// seat's `bought` counter could reset (a resumed match) without the guard noticing, and the page
// would paint one id at two cells with no error anywhere.

import { ERAS, openMatch } from "../../server/match.mjs";
import { buy } from "../../server/economy.mjs";

export const name = "pb207_piece_ids";

// The board asset list the placement rule reads: a capital and a city per side, a dock per side.
// A city holds one land unit (placement rule), so the purchase half of this test needs a run of
// friendly cities per side, each on plain ground in the fixture below.
const SITES = [
  { id: 0, name: "Washington", x: 79, y: 44, kind: "capital", country_id: 0 },
  { id: 1, name: "Moscow", x: 183, y: 25, kind: "capital", country_id: 1 },
  { id: 20, name: "Norfolk", x: 2, y: 16, kind: "dock", country_id: 0 },
  { id: 21, name: "Sevastopol", x: 299, y: 69, kind: "dock", country_id: 1 },
];
const BLUE_CITIES = [];
for (let i = 0; i < 14; i += 1) {
  BLUE_CITIES.push({ id: 100 + i, name: `Blue ${i}`, x: 62 + (i % 7) * 4, y: 34 + Math.floor(i / 7) * 4, kind: "city", country_id: 0 });
}
const RED_CITIES = [];
for (let i = 0; i < 10; i += 1) {
  RED_CITIES.push({ id: 200 + i, name: `Red ${i}`, x: 178 + (i % 5) * 2, y: 27 + Math.floor(i / 5) * 2, kind: "city", country_id: 1 });
}
SITES.push(...BLUE_CITIES, ...RED_CITIES);

function boardFixture() {
  const width = 320;
  const height = 136;
  const terrain = ["ocean", "docks", "shallows", "lake", "capital", "base", "city", "oilfield",
    "plain", "forest", "mountain", "desert", "jungle", "polar", "wasteland", "facility"];
  const cells = new Array(width * height).fill(0); // ocean
  for (let y = 32; y <= 52; y++) {
    for (let x = 58; x <= 92; x++) cells[y * width + x] = 8; // plain around the blue sites
  }
  for (let y = 22; y <= 30; y++) {
    for (let x = 176; x <= 190; x++) cells[y * width + x] = 8; // plain around the red sites
  }
  for (let y = 12; y <= 20; y++) {
    for (let x = 0; x <= 8; x++) cells[y * width + x] = 8; // plain off the blue dock
  }
  for (let y = 64; y <= 74; y++) {
    for (let x = 294; x < width; x++) cells[y * width + x] = 8; // plain off the red dock
  }
  return { width, height, cells, terrain };
}

// The one measurement this card is about: no literal id appears twice.
function duplicateIds(pieces) {
  const seen = new Map();
  for (const piece of pieces) seen.set(piece.id, (seen.get(piece.id) || 0) + 1);
  return [...seen].filter(([, count]) => count > 1);
}

export async function run(ctx) {
  const { fail } = ctx;
  const must = (cond, message) => { if (!cond) fail(message); };
  const eq = (actual, expected, label) => {
    if (actual !== expected) fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  };
  const board = boardFixture();
  const sitesFor = () => SITES.map((site) => ({ ...site, owner: null }));

  // ---- every era's opening: one id per piece, and the shape the card names ----------------
  for (const era of ERAS) {
    const match = openMatch(era, sitesFor());
    const dupes = duplicateIds(match.pieces);
    eq(dupes.length, 0, `${era} opening has no duplicated id (${JSON.stringify(dupes.slice(0, 3))})`);
    // An opening piece is `${side}:${domain}` (no capture) or `${side}:open:${kind}:${n}` (capture).
    // Either way it must name a side, and a capture row must sit in the `open` namespace so a
    // purchase can never reach it.
    for (const piece of match.pieces) {
      must(String(piece.id).startsWith(piece.side + ":"), `${era} id ${piece.id} names its side`);
      if (String(piece.id).includes(":open:")) {
        must(/^[a-z]+:open:[a-z]+:\d+$/.test(piece.id), `${era} capture id ${piece.id} keeps the open namespace`);
      }
    }
  }

  // 1942 is the captured army (60 records): the only era where two rows can share a kind, which is
  // exactly what a serial-per-kind collision would need.
  const captured = openMatch("1942", sitesFor());
  must(captured.pieces.length >= 50, `1942 opens on the captured army (${captured.pieces.length} pieces)`);
  eq(duplicateIds(captured.pieces).length, 0, "1942's 60-record army has no duplicated id");

  // ---- purchases: repeated buys on both sides, across kinds, never reuse a literal ---------
  const match = openMatch("1986", sitesFor());
  match.sides.blue.cash = 1e12; // funded: this test is about ids, not the purse
  match.sides.red.cash = 1e12;
  const openings = new Set(match.pieces.map((piece) => piece.id));
  const bought = [];
  for (let i = 0; i < 12; i += 1) {
    const site = BLUE_CITIES[i];
    const row = buy(match, "blue", "infantry", site.x, site.y, board);
    must(row && row.ok, `blue infantry purchase ${i + 1} is accepted (${row && row.error})`);
    bought.push(row.piece.id);
  }
  for (let i = 0; i < 8; i += 1) {
    const site = RED_CITIES[i];
    const row = buy(match, "red", "infantry", site.x, site.y, board);
    must(row && row.ok, `red infantry purchase ${i + 1} is accepted (${row && row.error})`);
    bought.push(row.piece.id);
  }
  const tank = buy(match, "blue", "tank", BLUE_CITIES[12].x, BLUE_CITIES[12].y, board);
  must(tank && tank.ok, `blue tank purchase is accepted (${tank && tank.error})`);
  bought.push(tank.piece.id);
  const hull = buy(match, "blue", "cruiser", 2, 16, board);
  must(hull && hull.ok, `blue cruiser purchase is accepted (${hull && hull.error})`);
  bought.push(hull.piece.id);

  eq(new Set(bought).size, bought.length, "no two purchases share an id");
  eq(duplicateIds(match.pieces).length, 0, "the whole room has one id per piece after purchases");
  eq(match.pieces.length, new Set(match.pieces.map((piece) => piece.id)).size, "piece count equals distinct id count");
  for (const id of bought) must(!openings.has(id), `purchase id ${id} is outside the opening namespace`);

  // The guard is a real check, not luck: a resumed match restores the pieces but a fresh seat
  // counter (`bought: 0`), which is the realistic way a serial restarts. The next buy must walk
  // past every live literal instead of reusing one.
  match.sides.blue.bought = 0;
  const used = new Set(match.pieces.map((piece) => piece.id));
  const resumed = buy(match, "blue", "infantry", BLUE_CITIES[13].x, BLUE_CITIES[13].y, board);
  must(resumed && resumed.ok, `a purchase after a seat counter reset is accepted (${resumed && resumed.error})`);
  must(!used.has(resumed.piece.id), `the reset buy skipped every live id (got ${resumed.piece.id})`);
  eq(resumed.piece.id, "blue:infantry:13", "the reset buy lands on the first free serial");
  eq(duplicateIds(match.pieces).length, 0, "a seat counter reset cannot reuse a live id");
}
