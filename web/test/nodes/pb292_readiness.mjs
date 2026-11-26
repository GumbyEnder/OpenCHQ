// PB-292 pin: the readiness SHAPE the manual states (manual_pages.txt l.914-917), at the server.
//
//   (a) producing a unit makes the producing city AND some nearby friendly cities unready;
//   (b) a costlier unit gives a longer unready time than a cheaper one at the same city;
//   (c) more nearby friendly cities, capitals especially, give a longer time;
//   (d) placing in an unready city is refused, with a message that names the round it is ready.
//
// Only the SHAPE is pinned - presence and orderings. The exact durations are NOT: the arithmetic
// (radiusSq 401, price scale 80/3, capital base, pooling, rounding) is already pinned by
// web/test/nodes/pb154_readiness.mjs:79-172 and is cited, not duplicated. The per-round rate has no
// RE/Ghidra citation beyond that formula, so nothing here asserts a number.
//
// What each arm would read if its producer were removed (the mutant each arm needs):
//   (a) poolReadiness writes only the build site            -> the neighbour arm reads one site
//   (b) the price term dropped from the pooled sum          -> tank reads the same as infantry
//   (c) the pooling divisor (readiness.mjs capitalDivisor / the total/count split) - see the
//       deviation note below: this arm is RED on this tree and is reported, not fixed
//   (d) unreadyRefusal without the round                    -> the refusal stops naming a round
import { warMatch } from "../wartime.mjs";
import { matchSites, boardPayload } from "../../server/board.mjs";
import { seedOwners, buy } from "../../server/economy.mjs";
import { capitalDivisor, poolReadiness, readinessNeighbours, unreadyRefusal } from "../../server/readiness.mjs";
import { readinessRules, priceOf } from "../../server/rules.mjs";

export const name = "pb292_readiness";

const ROUND = 10;

// A fresh match per measurement. The build site must come from the SAME match it is pooled in:
// readinessNeighbours matches on identity, so a site object carried across matches is not in the
// list and the pooled numbers move for the wrong reason.
function open() {
  const match = warMatch("1986", matchSites("1986"));
  seedOwners(match);
  match.pieces = [];
  match.round = ROUND;
  return match;
}

function buildCity(match) {
  const city = match.sites.find((site) => site.kind === "city" && site.owner === "blue");
  if (!city) throw new Error("pb292: the 1986 board must open with a blue city");
  return city;
}

// Pool one purchase at the build city and report the shape facts, not the arithmetic.
function pool(kind, mutate = null) {
  const match = open();
  const city = buildCity(match);
  if (mutate) mutate(match, city);
  const out = poolReadiness(match, "blue", city, kind);
  const neighbours = readinessNeighbours(match, "blue", city);
  return { match, city, out, neighbours, caps: capitalDivisor(match, "blue") };
}

// Put a producing site of the given kind within readinessRules().radiusSq of the build city, owned
// by blue, so "one more nearby friendly city" is a controlled variable.
function addNearby(match, city, kind) {
  const { radiusSq } = readinessRules();
  const site = match.sites.find((entry) => entry && entry.kind === kind && entry.owner !== "blue");
  if (!site) return null;
  site.owner = "blue";
  site.x = city.x + 3;
  site.y = city.y + 3;
  if ((3 * 3 + 3 * 3) >= radiusSq) throw new Error("pb292: the fixture offset is outside the readiness radius");
  return site;
}

