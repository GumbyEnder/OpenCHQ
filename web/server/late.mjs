// The 1986 kit. Owner: integrator (node `late_kit`, order 280).
//
// The tools are era-gated exactly as the archive gated them (docs/POLISH_LOOP.md): 1918 and
// 1942 hide nuke, satellites, foreign aid, intel and cease-fire; 1986 and 2023 have them; the
// concealed start has oil and the tools it already refuses. Where the original printed no
// number - a radius, a cost, a damage figure - nothing is invented here: a nuke is refused by
// default, and when enabled its kill zone is nukes.killRadius, flagged STAND-IN (PB-230). The nuke
// and foreign aid are the tools that change the board; the archive's own note says aid flips a
// city's owner.

import { millionsPerBillion, priceOf, rules } from "./rules.mjs";
import { countryName } from "./countries.mjs";
import { beginScan } from "./scan.mjs";
import { siteAtCell } from "./siteindex.mjs";
// PB-156: the launch gate is the DIFFERENCE of two counters, and one global detonation count drives
// the income roll and the winter check. Both live in nukes.mjs so economy.incomeGate reads the same
// numbers this module writes.
import { launchLead, warnFrom, winterFrom, nukeState, nukeRoll, winterChancePercent } from "./nukes.mjs";
// PB-230: the damage arm. Geometry and removal are blast.mjs's (PB-231); the aim checks, the
// wasteland paint and the note live here beside the counters that describe a launch.
import { blastCountries, killRadius, nukeNote, nukeStrike, nukeTarget } from "./nukestrike.mjs";
// PB-233: what a strike does after the ground stops burning (manual p.30): world opinion and the
// city switch. The manual's "production reduced by 25 per cent or more" is the 5n gate itself
// (frodo 8983 §4) and is made legible in economy.pay, not multiplied here.
import {
  shiftAttitude, switchCities,
} from "./aftermath.mjs";

const LATE_ERAS = new Set(["1986", "2023", "9999"]);

// Manual p.30: at most three more nukes than the opponent has fired. The old booklet paraphrase
// ("three fired or three absorbed without reply") counted one side's total and an intercept count;
// PB-156 replaces it with the difference. The number is config's `nukes.launchLead` (DECODED).

