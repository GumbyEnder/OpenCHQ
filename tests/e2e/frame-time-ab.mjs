// T-014 AC5, paired: two builds, one browser, interleaved samples.
//
// frame-time.mjs times one build per process. On this host the software rasteriser's numbers drift
// by 3x between runs (a baseline read 2.1 ms and 6.4 ms at the same zoom), so a ratio taken from two
// separate processes is noise, not a measurement. This script loads BOTH builds in one browser and
// times them alternately, sample by sample, so whatever the machine is doing affects both sides
// inside a few hundred microseconds of each other. The ratio of the two medians is the AC5 number.
//
//   node frame-time-ab.mjs --base=http://127.0.0.1:8106 --new=http://127.0.0.1:8107 --samples=200
//
// Writes t014-frame-time-ab-<stamp>/summary.json next to itself and prints both views + the ratio.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback = "") => {
  const hit = process.argv.find((v) => v.startsWith("--" + name + "="));
  if (hit) return hit.slice(name.length + 3);
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const BASE = (arg("base", "") || "").replace(/\/+$/, "");
const NEW = (arg("new", "") || "").replace(/\/+$/, "");
if (!BASE || !NEW) { console.error("usage: node frame-time-ab.mjs --base=<url> --new=<url> [--samples=200]"); process.exit(2); }
const SAMPLES = Math.max(20, Number(arg("samples", "200")) || 200);
const ERA = arg("era", "1942");
const ZOOM_STEPS = Math.max(1, Number(arg("zoom", "3")) || 3);
const OUT = path.join(here, "t014-frame-time-ab-" + new Date().toISOString().replace(/[:.]/g, "-"));

async function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_MODULE,
    "/home/gumbyender/agents/agent-relay/node_modules/playwright/index.mjs",
  ].filter(Boolean);
  for (const c of candidates) {
    if (c !== "playwright" && !existsSync(c)) continue;
    try { return await import(pathToFileURL(c).href); } catch {}
  }
  return await import("playwright");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (values) => {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const p90 = (values) => {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.9))];
};

async function openBuild(context, url, label) {
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(label + ": " + String(e)));
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 30000 });
  if (!(await page.evaluate(() => Boolean(window.__chq && window.__chq.me())))) {
    const name = label + Date.now().toString(36).slice(-8);
    await page.fill("#register input[name=username]", name);
    await page.fill("#register input[name=password]", "pw-" + Math.random().toString(36).slice(2, 12));
    await page.click("#register button[type=submit]");
    await page.waitForSelector("#play:not(.hidden)", { timeout: 30000 });
  }
  await page.selectOption('#launch select[name="era"]', ERA);
  await page.selectOption('#launch select[name="side"]', "blue");
  await page.click('#launch button[type=submit]');
  await page.waitForFunction((e) => window.__chq.room() && String(window.__chq.room().era) === e,
    ERA, { timeout: 30000, polling: 100 });
  await page.waitForFunction(() => {
    const r = window.__chq.room();
    return r && Array.isArray(r.pieces) && r.pieces.length > 0;
  }, null, { timeout: 30000, polling: 100 });
  const describe = await page.evaluate(() => {
    const r = window.__chq.room();
    return { era: String(r.era), round: Number(r.round), pieces: r.pieces.length,
      own: r.pieces.filter((p) => p.side === r.you).length };
  });
  return { page, errors, describe, label, url };
}

// One view, both builds, alternating: build A, build B, build A... The two paints are microseconds
// apart, so a machine that gets busy mid-run moves both medians together instead of one of them.
async function paired(builds, label) {
  const times = builds.map(() => []);
  for (let i = 0; i < SAMPLES; i++) {
    for (let b = 0; b < builds.length; b++) {
      const ms = await builds[b].page.evaluate(() => window.__chq.paint());
      if (!Number.isFinite(ms)) throw new Error("paint() returned a non-number at " + label);
      times[b].push(ms);
      await sleep(16);
    }
  }
  return builds.map((build, b) => ({
    label: build.label, view: label, median: median(times[b]), p90: p90(times[b]),
    min: Math.min(...times[b]), max: Math.max(...times[b]), samples: times[b].length,
  }));
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const builds = [await openBuild(context, BASE, "base"), await openBuild(context, NEW, "new")];

  for (const build of builds) {
    await build.page.evaluate(() => document.getElementById("camFit").click());
    await build.page.waitForTimeout(150);
  }
  const fitView = await builds[1].page.evaluate(() => window.__chq.state().camera);
  const fit = await paired(builds, "fit");

  for (const build of builds) {
    for (let i = 0; i < ZOOM_STEPS; i++) {
      await build.page.evaluate(() => document.getElementById("camIn").click());
      await build.page.waitForTimeout(80);
    }
  }
  const zoomView = await builds[1].page.evaluate(() => window.__chq.state().camera);
  const zoom = await paired(builds, "zoom");

  const ratio = (rows) => rows[1].median / rows[0].median;
  const summary = {
    base: BASE, new: NEW, era: ERA, samples: SAMPLES,
    pieces: builds.map((b) => b.describe), fitView, zoomView,
    fit, zoom, ratio: { fit: ratio(fit), zoom: ratio(zoom) },
    pageErrors: builds.flatMap((b) => b.errors), at: new Date().toISOString(),
  };
  const file = path.join(OUT, "summary.json");
  writeFileSync(file, JSON.stringify(summary, null, 2));

  console.log(`paired samples: ${SAMPLES} per build per view, one browser, alternating`);
  console.log(`builds: base ${BASE} (${builds[0].describe.pieces} pieces) · new ${NEW} (${builds[1].describe.pieces} pieces)`);
  for (const rows of [fit, zoom]) {
    console.log(`${rows[0].view === "fit" ? "fit" : "zoom "}  base median ${rows[0].median.toFixed(2)} ms (p90 ${rows[0].p90.toFixed(2)}) · new median ${rows[1].median.toFixed(2)} ms (p90 ${rows[1].p90.toFixed(2)}) · ratio ${ratio(rows).toFixed(2)}x`);
  }
  console.log("summary " + file);
  const errors = summary.pageErrors;
  if (errors.length) console.log("page errors: " + errors.join(" | "));
  await browser.close();
}

main().catch((err) => { console.error(err && err.stack || String(err)); process.exit(1); });
