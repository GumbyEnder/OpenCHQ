// pb308_layout_copy — a layout sandbox must not offer War as the way out (PB-307's wire refusal
// made "This is a layout, not a war. Save the setup or leave it." the truth; the page copy lagged).
//
// What breaks if this is removed:
//   - the War panel in a layout paints "Begin Hostilities"        -> a press the wire refuses
//     ("resume_war" is refused in a layout, PB-307);
//   - it paints "Run the clock"/"Hold the clock"                  -> setClock refuses a layout
//     ("Layout mode is a pregame setup. The clock does not run...");
//   - it paints the 1986 cold-war row and the Peacetime paragraph -> a layout has no war, so it
//     has no peace either, and the paragraph advertises an Intel Scan the sandbox refuses;
//   - the War nav hint says "the clock, and the way out"          -> names a clock that never runs
//     and a war as the exit;
//   - the lobby's Resume Saved War button is reachable in a layout -> the page offers a second way
//     out the server does not have (measured unreachable: the lobby is display:none in a match and
//     the slot panels close on the room-id change).
//
// Pure module arms over dialogs.mjs, plus a source-shape reachability arm for the lobby site.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NAV, navFor, navHint, warControls } from "../../public/dialogs.mjs";

export const name = "pb308_layout_copy";

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "public");
const LAYOUT_HINT = "Who holds which side in this layout.";

function layoutRoom() {
  // The frame a layout room actually sends at b8a3582: mode layout, held clock, round 0, and a
  // 1986 match object whose cold war is `active` with the counter elapsed (measured on the page).
  return {
    mode: "layout",
    clock: "held",
    round: 0,
    peace: { active: true, since: 0, untilRound: 0, remaining: 0, canResume: true, coldWar: true },
  };
}

function warRoom(active) {
  return {
    mode: "bot",
    clock: "running",
    round: 3,
    peace: { active, since: 0, untilRound: 4, remaining: 1, canResume: true, coldWar: true },
  };
}

export async function run({ fail }) {
  // ---- a. the layout offers neither the clock nor the war --------------------------------
  const layout = layoutRoom();
  const lay = warControls(layout, true);
  if (lay.clock !== false) fail("pb308 (a): the War panel still offers the clock in a layout: " + JSON.stringify(lay));
  if (lay.begin !== false) fail("pb308 (a): the War panel still offers Begin Hostilities in a layout: " + JSON.stringify(lay));
  if (lay.peace !== false) fail("pb308 (a): the War panel still paints the peace copy in a layout: " + JSON.stringify(lay));

  // The same room with no peace object must not become an offer by accident.
  const bare = warControls({ mode: "layout", clock: "held", round: 0 }, true);
  if (bare.clock !== false || bare.begin !== false || bare.peace !== false) {
    fail("pb308 (a): a layout without a peace object still offers war controls: " + JSON.stringify(bare));
  }

  // ---- b. a real war keeps every control ------------------------------------------------
  const war = warControls(warRoom(true), false);
  if (war.clock !== true) fail("pb308 (b): a live war lost the clock button: " + JSON.stringify(war));
  if (war.begin !== true) fail("pb308 (b): a war in an elapsed peace lost Begin Hostilities: " + JSON.stringify(war));
  if (war.peace !== true) fail("pb308 (b): a war in an elapsed peace lost the peace copy: " + JSON.stringify(war));

  // ---- c. a war with no peace keeps the clock and offers no Begin ------------------------
  const held = warControls(warRoom(false), false);
  if (held.clock !== true) fail("pb308 (c): a war without a peace lost the clock button: " + JSON.stringify(held));
  if (held.begin !== false || held.peace !== false) {
    fail("pb308 (c): a war without a peace still offers Begin Hostilities: " + JSON.stringify(held));
  }

  // ---- d. the War hint in a layout names neither the clock nor a way out ----------------
  const warNav = navFor("war");
  const hint = navHint(warNav, true);
  if (hint !== LAYOUT_HINT) fail("pb308 (d): the layout War hint is not the layout readout: " + JSON.stringify(hint));
  if (/way out|hostilit|resume|the clock/i.test(hint)) {
    fail("pb308 (d): the layout War hint still offers war: " + JSON.stringify(hint));
  }
  if (/(blue|red):[a-z]/.test(hint)) fail("pb308 (d): the layout War hint carries a raw piece id: " + JSON.stringify(hint));
  if (navHint(warNav, false) !== warNav.hint) {
    fail("pb308 (d): a real war's War hint changed: " + JSON.stringify(navHint(warNav, false)));
  }
  if (navHint(null, true) !== "") fail("pb308 (d): navHint(null) is not empty");
  // The other panels' hints are untouched in a layout.
  for (const item of NAV) {
    if (item.id !== "war" && navHint(item, true) !== item.hint) {
      fail("pb308 (d): " + item.id + "'s hint changed in a layout: " + JSON.stringify(navHint(item, true)));
    }
  }

  // ---- e. reachability: the lobby's Resume Saved War is not offered in a layout ---------
  const css = readFileSync(path.join(publicDir, "app.css"), "utf8");
  if (!/body\.in-match #lobby\s*\{\s*display:\s*none;\s*\}/.test(css)) {
    fail("pb308 (e): the lobby is no longer hidden in a match, so Resume Saved War may be reachable in a layout");
  }
  const html = readFileSync(path.join(publicDir, "index.html"), "utf8");
  const lobbyAt = html.indexOf('<section class="panel lobby" id="lobby">');
  const resumeAt = html.indexOf('id="resumeWarBtn"');
  const matchAt = html.indexOf('class="panel match" id="matchPanel"');
  if (lobbyAt < 0 || resumeAt < 0 || matchAt < 0 || !(lobbyAt < resumeAt && resumeAt < matchAt)) {
    fail("pb308 (e): #resumeWarBtn is no longer inside the lobby section: " + JSON.stringify({ lobbyAt, resumeAt, matchAt }));
  }
  const app = readFileSync(path.join(publicDir, "app.js"), "utf8");
  const bindings = app.match(/addEventListener\("click", openSlotsPanel\)/g) || [];
  const bindingLine = app.split("\n").find((line) => line.includes('addEventListener("click", openSlotsPanel)')) || "";
  if (bindings.length !== 1 || !bindingLine.includes("resumeWarBtn")) {
    fail("pb308 (e): openSlotsPanel has a second door: " + JSON.stringify({ bindings: bindings.length, bindingLine: bindingLine.trim() }));
  }
  if (!/function syncSlotPanels\(\)[\s\S]{0,900}?closeSlotsPanel\(\);/.test(app)) {
    fail("pb308 (e): syncSlotPanels no longer closes the slots panel on a room change");
  }
}