// PB-160: the banner is the transcript line the ack's note becomes (app.js `say(event.note)`).
// It says what the scan actually does - the bar reveals units as it passes, bar-local (Q51, T-022) -
// and carries the price the event charged, so the copy cannot drift from `prices.intelScan`.
export const INTEL_NOTE = "Intel: the scan bar reveals enemy units as it passes; the other side is told.";
export function intelNote(cost) {
  const per = Number(millionsPerBillion()) || 1000;
  const value = Number(cost);
  const billions = Number.isFinite(value)
    ? (value / per).toFixed(3).replace(/\.?0+$/, "")
    : "";
  return INTEL_NOTE + " " + (billions === "" || billions === "-0" ? "0" : billions) + "b";
}
export const SATELLITE_NOTE = "Satellite overhead. Its pass is quiet.";
// PB-228: the aid line names the CITY, the NATION and the STEP it moved the nation to, or the
// progress it banked. The manual's unit is the nation (L382 + p.30: "hostile ones become neutral,
// or neutral ones become allied"), so a gift that has not yet turned the nation says so instead of
// claiming a flip. PM 8866 §2a: "Foreign aid to Beijing: China is 1 of 3 gifts from turning."
export function nationName(nation) {
  const named = nation ? countryName(nation.country) : null;
  return named || "that nation";
}
export function aidNote(name, nation, turned, gifts, needed, cancelled) {
  const label = nationName(nation);
  // PB-228 §3: a gift that cancelled one the other side had banked says so, because the player's
  // own count is not the whole story that round.
  const tail = cancelled ? " Your gift cancels one the other side had banked." : "";
  if (turned === "neutral") return `Foreign aid to ${name}: ${label} has gone neutral.${tail}`;
  if (turned === "allied") return `Foreign aid to ${name}: ${label} has come over to your side.${tail}`;
  return `Foreign aid to ${name}: ${label} is ${gifts} of ${needed} gifts from turning; this gift is banked.${tail}`;
}
// PB-226: aid names its city, and every refusal has to be a sentence the player can act on.
export const AID_NEEDS_CITY = "Aid needs a city: pick the one you want to sway.";
export const AID_OFF_MAP = "The target is off the map.";
export const AID_NO_CITY = "That cell holds no city.";
export const AID_OWN_CITY = "That city is already yours.";
// PB-227 (manual p.30, L988): "Cities within an opponent's home country can never be the target of
// foreign aid." The refusal is about the country the city stands in, not who holds it.
export const AID_HOME_COUNTRY = "That city is inside the opponent's home country; foreign aid cannot reach it.";
// PB-228 (PM 8872 §2b, from frodo 8871 §7b): FAIL CLOSED on a partial capital set. `homeCountries`
// joins the capital set to live sites and never reads `capitalSet.missing`, so a set that did not
// fully resolve silently SHRINKS the home countries and lets aid into a country it could not
// identify. Paying for a guess about which ground is home ground is worse than a refusal the
// player can read, so an incomplete set refuses the tool outright, costs 0 and banks nothing.
export const AID_HOME_UNKNOWN = "This match's capitals did not all resolve, so foreign aid cannot tell home ground from a target.";
export function homeSetComplete(match) {
  const set = match && match.capitalSet;
  return !(set && Array.isArray(set.missing) && set.missing.length > 0);
}
// PB-226b: there is deliberately no neutral refusal. The manual (L986-987) says aid makes "hostile
// ones become neutral, or neutral ones become allied", so a neutral pick is the second half of the
// tool's job, not a mistake. The refusal that lived here until PM 8843 §2 was a stand-in that read
// the one-sided half of the sentence.
export const CEASEFIRE_NOTE = "Cease fire accepted.";
export const NUKE_NOTE = "A nuke is refused.";

// PB-224 (PM 8905 §2): "satellite" is NOT a tool any more. A recon satellite is an owned unit with
// a position, a radius and fuel (satellite.mjs), so the buy is the piece and the reveal is the
// piece's, each round. The old door is gone rather than left as a second, worldwide answer.
export const TOOLS = Object.freeze(["buy", "entrench", "intel", "aid", "ceasefire", "nuke", "oil"]);

// PB-235 (manual p.14: foreign aid is "used mostly in the pre-game and cease-fire portions"): the
// lobby's hold gate refuses every tool while the clock is not running, because spending into a pause
// is how a pause becomes a free turn. That guard is right for a pause, but the PRE-GAME is not a
// pause: it is round 0 with the clock not yet started, and aid is the one tool the manual places
// there. A hold after the first round has run is still a pause and still refuses. A room whose round
// is missing fails closed.
export function toolOpensWhileHeld(match, tool) {
  if (tool !== "aid") return false;
  // Fail closed: `Number(null)` is 0 and `Number(undefined)` is NaN, so a room that lost its match
  // or its round must read as "not the pre-game" rather than as round 0.
  if (!match || match.round === null || match.round === undefined || match.round === "") return false;
  return Number(match.round) === 0;
}

// PB-235 AC4: the refusal a mid-war hold gives aid. "Start the clock first." is the right sentence
// for the other tools and the wrong one here: the player has a clock, it is held, and the manual
// (p.14) is why aid is the tool they are reaching for before it starts. The sentence names the state
// the tool needs (the pre-game) and the state the room is in (a mid-war hold), and it deliberately
// does NOT offer a cease-fire: this build has no cease-fire state (`CEASEFIRE_NOTE` says the tool
// "changes nothing", config `notes.readiness` records no peace state), so naming one would promise a
// state the player cannot enter. AC2 is the PM's ruling, not this string.
export const AID_HELD_MID_WAR = "Foreign aid is used in the pre-game; the clock is held mid-war.";

