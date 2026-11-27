// The navigation, and the two dialogues that were missing: buying and the economy.
//
// The 1990 game hid its whole command set behind a menu bar that appeared when the controller moved
// into the strip at the top of the screen (Manual.pdf, "Menu Command Summary"). A browser has no
// controller, so the same commands are buttons in the strip the match collapses into, and each one
// opens a dialogue over the map.
//
// Everything here is pure: it turns the room the server sent into rows, and the page draws them. No
// rule is re-derived - the payday comes from the seat's own `income`, which the server counts with
// the economy module's rule, and the prices come from the shop row the server priced.

import { formatBillions, formatRate, formatWholeBillions, peaceIncomeOf, shopDisabled, shopLabel } from "./command.mjs";

export const NAV = [
  { id: "buy", label: "Buy", title: "Buy units", hint: "What each unit costs, how many you have, and how many you have seen." },
  { id: "economy", label: "Economy", title: "Economy", hint: "Cash, the next payday, what pays it, and what you are burning." },
  { id: "air", label: "Air", title: "Air power", hint: "Your aircraft, where each one is based, and how many rounds it is away." },
  { id: "kit", label: "Kit", title: "The late kit", hint: "The tools this scenario allows, and the sentence that says why one is refused." },
  { id: "map", label: "Map", title: "Map", hint: "Terrain or ownership, the whole world or a zoom, and whether the camera follows." },
  { id: "war", label: "War", title: "War", hint: "Who holds which side, the clock, and the way out." },
  { id: "log", label: "Log", title: "Last rounds", hint: "What the clock has actually done, newest last." },
];

export function navFor(id) {
  return NAV.find((item) => item.id === id) || null;
}

// PB-308 (manual p.37 l.1160-1171): a layout sandbox is a pregame setup, not a war. The wire already
// refuses `run`/`hold` and `resume_war` there ("This is a layout, not a war. Save the setup or leave
// it.", lobby.mjs), so the War panel must not paint a control that is guaranteed to be refused.
// `layoutMode` is the page's own room.mode reading, never a guess from the clock: a layout and a
// held war both read "held". The three keys stay separate so a leg can pin each offer on its own.
export function warControls(room, layoutMode) {
  const inLayout = layoutMode === true;
  const peaceActive = !inLayout && Boolean(room && room.peace && room.peace.active);
  return {
    clock: !inLayout,
    peace: peaceActive,
    begin: peaceActive,
    // PB-309 (manual p.35 l.1126-1127): Switch Sides is offered in a live war - a solo game, where
    // the server honours it, and a two-human one, where the server answers with the manual's own
    // limit and the player must be able to read it. Never in a layout, and never over a finished war.
    sides: !inLayout && !(room && room.over),
  };
}

// PB-308: the War panel's nav hint promised "the clock, and the way out" - the two things a layout
// sandbox does not have. In a layout the panel is only a readout of the two sides; the ways out are
// the strip's Save Setup and the panel's own Leave, and the hint does not re-word the wire's sentence.
export function navHint(item, layoutMode) {
  if (!item) return "";
  if (item.id === "war" && layoutMode === true) return "Who holds which side in this layout.";
  return item.hint;
}

