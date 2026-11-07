import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const root = process.env.OPENCHQ_WEB_DATA || path.join(homedir(), ".local", "share", "openchq");
mkdirSync(root, { recursive: true });

export const dataRoot = root;
export const db = new DatabaseSync(path.join(root, "openchq.sqlite"));
// One writer, many readers. WAL keeps a login from blocking a lobby read, and the busy
// timeout turns a rare lock into a short wait instead of an error. The volume is a local
// mount on the host, so WAL is safe here (it is not safe on a network share).
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 5000;
  PRAGMA foreign_keys = ON;
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL,
    username_key TEXT UNIQUE NOT NULL,
    pass_salt TEXT NOT NULL,
    pass_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT
  );
`);

// A session that never expires is a password that never has to be typed again. Rows written
// before this column existed get stamped on first read.
try {
  const cols = db.prepare("PRAGMA table_info(sessions)").all().map((col) => col.name);
  if (!cols.includes("expires_at")) db.exec("ALTER TABLE sessions ADD COLUMN expires_at TEXT");
} catch {
  // A read-only or missing table is not a reason to refuse to boot; userForToken copes.
}

const SESSION_DAYS = 30;
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;

// A handle may be a plain name or an email-shaped one, because that is how players will sign
// up. It must still start with a letter, so a handle can never look like a number or a route.
const NAME = /^[A-Za-z][A-Za-z0-9_.@-]{2,39}$/;

export function checkUsername(username) {
  const name = String(username ?? "").trim();
  if (!NAME.test(name)) {
    return { error: "Use 3 to 40 letters, numbers, dots, dashes, @ or _, starting with a letter." };
  }
  // Reject handles that only pass the character class: no double dots, no trailing punctuation.
  if (name.includes("..") || /[.@_-]$/.test(name) || name.includes("@.")) {
    return { error: "That handle has a stray dot, dash or @ at the wrong place." };
  }
  return { name, key: name.toLowerCase() };
}

export function register(username, password) {
  const checked = checkUsername(username);
  if (checked.error) return { error: checked.error };
  if (String(password ?? "").length < 8) return { error: "Use at least 8 characters." };
  const taken = db.prepare("SELECT id FROM users WHERE username_key = ?").get(checked.key);
  if (taken) return { error: "That name is taken." };
  const salt = randomBytes(16);
  const hash = scryptSync(String(password), salt, 32);
  const created = new Date().toISOString();
  db.prepare(
    "INSERT INTO users (username, username_key, pass_salt, pass_hash, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(checked.name, checked.key, salt.toString("hex"), hash.toString("hex"), created);
  const row = db.prepare("SELECT id, username FROM users WHERE username_key = ?").get(checked.key);
  return { user: { id: row.id, username: row.username } };
}

export function login(username, password) {
  const key = String(username ?? "").trim().toLowerCase();
  const row = db.prepare("SELECT id, username, pass_salt, pass_hash FROM users WHERE username_key = ?").get(key);
  if (!row) return { error: "Those credentials did not match." };
  const got = scryptSync(String(password ?? ""), Buffer.from(row.pass_salt, "hex"), 32);
  const expect = Buffer.from(row.pass_hash, "hex");
  if (got.length !== expect.length || !timingSafeEqual(got, expect)) {
    return { error: "Those credentials did not match." };
  }
  return { user: { id: row.id, username: row.username } };
}

export function openSession(userId) {
  const token = randomBytes(24).toString("hex");
  const at = Date.now();
  db.prepare("INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(
    token,
    userId,
    new Date(at).toISOString(),
    new Date(at + SESSION_MS).toISOString()
  );
  return token;
}

// Sessions nobody has used in a month are not worth the row, and a row that is past its date is
// not a session.
export function pruneSessions(at = Date.now()) {
  const iso = new Date(at).toISOString();
  const gone = db.prepare("DELETE FROM sessions WHERE expires_at IS NOT NULL AND expires_at < ?").run(iso);
  return Number(gone.changes || 0);
}

export function userForToken(token) {
  if (!token) return null;
  const row = db.prepare(
    `SELECT sessions.expires_at AS expires_at, sessions.created_at AS created_at,
            users.id AS id, users.username AS username
     FROM sessions JOIN users ON users.id = sessions.user_id
     WHERE sessions.token = ?`
  ).get(token);
  if (!row) return null;
  // A session with no date predates the column: stamp it from its creation instead of logging
  // an existing player out for no reason.
  if (!row.expires_at) {
    const born = Date.parse(row.created_at) || Date.now();
    db.prepare("UPDATE sessions SET expires_at = ? WHERE token = ?").run(
      new Date(born + SESSION_MS).toISOString(),
      token
    );
  } else if (Date.parse(row.expires_at) < Date.now()) {
    db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    return null;
  }
  return { id: row.id, username: row.username };
}

// Changing a password ends every other session: if someone else had the old one, they lose it.
export function changePassword(username, current, next, keepToken) {
  const key = String(username ?? "").trim().toLowerCase();
  const row = db.prepare("SELECT id, pass_salt, pass_hash FROM users WHERE username_key = ?").get(key);
  if (!row) return { error: "Those credentials did not match." };
  const got = scryptSync(String(current ?? ""), Buffer.from(row.pass_salt, "hex"), 32);
  const expect = Buffer.from(row.pass_hash, "hex");
  if (got.length !== expect.length || !timingSafeEqual(got, expect)) {
    return { error: "That is not the current password." };
  }
  if (String(next ?? "").length < 8) return { error: "Use at least 8 characters." };
  if (String(next) === String(current)) return { error: "That is the same password." };
  const salt = randomBytes(16);
  const hash = scryptSync(String(next), salt, 32);
  db.prepare("UPDATE users SET pass_salt = ?, pass_hash = ? WHERE id = ?").run(
    salt.toString("hex"),
    hash.toString("hex"),
    row.id
  );
  const ended = db.prepare("DELETE FROM sessions WHERE user_id = ? AND token <> ?").run(row.id, String(keepToken ?? ""));
  return { ok: true, ended: Number(ended.changes || 0) };
}

export function closeSession(token) {
  if (!token) return;
  db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}
