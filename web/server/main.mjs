import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { changePassword, closeSession, login, openSession, pruneSessions, register, userForToken } from "./db.mjs";
import { attemptKey, blocked, noteFailure, noteSuccess } from "./auth.mjs";
import { boardPayload, fontPayload } from "./board.mjs";
import { handicapSpec, roundSeconds, startPool } from "./rules.mjs";
import { createLobby } from "./lobby.mjs";
import { acceptWebSocket } from "./ws.mjs";
import { localName } from "./names.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, "..", "public");
const port = Number(process.env.PORT || process.env.OPENCHQ_WEB_PORT || 8094);
const host = process.env.OPENCHQ_WEB_HOST || "127.0.0.1";
const lobby = createLobby();

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
};

// The caller's address, for the login limit. A proxy header is only trusted when the socket came
// from loopback or a private address, which is the case behind Railway's edge.
function addressOf(req) {
  const raw = String(req.socket && req.socket.remoteAddress || "");
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const local = /^(127\.|::1$|::ffff:127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(raw);
  return (local && forwarded) || raw || "unknown";
}

function tokenFrom(req) {
  const header = String(req.headers.cookie ?? "");
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === "openchq_session") return rest.join("=");
  }
  return "";
}

function send(res, status, body, extra = {}) {
  const raw = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": raw.length,
    "cache-control": "no-store",
    ...extra,
  });
  res.end(raw);
}

function isSecure(req) {
  const flag = process.env.OPENCHQ_SECURE_COOKIE;
  if (flag === "1") return true;
  if (flag === "0") return false;
  const proto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim();
  return proto === "https";
}

function cookie(req, token, maxAge) {
  const secure = isSecure(req) ? "; Secure" : "";
  return `openchq_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 4096) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new Error("bad json"));
      }
    });
    req.on("error", reject);
  });
}

async function serveFile(res, urlPath) {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const full = path.resolve(publicDir, rel);
  if (full !== publicDir && !full.startsWith(publicDir + path.sep)) {
    res.writeHead(403);
    res.end();
    return;
  }
  try {
    const data = await readFile(full);
    res.writeHead(200, {
      "content-type": types[path.extname(full)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

// The commit the page is actually running. Railway's builder does not always keep .git, so
// tools/fire.sh writes web/data/build.json before upload; git is the fallback on a dev machine
// and OPENCHQ_COMMIT lets a host name the build explicitly.
let versionCache = null;
function versionInfo() {
  if (versionCache) return versionCache;
  let commit = String(process.env.OPENCHQ_COMMIT || "").trim();
  let source = commit ? "env" : "";
  if (!commit) {
    const buildFile = path.resolve(publicDir, "..", "data", "build.json");
    if (existsSync(buildFile)) {
      try {
        const baked = JSON.parse(readFileSync(buildFile, "utf8"));
        commit = String(baked.commit || "").trim();
        source = commit ? "build.json" : "";
      } catch {
        /* a corrupt build stamp is not a reason to fail a page load */
      }
    }
  }
  if (!commit) {
    const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: publicDir, encoding: "utf8" });
    if (git.status === 0) {
      commit = String(git.stdout || "").trim();
      source = commit ? "git" : "";
    }
  }
  versionCache = {
    commit: commit || "unknown",
    short: commit ? commit.slice(0, 7) : "unknown",
    source: source || "none",
  };
  return versionCache;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/api/health") {
    send(res, 200, { ok: true });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/version") {
    send(res, 200, versionInfo());
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/me") {
    const user = userForToken(tokenFrom(req));
    // The page shows a display name, never the handle it signed in with: a handle may be an email
    // address (T-007 AC1). The account row keeps the real one.
    const shown = user ? { id: user.id, username: localName(user.username) } : null;
    // A returning page keeps its session; refresh the cookie's clock so a long-lived tab does
    // not fall off the end of Max-Age mid-match. The value never changes.
    const extra = user ? { "set-cookie": cookie(req, tokenFrom(req), 60 * 60 * 24 * 14) } : {};
    send(res, 200, { user: shown }, extra);
    return;
  }
  // The font atlas is the original's art, so it follows the board's rule: served where the
  // extract exists, source "missing" where it does not.
  if (req.method === "GET" && url.pathname === "/api/fonts") {
    try {
      send(res, 200, fontPayload());
    } catch (err) {
      send(res, 500, { error: String(err && err.message ? err.message : err) });
    }
    return;
  }
  // The setup numbers the lobby needs and the report quotes: each era's opening pool and the
  // opponent's starting-money spinner (Manual p.17). Served rather than typed into the page, so
  // the lobby default, the test and the server's own validation read one source.
  if (req.method === "GET" && url.pathname === "/api/setup") {
    const spec = handicapSpec();
    const eras = ["1918", "1942", "1986", "2023", "9999"];
    const pool = {};
    for (const era of eras) pool[era] = startPool(era);
    send(res, 200, {
      eras,
      startPool: pool,
      handicap: { unit: spec.unit, min: spec.min, max: spec.max, step: spec.step, defaults: spec.defaults },
      note: "Handicap is the OPPONENT'S starting money (Manual p.17); 2023 has no spinner.",
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/board") {
    try {
      send(res, 200, boardPayload());
    } catch (err) {
      send(res, 500, { error: String(err && err.message ? err.message : err) });
    }
    return;
  }
  if (req.method === "POST" && (url.pathname === "/api/register" || url.pathname === "/api/login")) {
    let body;
    try {
      body = await readBody(req);
    } catch {
      send(res, 400, { error: "Send a JSON body." });
      return;
    }
    // An open login route is a password-guessing machine. A caller that keeps failing is told to
    // wait, keyed on the address and the name so neither one noisy address nor one name is enough.
    const key = attemptKey(addressOf(req), body.username);
    const gate = blocked(key);
    if (gate.blocked) {
      send(res, 429, { error: "Too many attempts. Try again in " + gate.retryAfter + " s." });
      return;
    }
    const result = url.pathname === "/api/register"
      ? register(body.username, body.password)
      : login(body.username, body.password);
    if (result.error) {
      noteFailure(key);
      send(res, 400, { error: result.error });
      return;
    }
    noteSuccess(key);
    const token = openSession(result.user.id);
    send(res, 200, { user: result.user }, { "set-cookie": cookie(req, token, 60 * 60 * 24 * 14) });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/password") {
    const token = tokenFrom(req);
    const user = userForToken(token);
    if (!user) {
      send(res, 401, { error: "Sign in first." });
      return;
    }
    let body;
    try {
      body = await readBody(req);
    } catch {
      send(res, 400, { error: "Send a JSON body." });
      return;
    }
    const changed = changePassword(user.username, body.current, body.next, token);
    if (changed.error) {
      send(res, 400, { error: changed.error });
      return;
    }
    // Every other session is gone; the one that asked keeps working.
    send(res, 200, { ok: true, ended: changed.ended });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/logout") {
    closeSession(tokenFrom(req));
    send(res, 200, { ok: true }, { "set-cookie": cookie(req, "", 0) });
    return;
  }
  if (req.method === "GET") {
    await serveFile(res, url.pathname);
    return;
  }
  send(res, 404, { error: "Not found" });
});

server.on("upgrade", (req, socket) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (url.pathname !== "/ws") {
    socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    return;
  }
  const user = userForToken(tokenFrom(req));
  if (!user) {
    socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    return;
  }
  acceptWebSocket(req, socket, (peer) => {
    lobby.join(user.username, peer);
    peer.ontext = (text) => {
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        peer.send({ op: "error", error: "Send JSON." });
        return;
      }
      const result = lobby.handle(user.username, message);
      if (result && result.error) {
        peer.send({ op: "error", id: message.id ?? null, error: result.error });
      } else if (result && Array.isArray(result.events) && result.events.length) {
        // A tool that changes the board but says nothing is a decision with no feedback: the
        // player pressed a button and has to guess what happened.
        peer.send({ op: "ack", events: result.events });
      }
    };
  });
});

server.on("error", (err) => {
  console.error(err.message);
  process.exit(1);
});

server.listen(port, host, () => {
  console.log(`OpenCHQ web shell http://${host}:${port}`);
});