// The purchase row: the original's own four columns - unit, how many you hold, how many you have
// seen of the enemy's, and the price. "Known" is only what this seat can see, which is why the
// server filters the pieces in the first place.
export function buyRows(room) {
  const shop = Array.isArray(room && room.shop) ? room.shop : [];
  const pieces = Array.isArray(room && room.pieces) ? room.pieces : [];
  const you = room ? room.you || (room.seat && room.seat.side) || "" : "";
  const enemy = you === "blue" ? "red" : you === "red" ? "blue" : "";
  const cash = room && room.seat && Number.isFinite(room.seat.cash) ? Number(room.seat.cash) : null;
  const count = (side, kind) => (side ? pieces.filter((piece) => piece.side === side && piece.kind === kind).length : 0);
  // PB-240(b): PB-224 moved satellites OUT of `pieces` (they ride `room.satellites`, both sides'),
  // so a satellite row counted 0 while blue held one in orbit. A satellite kind counts the ones in
  // ORBIT for that side; `orbit === false` is a satellite that is no longer up there.
  const sats = Array.isArray(room && room.satellites) ? room.satellites : [];
  const inOrbit = (side, kind) => (side ? sats.filter((sat) => sat && sat.side === side && sat.kind === kind && sat.orbit !== false).length : 0);
  const held = (side, entry) => (entry && entry.domain === "sat" ? inOrbit(side, entry.kind) : count(side, entry && entry.kind));
  return shop.map((entry) => {
    const price = Number.isFinite(Number(entry.price)) ? Number(entry.price) : null;
    return {
      kind: entry.kind,
      label: shopLabel(entry),
      price,
      domain: entry.domain || "land",
      tool: entry.tool || null,
      refused: entry.refused || "",
      own: held(you, entry),
      known: held(enemy, entry),
      // Whether the seat can pay is the shop's own rule, not a second copy of it here: a price the
      // server sent and a purse the server sent, and a refused unit stays refused whatever the pool.
      affordable: !shopDisabled(entry, cash),
    };
  });
}

// Pieces the server opened the match with carry a side and a domain but no unit type: the archive's
// opening order of battle was never recovered, so nothing invented a kind for them. The purchase
// table has to say that out loud, or "infantry 0" beside two armies reads as a broken count.
export function untypedCount(room) {
  const pieces = Array.isArray(room && room.pieces) ? room.pieces : [];
  const you = room ? room.you || (room.seat && room.seat.side) || "" : "";
  if (!you) return 0;
  return pieces.filter((piece) => piece.side === you && !piece.kind).length;
}

// The original's site subtype, read the way the server reads it (server/sitetype.mjs): the era
// table's `type` byte wins, and a board built by hand falls back to its kind. The economy
// dialogue counts by THIS, never by `kind`, because the asset list's word disagrees with the
// subtype on 14 of the 84 sites - six type-3 bases and three capitals of 1986 are all drawn
// with `kind: "city"` (PB-162).
export function siteSubtype(site) {
  if (!site) return 0;
  const type = site.type;
  if (typeof type === "number" && Number.isInteger(type) && type >= 0) return type;
  switch (site.kind) {
    case "city": return 4;
    case "capital": return 1;
    case "base": return 3;
    case "facility": return 5;
    default: return 0;
  }
}

// Held sites by SUBTYPE, straight off the room's own site list (PB-162). The old helper counted
// `kind === "city"` and the `oilfield`/`well` kinds, so 1986 Blue read "37 cities held" against
// the 31 the payday pays (six bases and three capitals are drawn as cities) and "5 oilfields"
// against the 11 type-5 fields the top bar's In already charges for. world.json's sketched
// `oilfield`/`well` rows carry no subtype and drive no rule (PB-153), so they are counted in
// none of these buckets.
export function heldSites(room, you) {
  const sites = Array.isArray(room && room.sites) ? room.sites : [];
  const held = { city: 0, capital: 0, base: 0, dock: 0, oilfield: 0 };
  for (const site of sites) {
    if (!site || site.owner !== you) continue;
    const type = siteSubtype(site);
    if (type === 4) held.city += 1;
    else if (type === 1 || type === 2) held.capital += 1;
    else if (type === 3) held.base += 1;
    else if (type === 5) held.oilfield += 1;
    else if (site.kind === "dock" || site.kind === "docks") held.dock += 1;
  }
  return held;
}