// Deduct a priced tool's cost from the seat's pool, in integer millions. Validation of whether a
// tool would do anything happens before this call, so a refused no-op never spends.
function charge(match, side, tool) {
  const kind = PRICE_KIND[tool];
  if (!kind) return { ok: true, price: 0 };
  const price = priceOf(kind);
  if (!Number.isFinite(price)) return { ok: true, price: 0 };
  const seat = match.sides && match.sides[side];
  if (!seat) return { error: `Unknown side: ${side}.` };
  if (!Number.isFinite(seat.cash) || seat.cash < price) {
    const factor = millionsPerBillion();
    const billions = Number.isFinite(factor) && factor > 0 ? price / factor : price;
    return { error: `Not enough in ${side}'s pool for ${tool} (${billions} billion).` };
  }
  seat.cash -= price;
  return { ok: true, price };
}

// Oil is its own case: 1918 and 1942 hide it, 1986 and 2023 show it, and the concealed start
// (9999) shows the 1986 set too, labelled UNVERIFIED in config.
const OIL_ERAS = new Set(["1986", "2023", "9999"]);

// What a tool costs, as a priced kind in config/game.json's table (Manual p.28 + DS:0x2E16).
// A tool with no price entry costs nothing; a tool with a price is charged from the seat's pool.
const PRICE_KIND = Object.freeze({
  intel: "intelScan",
  aid: "foreignAid",
  nuke: "nuke",
  ceasefire: null,
});

function eraHas(era, tool) {
  if (tool === "buy" || tool === "entrench") return true;
  if (tool === "oil") return OIL_ERAS.has(String(era));
  return LATE_ERAS.has(String(era));
}

// The tools an era's command bar shows.
export function toolsForEra(era) {
  return TOOLS.filter((tool) => eraHas(era, tool));
}

function counters(match) {
  if (!match.late || typeof match.late !== "object") match.late = {};
  if (!match.late[String()]) match.late.launched = match.late.launched || {};
  return match.late;
}

function launchedBy(match, side) {
  const late = counters(match);
  late.launched = late.launched || {};
  late.launched[side] = late.launched[side] || { fired: 0, absorbed: 0 };
  return late.launched[side];
}

function otherSide(side) {
  return side === "blue" ? "red" : "blue";
}

// How many launches this side leads by: fired(mine) - fired(theirs). Negative when the other side
// is ahead, which is why a side that has already fired three may fire again once its opponent does.
export function launchEdge(match, side) {
  const mine = launchedBy(match, side);
  const theirs = launchedBy(match, otherSide(side));
  return Number(mine.fired || 0) - Number(theirs.fired || 0);
}

// Whether this side may still launch. Exported so the rule can be read without launching.
export function nukeStatus(match, side) {
  const cfg = (rules().nukes || {});
  if (cfg.enabled !== true) return { allowed: false, reason: NUKE_NOTE };
  const lead = launchLead();
  const edge = launchEdge(match, side);
  if (edge >= lead) {
    return {
      allowed: false,
      reason: `${lead} more launches than the other side are already away. No further launches until they fire one.`,
    };
  }
  return { allowed: true };
}

// What the kit does, said out loud, with every unascertained number labelled.
//
// The tools existed and the buttons existed; the consequences were only in this file. A player could
// fire a nuke without being told what its blast does, or wonder why a launch was refused. This
// briefing is the text: a label, a sentence, whether the tool is available right now, and for a
// nuke the radius the config guards and how many launches are left. Anything the archive never
// printed is called STAND-IN in the sentence itself, not in a comment.
export const STAND_IN = "STAND-IN";

