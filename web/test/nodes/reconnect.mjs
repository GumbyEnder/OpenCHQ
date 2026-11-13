// reconnect — the page's reconnect policy, checked as numbers and as a simulation (T-012, PB-025).
//
// What breaks if this is removed: PB-025 measured 63 s to get the socket back after a real 10 s
// iptables drop (`reconnectedAfterMs: 63004`, live 5a602f9). Two halves of the policy caused it —
// the wait climbed to 15 s, and a socket whose SYN was dropped never fired an event, so the page sat
// inside a single failed attempt while the network was already back. This node pins both halves:
//   - the schedule is 0.5, 1, 2, then 4 s and never higher;
//   - one attempt may hang at most CONNECT_TIMEOUT_MS, so the worst-case recovery after the network
//     returns is CONNECT_TIMEOUT_MS + MAX_WAIT_MS, which must fit PB-025's 15 s budget;
//   - the page does not give up inside a minute of dead network;
//   - a simulated 10 s outage (every attempt during the outage burns its full connect timeout)
//     reopens the socket well inside 15 s of the restore;
//   - app.js actually uses that policy: no home-grown 15 s backoff, and a watchdog on the attempt.

import { readFileSync } from "node:fs";

import {
  CONNECT_TIMEOUT_MS,
  FIRST_WAIT_MS,
  MAX_WAIT_MS,
  RECONNECT_TRIES,
  backoffMs,
  giveUpAfterMs,
  schedule,
  worstCaseRecoveryMs,
} from "../../public/reconnect.mjs";

export const name = "reconnect";

const BUDGET_MS = 15000; // PB-025: back within 15 s of the network coming back.

export async function run(ctx) {
  const { fail } = ctx;

  // ---- the schedule ---------------------------------------------------------
  const waits = schedule();
  if (waits.length !== RECONNECT_TRIES) fail("schedule length " + waits.length + " != RECONNECT_TRIES " + RECONNECT_TRIES);
  if (waits[0] !== FIRST_WAIT_MS) fail("first wait is " + waits[0] + ", expected " + FIRST_WAIT_MS);
  for (let i = 1; i < waits.length; i++) {
    if (waits[i] < waits[i - 1]) fail("schedule is not monotone at " + i + ": " + waits.join(","));
    if (waits[i] > MAX_WAIT_MS) fail("wait " + waits[i] + " exceeds the " + MAX_WAIT_MS + " cap");
  }
  if (waits.slice(0, 4).join(",") !== "500,1000,2000,4000") fail("first four waits are " + waits.slice(0, 4).join(","));
  if (backoffMs(99) !== MAX_WAIT_MS) fail("a late try waits " + backoffMs(99) + ", expected the cap");
  if (backoffMs(0) !== FIRST_WAIT_MS) fail("try 0 waits " + backoffMs(0) + ", expected the first wait");

  // ---- the two bounds PB-025 is about ---------------------------------------
  const worst = worstCaseRecoveryMs();
  if (worst > BUDGET_MS) fail("worst-case recovery " + worst + " ms exceeds the " + BUDGET_MS + " ms budget");
  const patience = giveUpAfterMs();
  if (patience < 60000) fail("the page gives up after " + patience + " ms, inside a minute of outage");

  // ---- a simulated 10 s drop ------------------------------------------------
  // The page's own loop, on a fake clock: close at t=0, network back at t=DROP_MS. An attempt made
  // while the network is down hangs for its full connect timeout and fails; an attempt made after
  // the restore opens. The page then reconnects on the first attempt that starts after the restore,
  // so the measurement includes the attempt that was already in flight.
  const DROP_MS = 10000;
  const OPEN_MS = 60;
  const sim = (dropMs) => {
    let t = 0;
    let tries = 0;
    const attempts = [];
    for (;;) {
      tries += 1;
      const startedAt = t;
      const opens = startedAt >= dropMs;
      const spent = opens ? OPEN_MS : CONNECT_TIMEOUT_MS;
      t += spent;
      attempts.push({ tries, startedAt, opens, endedAt: t });
      if (opens) return { at: t, attempts };
      if (tries >= RECONNECT_TRIES) return { at: null, attempts };
      t += backoffMs(tries);
      if (t > 300000) return { at: null, attempts };
    }
  };
  const { at, attempts } = sim(DROP_MS);
  if (at === null) fail("the simulated drop never reconnected inside " + RECONNECT_TRIES + " tries");
  const reconnectedAfterMs = at - DROP_MS;
  if (reconnectedAfterMs > BUDGET_MS) fail("simulated 10 s drop recovered in " + reconnectedAfterMs + " ms, over the " + BUDGET_MS + " ms budget");
  const hung = attempts.filter((a) => !a.opens).length;
  if (hung < 2) fail("the simulation expected at least two failed attempts inside a 10 s drop, saw " + hung);

  // A drop that starts mid-attempt is the case that produced 63 s: the attempt is already hanging
  // when the network returns, so it must be capped rather than waited on.
  const late = sim(1);
  if (late.at === null) fail("a drop starting mid-attempt never reconnected");
  if (late.at - 1 > BUDGET_MS) fail("a drop starting mid-attempt recovered in " + (late.at - 1) + " ms, over budget");

  // ---- the page uses the policy ---------------------------------------------
  const app = readFileSync(new URL("../../public/app.js", import.meta.url), "utf8");
  if (!/backoffMs\(reconnectTries\)/.test(app)) fail("app.js does not drive its wait from backoffMs(reconnectTries)");
  if (/Math\.min\(15000, 500 \* 2/.test(app)) fail("app.js still carries the old 15 s home-grown backoff");
  if (!/CONNECT_TIMEOUT_MS\)/.test(app)) fail("app.js has no connect watchdog at CONNECT_TIMEOUT_MS");
  if (!/clearTimeout\(connectTimer\)/.test(app)) fail("app.js never clears the connect watchdog (an opened socket would still be closed later)");
  if (!/TAKEOVER_CODE/.test(app)) fail("app.js lost the takeover stand-down: two tabs would trade the socket again");

  // The numbers the report quotes, so the schedule is read from the code and not from a comment.
  console.log("  schedule: " + waits.join(", ") + " ms; worst case " + worst + " ms; patience " + patience + " ms");
  console.log("  simulated 10 s drop: reconnected " + reconnectedAfterMs + " ms after the restore, after " + attempts.length + " attempts");
}
