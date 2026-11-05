import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const root = process.env.OPENCHQ_WEB_DATA || path.join(homedir(), ".local", "share", "openchq");
mkdirSync(root, { recursive: true });

const db = new DatabaseSync(path.join(root, "openchq.sqlite"));
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
    created_at TEXT NOT NULL
  );
`);

const NAME = /^[A-Za-z][A-Za-z0-9_]{2,19}$/;

export function checkUsername(username) {
  const name = String(username ?? "").trim();
  if (!NAME.test(name)) {
    return { error: "Use 3 to 20 letters, numbers, or underscores, starting with a letter." };
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
  db.prepare("INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)").run(
    token,
    userId,
    new Date().toISOString()
  );
  return token;
}

export function userForToken(token) {
  if (!token) return null;
  const row = db.prepare(
    `SELECT users.id AS id, users.username AS username
     FROM sessions JOIN users ON users.id = sessions.user_id
     WHERE sessions.token = ?`
  ).get(token);
  if (!row) return null;
  return { id: row.id, username: row.username };
}

export function closeSession(token) {
  if (!token) return;
  db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}
