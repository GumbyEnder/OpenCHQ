// pb199_endgame — the end of a match is a state both seats can still read after a reload.
//
// The defect (PB-199, re-measured on live 235a77a, game row 10363): after a resignation the match
// is over server-side, but the SENTENCE is a note, and the reconnect path overwrites it. The socket
// close runs holdRoom(room, "<user> disconnected. The match is paused and still yours.") and the
// rejoin's seatView() replaces it with "Both seats are present. The clock is still held.", so a
// reloaded end screen says the clock is held instead of naming the result. Nothing could name who
// resigned either: the result carried `reason` and `winner` and no author.
//
// What this pins, per PM 10369 §1:
//   (a) result.reason === "resignation" carries the resigning side (`by`), the room note is that
//       sentence, and neither a disconnect nor the rejoin rewrites it;
//   (b) resignOp writes ONE log line, present on the seat that resigned AND after a reload;
//   (c) the server refuses a clock change on an over match with "The match is already over.", and
//       the clock stays held (a ▶ click is a `run`; it must not move the clock).
// (d) and the client-side disable/confirm arms are graded by the page leg tests/e2e/pb199-endgame.mjs.
import { resultOf, resultNote } from "../../server/view.mjs";

export const name = "pb199_endgame";

const BOT_START = { op: "bot", era: "1942", side: "blue" };

function opened(ws, label) {
  return new Promise((resolve, reject) => {
    if (ws.readyState === 1) return resolve();
    const timer = setTimeout(() => reject(new Error(label + " did not open")), 3000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(label + " failed to connect"));
    }, { once: true });
  });
}

export async function run(ctx) {
  const { fail } = ctx;
  const account = await ctx.register();
  const me = account.user.username;

  const first = ctx.socket(account.token);
  await opened(first.ws, "first socket");
  first.send(BOT_START);
  const started = await first.wait(
    (m) => m.op === "room" && m.room && m.room.mode === "bot",
    "a bot match opens"
  );
  if (started.room.over) fail("the fresh match is already over");

  // ---- (a) the resignation names who resigned ------------------------------------------------
  const from = first.box.length;
  first.send({ op: "resign" });
  const overFrame = await first.wait(
    (m) => m.op === "room" && m.room && m.room.over === true,
    "the resignation's over frame",
    from
  );
  const over = overFrame.room;
  const result = over.result || {};
  if (result.reason !== "resignation") fail("the result's reason reads " + JSON.stringify(result.reason));
  if (result.by !== "blue") fail("the result does not name the resigning side: " + JSON.stringify(result));
  if (result.winner !== "red") fail("the result's winner reads " + JSON.stringify(result.winner));
  if (over.you !== "blue") fail("the seat's own side reads " + JSON.stringify(over.you));
  if (over.note !== "Blue resigned. Red wins.") {
    fail("the room note reads " + JSON.stringify(over.note));
  }
  if (over.clock !== "held") fail("the clock is " + JSON.stringify(over.clock) + " after a resignation");

  // ---- (b) one log line, on the seat that resigned -------------------------------------------
  const lines = Array.isArray(over.log) ? over.log : [];
  const endLines = lines.filter((line) => String(line && line.text || "") === "Blue resigned. Red wins.");
  if (endLines.length !== 1) {
    fail("the log carries " + endLines.length + " end lines: " + JSON.stringify(lines.slice(-4)));
  }
  if (Number(endLines[0].round) !== Number(over.round || 0)) {
    fail("the end line's round reads " + JSON.stringify(endLines[0].round) + " against round " + over.round);
  }

  // ---- (c) the server refuses a clock change and the clock stays held -------------------------
  const beforeRun = first.box.length;
  first.send({ op: "run" });
  const refused = await first.wait(
    (m) => m.op === "error" && String(m.error || "").includes("already over"),
    "the clock refusal on an over match",
    beforeRun
  );
  if (refused.error !== "The match is already over.") fail("the refusal reads " + JSON.stringify(refused.error));
  const movedAfterRefusal = first.box
    .slice(beforeRun)
    .some((m) => m.op === "room" && m.room && m.room.clock !== "held");
  if (movedAfterRefusal) fail("a refused run still moved the clock");

  // ---- (a)+(b) again, across a reload --------------------------------------------------------
  // A reload is a socket close (holdRoom) plus a fresh socket (seatView): both used to rewrite the
  // note. Close, then reconnect as the same account.
  first.close();
  await new Promise((resolve) => setTimeout(resolve, 250));
  const second = ctx.socket(account.token);
  await opened(second.ws, "the reload's socket");
  const welcome = await second.wait((m) => m.op === "welcome", "the reload's welcome");
  const back = welcome.room;
  if (!back) fail("the reload came back with no room at all");
  if (back.over !== true) fail("the reloaded room is not over: " + JSON.stringify(back.over));
  if (back.note !== "Blue resigned. Red wins.") {
    fail("the reloaded note reads " + JSON.stringify(back.note));
  }
  const backResult = back.result || {};
  if (backResult.reason !== "resignation" || backResult.by !== "blue" || backResult.winner !== "red") {
    fail("the reloaded result reads " + JSON.stringify(backResult));
  }
  if (back.clock !== "held") fail("the reloaded clock reads " + JSON.stringify(back.clock));
  const backLines = (Array.isArray(back.log) ? back.log : [])
    .filter((line) => String(line && line.text || "") === "Blue resigned. Red wins.");
  if (backLines.length !== 1) {
    fail("the reloaded log carries " + backLines.length + " end lines");
  }

  // The producer itself: one sentence, and a resignation names no capital.
  const bare = {
    over: true,
    winner: "red",
    round: 3,
    winReason: { kind: "resignation", side: "blue", round: 3 },
    capitalSet: { list: [] },
    sites: [],
  };
  const seated = resultOf(bare);
  if (seated.reason !== "resignation" || seated.by !== "blue") {
    fail("resultOf on a resignation reads " + JSON.stringify(seated));
  }
  if (seated.lastCapital !== null) fail("resultOf invented a capital for a resignation");
  if (resultNote(bare) !== "Blue resigned. Red wins.") fail("resultNote reads " + JSON.stringify(resultNote(bare)));
  // A saved match from before `side` existed keeps the sentence it had: no invented author.
  const legacy = { over: true, winner: "red", round: 3, capitalSet: { list: [] }, sites: [] };
  if (resultNote(legacy) !== "Red wins.") fail("the legacy resignation sentence reads " + JSON.stringify(resultNote(legacy)));

  second.send({ op: "leave" });
  second.close();
}
