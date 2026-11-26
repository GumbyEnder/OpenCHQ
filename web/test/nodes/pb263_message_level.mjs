// PB-263: the Message Level control (Manual p.32 "Message Level", p.19 "The Message Bar").
//
// "Level three warns of all threats to friendly cities, and of enemy units spotted; level two warns
// of threats only; level one warns of only 'serious' threats; level zero gives no warning messages."
//
// This pins the four things the card asks for where they can be pinned without a browser:
//   1. the filter, on fixed log lines, at each level - and that it NEVER hides a non-warning line;
//   2. the cycle 3 -> 2 -> 1 -> 0 -> 3 and the default 3;
//   3. the server's tags: a capital alarm is "serious", a city approach is "threat", an enemy under
//      a friendly piece's eye is "spotted";
//   4. the page and the CSS actually carry the control and the filtered paint.
//
// "Serious" is PORT DECISION, UNVERIFIED: the manual names the level but not the word, and the RE
// recovered the "message level" string and the warning sentences, not the comparison
// (docs/re/SYSTEMS.md §21). This port calls a capital threat, or an enemy on/next to a friendly
// city, serious.
import { matchSites } from "../../server/board.mjs";
import { openMatch } from "../../server/match.mjs";
import { logLines } from "../../server/log.mjs";
import { tickMatch } from "../../server/tick.mjs";
import { appendLog, emptyLog, paintedLines } from "../../public/logview.mjs";
import {
  DEFAULT_MESSAGE_LEVEL,
  MESSAGE_LEVELS,
  filterLogLines,
  messageLevelReadout,
  nextMessageLevel,
  normalizeMessageLevel,
  showsLineAt,
} from "../../public/messagelevel.mjs";

export const name = "pb263_message_level";

function unit(id, side, x, y) {
  return { id, side, domain: "land", kind: "tank", x, y, path: [], strength: 100, shots: 0 };
}

