// PB-295 pin: air reconnaissance, manual_pages.txt l.779 (PM's line refs; the manual text is not on
// this host, so the rule below is the PM's reading of p.25 and is quoted, not re-derived).
//
//   "An active air unit reveals every enemy unit nearby except submarines; an inactive one reveals
//    nothing, so enemies can drop out of view during inactivity."
//
// The producer under test is the seat view (`view.mjs forSeat`), which is what decides whether an
// enemy piece leaves the server at all: a hidden piece is ABSENT from the payload, never sent with a
// flag (view.mjs:1-6). Nothing in this module writes to the match through a scan, a satellite or an
// intel pass - every arm is ordinary sight from a single aircraft.
//
// Radius: the port has ONE sight radius (`rules().sightCells`, config `sightCells` 8, read through
// rules.mjs:435). There is no separate air-recon radius and no source line for `sightCells` in
// config/game.json, so the pin asserts the reveal follows the shipped radius and the ticket records
// it UNVERIFIED: the original's recon radius was never recovered.
//
// Arms (a) and (b) are GREEN and each carries a mutant (see the ticket card):
//   (a) an ACTIVE aircraft reveals an enemy within sight  -> mutated: aircraft dropped from the
//       sight origins (ownPieces.some(... own.domain !== "air" ...)) -> "the active plane did not
//       reveal an enemy infantry 5 cells away"
//   (b) the boundary IS config's sightCells               -> mutated: withinSight widened by one
//       -> "an enemy 9 cells away was revealed; config's sightCells is 8"
//
// Arms (c) and (d) are the two clauses the port does NOT have. They are reported as DEVIATIONS
// with the producer line, and they are not fixed here (PM 9835/9844: tests first, reds as
// deviations). At f5a6109 both red.
//   (c) INACTIVE reveals nothing     -> view.mjs (visibleEnemy, :140-145) has no air-inactivity rule
//   (d) submarines are never revealed -> view.mjs:142 hides a submarine only while it did not move
//       and is not fighting, and that predicate is origin-blind, so a moving sub is seen from the air
import { CELL_W } from "../../server/board.mjs";
import { warMatch } from "../wartime.mjs";
import { forSeat } from "../../server/view.mjs";
import { rules } from "../../server/rules.mjs";

export const name = "pb295_air_recon";

const ROUND = 10;

function sight() {
  const value = Number((rules() || {}).sightCells);
  if (!(Number.isInteger(value) && value > 0)) {
    throw new Error("pb295: rules().sightCells is " + JSON.stringify((rules() || {}).sightCells));
  }
  return value;
}

// A board with ONE blue aircraft and whatever the arm puts in front of it. Sites exist so the
// aircraft has a berth to sit on; nothing in this module flies a mission.
function board() {
  const match = warMatch("1986", []);
  match.round = ROUND;
  match.clock = "running";
  match.sites = [
    { id: 10, name: "New York", x: 80, y: 40, kind: "city", type: 4, owner: "blue" },
    { id: 12, name: "Kiev", x: 40, y: 120, kind: "city", type: 4, owner: "red" },
  ];
  match.capitals = { blue: { x: 80, y: 40 }, red: { x: 40, y: 120 } };
  match.pieces = [{
    id: "blue:air:295", side: "blue", domain: "air", kind: "aircraft", x: 80, y: 40,
    path: [], pace: 1, facing: null, fighting: null, shots: 0, strength: 100, maxStrength: 100,
  }];
  return match;
}

function piece(id, side, kind, domain, x, y, extra = {}) {
  return {
    id, side, domain, kind, x, y, path: [], pace: 1, facing: null, fighting: null,
    shots: 0, strength: 100, maxStrength: 100, ...extra,
  };
}

function seen(match, id) {
  const payload = forSeat(match, "blue", Date.now());
  return (payload.pieces || []).some((unit) => unit.id === id);
}

