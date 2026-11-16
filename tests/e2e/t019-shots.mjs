// T-019 shot matrix (AC2 / AC5 / T-030 extra), corrected by the PM in room 6107 item 2.
//
//   node tests/e2e/t019-shots.mjs --url=http://127.0.0.1:8113 --out=local/t019-shots
//
// The matrix is exact, because a shot of the wrong scenario proves nothing:
//
//   * FOG shots: New game -> Era Concealed (9999), side blue, ROUND 0, one per theme (C and D) and
//     one per view (terrain and Show Ownership). Fog is era-gated: it only draws in 9999.
//   * ONE 1942 shot per theme, terrain, no fog expected. A missing fog in 1942 is NOT a fail: the
//     1942/1918 openings show the whole map and hide only enemy pieces the seat cannot see.
//   * Every shot records the painter's own layer list and fog rect count (window.__chq.paintReport()), so
//     the ownership shots also hold the fill-under-fog order (PB-071) instead of a re-order pass.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

function argOf(name, fallback = "") {
  const hit = process.argv.find((value) => value.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const BASE = (argOf("url", process.env.E2E_URL || "") || "").replace(/\/+$/, "");
if (!BASE) {
  console.error("usage: node tests/e2e/t019-shots.mjs --url=<base url> [--out=<dir>]");
  process.exit(2);
}
const OUT = path.resolve(argOf("out", path.join(process.env.HOME || ".", "agents", "game", "notes", "t019", "shots")));
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_MODULE,
    path.join(here, "node_modules", "playwright", "index.mjs"),
    "/home/gumbyender/agents/agent-relay/node_modules/playwright/index.mjs",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate !== "playwright" && !existsSync(candidate)) continue;
    try {
      return await import(pathToFileURL(candidate).href);
    } catch (err) {
      void err;
    }
  }
  return import("playwright");
}

const THEMES = [
  { id: "C", label: "Dark tactical" },
  { id: "D", label: "Classic" },
];

const evidence = [];
const failures = [];
function mark(step, ok, detail) {
  evidence.push({ step, ok: Boolean(ok), detail });
  if (!ok) failures.push(step);
  console.log((ok ? "PASS " : "FAIL ") + step + " :: " + JSON.stringify(detail));
  writeFileSync(path.join(OUT, "t019-shots.json"), JSON.stringify(evidence, null, 2));
}

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (err) => pageErrors.push(String(err && err.message ? err.message : err)));
// Quit and New game both confirm(); a silently dismissed dialog is a click that never happened.
page.on("dialog", (dialog) => dialog.accept().catch(() => {}));

const paint = () => page.evaluate(() => window.__chq.paintReport());

async function shot(name) {
  const file = path.join(OUT, name);
  await page.screenshot({ path: file });
  console.log("shot " + file);
  return file;
}

async function useTheme(id) {
  // The preference is client-side (localStorage, key openchq.theme) and the switch is cosmetic.
  // Setting it before the match opens is the honest way to capture a named theme; the one-click
  // in-match switch has its own test (T-019 AC1/AC4).
  await page.evaluate((theme) => localStorage.setItem("openchq.theme", theme), id);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 30000 });
  await page.waitForFunction(() => Boolean(window.__chq && window.__chq.me()), null, { timeout: 30000 });
}

async function quitRoom() {
  if (await page.evaluate(() => Boolean(window.__chq.room()))) {
    await page.click("#quitBtn");
    await page.waitForFunction(() => !window.__chq.room(), null, { timeout: 15000 }).catch(() => {});
  }
}

async function newGame(era) {
  await quitRoom();
  // The quit toast outlives the room frame; a shot taken through it reads as a live event.
  await page.waitForFunction(() => !window.__chq.toast(), null, { timeout: 12000 }).catch(() => {});
  // Leaving a match returns to the in-match nav; the launch form comes back from "New game".
  if (!(await page.evaluate(() => { const l = document.querySelector("#launch"); return Boolean(l && l.offsetParent); }))) {
    await page.click("#newBtn");
  }
  await page.waitForFunction(() => {
    const l = document.querySelector("#launch");
    return Boolean(l && l.offsetParent);
  }, null, { timeout: 15000 });
  await page.selectOption('#launch select[name="era"]', era);
  await page.selectOption('#launch select[name="side"]', "blue");
  await page.click('#launch button[type=submit]');
  await page.waitForFunction((wanted) => window.__chq.room() && String(window.__chq.room().era) === wanted, era,
    { timeout: 20000, polling: 100 });
  // Hold the clock at once: every shot in this matrix is the round 0 opening frame.
  await page.evaluate(() => window.__chq.send({ op: "hold" }));
  await page.waitForFunction(() => window.__chq.room() && String(window.__chq.room().clock) === "held", null,
    { timeout: 15000 }).catch(() => {});
  await page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
  await page.keyboard.press("0"); // world fit
  await sleep(500);
  const room = await page.evaluate(() => window.__chq.room());
  return room;
}

