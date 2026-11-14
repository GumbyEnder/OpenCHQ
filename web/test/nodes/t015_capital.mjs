// T-015 node test. Owner: game.
//
// What breaks if this file is removed: the two things T-015 exists for go back to being unchecked
// prose. (1) The measured duel — a lone tank against a dug-in 100-strength garrison on a capital —
// must end with the tank dead and the capital still red, as the original does (T-013b / PB-034).
// (2) An undefended capital must still fall on arrival (T-013 AC3), so the fix cannot have been
// "make capitals immortal". (3) A bot capital with hostile strength near it must get a defender
// sent, and a quiet one must not (Part B, docs/re/AI.md).
//
// The duel legs need the board extract; on a host without it they skip, the way every other
// board-dependent node here does.

import { boardPayload, matchSites } from "../../server/board.mjs";
import { openMatch } from "../../server/match.mjs";
import { tickMatch } from "../../server/tick.mjs";
import { issueOrder } from "../../server/move.mjs";
import { seedOwners } from "../../server/economy.mjs";
import { holderOf } from "../../server/capitals.mjs";
import { ordersFor, siteThreat, threatenedSites } from "../../server/bot.mjs";

export const name = "t015_capital";

function haveBoard() {
  try {
    const payload = boardPayload();
    return Boolean(payload && Array.isArray(payload.cells) && payload.cells.length);
  } catch {
    return false;
  }
}

function piece(id, side, kind, x, y, extra = {}) {
  return {
    id, side, domain: "land", kind, x, y, path: [], pace: 1, facing: null, fighting: null,
    shots: 0, strength: 100, maxStrength: 100, pinned: false, ...extra,
  };
}

// The capital entry the engine tracks, or the site's own name when the set names nothing.
function capitalFor(match, name) {
  const wanted = String(name).toLowerCase();
  return (match.capitalSet && match.capitalSet.list ? match.capitalSet.list : [])
    .find((entry) => String(entry.name).toLowerCase() === wanted) || null;
}

