// #4289: the room dump that diagnoses a stall is also a way to hand the server's whole match
// state to anyone who asks. So the endpoint exists only behind OPENCHQ_DEBUG, and with the flag
// absent it is a plain 404 -- the same answer an unknown path gets, so a public host does not
// even advertise that the route is there.
//
// This node pins both halves of that gate:
//   1. the harness server (no OPENCHQ_DEBUG) answers 404 with "debug is off" -- the default;
//   2. a server started with OPENCHQ_DEBUG=1 answers 404 with "no such room" for an id that is
//      not in its table, and 200-shaped JSON only for a room it actually holds. The second
//      phrase is the proof the flag was read: without it the handler never looks at the id.
//
// It does not open a match: the payload shape belongs to lobby.debugRoom, and the point here is
// the gate, not the dump. Read the dump contract from lobby.mjs if that changes.
export const name = "debug_room";

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

function startServer(port, dataDir, extraEnv) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      OPENCHQ_WEB_HOST: "127.0.0.1",
      OPENCHQ_WEB_PORT: String(port),
      OPENCHQ_WEB_DATA: dataDir,
      ...extraEnv,
    };
    if (!extraEnv.OPENCHQ_DEBUG) delete env.OPENCHQ_DEBUG;
    const child = spawn(process.execPath, ["web/server/main.mjs"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("server did not start: " + log));
    }, 5000);
    child.stdout.on("data", (chunk) => {
      log += chunk.toString();
      if (log.includes("OpenCHQ web shell")) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.stderr.on("data", (chunk) => { log += chunk.toString(); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error("server exited " + code + ": " + log));
    });
  });
}

export async function run(ctx) {
  const { base, fail } = ctx;

  if (String(process.env.OPENCHQ_DEBUG || "") === "1") {
    fail("the suite is running with OPENCHQ_DEBUG=1; the default-off leg cannot be measured");
  }

  const off = await fetch(base + "/api/debug/room?id=whatever");
  const offBody = await off.json().catch(() => ({}));
  if (off.status !== 404) fail("debug room answered " + off.status + " with the flag absent");
  if (!/debug is off/.test(String(offBody.error || ""))) fail("default 404 does not say the debug route is off: " + JSON.stringify(offBody));

  const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-debug-"));
  let child = null;
  try {
    const port = await freePort();
    child = await startServer(port, dataDir, { OPENCHQ_DEBUG: "1" });
    const onBase = "http://127.0.0.1:" + port;
    const unknown = await fetch(onBase + "/api/debug/room?id=no-such-room");
    const unknownBody = await unknown.json().catch(() => ({}));
    if (unknown.status !== 404) fail("enabled debug route answered " + unknown.status + " for an unknown room");
    if (String(unknownBody.error || "") !== "no such room") {
      fail("enabled debug route did not reach the lookup: " + JSON.stringify(unknownBody));
    }
  } finally {
    if (child) child.kill("SIGTERM");
    rmSync(dataDir, { recursive: true, force: true });
  }
}
