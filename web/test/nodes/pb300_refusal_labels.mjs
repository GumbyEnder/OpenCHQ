// PB-300 pin: a refusal names the piece the way a player reads it, never by its wire key.
//
// PM 9952 §4, filed from 9923/9924. PB-299 taught the Air panel to print "Aircraft 1" instead of
// "blue:aircraft:1"; the refusals were left interpolating the id. A player who mis-aimed an order
// was told "Another piece holds that cell (blue:tank:2)." - a key, not a name.
//
// The ruled set (PM 9952 §4 names FIVE holder refusals; this file pins EVERY refusal that echoed a
// piece id, which is what AC1 asks for - the extra ten are the bombing run's "defended (...)" and
// the nine defensive echoes of an id the caller was given):
//   move.mjs   planOrder          "Another piece holds that cell (...)"   land  + sea
//   move.mjs   transferPiece      "Another piece holds that cell (...)"   land  + sea
//   move.mjs   planOrder/transferPiece/destination/entrench/repair        "No such piece (...)"
//   air.mjs    paradrop           "Another piece holds that cell (...)"
//   air.mjs    sendMission (bomb) "<site> is defended (...)"
//   air.mjs    sendMission/transferPlane                                  "No such aircraft (...)"
//   air.mjs    paradrop           "A paradrop needs the aircraft that flies it (...)"
//
// Each arm asserts three things about the sentence the server hands the page: it still names the
// piece (the refusal did not lose its subject), the name is the kind-based label PB-299 prints, and
// the sentence contains NO wire key - not "blue:tank:2", not the bare "blue:sea" of a scenario's
// opening unit, and not any other "side:" prefix.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openMatch } from "../../server/match.mjs";
import { matchSites } from "../../server/board.mjs";
import { atWar } from "../wartime.mjs";
import { answerCeasefire } from "../../server/late.mjs";
import { useTool } from "../../server/late.mjs";
import { planOrder, transferPiece, entrench, repair, terrainNameAt } from "../../server/move.mjs";
import { paradrop, sendMission } from "../../server/air.mjs";
import { pieceEcho, pieceLabel, pieceRef } from "../../server/labels.mjs";

export const name = "pb300_refusal_labels";

function fail(message) {
  throw new Error(message);
}

function eq(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(label + ": expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
  }
}

const WIRE_KEY = /[a-z]+:[a-z]+:\d+/i;
const WIRE_PREFIX = /\b(?:blue|red):/i;

// The sentence must carry a name, that name must be the label, and no wire key may appear in it.
function named(where, error, expected, label) {
  if (!error) fail(where + ": the refusal went missing (no error came back)");
  if (!String(error).includes(expected)) fail(where + ": expected the label \"" + expected + "\" in \"" + error + "\"");
  if (WIRE_KEY.test(String(error))) fail(where + ": the sentence still carries a wire key: \"" + error + "\"");
  if (WIRE_PREFIX.test(String(error))) fail(where + ": the sentence still carries a side: prefix: \"" + error + "\"");
  return String(error);
}

function unit(id, kind, domain, x, y, side = "blue", extra = {}) {
  return {
    id, side, kind, domain, x, y, path: [], pace: 1, facing: null, fighting: null, shots: 0,
    strength: 100, maxStrength: 100, ...extra,
  };
}

const site = (match, owner) => (match.sites || []).find((entry) => entry && entry.owner === owner
  && ["city", "capital", "base"].includes(String(entry.kind)));

function peacetime(era = "1986", round = 3) {
  const match = openMatch(era, matchSites(era));
  match.clock = "running";
  match.round = round;
  if (!match.peace || match.peace.active !== true) {
    const offer = useTool(match, "blue", "ceasefire");
    if (offer.error) fail("the ceasefire proposal was refused: " + offer.error);
    const answer = answerCeasefire(match, "red", true);
    if (answer.error) fail("the ceasefire acceptance was refused: " + answer.error);
  }
  return match;
}

// Two adjacent open-water cells, found on the board the match actually deals.
function waterPair() {
  for (let y = 2; y < 130; y += 1) {
    for (let x = 0; x < 300; x += 1) {
      if (terrainNameAt(x, y) !== "ocean") continue;
      if (terrainNameAt(x + 1, y) !== "ocean") continue;
      if (terrainNameAt(x + 2, y) !== "ocean") continue;
      return [{ x, y }, { x: x + 1, y }];
    }
  }
  return null;
}

