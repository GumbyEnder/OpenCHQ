// PB-163: inspecting a city shows its readiness without buying.
//
// Filed at ff31844: the readiness sentence ("ready at round N") only appeared in Buy mode, and in
// Buy mode a click on a READY city buys instead of inspecting, so a player could not read a city's
// readiness without risking a purchase.
//
// Bound here, in three arms:
//   1. the sentence itself, as a pure function: name, kind, holder, and the round the server wrote;
//   2. the served page's click path: outside Buy mode a site click says that sentence and returns,
//      and the only path that sends a buy is still the `if (buying)` arm;
//   3. the wire fact the sentence depends on, in the two states a match can be in:
//      3a. at peace (the 1986 open, PB-245b / p.31): production does not tire cities, so the
//          purchase's own frame carries NO timer and the sentence reads "Ready" - asserted as the
//          rule, not as a missing field;
//      3b. once the war is resumed: the purchase's own frame carries the site's readyRound, so a
//          click straight after a buy reads the truth without a sync. No server change is needed
//          for this - the view spreads the match's site records.
//
// PB-253: arm 3b used to run at the open, where the match is at peace, so the expected value came
// from the wartime formula (22) while the server correctly wrote nothing. The two reds under the
// extract were this fixture and a real refusal-message defect in placement.mjs; the classify
// artifact is /mnt/nas/host-ops/openchq/pb253/classify/.
//
// The round-0 numbers are the decoded formula's (PB-154): 1986 Blue, infantry 10 b, Detroit pools
// 12 listed records into a 5-round timer.
import { siteAtCell, siteInspectText } from "../../public/command.mjs";
import { boardPayload, matchSites } from "../../server/board.mjs";
import { poolReadiness } from "../../server/readiness.mjs";

export const name = "pb163_inspect";

function fail(message) {
  throw new Error("node test pb163_inspect: " + message);
}

function eq(actual, expected, label) {
  if (actual !== expected) fail(label + ": expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
}

// The mask is a base64 bitset of cells the server will accept a placement on. Walk it in reading
// order and accept the first cell that is ALSO a producing site record (city/capital/base): the
// producing record is what owns the pooled timer this arm is measuring. A dock/ship cell is on the
// mask but has no production record, so buying there would prove nothing about the readiness seam.
function decodeCell(message, occupied, sites) {
  const binary = Buffer.from(String(message.mask), "base64");
  const width = Number(message.width);
  const height = Number(message.height);
  const byCell = new Map();
  for (const site of sites) {
    if (["city", "capital", "base"].includes(String(site.kind))) byCell.set(Number(site.x) + "," + Number(site.y), site);
  }
  const offered = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!binary[y * width + x]) continue;
      if (occupied.has(x + "," + y)) continue;
      offered.push({ x, y, site: byCell.get(x + "," + y) || null });
    }
  }
  const pick = offered.find((cell) => cell.site);
  if (!pick) return null;
  return { x: pick.x, y: pick.y, site: pick.site, offered: offered.length };
}