// The economy dialogue's model. `income` is the server's own count (economy.payoutFor), so the figure
// under "next payday" is the figure the tick will pay, not one this page made up by counting cities.
export function economyModel(room) {
  const seat = (room && room.seat) || null;
  const you = room ? room.you || (seat && seat.side) || "" : "";
  const held = heldSites(room, you);
  const income = seat && seat.income && typeof seat.income === "object"
    ? {
      cities: Number(seat.income.cities) || 0,
      wells: Number(seat.income.wells) || 0,
      cashWells: Number(seat.income.cashWells) || 0,
      amount: Number(seat.income.amount) || 0,
      // PB-233 AC (b) ships legibility, not a second cut (frodo 8983 §4): the payday is worth the
      // cities at the raw rate, and `perCity` is that rate read off the server.
      // A frame that predates PB-233 carries neither; it is passed through unchanged rather than
      // grown with zeroes.
      ...(seat.income.gross === undefined ? {} : {
        gross: Number(seat.income.gross) || 0,
        perCity: Number.isFinite(Number(seat.income.perCity)) ? Number(seat.income.perCity) : null,
      }),
    }
    : null;
  // T-033's oil budget, as the seat carries it: In / Out / the reserve. The dialogue's Stocks
  // list draws THIS for oil instead of the generic fuel meter, whose `held` is a cache that the
  // view never primes and whose `rate` was never recovered - the stand-in that sat beside a real
  // reserve of 3000 (PB-162).
  const oil = seat && seat.oil && typeof seat.oil === "object"
    ? {
      held: Number.isFinite(Number(seat.oil.held)) ? Number(seat.oil.held) : null,
      cap: Number.isFinite(Number(seat.oil.cap)) ? Number(seat.oil.cap) : null,
      in: Number.isFinite(Number(seat.oil.in)) ? Number(seat.oil.in) : null,
      out: Number.isFinite(Number(seat.oil.out)) ? Number(seat.oil.out) : null,
      wells: Number(seat.oil.wells) || 0,
      uses: seat.oil.uses !== false,
      short: seat.oil.short === true,
      dry: seat.oil.dry === true,
    }
    : null;
  const reserves = Array.isArray(seat && seat.reserves)
    ? seat.reserves
      // The fuel meter is the same oil under a generic name; with the oil budget present it is a
      // second, half-empty answer to the same question.
      .filter((meter) => !(oil && meter && meter.kind === "fuel"))
      .map((meter) => ({
        kind: String(meter.kind),
        held: Number.isFinite(Number(meter.held)) ? Number(meter.held) : null,
        reserve: Number.isFinite(Number(meter.reserve)) ? Number(meter.reserve) : null,
        rate: meter.rate === null || meter.rate === undefined ? null : Number(meter.rate),
        dry: meter.dry === true,
      }))
    : [];
  const pieces = Array.isArray(room && room.pieces) ? room.pieces : [];
  const enemy = you === "blue" ? "red" : you === "red" ? "blue" : "";
  const unitsOf = (side) => pieces.filter((piece) => piece.side === side).length;
  // PB-152: the other side's payday, as the server sent it. The payload has no cash field to
  // copy - the original prints ??? for the opponent's balance (MANUAL p.27) - so this model
  // carries none either, and the dialog prints ??? from the absence.
  const foe = room && room.opponent && room.opponent.income && typeof room.opponent.income === "object"
    ? {
      cities: Number(room.opponent.income.cities) || 0,
      amount: Number(room.opponent.income.amount) || 0,
    }
    : null;
  return {
    cash: seat && Number.isFinite(seat.cash) ? Number(seat.cash) : null,
    payIn: seat && Number.isFinite(Number(seat.payIn)) ? Number(seat.payIn) : null,
    payEvery: seat && Number.isFinite(Number(seat.payEvery)) ? Number(seat.payEvery) : null,
    // PB-268: the dialogue has to know WHICH clock is paying. `active` is the room's peace state and
    // `income` is the seat's peaceIncome (peaceRules() on the server): at peace no row may claim a
    // round, and the figure printed is the flat tick the server is actually crediting.
    peace: {
      active: Boolean(room && room.peace && room.peace.active === true),
      income: peaceIncomeOf(seat),
    },
    income,
    opponent: foe ? { income: foe } : null,
    held,
    oil,
    reserves,
    units: { own: you ? unitsOf(you) : 0, known: enemy ? unitsOf(enemy) : 0 },
  };
}

