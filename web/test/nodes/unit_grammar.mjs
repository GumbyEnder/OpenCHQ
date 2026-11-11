// T-007 AC7: article grammar everywhere. Every unit name an era can sell, plus every name an
// event can carry, is written once in units.mjs; this node walks every era's roster and asks for
// the phrase, so a new kind cannot ship with "a infantry" or "an tank".
//
// The article depends on the sound, not the spelling, so the check is: the noun in front of "an"
// starts with a vowel sound, and the noun in front of "a" does not.
import { articleFor, unitLabel, unitNoun, unitPhrase, UNIT_NOUNS } from "../../public/units.mjs";
import { purchaseText } from "../../public/command.mjs";
import { shopLabel } from "../../public/command.mjs";

export const name = "unit_grammar";

// Words whose spelling starts with a vowel letter but whose sound is a consonant, and the reverse.
const CONSONANT_SOUND = /^(one|uni|use|eu|ewe)/;
const VOWEL_SOUND = /^[aeiou]/;

function soundIsVowel(noun) {
  const word = String(noun).toLowerCase();
  if (CONSONANT_SOUND.test(word)) return false;
  return VOWEL_SOUND.test(word);
}

export async function run(ctx) {
  const { fail } = ctx;
  const rosters = ctx.config.rosters || {};
  const kinds = new Set();

  // Every era's roster, not one hand-written list: a kind that only one era sells is still a
  // sentence somewhere.
  for (const [era, roster] of Object.entries(rosters)) {
    for (const kind of Array.isArray(roster) ? roster : []) kinds.add(kind);
  }
  for (const kind of Object.keys(UNIT_NOUNS)) kinds.add(kind);
  if (kinds.size < 8) fail("the roster walk found too few unit names: " + [...kinds].join(","));

  for (const kind of [...kinds].sort()) {
    const noun = unitNoun(kind);
    if (!noun || noun === "unit" && kind !== "unit") fail("no noun for " + kind);
    if (/[A-Z]/.test(noun)) fail("a noun must not carry a camel case id: " + kind + " -> " + noun);

    const article = articleFor(noun);
    if (article !== "a" && article !== "an") fail("bad article for " + kind + ": " + article);
    const wantsAn = soundIsVowel(noun);
    if (article === "an" && !wantsAn) fail('"' + article + " " + noun + '" should read "a ' + noun + '"');
    if (article === "a" && wantsAn) fail('"' + article + " " + noun + '" should read "an ' + noun + '"');

    const phrase = unitPhrase(kind);
    if (phrase !== article + " " + noun) fail("phrase disagrees with the article: " + phrase);
    if (/^an? an? /.test(phrase)) fail("double article: " + phrase);

    // The purchase line and the Buy row must both use it, so the two views of one unit agree.
    const line = purchaseText(kind, { x: 3, y: 4 }, 1000);
    if (!line.startsWith("Bought " + phrase)) fail("purchase line does not use the phrase: " + line);
    const label = shopLabel({ kind, price: 10000, domain: "land" });
    if (!label.startsWith(unitLabel(kind))) fail("Buy row label disagrees: " + label);
  }

  // A kind the table has never seen still reads as a noun phrase instead of a wire id.
  if (unitNoun("mineLayer") !== "mine layer") fail("an unknown kind must be split into words: " + unitNoun("mineLayer"));
  if (unitPhrase("mineLayer") !== "a mine layer") fail("unknown kind phrase: " + unitPhrase("mineLayer"));

  // The specific sentences the play-test complained about.
  if (purchaseText("infantry", { x: 1, y: 1 }, 0) !== "Bought an infantry at 1,1. Pool 0b.") {
    fail("the infantry purchase line: " + purchaseText("infantry", { x: 1, y: 1 }, 0));
  }

  console.log("unit_grammar: " + kinds.size + " unit names, one article rule, page and server agree");
}