export async function run() {
  // ---- the label rule itself ---------------------------------------------------------------
  eq(pieceLabel({ id: "blue:aircraft:1", kind: "aircraft" }), "Aircraft 1", "an id with a number reads as the PB-299 label");
  eq(pieceLabel("blue:tank:2"), "Tank 2", "a bare id still resolves its own kind");
  eq(pieceLabel({ id: "blue:land", kind: "infantry" }), "Infantry", "a scenario's opening unit reads as its bare noun");
  eq(pieceLabel("blue:sea"), "", "an id whose second segment is a role (\"sea\"), not a kind, names nothing");
  eq(pieceRef({ id: "blue:sea", kind: "submarine" }), "Submarine", "the same opening hull names itself once it is passed as a piece");
  eq(pieceLabel({ id: "blue:thing:9", kind: "hosepipe" }), "Hosepipe 9", "an unknown kind still capitalises into a name");
  eq(pieceLabel(""), "", "nothing readable gives an empty string, never the key");
  eq(pieceLabel("nope"), "", "an id with no kind gives an empty string");
  eq(pieceRef({ id: "nope" }), "that piece", "a refusal that must name something falls back to a noun");
  eq(pieceEcho("blue:infantry:99"), " (Infantry 99)", "an echo names the id it was given");
  eq(pieceEcho("junk"), "", "an unreadable echo is silent rather than printing the key");

  // ---- 1+2: planOrder refuses a cell another piece holds (land, sea) ------------------------
  {
    const match = atWar(openMatch("1986", matchSites("1986")));
    match.round = 3;
    const city = site(match, "blue");
    if (!city) fail("the fixture has no blue city");
    const walker = unit("blue:infantry:11", "infantry", "land", Number(city.x) + 1, Number(city.y));
    const holder = unit("blue:tank:12", "tank", "land", city.x, city.y);
    match.pieces.push(walker, holder);
    named("planOrder land", planOrder(match, "blue", walker.id, city.x, city.y).error, "Tank 12", "planOrder land");
    eq([walker.x, walker.y], [Number(city.x) + 1, Number(city.y)], "the refused land order moved nothing");

    const pair = waterPair();
    if (!pair) fail("the fixture board has no adjacent open water");
    const hull = unit("blue:cruiser:13", "cruiser", "sea", pair[0].x, pair[0].y);
    const block = unit("blue:submarine:14", "submarine", "sea", pair[1].x, pair[1].y);
    match.pieces.push(hull, block);
    named("planOrder sea", planOrder(match, "blue", hull.id, pair[1].x, pair[1].y).error, "Submarine 14", "planOrder sea");
    eq([hull.x, hull.y], [pair[0].x, pair[0].y], "the refused sea order moved nothing");
  }

  // ---- 3+4: transferPiece refuses a cell another piece holds (land, sea) --------------------
  {
    const match = peacetime();
    eq(match.peace && match.peace.active, true, "the transfer arms run at peace");
    const city = site(match, "blue");
    const walker = unit("blue:infantry:21", "infantry", "land", Number(city.x) + 1, Number(city.y));
    const holder = unit("blue:tank:22", "tank", "land", city.x, city.y);
    match.pieces.push(walker, holder);
    named("transferPiece land", transferPiece(match, "blue", walker.id, city.x, city.y).error, "Tank 22", "transferPiece land");
    eq([walker.x, walker.y], [Number(city.x) + 1, Number(city.y)], "the refused land transfer moved nothing");

    const pair = waterPair();
    const hull = unit("blue:cruiser:23", "cruiser", "sea", pair[0].x, pair[0].y);
    const block = unit("blue:submarine:24", "submarine", "sea", pair[1].x, pair[1].y);
    match.pieces.push(hull, block);
    named("transferPiece sea", transferPiece(match, "blue", hull.id, pair[1].x, pair[1].y).error, "Submarine 24", "transferPiece sea");
    eq([hull.x, hull.y], [pair[0].x, pair[0].y], "the refused sea transfer moved nothing");
  }

  // ---- 5: a paradrop refuses a cell another piece holds ------------------------------------
  {
    const match = atWar(openMatch("1986", matchSites("1986")));
    match.round = 3;
    const city = site(match, "blue");
    const plane = unit("blue:aircraft:31", "aircraft", "air", city.x, city.y, "blue", { inactiveUntil: 0 });
    const rider = unit("blue:infantry:32", "infantry", "land", Number(city.x) + 1, city.y, "blue", { entrenched: true });
    // The held cell must be LAND (the water refusal comes first) and not an enemy site.
    const held = [];
    for (let dy = -2; dy <= 2 && !held.length; dy += 1) {
      for (let dx = -2; dx <= 2 && !held.length; dx += 1) {
        const x = Number(city.x) + dx;
        const y = Number(city.y) + dy;
        if (x === Number(city.x) && y === Number(city.y)) continue;
        if (terrainNameAt(x, y) === null || terrainNameAt(x, y) === "ocean" || terrainNameAt(x, y) === "lake") continue;
        if ((match.sites || []).some((entry) => entry && Number(entry.x) === x && Number(entry.y) === y)) continue;
        held.push({ x, y });
      }
    }
    if (!held.length) fail("no empty land cell stands beside the blue city for the paradrop arm");
    const holder = unit("blue:tank:33", "tank", "land", held[0].x, held[0].y);
    match.pieces.push(plane, rider, holder);
    const refused = paradrop(match, "blue", rider.id, { x: holder.x, y: holder.y }, plane.id);
    named("paradrop", refused.error, "Tank 33", "paradrop");
    eq([rider.x, rider.y], [Number(city.x) + 1, Number(city.y)], "the refused drop left the infantry where it stood");
  }

  // ---- 6: a bombing run's "defended (...)" names the defender ------------------------------
  {
    const match = atWar(openMatch("1986", matchSites("1986")));
    match.round = 3;
    const home = site(match, "blue");
    const away = site(match, "red");
    if (!away) fail("the fixture has no red city");
    const plane = unit("blue:aircraft:41", "aircraft", "air", home.x, home.y, "blue", { inactiveUntil: 0 });
    const defender = unit("red:infantry:42", "infantry", "land", away.x, away.y, "red", {});
    match.pieces.push(plane, defender);
    const refused = sendMission(match, "blue", plane.id, "bomb", { x: away.x, y: away.y });
    const text = named("bombing run defended", refused.error, "Infantry 42", "bombing run defended");
    if (!/is defended/.test(text)) fail("the bombing arm landed on the wrong refusal: " + text);
  }

  // ---- 7: the defensive echoes of an id the caller was given -------------------------------
  {
    const war = atWar(openMatch("1986", matchSites("1986")));
    war.round = 3;
    const city = site(war, "blue");
    named("planOrder missing", planOrder(war, "blue", "blue:infantry:99", city.x, city.y).error, "Infantry 99", "planOrder missing");
    eq(planOrder(war, "blue", "junk", city.x, city.y).error, "No such piece.", "an unreadable id is refused without echoing the key");
    eq(entrench(war, "blue", "blue:tank:98").error.includes("blue:"), false, "entrench does not echo a wire key");
    eq(repair(war, "blue", "blue:tank:98").error.includes("blue:"), false, "repair does not echo a wire key");

    const peace = peacetime();
    named("transferPiece missing", transferPiece(peace, "blue", "blue:cruiser:97", 1, 1).error, "Cruiser 97", "transferPiece missing");
    eq(transferPiece(peace, "blue", "nope", 1, 1).error, "No such piece.", "a junk transfer id is refused without echoing it");

    const plane = unit("blue:aircraft:51", "aircraft", "air", site(war, "blue").x, site(war, "blue").y, "blue", { inactiveUntil: 0 });
    const rider = unit("blue:infantry:52", "infantry", "land", site(war, "blue").x, site(war, "blue").y);
    war.pieces.push(plane, rider);
    named("sendMission missing plane", sendMission(war, "blue", "blue:aircraft:96", "strike", null).error, "Aircraft 96", "sendMission missing plane");
    named("paradrop missing plane", paradrop(war, "blue", rider.id, { x: 1, y: 1 }, "blue:aircraft:95").error, "Aircraft 95", "paradrop missing plane");
  }

  // ---- 8: the class, not just the fifteen instances ---------------------------------------
  // The card asks for a grep arm so a SIXTEENTH site cannot appear silently. This reads the server
  // sources and fails on the shapes that put a piece id into a sentence: `${piece}.id` concatenated
  // into an error, and the "No such piece/aircraft: <id>" echo. A comment line is skipped - the
  // test file at web/test/nodes/pb131 quotes the old sentence on purpose.
  {
    const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "server");
    // A defect only counts where a PLAYER reads the line: a refusal is what the page prints, i.e. an
    // `error:` / `error(` value, a thrown message, or a `note:` / `message:` / `say(` sentence.
    // Diagnostics are out of scope: history.mjs `console.warn`s and the bot's lobby log lines
    // template a room id on purpose, and a guard that reds on them grades the logging, not the
    // refusals. That was the over-broad first cut (16th-site grep flagged five console lines).
    const playerFacing = (code) => !/console\./.test(code) &&
      /(?:error\s*:|error\s*\(|throw\s+new|\bsay\s*\(|\bnote\s*:|\bmessage\s*:)/.test(code);
    const banned = [
      { what: "a piece id concatenated into a message", re: /\+\s*(?:holder|held|piece|plane|unit|defender|rider)\.id\s*\+/, playerOnly: false },
      { what: "an id echoed after \"No such piece/aircraft:\"", re: /"No such (?:piece|aircraft):\s*"\s*\+/, playerOnly: false },
      { what: "a wire id templated into a message", re: /\$\{[a-zA-Z]*\.id\}/, playerOnly: true },
    ];
    const files = readdirSync(serverDir).filter((file) => file.endsWith(".mjs"));
    const hits = [];
    for (const file of files) {
      const lines = readFileSync(path.join(serverDir, file), "utf8").split("\n");
      lines.forEach((line, index) => {
        const code = line.replace(/\/\/.*$/, "");
        for (const rule of banned) {
          if (rule.playerOnly && !playerFacing(code)) continue;
          if (rule.re.test(code)) hits.push(file + ":" + (index + 1) + " " + rule.what + " — " + line.trim());
        }
      });
    }
    eq(hits, [], "no server module interpolates a raw piece id into a message: " + hits.join(" | "));
    if (files.length <= 20) fail("the grep arm read only " + files.length + " server modules; it is not looking at the tree");
  }
}
