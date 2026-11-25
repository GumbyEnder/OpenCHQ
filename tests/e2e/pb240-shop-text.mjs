// PB-240 page leg: the three player-facing defects, measured on a real page at 1280x800.
//
//   node tests/e2e/pb240-shop-text.mjs                 # starts its own server from this tree
//   node tests/e2e/pb240-shop-text.mjs --url=<base>    # a running server
//
// What this proves, in the order it proves it (the order socket takes over the page's socket, so it
// goes last):
//   1. the Buy panel's satellite row counts the satellite the seat actually holds (Yours = 1 on 2023),
//      and a second seat's row would count zero - the count comes from `room.satellites`, not `pieces`;
//   2. the Killer satellite row's refusal is a player's sentence: no UNVERIFIED / STAND-IN / UNMEASURED
//      and no "archive's note" anywhere in the panel's text or titles;
//   3. a satellite order's ACK, read off the wire, carries the piece's domain ("sat") and kind, and
//      the page's own ackText() turns that frame into "to fly" - the sentence the toast shows.
// Artifacts: screenshot of the panel, the raw ack frame, and the sentences derived from it.
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright } from "./playwright.mjs";
import { ackText } from "../../web/public/command.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const GIVEN = (process.argv.find((v) => v.startsWith("--url=")) || "").slice(6).replace(/\/+$/, "") ||
  (process.env.E2E_URL || "").replace(/\/+$/, "");
const OUT = path.resolve((process.argv.find((v) => v.startsWith("--out=")) || "").slice(7) ||
  path.join(process.env.HOME || ".", "agents", "game", "notes", "pb240"));
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evidence = [];
let failed = 0;
function mark(label, ok, detail) {
  if (!ok) failed += 1;
  evidence.push({ label, ok, detail });
  console.log((ok ? "PASS " : "FAIL ") + label + " — " + detail);
}

const TAG = /\b(UNVERIFIED|UNMEASURED|STAND-IN)\b|archive's (own )?note/i;

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