export async function run(ctx) {
  const { fail } = ctx;
  const radius = sight();
  const reds = [];
  const arm = (label, body) => {
    try {
      body();
      console.log("pb295 arm " + label + " ok");
    } catch (err) {
      reds.push("arm " + label + ": " + (err && err.message ? err.message : String(err)));
    }
  };

  // ---- (a) an ACTIVE aircraft reveals every enemy unit nearby ----------------------------------
  arm("(a) active-reveal l.779", () => {
    const match = board();
    match.pieces.push(piece("red:inf:1", "red", "infantry", "land", 80 + radius - 3, 40));
    if (!seen(match, "red:inf:1")) {
      fail("the active plane did not reveal an enemy infantry " + (radius - 3) + " cells away"
        + " (sight is config's " + radius + "); producer: web/server/view.mjs visibleEnemy:143,"
        + " ownPieces.some(... withinSight)");
    }
  });

  // ---- (b) the boundary is exactly the port's sight radius -------------------------------------
  arm("(b) radius-is-config l.779", () => {
    const at = board();
    at.pieces.push(piece("red:inf:edge", "red", "infantry", "land", 80 + radius, 40));
    if (!seen(at, "red:inf:edge")) {
      fail("an enemy exactly " + radius + " cells away (config sightCells) was NOT revealed;"
        + " producer: web/server/view.mjs withinSight:55-57");
    }
    const past = board();
    past.pieces.push(piece("red:inf:past", "red", "infantry", "land", 80 + radius + 1, 40));
    if (seen(past, "red:inf:past")) {
      fail("an enemy " + (radius + 1) + " cells away was revealed; config's sightCells is " + radius
        + " (producer: web/server/view.mjs withinSight:55-57)");
    }
    // The wrap seam is the same rule, not a second one: x = 0 and the same d on the other edge.
    const wrap = board();
    wrap.sites = wrap.sites.map((site) => site);
    wrap.pieces[0].x = 1;
    wrap.pieces.push(piece("red:inf:wrap", "red", "infantry", "land", (1 - radius % CELL_W + CELL_W) % CELL_W, 40));
    if (!seen(wrap, "red:inf:wrap")) {
      fail("an enemy " + radius + " cells away ACROSS the wrap seam was not revealed"
        + " (producer: web/server/view.mjs distance:47-53)");
    }
  });

  // ---- (c) an INACTIVE aircraft reveals nothing ------------------------------------------------
  arm("(c) inactive-blind l.779", () => {
    const active = board();
    active.pieces.push(piece("red:inf:2", "red", "infantry", "land", 85, 40));
    if (!seen(active, "red:inf:2")) {
      fail("control: the ACTIVE plane did not reveal the infantry 5 cells away, so this arm cannot"
        + " measure what inactivity does (view.mjs:145)");
    }
    const idle = board();
    idle.pieces[0].inactiveUntil = ROUND + 8;
    idle.pieces.push(piece("red:inf:2", "red", "infantry", "land", 85, 40));
    if (seen(idle, "red:inf:2")) {
      fail("an INACTIVE aircraft still revealed an enemy infantry 5 cells away; manual l.779 says an"
        + " inactive air unit reveals nothing, so the enemy must drop out of view while it is away."
        + " Producer: web/server/air.mjs inactiveRounds is never read by web/server/view.mjs"
        + " visibleEnemy (:114-143) - DEVIATION, not fixed here");
    }
  });

  // ---- (d) air recon never reveals a submarine -------------------------------------------------
  // Two arms, because the port's one predicate has two escape hatches (moved, fighting) and a red
  // on the first would otherwise hide the second.
  arm("(d1) submarine-moved-exempt l.779", () => {
    const moving = board();
    moving.pieces.push(piece("red:sub:moved", "red", "submarine", "sea", 85, 40, { movedRound: ROUND }));
    if (seen(moving, "red:sub:moved")) {
      fail("a submarine that moved this round was revealed by an aircraft 5 cells away; manual l.779"
        + " excepts submarines from air reconnaissance. Producer: web/server/view.mjs:142 hides a"
        + " sub only while it did NOT move and is not fighting, and the predicate is origin-blind,"
        + " so air sight receives it - DEVIATION, not fixed here");
    }
  });

  arm("(d2) submarine-fighting-exempt l.779", () => {
    const fighting = board();
    fighting.pieces.push(piece("red:sub:fight", "red", "submarine", "sea", 85, 40, { fighting: "blue:air:295" }));
    if (seen(fighting, "red:sub:fight")) {
      fail("a submarine in a fight was revealed by an aircraft 5 cells away; manual l.779 excepts"
        + " submarines from air reconnaissance (producer: web/server/view.mjs:142) - DEVIATION,"
        + " not fixed here");
    }
  });

  arm("(d3) surface-sight-control l.779", () => {
    // Control: the exception is the AIRCRAFT's, not a blanket one. A surface piece still sees a
    // submarine that moved, so arms (d1)/(d2) cannot pass by hiding every submarine from everyone.
    const ship = board();
    ship.pieces[0] = piece("blue:cruiser:1", "blue", "cruiser", "sea", 80, 40);
    ship.pieces.push(piece("red:sub:seen", "red", "submarine", "sea", 85, 40, { movedRound: ROUND }));
    if (!seen(ship, "red:sub:seen")) {
      fail("control: a blue cruiser did not reveal the moving submarine 5 cells away, so the"
        + " submarine exception cannot be attributed to air recon (view.mjs:142)");
    }
  });

  // ---- the radius has no source, and the ticket must say so ------------------------------------
  {
    const config = (rules() || {});
    const source = config.sightCellsSource;
    if (source === undefined || source === null || String(source).trim() === "") {
      console.log("pb295 note: config sightCells = " + radius + " carries NO source line; the recon"
        + " radius stays as the port has it and is recorded UNVERIFIED in the ticket");
    } else if (!/UNVERIFIED|STAND-IN|UNMEASURED/i.test(String(source))) {
      console.log("pb295 note: config sightCellsSource = " + JSON.stringify(source));
    }
  }

  if (reds.length) {
    throw new Error(reds.length + " arm(s) red at f5a6109 - " + reds.join(" | "));
  }
}