// PB-268: the Economy dialogue's payday rows as one function, so BOTH states are pinned by a node
// test instead of living only in the page's DOM code. At war: the countdown to the next round's
// payday, the round length, and what that payday is worth. At peace: NO row claims a round — the
// only true sentence is the flat tick, at the rate config's `peace` block pays through
// economy.peacePay() (the shipped pair is 500M/s).
export function paydayRows(model) {
  if (!model) return [];
  const peace = model.peace;
  if (peace && peace.active === true) {
    const income = peace.income;
    if (!income) {
      return [{
        label: "Next payday",
        value: "none — the peace pays no round, and this build carries no tick rate",
      }];
    }
    const detail = income.perTick !== null && income.ticksPerSecond !== null
      ? " (" + income.perTick + "M a tick, " + income.ticksPerSecond + " a second)"
      : "";
    return [{
      label: "Peace income",
      value: formatRate(income.perSecond) + " a second" + detail + " · no payday during the peace",
    }];
  }
  return [
    {
      label: "Next payday",
      value: model.payIn === null ? "unknown" : "in " + model.payIn + (model.payIn === 1 ? " round" : " rounds"),
    },
    {
      label: "Payday every",
      value: model.payEvery === null ? "unknown" : model.payEvery + (model.payEvery === 1 ? " round" : " rounds"),
    },
    {
      label: "Payday worth",
      value: model.income
        ? formatBillions(model.income.amount) + "b per round · " + model.income.cities + " cities + " + model.income.cashWells + " paying oil"
        : "unknown",
    },
  ];
}

// The Alternate Function's income line (Manual p.27: the monitor swaps sides). At peace both seats
// are paid the same flat tick, so the honest figure is that tick - not the other side's war payday.
export function foeIncomeValue(model) {
  const peace = model && model.peace;
  if (peace && peace.active === true) {
    if (!peace.income) return "none — the peace pays no round, and this build carries no tick rate";
    return formatRate(peace.income.perSecond) + " a second (the peace tick, both seats)";
  }
  const income = model && model.opponent && model.opponent.income;
  return income ? formatBillions(income.amount) + "b per round" : "unknown";
}

// One line per reserve kind, in the player's words. A kind with no recovered yield says so instead of
// printing a rate nobody measured.
export function reserveLine(meter) {
  const held = meter.held === null ? "unknown" : String(meter.held);
  const rate = meter.rate === null ? "rate unknown" : String(meter.rate) + " a round";
  // PB-244: steel is an owner-designed second resource, and "non-original stand-in" is a note for a
  // maintainer, not something to print at a player. The provenance lives in config.resources.steel
  // ("choice": "non-original ..."), where whoever tunes the number will read it.
  return meter.kind + ": " + held + " held · " + rate + (meter.dry ? " · dry" : "");
}

// The oil budget in the player's words: the reserve, and what the next round puts in and takes
// out (T-033). This is the real oil the top bar charges; the generic fuel meter above is not
// drawn beside it any more (PB-162). A scenario that rewrites its reserve every round says so
// instead of showing a budget the rules never spend.
export function oilLine(oil) {
  if (!oil) return "";
  if (!oil.uses) return "oil: no oil use in this scenario";
  const held = oil.held === null ? "unknown" : String(oil.held);
  const cap = oil.cap === null ? "" : " of " + oil.cap;
  const flow = (oil.in === null ? "In unknown" : "In " + oil.in) +
    (oil.out === null ? " / Out unknown" : " / Out " + oil.out);
  return "oil: " + held + cap + " held · " + flow + " a round" +
    (oil.short ? " · short" : "") + (oil.dry ? " · dry" : "");
}

// The "Last rounds" list. The Log panel used to draw the last 8 LINES, so a single chatty round
// (contact lines are one per sighted cell) filled the whole panel and every earlier round vanished
// (PB-121). The window is ROUNDS: walk back from the newest line until `rounds` distinct rounds are
// in hand, then cap the total so one crowded round cannot push the panel past `cap` lines either.
export function logWindow(lines, { rounds = 6, cap = 48 } = {}) {
  const all = Array.isArray(lines) ? lines : [];
  const kept = [];
  const seen = new Set();
  for (let i = all.length - 1; i >= 0; i--) {
    const line = all[i];
    if (!line || !line.text) continue;
    const round = Number(line.round) || 0;
    if (!seen.has(round) && seen.size >= rounds) break;
    seen.add(round);
    kept.push(line);
  }
  kept.reverse();
  return kept.length > cap ? kept.slice(-cap) : kept;
}
