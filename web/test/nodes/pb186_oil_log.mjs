// PB-186: the capture log names an oil field as an oil field, never by the extract's row id.
//
// The playtest that filed this (cap_live_d4144a9, 03:35 ET) moved a blue infantry onto 189,48 and
// read "took site_72". The site is the extract's row 72: name "site_72", kind "facility", subtype 5 -
// the original's oil field (sitetype.mjs: type 5 = the 20 facility sites). Type-5 sites have no
// name at all, so the line has to invent a truthful one; "site_72" is an internal id wearing a
// name's clothes, the same defect PB-123 rejected for coordinates.
//
// The arm drives the real producer: occupy() emits the capture event, logLines() renders it for
// each seat. No fixture of the event shape means a change in what occupy emits cannot pass here
// while the player still reads a row id.

import { logLines, placeOf } from "../../server/log.mjs";
import { occupy } from "../../server/economy.mjs";

export const name = "pb186_oil_log";

function must(ok, why) {
  if (!ok) throw new Error(why);
}

function piece(side, kind, x, y) {
  return {
    id: side + ":" + kind + ":1", side, domain: "land", kind, x, y, path: [], pace: 1,
    facing: null, fighting: null, shots: 0, strength: 100, maxStrength: 100, pinned: false,
  };
}

// A board with only the sites this card needs: the field the playtest took, and one named city to
// hang the place clause on. openMatch is not used because the board is the test's fixture, and the
// caller of occupy() only needs sites + pieces + a side's seat.
function board(sites, pieces) {
  const seats = {};
  for (const site of sites) if (site.owner === "blue" || site.owner === "red") seats[site.owner] = { cash: 0 };
  return { era: "1986", round: 3, sites, pieces, seats: { blue: { cash: 0 }, red: { cash: 0 }, ...seats } };
}

function linesOf(match, side, events) {
  return logLines(match, side, events, match.round).map((line) => line.text);
}

export async function run() {
  // A fresh copy per board: occupy() mutates site.owner, so one shared object would make the second
  // arm start with the field already blue and produce no event at all.
  const fieldOf = () => ({ id: 72, name: "site_72", x: 189, y: 48, kind: "facility", type: 5, owner: "red", country_id: 37 });
  const field = fieldOf();
  // N1 (PM 9723 §1): the landmark is a REAL row, not an invented one. Baku is the baked board's
  // Russian well (id "russia_baku", x 192, y 52, kind "oilfield", era_min 1918), and it is the
  // nearest usable name to site 72 at 1986 - the same row the live arm resolved ("took the oil
  // field 4 cells north-west of Baku", frodo 9724 on ee3b72a).
  const city = { id: "russia_baku", name: "Baku", x: 192, y: 52, kind: "oilfield", region: "Azerbaijan" };
  // A second placeholder row next to the field. It must not become the landmark: the fix would
  // otherwise move the id from the capture line into "1 cell east of site_64".
  const neighbour = { id: 64, name: "site_64", x: 188, y: 48, kind: "facility", type: 5, owner: "blue", country_id: 37 };

  const match = board([field, city, neighbour], [piece("blue", "infantry", 189, 48)]);
  const events = occupy(match);
  const capture = events.find((event) => event.type === "capture" && event.site === 72);
  must(capture, "occupy() must emit the capture at the type-5 site: " + JSON.stringify(events));
  must(capture.name === "site_72" && capture.kind === "facility",
    "precondition: the extract's row is the placeholder-named facility: " + JSON.stringify(capture));

  const mine = linesOf(match, "blue", events);
  const took = mine.find((text) => /^took /.test(text));
  must(took, "the blue seat must read its own capture: " + JSON.stringify(mine));
  must(/oil field/.test(took), "the line must say oil field: " + took);
  must(!/site_/.test(took), "the line must not carry the extract's row id: " + took);
  must(!/facility/.test(took), "the line must not read as a bare facility: " + took);
  must(took === "took the oil field 4 cells north-west of Baku",
    "the line must name the field and the nearest city: " + took);

  const theirs = linesOf(match, "red", events);
  const lost = theirs.find((text) => /oil field/.test(text));
  must(lost, "the red seat must read the loss: " + JSON.stringify(theirs));
  must(!/site_/.test(lost), "the loser's line must not carry the row id either: " + lost);

  // No city on the board: the field is still an oil field, and the line invents no landmark.
  const bare = board([fieldOf()], [piece("blue", "infantry", 189, 48)]);
  const bareEvents = occupy(bare);
  const bareLine = linesOf(bare, "blue", bareEvents).find((text) => /^took /.test(text));
  must(bareLine === "took an oil field", "with no city near it must read 'took an oil field': " + bareLine);

  // A named well keeps its own name (this must not over-reach into every kind). Wells with a
  // world.json row are not occupiable, so their capture event comes from the oil tool's own
  // emitter (economy.captureWell) - the shape is the same {site, name, kind}.
  const named = { id: "texas_permian", name: "Permian Basin", x: 60, y: 60, kind: "oilfield", owner: "red" };
  const namedMatch = board([named], []);
  const namedLine = linesOf(namedMatch, "blue", [
    { type: "capture", site: "texas_permian", name: "Permian Basin", kind: "oilfield", side: "blue", from: "red" },
  ]).find((text) => /^took /.test(text));
  must(/^took Permian Basin/.test(String(namedLine)), "a named site keeps its name: " + namedLine);

  // The landmark filter is shared, so a placeholder row is never a place: the sighting predicate
  // still resolves against the named city, and the id stays out of the locative phrase too.
  const far = { id: 70, name: "site_70", x: 200, y: 60, kind: "facility", type: 5, owner: "red", country_id: 37 };
  const sightMatch = board([city, far], []);
  const place = placeOf(sightMatch, { x: 199, y: 60 }, "blue");
  must(place === "8 cells south-east of Baku", "the place must resolve to the named row: " + place);
  must(!/site_/.test(String(place)), "the place must not name a row id: " + place);
}
