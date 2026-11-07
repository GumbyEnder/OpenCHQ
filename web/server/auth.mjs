// Login limits. Owner: account_ops node.
//
// An open login route is a password-guessing machine, so a caller that keeps failing is told to
// wait. The window is small on purpose: it stops a script, it does not punish a player who
// mistyped twice. Counters live in memory — a restart forgets them, which is the right trade for
// a rate limit that exists to slow an attacker, not to be an audit log.

const ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_MS = 5 * 60 * 1000;

let failures = new Map();

function nowMs() {
  return Date.now();
}

// Key on the caller and the name they are trying, so one noisy IP cannot lock out a stranger
// and a single name cannot be ground down from many addresses.
export function attemptKey(address, username) {
  return String(address || "unknown") + "|" + String(username || "").trim().toLowerCase();
}

export function blocked(key, at = nowMs()) {
  const entry = failures.get(key);
  if (!entry) return { blocked: false, retryAfter: 0 };
  if (entry.until && entry.until > at) {
    return { blocked: true, retryAfter: Math.ceil((entry.until - at) / 1000) };
  }
  if (entry.count >= ATTEMPTS && !entry.until) {
    entry.until = at + LOCKOUT_MS;
    return { blocked: true, retryAfter: Math.ceil(LOCKOUT_MS / 1000) };
  }
  // A window that has gone quiet starts again from nothing.
  if (at - entry.first > WINDOW_MS) {
    failures.delete(key);
  }
  return { blocked: false, retryAfter: 0 };
}

export function noteFailure(key, at = nowMs()) {
  const entry = failures.get(key);
  if (!entry || at - entry.first > WINDOW_MS) {
    failures.set(key, { first: at, count: 1, until: 0 });
    return { count: 1 };
  }
  entry.count += 1;
  if (entry.count >= ATTEMPTS) entry.until = at + LOCKOUT_MS;
  return { count: entry.count };
}

export function noteSuccess(key) {
  failures.delete(key);
}

// Only used by tests and by a process that wants a clean slate.
export function forgetAll() {
  failures = new Map();
}

export { ATTEMPTS, WINDOW_MS, LOCKOUT_MS };