export async function run(ctx) {
  const { fail, base } = ctx;
  const expect = (condition, message) => {
    if (!condition) fail("pb263: " + message);
  };

  // ---- 1. the filter, per level, on fixed lines ------------------------------------------------
  // The fixed set is one of each kind the log can emit: three warnings and three lines that are news
  // the seat earned. Only the warnings may ever be hidden.
  const fixed = [
    { round: 5, text: "enemy troops 3 cells from Paris", tag: "serious" },
    { round: 5, text: "enemy troops 6 cells from Tobruk", tag: "threat" },
    { round: 5, text: "an enemy is in sight 2 cells east of Tobruk", tag: "spotted" },
    { round: 5, text: "paid 0.4b from 3 cities" },
    { round: 5, text: "took Tobruk" },
    { round: 5, text: "your tank landed 2 hits on an enemy tank for 1.5 (37 left)" },
  ];
  const texts = (level) => filterLogLines(fixed, level).map((line) => line.text);
  const counts = { 3: texts(3).length, 2: texts(2).length, 1: texts(1).length, 0: texts(0).length };
  expect(counts[3] === 6, "level 3 paints every line, got " + counts[3]);
  expect(counts[2] === 5, "level 2 should hide the sighting only, got " + counts[2]);
  expect(counts[1] === 4, "level 1 should keep only the serious warning and the news, got " + counts[1]);
  expect(counts[0] === 3, "level 0 should keep the news and hide every warning, got " + counts[0]);
  expect(!texts(2).some((text) => /in sight/.test(text)), "a spotted line survived level 2");
  expect(texts(1).some((text) => /Paris/.test(text)), "the serious warning was hidden at level 1");
  expect(!texts(1).includes("enemy troops 6 cells from Tobruk"), "a plain threat survived level 1");
  expect(
    filterLogLines(fixed, 1).every((line) => !line.tag || line.tag === "serious"),
    "level 1 painted a warning that is not serious"
  );
  for (const news of ["paid", "took Tobruk", "landed 2 hits"]) {
    for (const level of MESSAGE_LEVELS) {
      expect(texts(level).some((text) => text.includes(news)), "level " + level + " hid a non-warning line: " + news);
    }
  }
  expect(showsLineAt(0, "spotted") === false && showsLineAt(3, "spotted") === true, "spotted is not level 3 only");

  // ---- 2. the cycle and the default ------------------------------------------------------------
  const cycle = [];
  let level = DEFAULT_MESSAGE_LEVEL;
  for (let i = 0; i < 5; i++) {
    cycle.push(level);
    level = nextMessageLevel(level);
  }
  expect(cycle.join(",") === "3,2,1,0,3", "the cycle reads " + cycle.join(","));
  expect(DEFAULT_MESSAGE_LEVEL === 3, "the default level is " + DEFAULT_MESSAGE_LEVEL + ", not 3");
  expect(normalizeMessageLevel(null) === 3, "a missing stored level did not fall back to 3");
  expect(normalizeMessageLevel("") === 3, "an empty stored level did not fall back to 3");
  expect(normalizeMessageLevel("2") === 2, "a stored level of '2' did not read as 2");
  expect(normalizeMessageLevel(9) === 3, "an out-of-range level did not fall back to 3");
  // PB-263b: the readout is the compact "M2" (PM 9677(a)); the tooltip still carries the full name.
  expect(messageLevelReadout(2) === "M2", "the readout reads " + messageLevelReadout(2));

  // The panel keeps every line and filters only at paint: raising the level re-shows history.
  const buffer = emptyLog();
  appendLog(buffer, fixed);
  expect(paintedLines(buffer, 3).length === 6, "level 3 paints " + paintedLines(buffer, 3).length + " of 6");
  expect(paintedLines(buffer, 0).length === 3, "level 0 paints " + paintedLines(buffer, 0).length + " of 3");
  expect(paintedLines(buffer, 3).length === 6, "the buffer lost lines when the level dropped");
  expect(paintedLines(buffer, 3)[2].tag === "spotted", "the tag did not survive the buffer");

  // ---- 3. the server's tags --------------------------------------------------------------------
  // A capital alarm is serious; a threat to a plain city is a threat, and becomes serious when the
  // enemy is next to it; a sighting is spotted.
  const sites = matchSites("1942");
  const capitalIds = new Set(((openMatch("1942", sites).capitalSet || {}).list || []).map((row) => String(row.siteId)));
  const city = sites.find((site) => site.kind === "city" && site.owner === "blue" && !capitalIds.has(String(site.id)));
  expect(Boolean(city), "the 1942 board has no blue city outside the capital set to threaten");
  const match = openMatch("1942", sites);
  match.clock = "running";
  match.pieces = [unit("red:tank", "red", (city.x + 3) % 320, city.y)];
  const far = tickMatch(match);
  const farLine = (far.events || []).find((event) => event.type === "threat" && String(event.site) === String(city.id));
  expect(Boolean(farLine), "a red tank 3 cells from " + city.name + " raised no city threat");
  expect(farLine.serious === false, "a threat 3 cells out was marked serious");
  expect(farLine.distance === 3, "the city threat distance reads " + farLine.distance);
  const farLog = logLines(match, "blue", far.events, match.round)
    .find((line) => line.text.includes(city.name) && /enemy troops/.test(line.text));
  expect(Boolean(farLog) && farLog.tag === "threat", "the city threat line is not tagged threat: " + JSON.stringify(farLog));

  // The same tank one cell from the city: a closer approach, and now a serious threat.
  match.pieces = [unit("red:tank", "red", (city.x + 1) % 320, city.y)];
  const near = tickMatch(match);
  const nearLine = (near.events || []).find((event) => event.type === "threat" && String(event.site) === String(city.id));
  expect(Boolean(nearLine), "the closer approach to " + city.name + " raised no threat");
  expect(nearLine.serious === true, "a threat one cell from a city was not serious");
  expect(nearLine.distance === 1, "the closer threat distance reads " + nearLine.distance);
  const nearLog = logLines(match, "blue", near.events, match.round)
    .find((line) => line.text.includes(city.name) && /enemy troops/.test(line.text));
  expect(Boolean(nearLog) && nearLog.tag === "serious", "the serious city threat line is not tagged serious");

  // The capital alarm keeps its own tag at any distance: the capitals are the object of the war.
  const capitalWatch = openMatch("1942", sites);
  capitalWatch.clock = "running";
  const blueCapital = capitalWatch.capitals && capitalWatch.capitals.blue;
  expect(Boolean(blueCapital), "the 1942 match has no blue capital");
  capitalWatch.pieces = [unit("red:tank", "red", (blueCapital.x + 5) % 320, blueCapital.y)];
  const alarm = tickMatch(capitalWatch);
  const alarmEvent = (alarm.events || []).find((event) => event.type === "threat" && event.side === "blue" && !event.site);
  expect(Boolean(alarmEvent), "no capital alarm for a red tank five cells from the blue capital");
  expect(alarmEvent.serious === true, "the capital alarm is not marked serious");
  const alarmLog = logLines(capitalWatch, "blue", alarm.events, capitalWatch.round)
    .find((line) => /enemy troops/.test(line.text));
  expect(Boolean(alarmLog) && alarmLog.tag === "serious", "the capital alarm line is not tagged serious");

  // A sighting is spotted, and only at level 3.
  const scout = openMatch("1942", sites);
  scout.clock = "running";
  scout.pieces = [unit("blue:scout", "blue", 40, 40), unit("red:tank", "red", 41, 40)];
  const sight = logLines(scout, "blue", [], 1).find((line) => line.tag === "spotted");
  expect(Boolean(sight), "an enemy one cell from a blue piece produced no spotted line");
  expect(showsLineAt(3, sight.tag) && !showsLineAt(2, sight.tag), "the spotted line is not level-3 only");

  // ---- 4. the page and the CSS carry the control -----------------------------------------------
  const app = await (await fetch(base + "/app.js")).text();
  const css = await (await fetch(base + "/app.css")).text();
  for (const call of [
    'id = "msgLevelBtn"',
    "cycleMessageLevel",
    "nextMessageLevel(messageLevel)",
    "paintedLines(log, messageLevel)",
    "localStorage.setItem(messageLevelStorageKey(",
  ]) {
    expect(app.includes(call), "app.js does not use " + call);
  }
  expect(/\.navbtn\.msgbtn\s*\{[^}]*min-width:/.test(css), "the message-level control has no fixed width slot");

  console.log(
    "pb263_message_level: filter 6/5/4/3 lines at levels 3/2/1/0; cycle " + cycle.join("->") +
      "; capital alarm serious, city approach " + farLine.distance + " = threat then " + nearLine.distance +
      " = serious; sighting spotted (level 3 only)"
  );
}