export async function run(ctx) {
  const { fail } = ctx;
  const say = (what, actual) => fail(what + ": " + JSON.stringify(actual));

  // ---- the score's sign, which needs no board ------------------------------------------------
  const site = { id: "s", kind: "capital", owner: "blue", x: 10, y: 10 };
  const quiet = {
    pieces: [piece("a", "blue", "infantry", 14, 10)],
    sites: [site],
  };
  if (siteThreat(quiet, site) <= 0) say("our own lone defender did not score positive", siteThreat(quiet, site));
  quiet.pieces.push(piece("b", "red", "tank", 12, 10), piece("c", "red", "tank", 12, 11));
  const contested = siteThreat(quiet, site);
  if (contested >= 0) say("two enemy tanks beside a capital did not score negative", contested);
  if (threatenedSites(quiet, "blue").length !== 1) say("the threatened site was not listed", threatenedSites(quiet, "blue").length);

  if (!haveBoard()) {
    ctx.skip("no board extract: duel and bot-defence legs need the reference board");
  }

  const sites = JSON.parse(JSON.stringify(matchSites("1942")));
  const block = JSON.parse(JSON.stringify(ctx.config));

  // ---- 1. the duel: a dug-in garrison on a capital kills the tank -----------------------------
  {
    const match = openMatch("1942", sites, { handicapSide: "red" });
    match.clock = "running";
    match.seats = { blue: { kind: "human" }, red: { kind: "human" } };
    seedOwners(match);
    const paris = match.sites.find((s) => String(s.name).toLowerCase() === "paris");
    if (!paris) fail("the 1942 board has no Paris site");
    const tank = piece("blue:probe", "blue", "tank", paris.x - 1, paris.y);
    const garrison = piece("red:garrison", "red", "infantry", paris.x, paris.y, { entrenched: true });
    match.pieces = [tank, garrison];
    const parisEntry = capitalFor(match, "paris");
    if (!parisEntry) fail("Paris is not in the capital set");
    const ownerBefore = holderOf(match, parisEntry);

    const order = issueOrder(match, "blue", "blue:probe", paris.x, paris.y);
    if (!order || !order.ok) fail("the tank could not be ordered onto Paris: " + JSON.stringify(order));

    let shots = 0;
    const volleys = [];
    for (let round = 1; round <= 30 && match.pieces.includes(tank); round++) {
      const result = tickMatch(match);
      const fired = (result.events || []).filter((e) => e.type === "shot").length;
      shots += fired;
      if (fired) volleys.push(Number(match.round));
    }
    if (shots === 0) say("the duel resolved with no shot at all", shots);
    // The beat: shotEveryRounds rounds apart, never twice in consecutive rounds. The overrun path
    // used to fire on the round after the first exchange because it tested only "not this round"
    // (T-015 cadence trace); this pin is what keeps that from coming back.
    const rawBeat = block.combat && block.combat.shotEveryRounds;
    const beat = Number(rawBeat && typeof rawBeat === "object" ? rawBeat.value : rawBeat) || 2;
    for (let i = 1; i < volleys.length; i++) {
      const gap = volleys[i] - volleys[i - 1];
      if (gap < beat) say("two exchanges fired " + gap + " round(s) apart", volleys);
    }
    if (volleys.length < 2) say("fewer than two exchanges fired, so the beat is unproven", volleys);
    if (match.pieces.includes(tank)) {
      say("the tank survived the duel (original: attacker dies); its strength", tank.strength);
    }
    if (!match.pieces.includes(garrison)) say("the garrison died, which is the bug T-015 fixes", garrison.strength);
    const ownerAfter = holderOf(match, parisEntry);
    if (ownerAfter !== ownerBefore) say("Paris changed hands; original keeps it", { ownerBefore, ownerAfter });
    if (ownerAfter !== "red") say("Paris is not red after the duel", ownerAfter);
  }

  // ---- 2. an undefended capital still falls on arrival (T-013 AC3) ----------------------------
  {
    const match = openMatch("1942", sites, { handicapSide: "red" });
    match.clock = "running";
    match.seats = { blue: { kind: "human" }, red: { kind: "human" } };
    seedOwners(match);
    const paris = match.sites.find((s) => String(s.name).toLowerCase() === "paris");
    const tank = piece("blue:probe", "blue", "tank", paris.x - 1, paris.y);
    match.pieces = [tank];
    // The site must belong to the other side, or there is nothing to take.
    paris.owner = "red";
    const parisEntry = capitalFor(match, "paris");
    const before = holderOf(match, parisEntry);
    if (before !== "red") say("the undefended leg did not start red-owned", before);
    const order = issueOrder(match, "blue", "blue:probe", paris.x, paris.y);
    if (!order || !order.ok) fail("the tank could not be ordered onto an empty Paris: " + JSON.stringify(order));
    let captured = 0;
    for (let round = 1; round <= 6 && match.pieces.includes(tank); round++) {
      const result = tickMatch(match);
      captured += (result.events || []).filter((e) => e.type === "capture").length;
    }
    if (!match.pieces.includes(tank)) say("the tank died to an undefended capital", tank.strength);
    // The tank must actually be on the site cell: a capture that fires from the next cell over would
    // hide an overrun path that no longer lets a tank enter.
    if (tank.x !== paris.x || tank.y !== paris.y) {
      say("the tank never reached the undefended capital's cell", { at: [tank.x, tank.y], site: [paris.x, paris.y] });
    }
    if (captured === 0) say("no capture event fired on an undefended capital", captured);
    const after = holderOf(match, parisEntry);
    if (after !== "blue") say("an undefended capital did not fall on arrival", after);
  }

  // ---- 3. the bot answers a threatened capital ------------------------------------------------
  {
    const match = openMatch("1942", sites, { handicapSide: "blue" });
    match.clock = "running";
    match.seats = { blue: { kind: "bot" }, red: { kind: "human" } };
    match.botSide = "blue";
    match.sides = { blue: { cash: 0, bought: 99 }, red: { cash: 0, bought: 99 } };
    seedOwners(match);
    const capital = match.sites.find((s) => s.kind === "capital" && s.owner === "blue")
      || match.sites.find((s) => s.owner === "blue");
    if (!capital) fail("the 1942 board gives blue no site to defend");
    capital.kind = "capital";
    const defender = piece("blue:home", "blue", "infantry", capital.x + 6, capital.y);
    match.pieces = [
      defender,
      piece("red:a", "red", "tank", capital.x - 2, capital.y),
      piece("red:b", "red", "tank", capital.x - 2, capital.y + 1),
    ];
    const threat = siteThreat(match, capital);
    if (threat >= 0) say("the hostile pair did not make the capital read threatened", threat);
    const events = ordersFor(match, "blue");
    const defend = events.filter((e) => e.type === "bot_defend");
    if (defend.length !== 1) say("the bot did not send exactly one defender", events);
    if (defend[0].pieceId !== "blue:home") say("the bot sent the wrong piece", defend[0]);
    if (!Array.isArray(defend[0].path) || defend[0].path.length === 0) say("the defence order has no path", defend[0]);

    // A quiet capital gets no defence order: the rule fires on a negative score only.
    const calm = JSON.parse(JSON.stringify(match));
    calm.pieces = [piece("blue:home", "blue", "infantry", capital.x + 6, capital.y),
      piece("red:a", "red", "tank", capital.x + 60, capital.y)];
    const calmSite = calm.sites.find((s) => s.kind === "capital" && s.owner === "blue") || capital;
    if (siteThreat(calm, calmSite) < 0) {
      say("a far-away enemy still scored the capital threatened", siteThreat(calm, calmSite));
    }
    const calmEvents = ordersFor(calm, "blue").filter((e) => e.type === "bot_defend");
    if (calmEvents.length !== 0) say("the bot defended a capital nobody threatens", calmEvents);
  }

  void block;
}