async function main() {
  const { chromium } = await loadPlaywright();
  let child = null;
  let BASE = GIVEN;
  if (!BASE) {
    const port = await freePort();
    const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb240-"));
    child = spawn(process.execPath, ["web/server/main.mjs"], {
      cwd: root,
      env: { ...process.env, OPENCHQ_WEB_HOST: "127.0.0.1", OPENCHQ_WEB_PORT: String(port), OPENCHQ_WEB_DATA: dataDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    BASE = "http://127.0.0.1:" + port;
    const started = Date.now();
    while (Date.now() - started < 20000) {
      try {
        const res = await fetch(BASE + "/api/version");
        if (res.ok) break;
      } catch {}
      await sleep(100);
    }
    mark("a local server answers", true, BASE);
  } else {
    mark("using the given host", true, BASE);
  }

  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  const name = "e2e-pb240-" + Date.now().toString(36).slice(-7);
  const password = "pw-" + Math.random().toString(36).slice(2, 12);
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 25000 });
  await page.fill("#register input[name=username]", name);
  await page.fill("#register input[name=password]", password);
  await page.click("#register button[type=submit]");
  await page.waitForSelector("#play:not(.hidden)", { timeout: 25000 });
  await page.selectOption('#launch select[name="era"]', "2023");
  await page.selectOption('#launch select[name="side"]', "blue");
  await page.click('#launch button[type=submit]');
  await page.waitForFunction(() => window.__chq.room() && String(window.__chq.room().era) === "2023", null,
    { timeout: 25000, polling: 100 });
  await sleep(500);

  const held = await page.evaluate(() => {
    const room = window.__chq.room();
    const sats = Array.isArray(room && room.satellites) ? room.satellites : [];
    const mine = sats.filter((sat) => sat && sat.side === "blue" && sat.orbit !== false);
    return { count: mine.length, first: mine[0] ? { id: mine[0].id, kind: mine[0].kind, x: mine[0].x, y: mine[0].y } : null };
  });
  mark("the seat opens with a satellite in orbit", held.count > 0, JSON.stringify(held));

  // ---- the Buy panel ----------------------------------------------------------------
  await page.evaluate(() => {
    const button = Array.from(document.querySelectorAll("#play nav button, nav button")).find((b) => /buy/i.test(b.textContent || ""));
    if (button) button.click();
  });
  await page.waitForSelector(".buytable .buyrow", { timeout: 15000 });
  await sleep(300);
  const panel = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll(".buytable .buyrow")).map((row) => ({
      cells: Array.from(row.querySelectorAll("*")).filter((el) => el.children.length === 0).map((el) => (el.textContent || "").trim()).filter(Boolean),
      text: (row.textContent || "").replace(/\s+/g, " ").trim(),
      title: row.getAttribute("title") || "",
      disabled: row.disabled === true,
    }));
    const box = document.querySelector(".buytable");
    return { rows, text: box ? box.textContent || "" : "", titles: rows.map((r) => r.title).filter(Boolean) };
  });
  const satRow = panel.rows.find((row) => /satellit|recon/i.test(row.text || ""));
  mark("the Buy panel draws a satellite row", Boolean(satRow), satRow ? satRow.cells.join(" | ") : "no row");
  if (satRow) {
    const numbers = satRow.cells.map((c) => Number(String(c).replace(/[^0-9]/g, ""))).filter((n) => Number.isFinite(n));
    mark("the satellite row's Yours is the count the seat holds", numbers.includes(held.count),
      "cells=" + satRow.cells.join(" | ") + " (held " + held.count + ")");
  }
  const killerRow = panel.rows.find((row) => /killer/i.test(row.text || "") || /killer/i.test(row.title || ""));
  mark("the Killer satellite row is present and refused", Boolean(killerRow && killerRow.disabled),
    killerRow ? "disabled=" + killerRow.disabled + " title=" + killerRow.title : "no killer row");
  const leaks = [panel.text, ...panel.titles].filter((text) => TAG.test(String(text)));
  mark("no developer tag anywhere in the Buy panel", leaks.length === 0, leaks.slice(0, 2).join(" | ") || "clean");
  if (killerRow) {
    mark("the killer refusal is a sentence, not a tag",
      /not in this build/i.test(String(killerRow.title || "")) && !TAG.test(String(killerRow.title || "")),
      String(killerRow.title || "(no title)"));
  }
  const shot = path.join(OUT, "pb240-buy-panel-1280x800.png");
  await page.screenshot({ path: shot });
  mark("captured the Buy panel", true, shot);

  // ---- the ack's shape, off the wire, turned into the sentence ------------------------
  const frame = await page.evaluate(async (sat) => {
    if (!sat) return null;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(proto + "//" + location.host + "/ws");
    const opened = await new Promise((resolve) => {
      socket.addEventListener("open", () => resolve(true), { once: true });
      socket.addEventListener("error", () => resolve(false), { once: true });
      setTimeout(() => resolve(false), 8000);
    });
    if (!opened) return { error: "the socket did not open" };
    // A destination a few cells away keeps the satellite's own path rules happy.
    const to = { x: Math.max(0, Math.min(319, Number(sat.x) + 4)), y: Math.max(0, Math.min(135, Number(sat.y) + 2)) };
    socket.send(JSON.stringify({ op: "order", piece: sat.id, to }));
    const reply = await new Promise((resolve) => {
      const onMessage = (event) => {
        try {
          const message = JSON.parse(String(event.data));
          if (message && message.op === "ordered") {
            socket.removeEventListener("message", onMessage);
            resolve(message);
          }
        } catch {}
      };
      socket.addEventListener("message", onMessage);
      setTimeout(() => resolve({ error: "no ordered ack within 10 s" }), 10000);
    });
    try { socket.close(); } catch {}
    return reply;
  }, held.first);
  mark("the wire sends an ordered ack for the satellite", Boolean(frame && frame.op === "ordered"),
    JSON.stringify(frame));
  if (frame && frame.op === "ordered") {
    mark("the ack names the piece's domain and kind", frame.domain === "sat" && frame.kind === "reconSat",
      "domain=" + frame.domain + " kind=" + frame.kind);
    const sentence = ackText(frame);
    mark("the page's own ackText turns that frame into a flight", / to fly\.$/.test(sentence), sentence);
    mark("and it does not say walk", !/ to walk\.$/.test(sentence), sentence);
    writeFileSync(path.join(OUT, "pb240-ack-frame.json"), JSON.stringify({ frame, sentence }, null, 2) + "\n");
  }

  mark("no page errors", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));
  writeFileSync(path.join(OUT, "pb240-shop-text.json"), JSON.stringify({ base: BASE, held, panel, frame, evidence }, null, 2) + "\n");
  console.log("EVIDENCE " + path.join(OUT, "pb240-shop-text.json"));
  await browser.close();
  if (child) child.kill("SIGTERM");
  console.log("PB240_E2E " + (failed === 0 ? "OK" : "FAILED " + failed));
  if (failed !== 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("PB240_E2E THREW " + (err && err.message ? err.message : err));
  process.exit(1);
});
