// Unit names and the article in front of them. Owner: T-007 AC7.
//
// One table, read by the page and by the server, because a sentence about a unit is written in
// both places: the Buy panel's rows and the purchase line are the page's, the round log is the
// server's. Before this, the article was a second guess at every call site ("a infantry", "an
// tank"), and the test could only check the one path it knew about.
//
// The rule is the sound of the first syllable, with an explicit table for the spellings that lie.
// A unit name is a noun phrase; the page prints it as `unitPhrase` ("an infantry") and as a row
// label ("Infantry").

export const UNIT_NOUNS = Object.freeze({
  infantry: "infantry",
  tank: "tank",
  aircraft: "aircraft",
  cruiser: "cruiser",
  carrier: "carrier",
  submarine: "submarine",
  reconSat: "recon satellite",
  killerSat: "killer satellite",
  intelScan: "intel scan",
  nuke: "nuke",
  foreignAid: "foreign aid",
  // Not shop rows, but events name them.
  unit: "unit",
  transport: "transport",
});

// Nouns that take "an" whatever their first letter suggests.
const AN_NOUNS = new Set(["infantry", "aircraft", "intel scan", "escort", "officer"]);

// A kind the table has never heard of still reads as a noun rather than as a bare wire id:
// "recon satellite" for reconSat, "mine layer" for mineLayer.
function splitKind(kind) {
  return String(kind ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
}

export function unitNoun(kind) {
  const key = String(kind ?? "");
  if (UNIT_NOUNS[key]) return UNIT_NOUNS[key];
  return splitKind(key) || "unit";
}

export function articleFor(noun) {
  const word = String(noun ?? "").trim().toLowerCase();
  if (!word) return "a";
  if (AN_NOUNS.has(word)) return "an";
  // A vowel letter is the usual tell; "one" and "unit" are the usual exceptions.
  if (/^(one|uni|use|eu|ewe)/.test(word)) return "a";
  return /^[aeiou]/.test(word) ? "an" : "a";
}

// "an infantry", "a tank", "an aircraft".
export function unitPhrase(kind) {
  const noun = unitNoun(kind);
  return articleFor(noun) + " " + noun;
}

// The Buy panel's row label: the same noun, capitalised, with no article.
export function unitLabel(kind) {
  const noun = unitNoun(kind);
  return noun.charAt(0).toUpperCase() + noun.slice(1);
}
