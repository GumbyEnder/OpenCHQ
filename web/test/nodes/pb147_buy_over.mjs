// PB-147: after the result, the Buy panel still opened and armed placement. Measured on live a82dd22
// (room 7390, from the PB-145 hand-check): a resigned 1986 blue-vs-bot match still listed units with
// prices, and picking Infantry put "Buy infantry: click one of the highlighted cities or bases you
// hold to place it." on screen and a {"op":"placement"} frame on the wire; the click that followed
// was refused by PB-145's guard, so the page offered a purchase it could never make.
//
// This is a page test in the shape this codebase uses for `app.js`: the module owns a DOM at import,
// so what is pinned is the shipped source. Five rows:
//
//   1. AC1 - openDialog() refuses `buy` while room.over, before it can set openDialogId, and the
//      refusal is a bare return (7285: no new refusal sentence).
//   2. AC1 - the over frame closes an already-open Buy panel inside the once-only clear, so a panel
//      that was up when the result landed does not keep offering rows.
//   3. AC1 - the Buy nav control is disabled from room.over in renderRoom and again on every panel
//      repaint, so the control itself cannot open it, and the next match re-enables it because the
//      expression reads room.over rather than a sticky flag.
//   4. AC2 - the buy row's click listener returns on room.over before `buying =` and before the
//      placement request: no arm, no toast, no wire frame.
//   5. AC3 - none of those guards writes text and the over block never reaches #result (PB-137 AC4).
//
// Base control: on the gated tree (dc87735 / ad43e71) openDialog() has no over guard, syncBuyNav()
// does not exist, and the over block calls only clearCommand(): rows 1-3 red there by construction.
// The mutant run in the ticket removes exactly the `&& room.over` arm from openDialog() and re-runs.
export const name = "pb147_buy_over";

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appPath = path.resolve(here, "..", "..", "public", "app.js");
const src = readFileSync(appPath, "utf8");

// A comment that NAMES room.over or closeDialog() must not satisfy a row: PB-145's fix and this one
// both carry those words in prose. Match code only.
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => {
      const at = line.indexOf("//");
      return at >= 0 ? line.slice(0, at) : line;
    })
    .join("\n");
}

function fail(message) {
  throw new Error("node test pb147_buy_over: " + message);
}

// A function body by brace matching, so a later function's text cannot satisfy a row by accident.
function bodyOf(needle) {
  const at = src.indexOf(needle);
  if (at < 0) fail("app.js has no `" + needle + "`");
  const open = src.indexOf("{", at + needle.length - 1);
  if (open < 0) fail("no body for `" + needle + "`");
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return fail("unbalanced body for `" + needle + "`");
}