export function kitBriefing(match, side) {
  const cfg = (rules().nukes || {});
  const radius = Number(cfg.exclusion);
  const status = nukeStatus(match, side);
  const lead = launchLead();
  const edge = match ? launchEdge(match, side) : 0;
  const left = Math.max(0, lead - edge);
  const kit = [];

  const add = (name, label, text, allowed, reason) => {
    kit.push({ name, label, text, allowed: Boolean(allowed), reason: reason || null });
  };

  const foes = (match && Array.isArray(match.pieces) ? match.pieces : [])
    .filter((piece) => piece && piece.side !== side).length;
  // PB-226b: a neutral city (owner null) is a legal target too, so the gate is "not mine", not
  // "held by the other side" - counting only hostile cities disabled the row on a board of neutrals.
  // PB-227: a city inside the opponent's home country is refused by aidTarget, so it must not keep
  // the row enabled either - a row that opens onto nothing but refusals is a lie.
  const home = homeCountries(match, side === "blue" ? "red" : "blue");
  // PB-228 (PM 8872 §2b): a partial capital set means every click is refused, so the row must not be
  // offered either - the same lie the home-country filter above exists to prevent.
  const homeKnown = homeSetComplete(match);
  const turnable = homeKnown ? (match && Array.isArray(match.sites) ? match.sites : [])
    .filter((site) => site && site.kind === "city" && site.owner !== side
      && !(home && site.country_id !== undefined && site.country_id !== null && home.has(Number(site.country_id))))
    .length : 0;

  add("intel", "Intel scan", "Every enemy unit is revealed for one round, and the other side is told it was read.",
    foes > 0, foes > 0 ? null : "There is nothing to reveal.");
  add("aid", "Foreign aid", "Turns the nation of the city you pick - an enemy's or a neutral one. The archive's own note says aid flips a city's owner; the manual says the player selects the city, that a city inside the opponent's home country can never be a target (p.30), and that a nation moves one step at a time, hostile to neutral and neutral to allied, with more gifts needed the more cities it has. It also says the other side can give aid to the same nation, negating your efforts: a gift from the other side to the same nation cancels one gift you had banked there. That arithmetic and the one-for-one cancel are a " + STAND_IN + ": the archive never printed either count.",
    turnable > 0, turnable > 0 ? null : (homeKnown ? "There is no city to turn." : AID_HOME_UNKNOWN));
  add("ceasefire", "Cease fire", "Accepted, and it changes nothing: no movement, no damage, no income.", true);

  if (eraHas(match && match.era, "nuke")) {
    const radiusText = Number.isFinite(radius) && radius >= 1
      ? `A capital and the ${radius} cells around it cannot be targeted. That radius is a ${STAND_IN}: the archive kept a guard but never printed its size.`
      : "No home-ground guard is set in this match.";
    const limitText = `Launches stop once this side has ${lead} more fired than the other side (Manual p.30). ` +
      `This side may fire ${left} more before the other side answers.`;
    // PB-230: the launch has consequences now, so the briefing describes them. A briefing that still
    // said "deals no damage" would be the one place in the build where the player is told the old
    // stand-in was the rule.
    const zone = killRadius();
    const zoneText = zone === null
      ? "This build's nuke has no kill radius configured, so a launch is refused."
      : `The blast levels everything within ${zone} cells of the aim point — both sides' units, cities, bases and oil fields — and leaves wasteland, where attrition can kill. ${zone} is a ${STAND_IN}: the manual says "within three spaces" and the shape is read as a square.`;
    const homeText = "Your own home country cannot be targeted, even where it has been invaded.";
    // PB-156: the global count is not decoration. Every launch feeds it, and it is what turns the
    // sky on both sides: income can be skipped from the first detonation, the warning comes at 5,
    // and winter can end the war from 10.
    const parked = match ? nukeState(match) : null;
    const detonated = parked ? Number(parked.detonated) || 0 : 0;
    const countText = `Detonations so far: ${detonated}. From ${warnFrom()} the sky is warned; from ${winterFrom()} each launch can end the war for both sides.`;
    add("nuke", "Nuke", [radiusText, homeText, zoneText, limitText, countText].join(" "), status.allowed, status.reason);
  }

  return kit;
}

