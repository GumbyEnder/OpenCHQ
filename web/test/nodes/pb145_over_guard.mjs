// PB-145: the order affordance stayed up after the match ended. Measured on live 5f1c216 (room 7272):
// after a resign the tank stayed selected, the status line still offered "Click to send the order", and
// one click put exactly one {"op":"order"} frame on the wire for the server to refuse (move.mjs:333).
// frodo's blob read (room 7281) showed the build cursor shares that click path, so the wire rule has to
// cover a purchase frame too.
//
// This is a page test in the shape this codebase uses for `app.js`: the module owns a DOM at import, so
// what is pinned is the shipped source plus the one ordering fact that makes the guard real. Three rows:
//
//   1. AC1 - the over frame clears the command state once (renderRoom -> clearCommand), and only on the
//      transition, so the result line's own re-render cannot fight the clear.
//   2. AC2 - clearCommand() writes no element text at all: that is what keeps #result (PB-137 AC4) out
//      of reach of this clear. A `.textContent =` inside it must red this row.
//   3. AC3 - the board click handler's guard names room.over, and it sits BEFORE both wire arms
//      (sendOrder for the order branch, buyMessage for the build cursor), so neither can be reached.
//
// Base control: on the gated tree (0f05240) the guard line reads `if (!room || !room.you) return;` and
// the over path calls only sayResult(room); rows 1 and 3 red there by construction. The mutant run in
// the ticket removes exactly the `|| room.over` arm and re-runs this node.
export const name = "pb145_over_guard";

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appPath = path.resolve(here, "..", "..", "public", "app.js");
const src = readFileSync(appPath, "utf8");

// A comment that NAMES clearCommand() or room.over must not satisfy a row: PB-145's own fix carries
// those words in prose, and a mutant on the code stayed green off its comment. Match code only.
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
  throw new Error("node test pb145_over_guard: " + message);
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
  // ---- AC1: the over path clears the command state, once.
  const renderRoom = bodyOf("function renderRoom(");
  const overMatch = /if\s*\(\s*room\s*&&\s*room\.over\s*\)\s*\{/.exec(renderRoom);
  if (!overMatch) fail("renderRoom has no `if (room && room.over) {` block - the over frame is not distinguished");
  const overStart = overMatch.index;
  const overEnd = renderRoom.indexOf("} else {", overStart);
  if (overEnd < 0) fail("the over block has no `else` arm, so the once-only flag is never reset");
  const overBlock = stripComments(renderRoom.slice(overStart, overEnd));
  if (!/sayResult\s*\(\s*room\s*\)/.test(overBlock)) fail("the over block does not call sayResult(room)");
  if (!/clearCommand\s*\(\s*\)/.test(overBlock)) {
    fail("the over frame does not call clearCommand(): the selection and preview survive the result (AC1)");
  }
  if (!/overCleared/.test(overBlock)) {
    fail("clearCommand() on the over frame is not gated by a transition flag - it would run every frame");
  }
  if (!/overCleared\s*=\s*false/.test(renderRoom.slice(overEnd))) {
    fail("the else arm does not reset overCleared, so a second match would not clear");
  }

  // ---- AC2: clearCommand() is text-free, so #result (PB-137 AC4) cannot be reached by it.
  const clearCommand = stripComments(bodyOf("function clearCommand("));
  if (/\.textContent\s*=/.test(clearCommand) || /\.innerText\s*=/.test(clearCommand) || /#result/.test(clearCommand)) {
    fail("clearCommand() writes element text; the result line (PB-137 AC4) must not be touched by this clear");
  }
  // A comment may name the result line; a WRITE to it may not. This is the DOM form, not the word.
  if (/resultLine\s*\.\s*(textContent|innerText|innerHTML)\s*=/.test(overBlock) ||
      /getElementById\(\s*["']result["']\s*\)/.test(overBlock)) {
    fail("the over block writes the result line directly; #result belongs to flashLine (PB-137 AC4)");
  }

  // ---- AC3: the click guard names room.over and sits before both wire arms.
  const clickBody = stripComments(bodyOf('board.addEventListener("click"'));
  const guard = /if\s*\(\s*!room\s*\|\|\s*!room\.you\s*\|\|\s*room\.over\s*\)\s*return;/.exec(clickBody);
  if (!guard) {
    const seen = /if\s*\(\s*!room\s*\|\|\s*!room\.you[^)]*\)\s*return;/.exec(clickBody);
    fail("the click guard does not refuse `room.over` (found: " + (seen ? seen[0] : "no seat guard") + ")");
  }
  const orderArm = clickBody.indexOf("sendOrder(");
  const buyArm = clickBody.indexOf("buyMessage(");
  if (orderArm < 0) fail("the click body has no sendOrder arm");
  if (buyArm < 0) fail("the click body has no buyMessage arm");
  if (!(guard.index < orderArm)) fail("the over guard sits after the order arm, so a finished match still sends an order");
  if (!(guard.index < buyArm)) fail("the over guard sits after the build cursor arm, so a finished match still sends a purchase");

  // The guard must also be after the pan-slop swallow, or a pan's release click would be counted as an order.
  const slop = clickBody.indexOf("if (suppressClick)");
  if (slop >= 0 && !(slop < guard.index)) fail("the pan-slop swallow sits after the over guard; a pan release would reach the order arm");

  // Node contract: the runner passes a context; this pin reads no server, so it asserts its own shape.
  if (!ctx || typeof ctx !== "object") fail("no test context");
}