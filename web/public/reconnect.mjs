// The page's reconnect policy, as numbers instead of a setTimeout buried in app.js.
//
// PB-025: after a real 10 s iptables drop the page took 63 s to get its socket back. Two things
// stacked up. The wait grew to 15 s, and — worse — a socket whose SYN went into a black hole never
// settles, so one "try" could block far past the moment the network returned. The page was not
// backing off; it was stuck inside a single attempt.
//
// So the policy has two halves, and both are bounded: an attempt that has not opened in
// CONNECT_TIMEOUT_MS counts as the failure it is, and the wait between attempts never exceeds
// MAX_WAIT_MS. Worst case, the network comes back the instant after an attempt starts: that attempt
// dies at CONNECT_TIMEOUT_MS and the next one starts at most MAX_WAIT_MS later. That sum is what
// PB-025's 15 s budget is measured against, and web/test/nodes/reconnect.mjs asserts it.
//
// The retry count is generous because giving up is the one outcome the player cannot fix without
// reloading: RECONNECT_TRIES tries at this schedule covers minutes of dead wifi.

export const FIRST_WAIT_MS = 500;
export const MAX_WAIT_MS = 4000;
export const CONNECT_TIMEOUT_MS = 6000;
export const RECONNECT_TRIES = 30;

// 0.5, 1, 2, 4, 4, 4 ... A try counts up from 1; anything below 1 is the first wait.
export function backoffMs(tries) {
  const n = Math.max(1, Math.floor(Number(tries) || 1));
  return Math.min(MAX_WAIT_MS, FIRST_WAIT_MS * 2 ** (n - 1));
}

// The schedule the page will follow, in ms, one entry per attempt.
export function schedule(count = RECONNECT_TRIES) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  return Array.from({ length: n }, (_, i) => backoffMs(i + 1));
}

// The longest a healthy network can sit unused after it comes back: one dead attempt plus one wait.
export function worstCaseRecoveryMs() {
  return CONNECT_TIMEOUT_MS + MAX_WAIT_MS;
}

// How long the page keeps trying before it tells the player to reload: every attempt can also burn
// its full connect timeout, so this is the conservative (longest) reading of the schedule.
export function giveUpAfterMs(count = RECONNECT_TRIES) {
  const waits = schedule(count);
  return waits.reduce((sum, wait) => sum + wait + CONNECT_TIMEOUT_MS, 0);
}
