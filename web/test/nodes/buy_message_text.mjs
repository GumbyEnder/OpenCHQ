// F3/F4: the purchase line. It read "Bought an submarine at 86,61. Pool 300": the wrong article, and
// a pool printed in millions, which T-001's display rule forbids. F3 gave every kind its own article
// and moved the pool to billions. F4 fixed the form: the original shows cash in whole billions and
// truncates (`3711:16f3`, DS:0x148e / 0x28, integer divide - Manual p.27), so the line reads
// "Pool 10b", never "Pool 10.049b" and never a rounded-up figure.
//
// A balance under one billion therefore prints "0b". That is what the divide gives, but it is
// UNVERIFIED against the original until a capture shows a sub-1b balance; this node pins the
// remake to the divide, not to a guess about a screen nobody has photographed.
export const name = "buy_message_text";

import { articleFor, formatWholeBillions, purchaseText } from "../../public/command.mjs";

export async function run(ctx) {
  const { fail } = ctx;

  // 300 million is under a billion: the original's integer divide prints the billion below it.
  const submarine = purchaseText("submarine", { x: 86, y: 61 }, 300);
  if (submarine !== "Bought a submarine at 86,61. Pool 0b.") {
    fail("submarine purchase line: " + JSON.stringify(submarine));
  }
  if (/\bPool 300\b/.test(submarine)) fail("the pool is still printed in raw millions: " + submarine);
  if (/Pool 0\.3b/.test(submarine)) fail("the pool is still printed with a fraction: " + submarine);

  const infantry = purchaseText("infantry", { x: 80, y: 45 }, 12000);
  if (infantry !== "Bought an infantry section at 80,45. Pool 12b.") {
    fail("infantry purchase line: " + JSON.stringify(infantry));
  }

  // Truncate, do not round: 1,049 million is one whole billion and 1,950 million is still one.
  for (const [millions, expected] of [[1049, "1"], [1950, "1"], [1999, "1"], [2000, "2"], [999, "0"], [0, "0"]]) {
    const got = formatWholeBillions(millions);
    if (got !== expected) fail("formatWholeBillions(" + millions + ") = " + JSON.stringify(got) + ", wanted " + expected);
  }

  // Every kind the shop sells must read with an article its spelling cannot break, and the pool is
  // always a whole number of billions with no decimal point.
  for (const kind of ["tank", "cruiser", "carrier", "aircraft", "nuke", "reconSat", "killerSat", "foreignAid", "intelScan"]) {
    const line = purchaseText(kind, { x: 1, y: 2 }, 1000);
    if (!/^Bought an? \S/.test(line)) fail("no article for " + kind + ": " + line);
    if (/\ban [bcdfghjklmnpqrstvwxyz]/i.test(line)) fail("wrong article for " + kind + ": " + line);
    if (/\ba [aeiou]/i.test(line)) fail("wrong article for " + kind + ": " + line);
    if (!/ Pool \d+b\.$/.test(line)) fail("pool is not whole billions for " + kind + ": " + line);
  }
  if (articleFor("infantry section") !== "an") fail("article for a collective noun");
  if (articleFor("aircraft") !== "an") fail("article for aircraft");

  // No pool figure (a reply that carries none) still reads as a sentence.
  const bare = purchaseText("cruiser", { x: 3, y: 4 }, null);
  if (bare !== "Bought a cruiser at 3,4.") fail("purchase line with no pool: " + JSON.stringify(bare));

  console.log("buy_message_text: article per kind, pool in truncated whole billions, no raw millions");
}
