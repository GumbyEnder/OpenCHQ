// pb322_log_scope — `transferOp` may not keep its own copy of the seat-log delivery block (PB-322).
//
// What breaks if this is removed: `transferOp` wrote `room.log[mine]` and sent one `op:"log"`, by
// construction, and that copy carries NO clamp — a seat's log can only be trimmed by a round, and a
// peace runs no rounds, so a transfer-heavy peace grew the array without a ceiling. This is the
// second instance of the template PB-316 copied and PB-321 removed from `destinationOp`.
//
// Why body-scoped: `lobby.mjs` still carries four other write sites this ticket does not touch
// (ceasefireAnswerOp, resumeWarOp, chatOp, and the shared helper). A file-wide count would red on
// them; the property is that `transferOp`'s OWN body carries no write and no send at all.
//
// The text half reads one tracked file; it needs no extraction tree, so it must never skip.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..", "..");
const lobbyPath = path.join(root, "web", "server", "lobby.mjs");

export const name = "pb322_log_scope";

function must(ok, why) {
  if (!ok) throw new Error(why);
}

function count(source, pattern) {
  return (source.match(pattern) || []).length;
}

// `function <name>(` at the factory's two-space indent, up to the next declaration at that indent.
// Offsets, not line numbers: the fix moves every line under these declarations.
function bodyOf(source, fn) {
  const decl = new RegExp("^  function " + fn + "\\(", "m").exec(source);
  must(decl, "lobby.mjs no longer declares `function " + fn + "(` at the factory's indent");
  const rest = source.slice(decl.index + decl[0].length);
  const next = /\n  function /.exec(rest);
  must(next, "`function " + fn + "(` is the last two-space declaration in lobby.mjs");
  return rest.slice(0, next.index);
}

export async function run() {
  const file = readFileSync(lobbyPath, "utf8");

  // --- transferOp: no write, no send, no builder call of its own --------------------------------
  const transfer = bodyOf(file, "transferOp");
  const writes = count(transfer, /room\.log\[/g);
  must(writes === 0, "transferOp must not write room.log itself, found " + writes + " site(s)");
  const sends = count(transfer, /op:\s*"log"/g);
  must(sends === 0, "transferOp must not send op:\"log\" itself, found " + sends);
  const builder = count(transfer, /logLines\(/g);
  must(builder === 0, "transferOp must not call logLines itself, found " + builder);
  const delivered = count(transfer, /deliverSeatLog\(room,/g);
  must(
    delivered === 1,
    "transferOp must route its lines through exactly one `deliverSeatLog(room, …)` call, found " +
      delivered + " — the inline mine-only copy is the defect this pin reds"
  );

  // --- the helper keeps the clamp this path was missing -----------------------------------------
  const helper = bodyOf(file, "deliverSeatLog");
  must(
    count(helper, /for \(const side of \["blue",\s*"red"\]\)/g) === 1,
    "deliverSeatLog must carry exactly one both-seat loop"
  );
  must(
    count(helper, /room\.log\[side\]\.push\(\.\.\.lines\)/g) === 1,
    "deliverSeatLog must carry exactly one room.log[side].push(...lines)"
  );
  const clamp = count(helper, /slice\(-240\)/g);
  must(
    clamp === 1,
    "deliverSeatLog must keep exactly one 240-line clamp, found " + clamp +
      " — the clamp is what a transfer gained by routing through the helper"
  );
  // --- the seat-scope owner names a transfer as the mover's own order ---------------------------
  const scopeDecls = count(file, /^  function logSeatsFor\(/gm);
  must(scopeDecls === 1, "lobby.mjs must declare `logSeatsFor` exactly once, found " + scopeDecls);
  const scope = bodyOf(file, "logSeatsFor");
  must(
    /"transfer"/.test(scope),
    "logSeatsFor must treat a `transfer` event as addressed to its own side (PB-322) — a transfer " +
      "that falls through to the both-seat branch hands the mover's private move to the other seat " +
      "the moment log.mjs words an enemy arm for it"
  );
}