async function setView(wanted) {
  // `p` toggles terrain <-> political. Read the mode from the paint report, not from a guess.
  for (let i = 0; i < 4; i++) {
    const now = await paint();
    const political = (now && now.layers || []).includes("ownership");
    if ((wanted === "ownership") === political) return now;
    await page.keyboard.press("p");
    await sleep(400);
  }
  return paint();
}

try {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 30000 });
  const version = await page.evaluate(() => fetch("/api/version").then((r) => r.json()));
  mark("build under test", Boolean(version && version.commit), version);

  if (!(await page.evaluate(() => Boolean(window.__chq && window.__chq.me())))) {
    const name = "t019" + Date.now().toString(36).slice(-8);
    await page.fill("#register input[name=username]", name);
    await page.fill("#register input[name=password]", "pw-" + Math.random().toString(36).slice(2, 12));
    await page.click("#register button[type=submit]");
    await page.waitForSelector("#play:not(.hidden)", { timeout: 30000 });
    mark("registered", true, name);
  } else {
    mark("signed in", true, "session");
  }

  for (const theme of THEMES) {
    await useTheme(theme.id);
    const label = await page.evaluate(() => document.getElementById("themeToggle")?.textContent || "");
    mark("theme " + theme.id + " is on before the match", label.includes(theme.label), { label });

    // --- one 1942 shot per theme, terrain, no fog expected --------------------------------
    const r1942 = await newGame("1942");
    const p1942 = await setView("terrain");
    const file1942 = await shot("t019-" + theme.id + "-1942-terrain.png");
    mark("1942 " + theme.id + " shot is the round 0 opening",
      String(r1942.round) === "0" && String(r1942.clock) === "held",
      { round: r1942.round, clock: r1942.clock, file: file1942 });
    mark("1942 " + theme.id + " shows the whole map (no fog required)",
      p1942 && p1942.layers && !p1942.layers.includes("fog") && !(p1942.fogged > 0),
      { layers: p1942 && p1942.layers, fogged: p1942 && p1942.fogged, file: file1942 });

    // --- fog shots: Concealed 9999, blue, round 0, both views -----------------------------
    const rFog = await newGame("9999");
    mark("Concealed " + theme.id + " is the round 0 opening",
      String(rFog.round) === "0" && String(rFog.clock) === "held" && String(rFog.era) === "9999",
      { era: rFog.era, round: rFog.round, clock: rFog.clock });

    const terrainFog = await setView("terrain");
    const fileFogTerrain = await shot("t019-" + theme.id + "-concealed-round0-terrain.png");
    mark("Concealed " + theme.id + " terrain draws fog at round 0",
      terrainFog && terrainFog.fogged > 0 && terrainFog.layers && terrainFog.layers.includes("fog"),
      { fogged: terrainFog && terrainFog.fogged, layers: terrainFog && terrainFog.layers, file: fileFogTerrain });

    const ownershipFog = await setView("ownership");
    const fileFogOwn = await shot("t019-" + theme.id + "-concealed-round0-ownership.png");
    const layers = (ownershipFog && ownershipFog.layers) || [];
    mark("Concealed " + theme.id + " Show Ownership draws fog at round 0",
      ownershipFog && ownershipFog.fogged > 0 && layers.includes("ownership") && layers.includes("fog"),
      { fogged: ownershipFog && ownershipFog.fogged, layers, file: fileFogOwn });
    mark("Concealed " + theme.id + " keeps the fill UNDER the fog (PB-071)",
      layers.indexOf("ownership") >= 0 && layers.indexOf("fog") > layers.indexOf("ownership"),
      { layers });
  }

  mark("no page errors", pageErrors.length === 0, pageErrors);
} finally {
  writeFileSync(path.join(OUT, "t019-shots.json"), JSON.stringify(evidence, null, 2));
  await browser.close();
}

const failed = evidence.filter((row) => !row.ok);
console.log("t019-shots: " + (evidence.length - failed.length) + " passed, " + failed.length + " failed, shots in " + OUT);
if (failed.length) process.exit(1);