export async function run(ctx) {
  const { fail } = ctx;
  const rules = readinessRules();
  if (!(Number(rules.radiusSq) > 0)) fail("pb292: readinessRules().radiusSq is " + rules.radiusSq + "; the pin needs a live radius");

  // ---- (a) l.914-917: the build site AND nearby friendly cities go unready -------------------
  {
    const base = pool("infantry");
    const written = base.out.sites;
    const ids = [...new Set(written.map(String))];
    if (!ids.includes(String(base.city.id))) {
      fail("pb292 (a) l.914-917: producing did not make the build city " + base.city.id + " unready (wrote " + JSON.stringify(written) + ")");
    }
    if (ids.length < 2) {
      fail("pb292 (a) l.914-917: producing made ONLY the build city unready - no nearby friendly city was written "
        + "(wrote " + JSON.stringify(written) + ", neighbours " + JSON.stringify(base.neighbours.map((s) => s.id)) + "). "
        + "Producer: web/server/readiness.mjs poolReadiness's write loop over `listed`");
    }
    const neighbourIds = base.neighbours.map((site) => String(site.id));
    const writtenNeighbour = ids.some((id) => id !== String(base.city.id) && neighbourIds.includes(id));
    if (!writtenNeighbour) {
      fail("pb292 (a) l.914-917: the written set " + JSON.stringify(ids) + " names no readiness neighbour of "
        + base.city.id + " (" + JSON.stringify(neighbourIds) + ")");
    }
    if (!(base.out.round > ROUND)) fail("pb292 (a): the pooled timer is " + base.out.round + ", not after round " + ROUND);
    console.log("pb292 arm (a) ok at l.914-917: city " + base.city.id + " and " + (ids.length - 1) + " neighbour site(s) went unready until round " + base.out.round);
  }

  // ---- (b) l.914-917: a costlier unit is unready longer at the same city ---------------------
  {
    const cheap = pool("infantry");
    const dear = pool("tank");
    if (!(priceOf("tank") > priceOf("infantry"))) fail("pb292 (b): the fixture needs tank to cost more than infantry");
    if (!(dear.out.rounds > cheap.out.rounds)) {
      fail("pb292 (b) l.914-917: a tank (" + priceOf("tank") + ") read " + dear.out.rounds
        + " rounds where infantry (" + priceOf("infantry") + ") read " + cheap.out.rounds
        + " - the costlier unit is not unready longer. Producer: web/server/readiness.mjs poolReadiness's price term");
    }
    console.log("pb292 arm (b) ok at l.914-917: infantry " + cheap.out.rounds + " rounds, tank " + dear.out.rounds + " at the same city");
  }

  // ---- (d) l.914-917: placing in an unready city is refused, naming the round it is ready -----
  {
    const match = open();
    const city = buildCity(match);
    const readyAt = ROUND + 7;
    city.readyRound = readyAt;
    const seat = match.sides.blue;
    seat.cash = 99999;
    const refused = buy(match, "blue", "infantry", city.x, city.y, boardPayload());
    if (!refused || typeof refused.error !== "string") {
      fail("pb292 (d) l.914-917: placing in an unready city was ACCEPTED (result " + JSON.stringify(refused && refused.error) + ")");
    }
    if (!String(refused.error).includes(String(readyAt))) {
      fail("pb292 (d) l.914-917: the refusal does not name the round the city is ready: " + JSON.stringify(refused.error)
        + " (readyRound " + readyAt + "). Producer: web/server/readiness.mjs:210-215 unreadyRefusal, called from "
        + "web/server/placement.mjs:655/695");
    }
    // The other direction: a READY city is not refused for readiness (it may still refuse for cash
    // or footprint; the point is that the message is not the readiness one).
    const fresh = open();
    const readyCity = buildCity(fresh);
    fresh.sides.blue.cash = 99999;
    const bought = buy(fresh, "blue", "infantry", readyCity.x, readyCity.y, boardPayload());
    if (bought && typeof bought.error === "string" && /isn't ready/i.test(bought.error)) {
      fail("pb292 (d) l.914-917: a READY city was refused with the readiness message: " + JSON.stringify(bought.error));
    }
    console.log("pb292 arm (d) ok at l.914-917: unready city refused with " + JSON.stringify(refused.error));
  }
  // ---- (c) l.914-917: more nearby friendly cities, capitals especially, give a LONGER time ----
  // Both halves are measured before any failure so the row carries both numbers: the manual's
  // sentence has two clauses and a ruling may split them.
  {
    const one = pool("infantry");
    const more = pool("infantry", (match, city) => {
      const added = addNearby(match, city, "city");
      if (!added) throw new Error("pb292 (c): no non-blue city to bring alongside");
    });
    const cap = pool("infantry", (match, city) => {
      const added = addNearby(match, city, "capital");
      if (!added) throw new Error("pb292 (c): no non-blue capital to bring alongside");
    });
    const cityHolds = more.out.rounds > one.out.rounds;
    const capHolds = cap.out.rounds > one.out.rounds;
    console.log("pb292 arm (c) measured: alone " + one.out.rounds + " rounds; +1 city " + more.out.rounds
      + " (neighbours " + one.neighbours.length + " -> " + more.neighbours.length + ", caps " + one.caps + " -> " + more.caps
      + "); +1 capital " + cap.out.rounds + " (caps " + one.caps + " -> " + cap.caps + ")");
    if (!cityHolds || !capHolds) {
      const parts = [];
      if (!cityHolds) {
        parts.push("(cities) one more nearby friendly city made the same purchase " + more.out.rounds
          + " rounds where the unpadded city read " + one.out.rounds
          + " (neighbours " + one.neighbours.length + " -> " + more.neighbours.length + ") - the manual says more "
          + "nearby friendly cities give a LONGER time; web/server/readiness.mjs:139-166 pools a ready neighbour's "
          + "timer (0) into `total` and 1 into `count`, so the average falls");
      }
      if (!capHolds) {
        parts.push("(capitals) one more friendly capital made it " + cap.out.rounds + " rounds where the unpadded city read "
          + one.out.rounds + " (caps divisor " + one.caps + " -> " + cap.caps + ") - the manual says capitals ESPECIALLY "
          + "give a longer time; web/server/readiness.mjs:89-100 capitalDivisor puts each capital in the price term's "
          + "DIVISOR");
      }
      fail("pb292 (c) l.914-917 DEVIATION " + parts.join("; ") + ". Measured, reported, not fixed (PM 9823).");
    }
    console.log("pb292 arm (c) ok at l.914-917: +1 city " + one.out.rounds + " -> " + more.out.rounds + ", +1 capital -> " + cap.out.rounds);
  }
}
