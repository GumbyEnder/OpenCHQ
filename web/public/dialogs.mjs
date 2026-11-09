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

import { formatBillions, formatWholeBillions, shopDisabled, shopLabel } from "./command.mjs";

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
  return shop.map((entry) => {
    const price = Number.isFinite(Number(entry.price)) ? Number(entry.price) : null;
    return {
      kind: entry.kind,
      label: shopLabel(entry),
      price,
      domain: entry.domain || "land",
      tool: entry.tool || null,
      refused: entry.refused || "",
      own: count(you, entry.kind),
      known: count(enemy, entry.kind),
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

// Held sites by kind, straight off the room's own site list.
function heldSites(room, you) {
  const sites = Array.isArray(room && room.sites) ? room.sites : [];
  const held = { city: 0, capital: 0, dock: 0, well: 0 };
  for (const site of sites) {
    if (!site || site.owner !== you) continue;
    if (site.kind === "city") held.city += 1;
    else if (site.kind === "capital") held.capital += 1;
    else if (site.kind === "dock") held.dock += 1;
    else if (site.kind === "oilfield" || site.kind === "well") held.well += 1;
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
    }
    : null;
  const reserves = Array.isArray(seat && seat.reserves)
    ? seat.reserves.map((meter) => ({
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
  return {
    cash: seat && Number.isFinite(seat.cash) ? Number(seat.cash) : null,
    payIn: seat && Number.isFinite(Number(seat.payIn)) ? Number(seat.payIn) : null,
    payEvery: seat && Number.isFinite(Number(seat.payEvery)) ? Number(seat.payEvery) : null,
    income,
    held,
    reserves,
    units: { own: you ? unitsOf(you) : 0, known: enemy ? unitsOf(enemy) : 0 },
  };
}

// One line per reserve kind, in the player's words. A kind with no recovered yield says so instead of
// printing a rate nobody measured.
export function reserveLine(meter) {
  const held = meter.held === null ? "unknown" : String(meter.held);
  const rate = meter.rate === null ? "rate unknown" : String(meter.rate) + " a round";
  return meter.kind + ": " + held + " held · " + rate + (meter.dry ? " · dry" : "");
}
