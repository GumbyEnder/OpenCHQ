// Display names. Owner: T-007 Part 1 (privacy).
//
// A handle may be an email address (db.checkUsername allows it, and players sign up with one).
// Everything a player sees about another player goes through this module: the lobby list, the
// seat table, the invite text and every note a room writes about a person. The account row keeps
// the real handle - that is how a session and a seat are found - and it never leaves the server
// in a payload another client receives.
//
// The rule, in one place, so no call site can invent its own:
//   "shane@example.com"  -> "shane"
//   ""                   -> "Player"
// and a name already held by another online player gets a numeric suffix (shane, shane 2), so an
// invite still addresses exactly one account.

const CONTROL = /[\u0000-\u001f\u007f<>]/g;

// The part of a handle before the @, with the punctuation that would read as an email left off.
export function localName(username) {
  const raw = String(username ?? "").trim();
  const at = raw.indexOf("@");
  const head = at >= 0 ? raw.slice(0, at) : raw;
  const clean = head.replace(CONTROL, "").replace(/^[._\-\s]+|[._\-\s]+$/g, "").trim();
  if (!clean) return "Player";
  return clean.slice(0, 40);
}

// True when a value looks like an email address, so a test (and the client's belt-and-braces
// scrub) can ask the same question the server answers.
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

export function looksLikeEmail(value) {
  return EMAIL.test(String(value ?? ""));
}

// A table of account -> display name for one moment in time, de-duplicated.
//
// `reserved` names are display names already handed out to accounts that are still online; a new
// arrival that collides takes the next free suffix. The map is built from a sorted list so two
// runs of the same population produce the same names.
export function displayNames(accounts, reserved = new Map()) {
  const out = new Map();
  const taken = new Set([...reserved.values()].map((name) => String(name).toLowerCase()));
  const sorted = [...new Set([...accounts].map((account) => String(account ?? "")))].sort();
  for (const account of sorted) {
    const base = localName(account);
    let name = base;
    let n = 2;
    while (taken.has(name.toLowerCase())) {
      name = base + " " + n;
      n += 1;
      if (n > 99) break;
    }
    taken.add(name.toLowerCase());
    out.set(account, name);
  }
  return out;
}
