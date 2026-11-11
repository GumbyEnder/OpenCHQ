// The round log: what a seat is told each round, and what it must never be told.
// Owner: feedback node.

import { openMatch } from "../../server/match.mjs";
import { logLines } from "../../server/log.mjs";
import { boardPayload } from "../../server/board.mjs";
import { sightCells } from "../../server/rules.mjs";

export const name = "log";

function must(ok, why) {
  if (!ok) throw new Error(why);
}

export async function run() {
  const sites = boardPayload().sites || [];
  const match = openMatch("1986", sites);
  const radius = sightCells();

  // Give blue a scout so there is a lit part of the map, and put a red city far from it.
  const blue = match.pieces.find((piece) => piece.side === "blue" && piece.domain === "land");
  must(blue, "no blue land piece to scout with");
  const citySite = sites.find((site) => site.kind === "city");
  must(citySite, "the board has no city");

  // ---- your own payday is yours to read, the enemy's is not -------------------------------
  const mine = logLines(match, "blue", [{ type: "income", side: "blue", amount: 4, cities: 6 }], 25);
  must(mine.length === 1 && mine[0].round === 25, "an income event must produce one line at its round");
  must(/paid 0\.004b/.test(mine[0].text), "the amount must be the one the economy paid, in billions: " + mine[0].text);
  // The pool's own display is billions (Manual p.27), so the log's money is billions too: 650
  // million millions read as 0.65b, not as a bare 650 (T-007 AC8).
  const payday = logLines(match, "blue", [{ type: "income", side: "blue", amount: 650, cities: 13 }], 26);
  must(/paid 0\.65b from 13 cities/.test(payday[0].text), "a payday must read in billions with its unit: " + payday[0].text);
  must(/6 cities/.test(mine[0].text), "the city count must be the one the economy counted: " + mine[0].text);

  const theirs = logLines(match, "blue", [{ type: "income", side: "red", amount: 9, cities: 9 }], 25);
  must(theirs.length === 0, "the enemy's payday must not reach this seat: " + JSON.stringify(theirs));

  // ---- a capture at a lit cell is legible; one in the dark is not --------------------------
  const nearSite = { id: "near", name: "Nearville", kind: "city", x: blue.x, y: blue.y };
  match.sites.push(nearSite);
  const lit = logLines(match, "blue", [{ type: "capture", site: "near", name: "Nearville", side: "red", from: "blue" }], 30);
  must(lit.length === 1, "a city lost inside sight must be reported");
  must(/lost/.test(lit[0].text), "a lost city must say so: " + lit[0].text);

  const darkSite = { id: "dark", name: "Darkhollow", kind: "city", x: (blue.x + radius * 4) % 320, y: blue.y };
  match.sites.push(darkSite);
  const dark = logLines(match, "blue", [{ type: "capture", site: "dark", name: "Darkhollow", side: "red", from: null }], 31);
  must(dark.length === 0, "a city changing hands out of sight must stay unknown: " + JSON.stringify(dark));

  // ---- a killed enemy unit is reported only where it can be seen ---------------------------
  const seenKill = logLines(match, "blue", [{ type: "destroyed", side: "red", x: blue.x + 1, y: blue.y }], 32);
  must(seenKill.length === 1, "an enemy loss inside sight must be reported");
  const unseenKill = logLines(match, "blue", [{ type: "destroyed", side: "red", x: (blue.x + radius * 5) % 320, y: blue.y }], 32);
  must(unseenKill.length === 0, "an enemy loss out of sight must stay unknown");

  // ---- your own loss is always yours, wherever it happened ---------------------------------
  const ownLoss = logLines(match, "blue", [{ type: "destroyed", side: "blue", x: 200, y: 120 }], 33);
  must(ownLoss.length === 1 && /lost a unit/.test(ownLoss[0].text), "your own loss must always be reported");

  // ---- a shot on its own is noise; a win is not -------------------------------------------
  const shots = logLines(match, "blue", [{ type: "shot", side: "red", x: blue.x, y: blue.y }], 34);
  must(shots.length === 0, "a single shot must not fill the log");

  const win = logLines(match, "blue", [{ type: "win", side: "blue" }], 400);
  must(win.length === 1 && /both capitals/.test(win[0].text), "a win must be reported in words");

  // ---- the seam: sight wraps in X, so a fight across the wrap is visible -------------------
  const edge = match.pieces.find((piece) => piece.side === "blue" && piece.domain === "land");
  edge.x = 1;
  edge.y = 60;
  const wrapped = logLines(match, "blue", [{ type: "destroyed", side: "red", x: 319, y: 60 }], 35);
  must(wrapped.length === 1, "sight must wrap across the seam in the log too");

  // ---- contact: the sight rule made legible, and never a leak -------------------------------
  // The opening armies are on opposite sides of the map, so put a red piece next to blue's
  // scout before asking whether contact is reported.
  const blueScout = match.pieces.find((piece) => piece.side === "blue" && piece.domain === "land");
  const redPiece = match.pieces.find((piece) => piece.side === "red" && piece.domain === "land");
  must(blueScout && redPiece, "the opening armies must each have a land piece");
  redPiece.x = blueScout.x + 1;
  redPiece.y = blueScout.y;
  const contact = logLines(match, "blue", [], 36).filter((line) => /in sight/.test(line.text));
  must(contact.length >= 1, "an enemy inside sight must be reported as contact");
  must(contact.every((line) => line.key), "a contact line must carry a key so the page says it once");

  // The concealed era withholds the enemy until its capital is seen: contact must not leak it.
  const concealed = openMatch("9999", boardPayload().sites || []);
  const leaked = logLines(concealed, "blue", [], 1).filter((line) => /in sight/.test(line.text));
  must(leaked.length === 0, "the concealed era must not name an enemy the seat cannot see");
}