// PB-227: the countries the opponent's own capitals stand in. The 1986 file gives a side more than
// one capital row - Washington (country 0), London (3) and Tokyo (14) for blue, Moscow (1) for red -
// so "home country" is read as the SET of countries the opponent's held capitals sit in; a year with
// one capital per side reduces to the manual's single sentence. A capital held by nobody (the
// original's neutral capital) contributes nothing, because it is nobody's home.
function homeCountries(match, side) {
  const set = match && match.capitalSet;
  const sites = (match && Array.isArray(match.sites)) ? match.sites : [];
  if (!set || !Array.isArray(set.list) || !sites.length) return null;
  const out = new Set();
  for (const row of set.list) {
    if (!row) continue;
    const site = sites.find((place) => place && Number(place.id) === Number(row.siteId));
    if (!site) continue;
    const holder = site.owner === "blue" || site.owner === "red" ? site.owner : null;
    if (holder !== side) continue;
    const country = site.country_id;
    if (country === undefined || country === null) continue;
    out.add(Number(country));
  }
  return out.size ? out : null;
}

// PB-228: staged loyalty per nation (Manual L382 + p.30). The unit that changes is the NATION, the
// steps are hostile -> neutral -> allied, and a nation with more cities takes more gifts. The
// number of gifts per city is UNVERIFIED (Open RE Q52), so it is config (`loyalty.giftsPerCity`)
// rather than a constant here, and the player-facing copy says the arithmetic is a stand-in.
export function giftsPerCity() {
  const cfg = rules().loyalty || {};
  const value = Number(cfg.giftsPerCity);
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 1;
}

// PB-228 §3 (manual p.30: "Your opponent can give foreign aid to the same targets you do, thus
// negating your efforts"). The manual says a rival's gift NEGATES the payer's, but it never says
// how much it cancels, so this build cancels ONE banked gift for one (config `loyalty.counterAid`,
// shipped true) and labels that one-for-one as a STAND-IN. Turning the key off is the arms-race
// reading where each side's campaign runs independently.
export function counterAid() {
  const cfg = rules().loyalty || {};
  return cfg.counterAid !== false;
}

// The nation a city belongs to. A site with no country has no nation to sway, so it is its own
// one-city nation: the smallest nation the rule allows, never a silent no-op.
export function nationOf(match, city) {
  const sites = match && Array.isArray(match.sites) ? match.sites : [];
  const country = city && city.country_id !== undefined && city.country_id !== null
    ? Number(city.country_id)
    : null;
  if (country === null) return { key: "site:" + city.id, country: null, cities: [city] };
  const cities = sites.filter((site) => site && site.kind === "city" && Number(site.country_id) === country);
  return { key: String(country), country, cities: cities.length ? cities : [city] };
}

export function giftsNeeded(nation) {
  return Math.max(1, nation.cities.length) * giftsPerCity();
}

// A nation's standing as the payer sees it. A split nation reads hostile: the first step is to
// unseat the other side's hold on it.
export function nationStanding(nation, side) {
  const mine = nation.cities.filter((site) => site.owner === side).length;
  if (mine === nation.cities.length) return "allied";
  const unheld = nation.cities.filter((site) => site.owner !== "blue" && site.owner !== "red").length;
  if (unheld === nation.cities.length) return "neutral";
  return "hostile";
}

// The gift ledger: one count per (side, nation). It lives on the match so a reload keeps the
// campaign a player has already paid for, and it is per side so counter-aid is its own campaign.
function aidLedger(match, side) {
  if (!match.aid || typeof match.aid !== "object") match.aid = {};
  if (!match.aid[side] || typeof match.aid[side] !== "object") match.aid[side] = {};
  return match.aid[side];
}

// The step itself. hostile -> neutral unseats the other side and leaves the payer's own cities
// alone; neutral -> allied brings the WHOLE nation over at once, which is what "the whole nation
// switches" means and why one gift after the threshold moves more than one city.
function stepNation(nation, side, standing) {
  for (const site of nation.cities) {
    if (standing === "hostile") {
      if (site.owner !== side) site.owner = null;
    } else {
      site.owner = side;
    }
  }
}

