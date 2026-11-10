// F3: the purchase line. It read "Bought an submarine at 86,61. Pool 300": the wrong article, and
// a pool printed in millions, which T-001's display rule forbids. Every kind gets its own article,
// and the pool is billions like the rest of the UI.
export const name = "buy_message_text";

import { articleFor, purchaseText } from "../../public/command.mjs";

export async function run(ctx) {
  const { fail } = ctx;

  const submarine = purchaseText("submarine", { x: 86, y: 61 }, 300);
  if (submarine !== "Bought a submarine at 86,61. Pool 0.3b.") {
    fail("submarine purchase line: " + JSON.stringify(submarine));
  }
  if (/\bPool 300\b/.test(submarine)) fail("the pool is still printed in raw millions: " + submarine);

  const infantry = purchaseText("infantry", { x: 80, y: 45 }, 12000);
  if (infantry !== "Bought an infantry section at 80,45. Pool 12b.") {
    fail("infantry purchase line: " + JSON.stringify(infantry));
  }

  // Every kind the shop sells must read with an article its spelling cannot break.
  for (const kind of ["tank", "cruiser", "carrier", "aircraft", "nuke", "reconSat", "killerSat", "foreignAid", "intelScan"]) {
    const line = purchaseText(kind, { x: 1, y: 2 }, 1000);
    if (!/^Bought an? \S/.test(line)) fail("no article for " + kind + ": " + line);
    if (/\ban [bcdfghjklmnpqrstvwxyz]/i.test(line)) fail("wrong article for " + kind + ": " + line);
    if (/\ba [aeiou]/i.test(line)) fail("wrong article for " + kind + ": " + line);
    if (!/ Pool 1b\.$/.test(line)) fail("pool is not whole billions for " + kind + ": " + line);
  }
  if (articleFor("infantry section") !== "an") fail("article for a collective noun");
  if (articleFor("aircraft") !== "an") fail("article for aircraft");

  // No pool figure (a reply that carries none) still reads as a sentence.
  const bare = purchaseText("cruiser", { x: 3, y: 4 }, null);
  if (bare !== "Bought a cruiser at 3,4.") fail("purchase line with no pool: " + JSON.stringify(bare));

  console.log("buy_message_text: article per kind, pool in billions, no raw millions");
}
