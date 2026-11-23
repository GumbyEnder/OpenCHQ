// PB-169 node: a late-order warning comes down when that order's answer arrives.
//
// The defect: `say()` is a 6 s flash with no way to read or clear it, so "No answer yet for your
// order. It is queued and will be applied when the server answers." sat on screen for the rest of
// its timer even after the ack had landed — the page told the player the order was unanswered while
// it was answering.
//
// What is measured here, on a fake clock, with the shipped modules:
//   1. the sentence a late order writes is remembered against that order's id;
//   2. settling a DIFFERENT order clears nothing, and the older warning stays up;
//   3. settling the order that wrote it returns that exact sentence, so the caller can clear it;
//   4. flash.clear() takes the line down and cancels its timer, and flash.text() reads what is on
//      screen — the pair the comparison needs.
export const name = "pb169_late_order_line";

import { createFlashLine } from "../../public/flash.mjs";
import { createLateOrders, queuedText } from "../../public/orderwatch.mjs";

function eq(label, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(label + ": got " + JSON.stringify(actual) + ", wanted " + JSON.stringify(expected));
  }
}

// A fake clock: one list of timers the test fires by hand.
function fakeClock() {
  let next = 1;
  const timers = new Map();
  return {
    setTimer(fn, delay) {
      timers.set(next, { fn, delay });
      return next++;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    fire() {
      const entries = [...timers.entries()];
      timers.clear();
      for (const [, timer] of entries) timer.fn();
    },
    count: () => timers.size,
  };
}

export async function run() {
  // ---- the sentence and its owner ------------------------------------------------------------
  const late = createLateOrders();
  const mission = { op: "mission", kind: "mission", id: "o-1" };
  eq("a late mission names itself", late.note(mission), queuedText("mission"));
  if (!/your mission/.test(queuedText("mission"))) throw new Error("the sentence does not say which order: " + queuedText("mission"));
  eq("one order is remembered", late.size(), 1);
  eq("an unrelated order clears nothing", late.settle("o-2"), "");
  eq("the warning is still on the books", late.size(), 1);
  eq("the order that wrote it returns the same sentence", late.settle("o-1"), queuedText("mission"));
  eq("and is forgotten", late.size(), 0);
  eq("a second settle returns nothing", late.settle("o-1"), "");
  eq("an order with no id writes nothing", late.note({ op: "buy" }), "");

  // ---- the flash line: read it back, clear only what matches ----------------------------------
  const clock = fakeClock();
  const element = { textContent: "" };
  const flash = createFlashLine({ element, ms: 6000, setTimer: clock.setTimer, clearTimer: clock.clearTimer });

  const warning = late.note({ op: "order", kind: "infantry", id: "o-3" });
  flash.say(warning);
  eq("the line on screen is the warning", flash.text(), warning);
  // A newer, unrelated flash replaces it: settling the old order must not blank THIS one.
  flash.say("Order sent. 1 round to walk.");
  if (flash.text() === warning) throw new Error("the newer flash did not replace the warning");
  const stale = late.settle("o-3");
  if (flash.text() === stale) throw new Error("a stale warning cleared a newer line");
  eq("the newer line survives the stale settle", flash.text(), "Order sent. 1 round to walk.");

  // The real sequence: the warning is up, the ack for THAT order arrives, the line comes down.
  // A fresh tracker, because the stale settle above deliberately consumed o-3.
  const lateB = createLateOrders();
  const warningB = lateB.note({ op: "order", kind: "infantry", id: "o-3" });
  flash.say(warningB);
  const line = lateB.settle("o-3");
  if (flash.text() !== line) throw new Error("the line on screen is not the one the order wrote");
  flash.clear();
  eq("clear takes the line down", flash.text(), "");
  eq("clear cancels the timer", clock.count(), 0);
  if (flash.pending()) throw new Error("a cleared line is still pending");

  // And a line that already timed out clears nothing, because text() no longer matches.
  const clock2 = fakeClock();
  const element2 = { textContent: "" };
  const flash2 = createFlashLine({ element: element2, ms: 6000, setTimer: clock2.setTimer, clearTimer: clock2.clearTimer });
  const late2 = createLateOrders();
  flash2.say(late2.note({ op: "order", kind: "tank", id: "o-4" }));
  clock2.fire();
  eq("the warning timed out on its own", flash2.text(), "");
  const lineAfterTimeout = late2.settle("o-4");
  if (lineAfterTimeout && flash2.text() === lineAfterTimeout) throw new Error("a timed-out warning was 'cleared' again");

  console.log("pb169_late_order_line: the late warning is owned by its order id and comes down on that order's answer");
}