// PB-226: which city an aid is aimed at, or the sentence that says why it was refused.
// `target` is the cell the page sent (`{op:"tool", tool:"aid", to:{x,y}}`), and the wire has
// carried it all along - only this tool ignored it. A target-less call is refused rather than
// falling back to a hidden policy: the manual's rule is that the player selects the city.
// Nothing here refuses a neutral city: manual L986-987 makes one a legal target (PB-226b).
function aidTarget(match, side, target) {
  if (!target || target.x === undefined || target.y === undefined) return { error: AID_NEEDS_CITY };
  const x = Number(target.x);
  const y = Number(target.y);
  // The board wraps in x and is fixed in y (the same bound the nuke uses), so a cell that is not
  // on the map is refused here instead of being searched for and reported as an empty cell.
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || y > 135) {
    return { error: AID_OFF_MAP };
  }
  const site = siteAtCell(match.sites, x, y);
  if (!site || site.kind !== "city") return { error: AID_NO_CITY };
  if (site.owner === side) return { error: AID_OWN_CITY };
  // PB-228 (PM 8872 §2b): an incomplete capital set cannot say what home ground is, so the tool
  // refuses rather than guess. Above charge(), like every other refusal here.
  if (!homeSetComplete(match)) return { error: AID_HOME_UNKNOWN };
  // PB-227: the opponent's home country is closed to aid whatever the city's owner is, so this sits
  // before the turn and above charge() - a refused aid costs 0.
  const home = homeCountries(match, side === "blue" ? "red" : "blue");
  const country = site.country_id;
  if (home && country !== undefined && country !== null && home.has(Number(country))) {
    return { error: AID_HOME_COUNTRY };
  }
  // PB-228: the pick names the CITY and the gift accrues to its NATION; which step that gift buys
  // (hostile -> neutral, neutral -> allied) is decided in useTool, against the ledger, so a refused
  // pick here costs nothing and banks nothing.
  return { site };
}

