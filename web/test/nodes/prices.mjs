// Node prices: the recovered 1990 price list, the city income rule, and the two grep guards.
//
// Manual p.28's production screen and the executable's own table at DS:0x2E16 agree:
//   infantry 10, tank 20, submarine 10, cruiser 10, carrier 20, aircraft 20,
//   recon satellite 10, satellite killer 5, use nukes 10, foreign aid 10, intel scan 10
// in billions. The sub/cruiser/carrier row order is read from the p.28 icons and is UNVERIFIED.
// Manual p.22 makes a tank twice an infantry; p.30 makes a nuke 10; p.27 makes each city pay
// 50 million (0.05 billion) every round.
//
// What breaks if this node is removed: a price could drift back to a stand-in, "ship" could
// return as a unit kind, a literal could be typed into money code, and an old save's ship
// would never become a cruiser.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cityIncome, millionsPerBillion, priceOf, rules, sourceOf } from "../../server/rules.mjs";
import { migrateMatch } from "../../server/migrate.mjs";

export const name = "prices";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// The manual's own numbers, in billions.
const BILLIONS = {
  infantry: 10,
  tank: 20,
  submarine: 10,
  cruiser: 10,
  carrier: 20,
  aircraft: 20,
  reconSat: 10,
  killerSat: 5,
  nuke: 10,
  foreignAid: 10,
  intelScan: 10,
};

function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(mjs|js)$/.test(entry.name)) out.push(full);
  }
  return out;
}

// A line is money code when it names a money concept; prose is not. Comments are skipped, so
// a citation in a comment cannot be mistaken for a literal the server would spend.
const MONEY_LINE = /\b(price|prices|cost|cityIncome|payout|payday|payEvery|cash|pool|income|billion)\b/i;
const MONEY_LITERAL = /(?<![\w.$])(10|20|5|0\.05|50)(?![\w.])/;

export async function run(ctx) {
  const { fail } = ctx;
  const eq = (actual, expected, label) => {
    if (actual !== expected) fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  };

  const factor = millionsPerBillion();
  eq(factor, 1000, "a billion is 1000 million");

  // ---- 1-2: every price, the two relations, and the nuke ------------------------------
  for (const [kind, billions] of Object.entries(BILLIONS)) {
    const millions = priceOf(kind);
    eq(millions, billions * factor, `priceOf(${kind}) in millions`);
    eq(millions / factor, billions, `priceOf(${kind}) in billions`);
  }
  eq(priceOf("tank"), 2 * priceOf("infantry"), "a tank is twice an infantry (Manual p.22)");
  eq(priceOf("nuke"), 10 * factor, "a nuke is 10 billion (Manual p.30, p.28)");

  // ---- 3: the generic ship kind is gone -----------------------------------------------
  if (priceOf("ship") !== undefined) fail("priceOf(\"ship\") still answers: the generic kind is gone");
  let threw = false;
  try {
    const missing = priceOf("no-such-unit");
    if (missing !== undefined) fail("an unknown kind must be undefined, got " + JSON.stringify(missing));
  } catch {
    threw = true;
  }
  if (threw) fail("priceOf must answer undefined for an unknown kind, not throw");

  // ---- 8: config carries a source for every price and for income ---------------------
  const sources = rules().sources || {};
  for (const kind of Object.keys(BILLIONS)) {
    const source = sourceOf("prices." + kind);
    if (typeof source !== "string" || !source.includes("Manual p.28")) {
      fail("no Manual p.28 source for " + kind + ": " + JSON.stringify(source));
    }
    if (!/DS:0x2E16/.test(source)) fail("no DS:0x2E16 source for " + kind + ": " + source);
  }
  for (const kind of ["submarine", "cruiser", "carrier"]) {
    if (!/row order from p\.28 icons: UNVERIFIED/.test(sourceOf("prices." + kind))) {
      fail(kind + " does not carry the p.28 icon row-order label");
    }
  }
  if (!/Manual p\.27/.test(String(sourceOf("payEvery")))) fail("payEvery has no Manual p.27 source");
  if (!/Manual p\.27/.test(String(sourceOf("cityIncome")))) fail("cityIncome has no Manual p.27 source");
  if (String(sourceOf("capitalPays")) !== "UNVERIFIED") fail("capitalPays must be labelled UNVERIFIED");
  eq(cityIncome(), 50, "a city pays 50 million a round (Manual p.27)");

  // ---- 9: no money literal outside config ---------------------------------------------
  const offenders = [];
  for (const file of [...sourceFiles(path.join(root, "web", "server")), ...sourceFiles(path.join(root, "web", "public"))]) {
    const rel = path.relative(root, file);
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      const text = line.trim();
      if (!text || text.startsWith("//") || text.startsWith("*") || text.startsWith("/*")) return;
      if (!MONEY_LINE.test(text)) return;
      const hit = text.match(MONEY_LITERAL);
      if (hit) offenders.push(`${rel}:${index + 1}: ${text}`);
    });
  }
  if (offenders.length) fail("money literals outside config/game.json:\n" + offenders.join("\n"));

  // ---- 10: no "ship" unit kind outside migration code ---------------------------------
  const ships = [];
  for (const file of sourceFiles(path.join(root, "web"))) {
    const rel = path.relative(root, file);
    if (rel.endsWith(path.join("server", "migrate.mjs"))) continue; // the migration itself
    if (rel === path.join("web", "test", "nodes", "prices.mjs")) continue; // this guard, which must name it
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      const text = line.trim();
      if (text.startsWith("//") || text.startsWith("*")) return;
      if (/["']ship["']/.test(line)) ships.push(`${rel}:${index + 1}: ${text}`);
    });
  }
  if (ships.length) fail("a \"ship\" unit kind survives outside migration code:\n" + ships.join("\n"));

  // ---- 12: an old save's ship becomes a cruiser, and money scales once ----------------
  const old = migrateMatch({
    pieces: [
      { id: "blue:ship:1", side: "blue", domain: "sea", kind: "ship", x: 1, y: 2 },
      { id: "blue:infantry:2", side: "blue", domain: "land", kind: "infantry", x: 3, y: 4 },
    ],
    sides: { blue: { cash: 9 }, red: { cash: 40 } },
  });
  eq(old.pieces[0].kind, "cruiser", "an old ship is now a cruiser");
  eq(old.pieces[1].kind, "infantry", "an old infantry is untouched");
  eq(old.sides.blue.cash, 9 * factor, "old billions scale to millions");
  eq(old.sides.red.cash, 40 * factor, "old billions scale to millions");
  const again = migrateMatch(old);
  eq(again.sides.blue.cash, 9 * factor, "a row already in millions is never scaled twice");
}
