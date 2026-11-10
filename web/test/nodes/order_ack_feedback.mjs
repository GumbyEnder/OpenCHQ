// F2: an order with no answer is not "sent". A network cut shorter than the ping interval leaves
// the socket open, so nothing says the order is still outstanding: the player sees neither a buy
// nor a refusal. The page now watches each order id and, when no ack arrives inside the wait,
// says the order is queued. This holds the ack back on purpose and asserts the line appears;
// settling in time must stay silent.
export const name = "order_ack_feedback";

import { ACK_WAIT_MS, createOrderWatch, queuedText } from "../../public/orderwatch.mjs";

export async function run(ctx) {
  const { fail } = ctx;

  // The shipped wait is about two seconds, not a number a page could keep to itself.
  if (!(ACK_WAIT_MS >= 1000 && ACK_WAIT_MS <= 3000)) {
    fail("the ack wait is " + ACK_WAIT_MS + "ms, expected about 2 s");
  }

  const late = [];
  const watch = createOrderWatch({ waitMs: 40, onLate: (order) => late.push(order) });
  const buy = { op: "buy", id: "held-1", kind: "submarine", x: 86, y: 61 };
  watch.watch(buy);

  // A no-ack order: the deadline passes with no settle call, and the page reports it.
  await new Promise((resolve) => setTimeout(resolve, 120));
  if (late.length !== 1) fail("a held-back ack produced " + late.length + " late reports, expected 1");
  if (late[0].id !== "held-1") fail("the late report is for " + late[0].id + ", not held-1");
  if (watch.has("held-1")) fail("the order is still being watched after it was reported");
  const line = queuedText(late[0].kind);
  if (!/queued/i.test(line)) fail("the queued line does not say queued: " + line);
  if (!/submarine/.test(line)) fail("the queued line does not name the order: " + line);

  // An acknowledged order: settled before the deadline, so nothing is said.
  const acked = { op: "order", id: "acked-1", kind: "infantry" };
  watch.watch(acked);
  if (!watch.settle("acked-1")) fail("settling a watched order reported no timer");
  await new Promise((resolve) => setTimeout(resolve, 120));
  if (late.length !== 1) fail("an acknowledged order still produced a late report: " + JSON.stringify(late));
  if (watch.pending().length !== 0) fail("orders left watched: " + JSON.stringify(watch.pending()));

  // The queue is real: a second order reported on its own deadline, not on the first one's.
  const other = { op: "buy", id: "held-2", kind: "cruiser" };
  watch.watch(other);
  await new Promise((resolve) => setTimeout(resolve, 120));
  if (late.length !== 2 || late[1].id !== "held-2") {
    fail("the second held order was not reported on its own deadline: " + JSON.stringify(late));
  }
  watch.clear();

  console.log("order_ack_feedback: no ack in time says queued; an ack in time says nothing");
}