// One tool use. Returns { ok, events } or { error }.
export function useTool(match, side, tool, target) {
  if (!match) return { error: "There is no match." };
  if (match.over) return { error: "The match is over." };
  const name = String(tool || "");
  if (!TOOLS.includes(name)) return { error: "No such tool: " + (name || "(none)") + "." };
  if (!["blue", "red"].includes(side)) return { error: "Unknown side: " + side + "." };
  if (!eraHas(match.era, name)) return { error: `${name} is not in this era.` };

  const round = Number(match.round) || 0;
  const events = [];

  // PB-224: the intel scan stays a tool; the satellite's reveal is the PIECE's now (satellite.mjs)
  // and is not reachable through this door. A call that still names "satellite" is refused by the
  // TOOLS membership check above, so there is no second, worldwide reveal left in the kit.
  if (name === "intel") {
    const shown = (match.pieces || []).filter((piece) => piece && piece.side !== side);
    if (shown.length === 0) return { error: "There is nothing to reveal." };
    const paid = charge(match, side, name);
    if (paid.error) return paid;
    for (const piece of shown) piece.revealedRound = round;
    // PB-158: the reveal is the bar's, so the pass is armed on the server at the same instant.
    // `view.forSeat` then sends only the pieces whose column the bar covers, and stops sending
    // them once the trailing edge has passed (no lingering: Q51).
    beginScan(match, side, Date.now(), round);
    events.push({
      type: "intel",
      side,
      round,
      reveals: shown.length,
      cost: paid.price,
      note: intelNote(paid.price),
    });
    // Intel tells the opponent it was read.
    events.push({ type: "intel_seen", side: side === "blue" ? "red" : "blue", by: side, round });
    return { ok: true, events };
  }

  if (name === "aid") {
    // PB-226: the player names the city (Manual L382 + p.30, "select a city within the nation you
    // wish to sway"). The archive's stand-in picked the lowest-id enemy city, which ignored the
    // target the wire already carried (`lobby.mjs` passes `message.to`) and turned a city nobody
    // chose. Every refusal sits above `charge()`, so a refused aid costs 0.
    const picked = aidTarget(match, side, target);
    if (picked.error) return picked;
    const city = picked.site;
    const paid = charge(match, side, name);
    if (paid.error) return paid;
    const from = city.owner;
    // PB-228: the gift buys a step for the nation the picked city stands in, not a flip of that one
    // city. `giftsNeeded` scales with the nation's city count, so a nation with more cities takes
    // more gifts; the threshold moves the WHOLE nation, and it moves one step per threshold.
    const nation = nationOf(match, city);
    const needed = giftsNeeded(nation);
    const standing = nationStanding(nation, side);
    const ledger = aidLedger(match, side);
    // PB-228 §3: a gift from the other side to the same nation cancels ONE of the payer's banked
    // gifts BEFORE this gift builds its own. The manual states the negation (p.30) and never says
    // how it works, so one-for-one is a STAND-IN (`counterAid`, config `loyalty.counterAid`).
    const rival = side === "blue" ? "red" : "blue";
    const rivalLedger = aidLedger(match, rival);
    const rivalBanked = Number(rivalLedger[nation.key]) || 0;
    const cancelled = counterAid() && rivalBanked > 0 ? 1 : 0;
    if (cancelled) rivalLedger[nation.key] = rivalBanked - cancelled;
    const spent = (Number(ledger[nation.key]) || 0) + 1;
    let turned = null;
    if (spent >= needed) {
      turned = standing === "hostile" ? "neutral" : "allied";
      stepNation(nation, side, standing);
      ledger[nation.key] = 0;
    } else {
      ledger[nation.key] = spent;
    }
    events.push({
      type: "aid", side, site: city.id, name: city.name, x: city.x, y: city.y, from, round,
      cost: paid.price, country: nation.country, stance: standing, turned,
      gifts: Number(ledger[nation.key]) || 0, spent, needed, cities: nation.cities.length,
      cancelled, cancelledSide: cancelled ? rival : null, rivalBanked,
      note: aidNote(city.name, nation, turned, spent, needed, cancelled),
    });
    return { ok: true, events };
  }

  if (name === "ceasefire") {
    // Accepted, and deliberately changes nothing: no movement, no damage, no income.
    events.push({ type: "ceasefire", side, round, note: CEASEFIRE_NOTE });
    return { ok: true, events };
  }

  if (name === "nuke") {
    const status = nukeStatus(match, side);
    if (!status.allowed) return { error: status.reason };
    // PB-230: the three refusals, all above the charge and each with its own sentence - the capital
    // ring (SDI/ABM, size a STAND-IN), the firer's OWN home country ("even if it's been invaded"),
    // and the two above. A refused aim costs 0 and banks nothing.
    const aim = nukeTarget(match, side, target);
    // PB-242: a refusal carries WHY it refused (no region / no site row / no country byte) and, for a
    // cell the territory map leaves unassigned, whether the ground was water or land. The sentence
    // alone says "did not resolve"; a player aiming at a lake and a player aiming at land both need
    // to be told which one they hit, so the fields ride with the error.
    if (aim.error) {
      return { error: aim.error, country: aim.country, name: aim.name, reason: aim.reason ?? null, terrain: aim.terrain ?? null };
    }
    const at = aim.cell;
    const paid = charge(match, side, name);
    if (paid.error) return paid;
    const strike = nukeStrike(match, side, at);
    // The aim already proved the cell and the radius, so this is a guard, not a path: a charge that
    // bought no strike is refunded rather than kept.
    if (strike.error) {
      const seat = match.sides && match.sides[side];
      if (seat && Number.isFinite(seat.cash)) seat.cash += paid.price;
      return { error: strike.error };
    }
    const mine = launchedBy(match, side);
    mine.fired = Number(mine.fired || 0) + 1;
    // FUN_1eb5_0eae: one global count, incremented by the detonation itself, whatever the side.
    const state = nukeState(match);
    state.detonated = Number(state.detonated || 0) + 1;
    const detonated = state.detonated;
    // PB-230: the board changes now. Both sides' units inside the square are gone, the cities,
    // bases and oil fields in it are levelled, and every land cell it covered reads wasteland from
    // this round on. Satellites are not in `pieces`, so they are untouched by construction.
    for (const lost of strike.pieces) {
      events.push({
        type: "destroyed", side: lost.side, pieceId: lost.id, kind: lost.kind, by: "nuke",
        x: lost.x, y: lost.y, strength: 0, round, note: "Nuke.",
      });
    }
    events.push({
      type: "nuke", side, x: at.x, y: at.y, round, launched: mine.fired, detonated, cost: paid.price,
      radius: strike.radius, killed: strike.pieces, sites: strike.sites.map((site) => ({
        id: site.id, kind: site.kind, name: site.name || null, x: site.x, y: site.y, owner: site.owner || null,
      })),
      wasteland: strike.wasteland,
      note: nukeNote(strike),
    });
    // PB-233: the manual's p.30 after-effects. Both read the ground the blast actually covered
    // (`blastCountries`), not the aim cell, because the manual's subject is "the attacked country".
    // The attitude move is FUN_1eb5_0eae 12133-12166; the city switch is the manual's sentence with
    // STAND-IN counts. The manual's third sentence (production down 25 per cent or more) is the
    // decoded 5n gate, logged in economy.pay with the cities it skipped - no cut is applied here.
    const countries = blastCountries(match, at, strike.radius, strike.sites);
    const moved = shiftAttitude(match, countries);
    if (moved.length) {
      const names = moved.map((row) => countryName(row.country) || ("country " + row.country));
      events.push({
        type: "nuke_attitude", side, round, detonated, moved,
        note: `World opinion turned against the launch: ${names.join(", ")}.`,
      });
    }
    const cities = strike.sites.filter((site) => String(site.kind) === "city").length;
    const losses = strike.pieces.filter((piece) => piece && piece.side === side).length;
    const switched = switchCities(match, side, countries, { struckCities: cities, friendlyLosses: losses });
    if (switched.wanted > 0) {
      const names = switched.switched.map((row) => row.name || (row.x + "," + row.y));
      events.push({
        type: "nuke_switch", side, round, detonated,
        roll: switched.roll, chance: switched.chance, first: switched.first,
        wanted: switched.wanted, switched: switched.switched,
        note: names.length
          ? `${names.length} ${names.length === 1 ? "city" : "cities"} switched after the strike: ${names.join(", ")}.`
          : "The strike turned no city: the nations it hit had none left to move.",
      });
    }
    // The manual's "25 per cent or more" is the 5n gate itself (frodo 8983 §4): the gate's skip is
    // logged in economy.pay with the cities it took. There is no second, multiplying effect here.
    // From 5, a warning. Both seats read it: the count is global, not the launcher's business.
    if (detonated >= warnFrom()) {
      events.push({
        type: "nuke_warning", side: null, round, detonated,
        note: `${detonated} detonations. Nuclear winter can end the war from ${winterFrom()}.`,
      });
    }
    // From 10, winter if rnd(100) < 100 / (20 - n). The game ends as a loss for BOTH sides: no
    // winner is recorded, because neither side survives the sky.
    if (detonated >= winterFrom()) {
      const roll = nukeRoll(match);
      const chance = winterChancePercent(detonated);
      if (roll < chance) {
        match.over = true;
        match.clock = "held";
        match.winner = null;
        match.winReason = { kind: "nuclear_winter", side: null, detonated, round, chance, roll };
        events.push({
          type: "nuclear_winter", side: null, round, detonated, roll, chance,
          note: "Nuclear winter. Neither side goes on.",
        });
      }
    }
    return { ok: true, events };
  }

  return { error: `${name} is not a tool this module runs.` };
}