// The one clock. Each room carries its own speed (T-004, Manual p.34-35): the ticker beats at a
// fixed base interval and lobby.tickRooms(now) advances only the rooms whose own round length has
// elapsed. A room at speed 0 is never advanced, and its orders still land.
// Expired sessions are not worth the row. One sweep at boot, one an hour.
pruneSessions();
setInterval(() => {
  try {
    pruneSessions();
  } catch (err) {
    console.error("session prune failed:", err && err.message ? err.message : err);
  }
}, 60 * 60 * 1000).unref();

// The base beat has to divide the shortest round length so a fast room is not visibly late. At the
// shipped speeds the shortest round is 0.6 s; 50 ms gives it twelve chances a round.
const beat = 50;
const ticker = setInterval(() => {
  try {
    lobby.tickRooms(Date.now());
  } catch (err) {
    console.error("tick failed:", err && err.message ? err.message : err);
  }
}, beat);
ticker.unref();
console.log(`round length ${roundSeconds()} s at speed 1; base beat ${beat} ms; speeds 0-6`);

// A deploy sends SIGTERM and the process used to die mid-round with live sockets. Now it stops
// the clock, tells the seats, writes every room and leaves: the rooms that were running with a
// human in them come back running, because that interruption was ours and not the player's.
let draining = false;
function drain(signal) {
  if (draining) return;
  draining = true;
  clearInterval(ticker);
  try {
    const marked = lobby.beginDrain();
    const told = lobby.broadcast({
      op: "bye",
      reason: "The server is restarting. Your match is saved; this page reconnects by itself.",
    });
    const written = lobby.flushAll();
    console.log(`${signal}: drained ${written} rooms, ${marked.length} will resume, ${told} seats told`);
  } catch (err) {
    console.error("drain failed:", err && err.message ? err.message : err);
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", () => drain("SIGTERM"));
process.on("SIGINT", () => drain("SIGINT"));
