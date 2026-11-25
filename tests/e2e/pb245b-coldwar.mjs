// PB-245b page leg: a 1986 open shows the cold war, the enemy is hidden, a transfer works, and
// Begin Hostilities leaves the peace (manual printed p.31-32).
//
//   node tests/e2e/pb245b-coldwar.mjs                 # starts its own server from this tree
//   node tests/e2e/pb245b-coldwar.mjs --url=<base>    # a running server (the LIVE leg once shipped)
//
// Measured from the page's own view (window.__chq) and real clicks at 1280x800:
//   1. the room opens with peace.active, coldWar, and the counter the config gives ({} -> 0);
//   2. the monitor strip prints the counter ("cold war, war may resume" with no forced wait);
//   3. no enemy piece is in the seat's payload (p.31 "invisible");
//   4. one select + a destination click is a TRANSFER, and the server's frame moves the piece in
//      the same round;
//   5. War > Begin Hostilities ends the peace for the seat, and the strip's counter goes away.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright } from "./playwright.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const GIVEN = (process.argv.find((v) => v.startsWith("--url=")) || "").slice(6).replace(/\/+$/, "") ||
  (process.env.E2E_URL || "").replace(/\/+$/, "");
const OUT = path.resolve((process.argv.find((v) => v.startsWith("--out=")) || "").slice(6) ||
  path.join(process.env.HOME || ".", "agents", "game", "notes", "pb245b"));
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evidence = [];
let failed = 0;
function mark(label, ok, detail) {
  if (!ok) failed += 1;
  evidence.push({ label, ok, detail });
  console.log((ok ? "PASS " : "FAIL ") + label + " — " + detail);
}

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
  if (BASE) {
    mark("using the given host", true, BASE);
  } else {
    const port = await freePort();
    const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb245b-"));
    child = spawn(process.execPath, ["web/server/main.mjs"], {
      cwd: root,
      env: { ...process.env, OPENCHQ_WEB_HOST: "127.0.0.1", OPENCHQ_WEB_PORT: String(port), OPENCHQ_WEB_DATA: dataDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    BASE = "http://127.0.0.1:" + port;
    const started = Date.now();
    let log = "";
    while (Date.now() - started < 20000) {
      if (log.includes("OpenCHQ web shell")) break;
      await sleep(100);
      log += child.stdout.read() ? String(child.stdout.read()) : "";
      try {
        const res = await fetch(BASE + "/api/version");
        if (res.ok) break;
      } catch {}
    }
    mark("a local server answers", true, BASE);
  }

  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));
  const name = "e2e-pb245b-" + Date.now().toString(36).slice(-6);
  const password = "pw-" + Math.random().toString(36).slice(2, 12);
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 25000 });
  await page.fill("#register input[name=username]", name);
  await page.fill("#register input[name=password]", password);
  await page.click("#register button[type=submit]");
  await page.waitForSelector("#play:not(.hidden)", { timeout: 25000 });
  await page.selectOption('#launch select[name="era"]', "1986");
  await page.selectOption('#launch select[name="side"]', "blue");
  await page.click('#launch button[type=submit]');
  await page.waitForFunction(() => window.__chq.room() && String(window.__chq.room().era) === "1986", null,
    { timeout: 25000, polling: 100 });
  await sleep(700);

  const open = await page.evaluate(() => {
    const room = window.__chq.room();
    const strip = document.getElementById("stripInfo");
    return {
      peace: room.peace,
      round: room.round,
      clock: room.clock,
      strip: strip ? (strip.textContent || "").trim() : "",
      pieces: (room.pieces || []).map((p) => ({ id: p.id, side: p.side, x: p.x, y: p.y, domain: p.domain, kind: p.kind })),
      sites: (room.sites || []).filter((s) => s.owner === "blue").map((s) => ({ name: s.name, kind: s.kind, x: s.x, y: s.y })),
    };
  });
  mark("the 1986 open reads peace at round 0", Boolean(open.peace && open.peace.active) && open.round === 0,
    JSON.stringify(open.peace) + " round " + open.round);
  mark("it is the cold war, not a proposed cease-fire", Boolean(open.peace && open.peace.coldWar),
    "coldWar=" + (open.peace && open.peace.coldWar) + " by=" + (open.peace && open.peace.by));
  mark("the counter is the config's ({} -> no forced wait)", Boolean(open.peace) && open.peace.remaining === 0,
    "remaining=" + (open.peace && open.peace.remaining));
  mark("the monitor strip prints the cold-war counter", /cold war/i.test(open.strip), open.strip);
  mark("the enemy is invisible at peace", open.pieces.every((p) => p.side !== "red"),
    open.pieces.length + " piece(s), sides " + [...new Set(open.pieces.map((p) => p.side))].join(","));

  // One select then a destination click is the transfer (p.31 "select the unit once, then select
  // its new location").
  const soldier = open.pieces.find((p) => p.side === "blue" && p.domain !== "sea" && p.kind !== "aircraft");
  const target = open.sites.find((s) => ["city", "capital", "base"].includes(String(s.kind))
    && !(s.x === soldier.x && s.y === soldier.y));
  if (!soldier || !target) {
    mark("the fixture has a piece and a friendly city to transfer to", false, "soldier=" + JSON.stringify(soldier) + " target=" + JSON.stringify(target));
  } else {
    const a = await page.evaluate(([x, y]) => window.__chq.cellToScreen(x, y), [soldier.x, soldier.y]);
    const b = await page.evaluate(([x, y]) => window.__chq.cellToScreen(x, y), [target.x, target.y]);
    await page.mouse.click(a.x, a.y);
    await sleep(250);
    await page.mouse.click(b.x, b.y);
    await page.waitForFunction((to) => {
      const piece = (window.__chq.room().pieces || []).find((p) => p.side === "blue" && p.domain !== "sea" && p.kind !== "aircraft");
      return piece && Number(piece.x) === to.x && Number(piece.y) === to.y;
    }, { x: target.x, y: target.y }, { timeout: 8000, polling: 100 }).catch(() => {});
    const after = await page.evaluate(() => {
      const room = window.__chq.room();
      const piece = (room.pieces || []).find((p) => p.side === "blue" && p.domain !== "sea" && p.kind !== "aircraft");
      return { piece: piece ? { x: piece.x, y: piece.y } : null, toast: window.__chq.toast(), round: room.round };
    });
    mark("a peacetime transfer lands in the same round",
      Boolean(after.piece) && after.piece.x === target.x && after.piece.y === target.y && after.round === open.round,
      JSON.stringify(after) + " to " + target.x + "," + target.y);
    mark("the page says it was a transfer, not a walk", /transfer/i.test(after.toast), after.toast);
    await page.screenshot({ path: path.join(OUT, "pb245b-coldwar-1986-1280x800.png") });
  }

  // War > Begin Hostilities (p.32 War Status).
  await page.click('.navbtn[data-dialog="war"]');
  await sleep(250);
  const before = await page.evaluate(() => ({
    label: [...document.querySelectorAll("#dialogBody button")].map((b) => b.textContent).join(" | "),
    disabled: (() => {
      const btn = [...document.querySelectorAll("#dialogBody button")].find((b) => /Begin Hostilities/i.test(b.textContent));
      return btn ? btn.disabled : null;
    })(),
    counter: (document.getElementById("dialogBody") || {}).textContent || "",
  }));
  mark("War shows the counter and a Begin Hostilities button", /mandatory peace/i.test(before.counter) && /Begin Hostilities/.test(before.label),
    before.label + " :: " + before.counter.replace(/\s+/g, " ").slice(0, 160));
  mark("Begin Hostilities is legal at round 0 with config {}", before.disabled === false, "disabled=" + before.disabled);
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("#dialogBody button")].find((b) => /Begin Hostilities/i.test(b.textContent));
    if (btn) btn.click();
  });
  await page.waitForFunction(() => {
    const peace = window.__chq.room().peace;
    return !peace || peace.active !== true;
  }, null, { timeout: 8000, polling: 100 }).catch(() => {});
  const war = await page.evaluate(() => ({
    peace: window.__chq.room().peace,
    strip: (document.getElementById("info") || {}).textContent || "",
    log: window.__chq.log().slice(-3).map((line) => line.text || ""),
  }));
  mark("Begin Hostilities leaves the peace for this seat", !war.peace || war.peace.active !== true, JSON.stringify(war.peace));
  mark("the strip stops printing the counter", !/cold war/i.test(war.strip), war.strip.trim());
  mark("the seat reads its own act", war.log.some((line) => /hostilities/i.test(line)), war.log.join(" | "));

  mark("no page errors", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));
  writeFileSync(path.join(OUT, "pb245b-coldwar.json"), JSON.stringify({ base: BASE, open, evidence }, null, 2) + "\n");
  console.log("EVIDENCE " + path.join(OUT, "pb245b-coldwar.json"));
  await context.close();
  await browser.close();
  if (child) child.kill("SIGTERM");
  console.log("PB245B_E2E " + (failed === 0 ? "OK" : "FAILED " + failed));
  if (failed !== 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("PB245B_E2E THREW " + (err && err.message ? err.message : err));
  process.exit(1);
});