export function run(ctx) {
  // ---- AC1: openDialog() refuses Buy while the match is over, and says nothing about it.
  const openDialog = stripComments(bodyOf("function openDialog("));
  const buyGuard = /if\s*\(\s*id\s*===\s*"buy"\s*&&\s*room\.over\s*\)\s*return;/.exec(openDialog);
  if (!buyGuard) {
    fail("openDialog() does not refuse `buy` while room.over: the Buy panel still opens after the result (AC1)");
  }
  const opensAt = openDialog.indexOf('type: "open"');
  if (opensAt < 0) fail("openDialog() has no `type: \"open\"` step - the pin cannot place the guard");
  if (!(buyGuard.index < opensAt)) fail("the over guard sits after openDialogId is set, so the panel opens anyway");
  // 7285: the refusal does not widen. The guard is a bare return, not a sentence.
  const lines = openDialog.slice(0, opensAt).split("\n");
  const guardLine = lines.find((line) => /id\s*===\s*"buy"\s*&&\s*room\.over/.test(line)) || "";
  if (!/^\s*if\s*\([^)]*\)\s*return;\s*$/.test(guardLine)) {
    fail("the Buy over guard is not a bare return (7285: the refusal surface does not widen): " + guardLine.trim());
  }

  // ---- AC1: an open panel closes on the over frame, inside the once-only clear.
  const renderRoom = bodyOf("function renderRoom(");
  const overMatch = /if\s*\(\s*room\s*&&\s*room\.over\s*\)\s*\{/.exec(renderRoom);
  if (!overMatch) fail("renderRoom has no `if (room && room.over) {` block");
  const overStart = overMatch.index;
  const overEnd = renderRoom.indexOf("} else {", overStart);
  if (overEnd < 0) fail("the over block has no else arm");
  const overBlock = stripComments(renderRoom.slice(overStart, overEnd));
  if (!/if\s*\(\s*openDialogId\s*===\s*"buy"\s*\)\s*closeDialog\s*\(\s*\)/.test(overBlock)) {
    fail("the over frame does not close an open Buy panel: it keeps listing units the row then refuses (AC1)");
  }
  if (!/overCleared/.test(overBlock)) fail("the Buy close does not sit inside the over-frame clear");

  // ---- AC1/AC4: the control is disabled from room.over, and the next match re-enables it.
  const syncBuyNav = stripComments(bodyOf("function syncBuyNav("));
  if (!/disabled\s*=\s*Boolean\s*\(\s*room\s*&&\s*room\.over\s*\)/.test(syncBuyNav)) {
    fail("syncBuyNav() does not disable the Buy control from room.over (AC1), or uses a sticky flag so a new match cannot restore it (AC4)");
  }
  if (!/\.navbtn\[data-dialog="buy"\]/.test(syncBuyNav)) {
    fail("syncBuyNav() does not select the Buy nav control");
  }
  const renderRoomCode = stripComments(renderRoom);
  if (!/syncBuyNav\s*\(\s*\)\s*;/.test(renderRoomCode)) {
    fail("renderRoom does not call syncBuyNav(), so the control never learns the result arrived");
  }
  const paintDialog = stripComments(bodyOf("function paintDialog("));
  if (!/if\s*\(\s*button\.dataset\.dialog\s*===\s*"buy"\s*\)\s*button\.disabled\s*=\s*Boolean\s*\(\s*room\s*&&\s*room\.over\s*\)/.test(paintDialog)) {
    fail("paintDialog does not carry the same Buy-disabled rule, so a repaint can re-enable it mid-result");
  }

  // ---- AC2: the buy row refuses the arm and the placement request while over.
  const buyPainter = stripComments(bodyOf("buy(body) {"));
  const rowAt = buyPainter.indexOf('line.addEventListener("click"');
  if (rowAt < 0) fail("the buy painter has no row click listener");
  const rowBody = buyPainter.slice(rowAt);
  const rowGuard = /if\s*\(\s*room\s*&&\s*room\.over\s*\)\s*return;/.exec(rowBody);
  if (!rowGuard) {
    fail("the buy row arms placement after the match ends: no `if (room && room.over) return;` (AC2)");
  }
  const armAt = rowBody.indexOf("buying = row.kind");
  const askAt = rowBody.indexOf('op: "placement"');
  if (armAt < 0) fail("the buy row does not set `buying = row.kind`");
  if (askAt < 0) fail("the buy row does not send the placement request");
  if (!(rowGuard.index < armAt)) fail("the over guard sits after the arm, so a finished match still arms placement");
  if (!(rowGuard.index < askAt)) fail("the over guard sits after the placement request, so a finished match still asks the server");
  const guardText = rowBody.slice(rowGuard.index, armAt);
  if (/say\s*\(|\.textContent\s*=|\.innerText\s*=/.test(guardText)) {
    fail("the buy row's over guard writes a refusal sentence (7285: the refusal surface does not widen)");
  }

  // ---- AC3: the over block never reaches the result line (PB-137 AC4).
  if (/getElementById\(\s*["']result["']\s*\)/.test(overBlock) ||
      /resultLine\s*\.\s*(textContent|innerText|innerHTML)\s*=/.test(overBlock) ||
      /\.textContent\s*=/.test(overBlock)) {
    fail("the over block writes element text or reaches #result; #result belongs to flashLine (PB-137 AC4)");
  }

  // ---- AC1 (delta path): the over frame can arrive as a delta, and the close/disable must ride it.
  // frodo (room 7391) named this the PB-145 trap: a seat that only ever sees deltas must have Buy
  // closed and disabled on the same frame the result lands. applyDelta folds delta.over into room.over
  // and then calls renderRoom(), which is what carries the over block and syncBuyNav().
  const applyDelta = stripComments(bodyOf("function applyDelta("));
  const foldAt = applyDelta.indexOf("delta.over === undefined ? room.over : Boolean(delta.over)");
  if (foldAt < 0) fail("applyDelta does not fold delta.over into room.over: a delta-only seat never learns the match ended");
  const renderAt = applyDelta.indexOf("renderRoom()");
  if (renderAt < 0) fail("applyDelta does not call renderRoom(): the over block and syncBuyNav never run on a delta frame");
  if (!(foldAt < renderAt)) fail("applyDelta calls renderRoom() before folding delta.over, so a delta frame renders the old state");

  // Node contract: the runner passes a context; this pin reads no server, so it asserts its own shape.
  if (!ctx || typeof ctx !== "object") fail("no test context");
}
