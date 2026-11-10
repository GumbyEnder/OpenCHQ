// An order is only "sent" once the server answers it. A silent network cut shorter than the
// ping interval leaves the socket open and TCP retransmits, so the page used to wait in
// silence: the buy landed on the server, and the player saw nothing either way. This watches
// each order id for its ack/bought/reject and reports the ones that go unanswered for longer
// than a person would wait. It is a timer table, not a connection check, so it also covers a
// socket that is open but wedged behind a proxy.

export const ACK_WAIT_MS = 2000;

// What the player reads when the answer does not come. The order is still in the queue (the
// page resends it on reconnect and the server applies one id at most once), so the sentence
// says both things: it is kept, and it is not confirmed yet.
export function queuedText(kind) {
  const what = String(kind || "order");
  return "No answer yet for your " + what + ". It is queued and will be applied when the server answers.";
}

// watch(order, onLate) with settle(id). Timers are injected so a test can run the deadline
// without waiting for it.
export function createOrderWatch({
  waitMs = ACK_WAIT_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onLate = () => {},
} = {}) {
  const open = new Map();
  return {
    watch(order) {
      const id = order && order.id;
      if (id === undefined || id === null) return;
      if (open.has(id)) return;
      const timer = setTimer(() => {
        open.delete(id);
        onLate(order);
      }, waitMs);
      open.set(id, timer);
    },
    settle(id) {
      const timer = open.get(id);
      if (timer === undefined) return false;
      clearTimer(timer);
      open.delete(id);
      return true;
    },
    has(id) {
      return open.has(id);
    },
    pending() {
      return [...open.keys()];
    },
    clear() {
      for (const timer of open.values()) clearTimer(timer);
      open.clear();
    },
  };
}
