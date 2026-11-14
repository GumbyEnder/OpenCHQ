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

import { boardPayload, matchSites, TERRAIN, CELL_W } from "../../server/board.mjs";
import { baseDamageFor, damageFor } from "../../server/combat.mjs";
import { openMatch } from "../../server/match.mjs";
import { tickMatch } from "../../server/tick.mjs";
import { issueOrder } from "../../server/move.mjs";
import { seedOwners } from "../../server/economy.mjs";
import { holderOf } from "../../server/capitals.mjs";
import { holdsOwnCapital, ordersFor, siteThreat, threatenedSites } from "../../server/bot.mjs";

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

  // ---- 3b. the capital's own garrison does not march off it -----------------------------------
  // Measured on 37b7537 and on this branch before the rule: red's Paris garrison left the cell on
  // round 1 and the capital stood empty, so a lone tank met nothing and took it. The march is the
  // remake's behaviour, not a ported routine, so this is pinned as behaviour: a dug-in piece ON one
  // of its own capitals holds the cell, while a dug-in piece anywhere else still gets its march.
  {
    const match = openMatch("1942", JSON.parse(JSON.stringify(sites)), { handicapSide: "red" });
    match.clock = "running";
    match.seats = { blue: { kind: "bot" }, red: { kind: "human" } };
    match.botSide = "blue";
    match.sides = { blue: { cash: 0, bought: 99 }, red: { cash: 0, bought: 99 } };
    seedOwners(match);
    const capital = match.sites.find((s) => s.kind === "capital" && s.owner === "blue")
      || match.sites.find((s) => s.owner === "blue");
    if (!capital) fail("the 1942 board gives blue no capital to garrison");
    capital.kind = "capital";
    const garrison = piece("blue:garrison", "blue", "infantry", capital.x, capital.y, { entrenched: true });
    const marcher = piece("blue:marcher", "blue", "infantry", capital.x + 6, capital.y, { entrenched: true });
    const foe = { x: (capital.x + 60) % CELL_W, y: capital.y };
    match.pieces = [garrison, marcher, piece("red:far", "red", "infantry", foe.x, foe.y)];
    const events = ordersFor(match, "blue");
    const ordered = new Set(events.filter((e) => e.type === "bot_order").map((e) => e.pieceId));
    if (ordered.has(garrison.id)) say("the capital garrison was marched off its own capital", events);
    if (Array.isArray(garrison.path) && garrison.path.length) say("the capital garrison was given a path away from its capital", garrison.path);
    if (!ordered.has(marcher.id)) say("a dug-in piece that is not on a capital was not marched", events);
    // And the rule is narrow: the same piece one cell off the capital is marchable again.
    const offCell = piece("blue:off", "blue", "infantry", capital.x + 1, capital.y, { entrenched: true });
    if (holdsOwnCapital(match, "blue", offCell)) say("a piece one cell off the capital still counted as its garrison", offCell);
  }

  // ---- 3b. a threat ELSEWHERE must not pull the garrison off its capital either ----------------
  // The march is not the only order a bot gives: `defendSites` answers a threatened site of its own
  // by sending the nearest idle land unit, and a dug-in garrison standing on a capital is idle, land,
  // and close enough to qualify. Live evidence that it does (2026-11-14, ad71410): Paris' red
  // garrison left its cell at r6 with the blue tank still 30 cells out, and the tank took an empty
  // Paris at r20 - /mnt/nas/projects/OpenCHQ/local/t015-shots/t015-garrison-handcheck.json.
  // So the hold has to be a property of the piece, not of one call site.
  {
    const match = openMatch("1942", JSON.parse(JSON.stringify(sites)), { handicapSide: "red" });
    match.clock = "running";
    match.seats = { blue: { kind: "bot" }, red: { kind: "human" } };
    match.botSide = "blue";
    match.sides = { blue: { cash: 0, bought: 99 }, red: { cash: 0, bought: 99 } };
    seedOwners(match);
    const capital = match.sites.find((s) => s.kind === "capital" && s.owner === "blue")
      || match.sites.find((s) => s.owner === "blue");
    if (!capital) fail("the 1942 board gives blue no capital to garrison");
    capital.kind = "capital";
    // A second blue site close enough that the capital's garrison is a legal defender for it
    // (defendSites only reaches DEFEND_REACH = 50 cells, squared 2500) but far enough that the
    // capital is not itself the threatened site.
    const reach = (s) => Math.max(Math.abs(s.x - capital.x), Math.abs(s.y - capital.y));
    const other = match.sites.filter((s) => s.owner === "blue" && s !== capital)
      .filter((s) => reach(s) > 12 && reach(s) <= 40)
      .sort((a, b) => reach(a) - reach(b))[0];
    if (!other) fail("the 1942 board gives blue no second site between 13 and 40 cells of its capital");
    const garrison = piece("blue:garrison", "blue", "infantry", capital.x, capital.y, { entrenched: true });
    // One enemy tank on the neighbouring cell of that other site: a negative score, so the ported
    // defence routine runs and looks for a defender.
    const threat = piece("red:threat", "red", "tank", (other.x + 1) % CELL_W, other.y, {});
    match.pieces = [garrison, threat];
    const threatened = threatenedSites(match, "blue");
    if (!threatened.length) say("the threatened blue site is not scored as threatened, so the leg is vacuous", { site: other.name });
    const events = ordersFor(match, "blue");
    const sent = events.filter((e) => e.type === "bot_defend" && e.pieceId === garrison.id);
    if (sent.length) say("a threat elsewhere sent the capital garrison off its capital", sent.map((e) => ({ site: e.site, to: e.to, path: (e.path || []).length })));
    if (Array.isArray(garrison.path) && garrison.path.length) say("the capital garrison was given a path toward another site", garrison.path);
    if (garrison.x !== capital.x || garrison.y !== capital.y) say("the capital garrison left its cell", { from: [capital.x, capital.y], to: [garrison.x, garrison.y] });
    // The control: no threat, no order — so the leg above is measuring the defence routine and not
    // the march (which 3. already covers).
    const quiet = openMatch("1942", JSON.parse(JSON.stringify(sites)), { handicapSide: "red" });
    quiet.clock = "running";
    quiet.seats = { blue: { kind: "bot" }, red: { kind: "human" } };
    quiet.botSide = "blue";
    quiet.sides = { blue: { cash: 0, bought: 99 }, red: { cash: 0, bought: 99 } };
    seedOwners(quiet);
    const qCapital = quiet.sites.find((s) => String(s.name) === String(capital.name));
    qCapital.kind = "capital";
    const qGarrison = piece("blue:garrison", "blue", "infantry", qCapital.x, qCapital.y, { entrenched: true });
    quiet.pieces = [qGarrison];
    if (threatenedSites(quiet, "blue").length) fail("the control leg has a threatened site, so it is not a control");
    const qEvents = ordersFor(quiet, "blue");
    if (qEvents.some((e) => e.type === "bot_defend")) say("the control leg issued a defend order with nothing threatening", qEvents.filter((e) => e.type === "bot_defend"));
    if (Array.isArray(qGarrison.path) && qGarrison.path.length) say("the control leg moved the garrison with nothing threatening", qGarrison.path);
  }

  // ---- 4. terrain cover: mountain, on the real board (D-020) ----------------------------------
  // Leg 1 pins a CITY cell (the 1942 capital's own terrain byte). D-020 also asks for mountain
  // cover, and mountain is different arithmetic in the same function: the DEFENDER's terrain byte
  // (unit+0x836) is read before flank/rear, infantry kinds 1/3 lose a quarter (`dmg-(dmg>>2)`),
  // tanks (2) a sixth (`dmg-dmg/6`) - versus the city's `(dmg+1)/3` and `dmg/5`. Both are read from
  // `FUN_194c_000e` @ 194c:000e (decompiled.c 7032-7046).
  //   MEASURED (T-009): the matrix cell under it, tank -> dug-in infantry = 20.
  //   DISASSEMBLY (T-015 scope note): the mountain factors. Not measured on a live run yet; the
  //   assertion is exact arithmetic, so a change to the factors fails here.
  {
    const cells = boardPayload().cells;
    // The duel needs the defender standing on mountain and the attacker on a land cell beside it.
    let pair = null;
    for (let y = 1; y < 135 && !pair; y++) {
      for (let x = 1; x < CELL_W - 1 && !pair; x++) {
        if (cells[y * CELL_W + x] !== 10) continue;
        const east = cells[y * CELL_W + x + 1];
        if (east > 3 && east !== 10) pair = { mountain: [x, y], beside: [x + 1, y], besideTerrain: TERRAIN[east] };
      }
    }
    if (!pair) fail("the 1942 board has no mountain cell with a land neighbour, so the mountain duel cannot be set up");

    const tankAt = (x, y) => piece("blue:probe", "blue", "tank", x, y, { domain: "land", facing: "e" });
    const dugInAt = (x, y) => piece("red:garrison", "red", "infantry", x, y, { entrenched: true });

    // The matrix cell, before any terrain: 20 is the measured tank -> entrenched infantry value.
    const base = baseDamageFor("tank", dugInAt(pair.mountain[0], pair.mountain[1]));
    if (base !== 20) say("tank -> dug-in infantry is no longer matrix cell 2->3 = 20", base);

    // Plain control: no cover, so the cell is untouched. Same pairing, defender one cell off mountain.
    const plainDef = dugInAt(pair.beside[0], pair.beside[1]);
    if (pair.besideTerrain === "mountain") say("the control cell is a mountain too", pair.besideTerrain);
    const onPlain = damageFor(tankAt(pair.mountain[0], pair.mountain[1]), plainDef);
    if (onPlain.amount !== base) say("open ground modified the damage; cover must be the defender's terrain only", onPlain);

    // Mountain: infantry loses a quarter of the cell, integer arithmetic.
    const onMountain = damageFor(tankAt(pair.beside[0], pair.beside[1]), dugInAt(pair.mountain[0], pair.mountain[1]));
    const wantMountain = base - (base >> 2);
    if (onMountain.amount !== wantMountain) {
      say("mountain cover for infantry is not dmg-(dmg>>2) = " + wantMountain, { cell: base, got: onMountain.amount, at: pair.mountain });
    }
    // A tank defender on the same mountain loses a sixth, not a quarter.
    const tankDef = piece("red:armour", "red", "tank", pair.mountain[0], pair.mountain[1], { domain: "land" });
    const tankBase = baseDamageFor("tank", tankDef);
    const onMountainTank = damageFor(tankAt(pair.beside[0], pair.beside[1]), tankDef);
    const wantTank = tankBase - Math.floor(tankBase / 6);
    if (onMountainTank.amount !== wantTank) {
      say("mountain cover for tanks is not dmg-dmg/6 = " + wantTank, { cell: tankBase, got: onMountainTank.amount });
    }

    // The same arithmetic through the match tick, so the wiring (coordinates -> terrain byte) is
    // pinned and not just the helper: the garrison on the mountain must be hit for 15, not 20.
    {
      const match = openMatch("1942", JSON.parse(JSON.stringify(sites)), { handicapSide: "red" });
      match.clock = "running";
      match.seats = { blue: { kind: "human" }, red: { kind: "human" } };
      seedOwners(match);
      const attacker = tankAt(pair.beside[0], pair.beside[1]);
      const garrison = dugInAt(pair.mountain[0], pair.mountain[1]);
      match.pieces = [attacker, garrison];
      const hits = [];
      for (let round = 1; round <= 8 && match.pieces.includes(garrison); round++) {
        const result = tickMatch(match);
        for (const event of result.events || []) {
          if (event.type === "shot" && event.target === "red:garrison") hits.push(event.amount);
        }
      }
      if (!hits.length) fail("no shot landed on the mountain garrison through the match tick");
      if (hits.some((amount) => amount !== wantMountain)) {
        say("the tick path did not apply mountain cover (want " + wantMountain + " per exchange)", hits);
      }
    }
  }

  void block;
}
