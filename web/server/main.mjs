import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closeSession, login, openSession, register, userForToken } from "./db.mjs";
import { boardPayload } from "./board.mjs";
import { createLobby } from "./lobby.mjs";
import { acceptWebSocket } from "./ws.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, "..", "public");
const port = Number(process.env.PORT || process.env.OPENCHQ_WEB_PORT || 8094);
const host = process.env.OPENCHQ_WEB_HOST || "127.0.0.1";
const lobby = createLobby();

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

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

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/api/health") {
    send(res, 200, { ok: true });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/me") {
    const user = userForToken(tokenFrom(req));
    send(res, 200, { user });
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
    const result = url.pathname === "/api/register"
      ? register(body.username, body.password)
      : login(body.username, body.password);
    if (result.error) {
      send(res, 400, { error: result.error });
      return;
    }
    const token = openSession(result.user.id);
    send(res, 200, { user: result.user }, { "set-cookie": cookie(req, token, 60 * 60 * 24 * 14) });
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
      if (result && result.error) peer.send({ op: "error", error: result.error });
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