export async function run(ctx) {
  // ---- 1. the sentence --------------------------------------------------------------
  const readyCity = { id: 24, name: "Detroit", kind: "city", owner: "blue", x: 74, y: 40 };
  eq(siteInspectText(readyCity, 0), "Detroit — city, blue. Ready.", "a ready city names itself and says ready");
  eq(siteInspectText({ ...readyCity, readyRound: 5 }, 0),
    "Detroit — city, blue. Unready — ready at round 5 (5 rounds).", "an unready city gives the round it comes back");
  eq(siteInspectText({ ...readyCity, readyRound: 5 }, 3),
    "Detroit — city, blue. Unready — ready at round 5 (2 rounds).", "the countdown is measured from the room's round");
  eq(siteInspectText({ ...readyCity, readyRound: 5 }, 5), "Detroit — city, blue. Ready.",
    "the ready round itself reads ready");
  eq(siteInspectText({ id: 62, name: "Washington", kind: "capital", owner: "blue" }, 0),
    "Washington — capital, blue. Ready.", "a capital reads as a capital");
  eq(siteInspectText({ id: 80, name: "Kirkuk", kind: "facility", owner: null }, 0),
    "Kirkuk — oil field, unheld. No production timer.", "an oil field takes no readiness timer");
  eq(siteInspectText(null, 0), "", "no site, no sentence");

  // The cell match is the site's own (x,y), and a cell with no site is not an inspection.
  const table = [readyCity, { id: 62, name: "Washington", kind: "capital", owner: "blue", x: 79, y: 44 }];
  eq(siteAtCell(table, { x: 74, y: 40 })?.name, "Detroit", "the click finds the site on that cell");
  eq(siteAtCell(table, { x: 75, y: 41 }), null, "a blank cell is not a site");
  eq(siteAtCell(table, null), null, "no cell, no site");

  // ---- 2. the served click path ------------------------------------------------------
  const app = await (await fetch(ctx.base + "/app.js")).text();
  const notSelected = app.indexOf("if (!selected) {");
  if (notSelected < 0) fail("app.js has no `if (!selected)` arm; the inspect branch has nowhere to live");
  const inspect = app.indexOf("siteInspectText(site, room.round)", notSelected);
  if (inspect < 0) fail("the no-selection arm never says a site's readiness");
  const hint = app.indexOf("say(PICK_HINT)", notSelected);
  if (hint < 0 || inspect > hint) fail("the site inspection is not on the path before the pick hint");
  // A selectable piece still wins over a site: the piece arm returns before this branch.
  const pieceArm = app.indexOf('intent.kind === "piece"');
  if (pieceArm < 0 || pieceArm > inspect) fail("the piece arm no longer precedes the site inspection");
  // Buy stays inside the buying arm: exactly one buyMessage send call site in the click handler.
  const clickHandler = app.slice(app.indexOf('board.addEventListener("click"'), app.indexOf('// Hover names the unit under the pointer'));
  const sends = (clickHandler.match(/sendOrder\(buyMessage\(/g) || []).length;
  eq(sends, 1, "the click handler sends a buy from exactly one place");
  const buyingArm = clickHandler.indexOf("if (buying) {");
  const buySend = clickHandler.indexOf("sendOrder(buyMessage(");
  if (buyingArm < 0 || buySend < buyingArm) fail("the buy send is outside the `if (buying)` arm");
  if (clickHandler.indexOf("siteInspectText") < buyingArm) fail("the inspection is inside the buy arm");

  // ---- 3. the wire: the purchase's own frame already carries the timer --------------
  // The card says the server already carries readyRound per site, so this arm exists to prove the
  // buyer can read the new state IMMEDIATELY after a purchase, not to add a server field. A buy is
  // announced with a WHOLE room frame: tellRoom -> frameFor returns a full frame unless the round
  // advanced by exactly one since that seat's last frame, and a purchase does not advance the
  // round. The view spreads the match's own site records, readyRound included.
  // (The first cut of this branch added a `ready` row to the delta; it was reverted. A held-round
  // buy never produced a delta to carry it, and no measurement in the room showed a seat reading a
  // stale timer, so the row was surface with no defect behind it.)
  const board = boardPayload();
  if (!Array.isArray(board.cells) || board.source !== "extract") {
    ctx.skip("no board extract on this host, so the live purchase and the frame it produces cannot be measured");
    return;
  }

  const user = await ctx.register();
  const socket = ctx.socket(user.token);
  await socket.wait((m) => m.op === "welcome", "welcome");
  socket.send({ op: "bot", era: "1986", side: "blue" });
  const opened = await socket.wait((m) => m.op === "room" && m.room && m.room.mode === "bot", "bot room");
  eq(opened.room.clock, "held", "a fresh 1986 match opens with the clock held");

  // The formula's own numbers, computed on a fresh copy of the same era table (a synthetic match
  // is fine HERE because it is asking the wartime formula a wartime question).
  const sites = matchSites("1986", board);
  const detroitSites = matchSites("1986", board);
  if (!detroitSites.find((site) => site.name === "Detroit")) fail("the 1986 extract has no Detroit record");
  const detroitPool = poolReadiness(
    { era: "1986", round: 0, sites: detroitSites, sides: { blue: { bought: 0 } } },
    "blue",
    detroitSites.find((site) => site.name === "Detroit"),
    "infantry",
  );
  eq(detroitPool.rounds, 5, "the decoded formula gives Detroit's infantry a 5-round timer");
  eq(detroitPool.sites.length, 11, "Detroit's pool is 11 unique sites");

  // ---- 3a. at peace: the purchase frame carries NO timer, because none was written ------------
  // PB-245b: the 1986 open IS the cold war, and p.31 says producing units does not tire cities
  // during peacetime. So the wire is measured in the state a fresh match actually starts in, and
  // the absence of a timer is asserted as the rule rather than accepted as a missing field.
  eq(Boolean(opened.room.peace && opened.room.peace.active), true,
    "a fresh 1986 match opens at the cold war, so the peacetime production rule is in force");
  socket.send({ op: "placement", kind: "infantry" });
  const peaceMask = await socket.wait((m) => m.op === "placement" && m.kind === "infantry", "placement mask at peace");
  const peaceAt = decodeCell(peaceMask, new Set((opened.room.pieces || []).map((piece) => piece.x + "," + piece.y)), sites);
  if (!peaceAt) fail("the peacetime placement mask offered no free cell on a producing site");
  const peaceFrom = socket.box.length;
  socket.send({ op: "buy", id: "pb163-peace-buy", kind: "infantry", x: peaceAt.x, y: peaceAt.y });
  const peaceBought = await socket.wait(
    (m) => (m.op === "bought" && m.id === "pb163-peace-buy") || m.op === "error",
    "the peacetime purchase", peaceFrom);
  if (peaceBought.op !== "bought") fail("a 1986 Blue seat could not buy infantry at peace: " + JSON.stringify(peaceBought));
  const peaceFrame = await socket.wait(
    (m) => m.op === "room" && m.room && Number(m.room.round) === 0, "the peacetime purchase's room frame", peaceFrom);
  const peaceRecord = (peaceFrame.room.sites || []).find((site) => site.id === peaceAt.site.id);
  if (!peaceRecord) fail("the peacetime purchase's frame has no record for " + peaceAt.site.name);
  eq(Number(peaceRecord.readyRound) || 0, 0,
    "peacetime production writes no timer, so the purchase's frame carries none (" + peaceAt.site.name + ")");
  eq(siteInspectText(peaceRecord, Number(peaceFrame.room.round)),
    peaceAt.site.name + " — " + String(peaceRecord.kind) + ", blue. Ready.",
    "at peace the inspect sentence reads ready, which is the rule rather than a missing field");

  // ---- 3b. war resumed: the purchase frame carries the timer ----------------------------------
  const warFrom = socket.box.length;
  socket.send({ op: "resume_war" });
  const warFrame = await socket.wait(
    (m) => m.op === "room" && m.room && m.room.peace && m.room.peace.active === false, "the war resumed frame", warFrom);
  eq(warFrame.room.peace.active, false, "the acting seat's own frame leaves the cold war");

  const occupied = new Set((warFrame.room.pieces || []).map((piece) => piece.x + "," + piece.y));
  socket.send({ op: "placement", kind: "infantry" });
  const mask = await socket.wait((m) => m.op === "placement" && m.kind === "infantry", "placement mask at war", warFrom);
  const at = decodeCell(mask, occupied, sites);
  if (!at) fail("the placement mask offered no free cell on a producing site (city/base/capital); " +
    "a dock or ship cell has no production timer to measure");
  const boughtSite = at.site;
  // `poolReadiness` compares the build site to the table BY IDENTITY before it appends it a second
  // time, so the site handed in must be the very object in `match.sites` - pass a copy and the
  // home is listed twice as two distinct entries and the timer comes out different (measured 22
  // for the same city from the same round). Build the expected value the way the server does: one
  // table, the site from it.
  const expectedTable = matchSites("1986", board);
  const expected = poolReadiness(
    { era: "1986", round: 0, sites: expectedTable, sides: { blue: { bought: 0 } } },
    "blue",
    expectedTable.find((site) => site.id === boughtSite.id),
    "infantry",
  );
  if (!(expected.rounds > 0)) fail("the formula gave " + boughtSite.name + " a zero timer at war; the wire would prove nothing");

  const from = socket.box.length;
  socket.send({ op: "buy", id: "pb163-buy", kind: "infantry", x: at.x, y: at.y });
  const bought = await socket.wait((m) => (m.op === "bought" && m.id === "pb163-buy") || (m.op === "error"), "the first purchase", from);
  if (bought.op !== "bought") fail("a 1986 Blue seat could not buy infantry: " + JSON.stringify(bought));

  // The frame the purchase itself produced (round 0 is a whole-frame round, so this is a room
  // frame, not a delta) must name the site's timer: no sync, no waiting for a round.
  const frame = await socket.wait((m) => m.op === "room" && m.room && Number(m.room.round) === 0, "the purchase's room frame", from);
  const record = (frame.room.sites || []).find((site) => site.id === boughtSite.id);
  if (!record) fail("the purchase's frame has no record for " + boughtSite.name);
  eq(Number(record.readyRound), expected.round, "the purchase's own frame carries " + boughtSite.name + "'s timer");
  eq(record.readyRound > Number(frame.room.round), true, "the timer is still in the future at round " + frame.room.round);

  // And the sentence the click path reads from exactly that record is the unready one, so the
  // inspect click after a buy tells the truth instead of "Ready".
  eq(siteInspectText(record, Number(frame.room.round)),
    boughtSite.name + " — " + String(record.kind) + ", blue. Unready — ready at round " + expected.round +
      " (" + expected.round + " rounds).",
    "the inspection sentence reads the timer out of the purchase's own frame");

  socket.close();
  console.log("pb163_inspect: sentence, click path and the purchase frame's timer all bound in both states (peace: none written; war: readyRound on the wire)");
}