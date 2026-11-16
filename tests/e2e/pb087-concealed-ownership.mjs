// PB-087 visible shot: the Concealed campaign's Show Ownership view must PAINT, which is the thing
// the node pins cannot see. Round 0, era 9999, side blue, view switched by CLICKING #viewToggle.
//
//   node tests/e2e/pb087-concealed-ownership.mjs --url=http://127.0.0.1:8119 --out=local/pb087-shots
//
// Asserts the served frame carries ownership.ready with 184 owners, the painter's layer list holds
// "ownership", and the shot is taken through the in-match controls (PB-078) rather than by keys.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const argOf = (name, fallback = "") => {
  const hit = process.argv.find((v) => v.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const BASE = argOf("url").replace(/\/+$/, "");
if (!BASE) {
  console.error("usage: node tests/e2e/pb087-concealed-ownership.mjs --url=<base url> [--out=<dir>]");
  process.exit(2);
}
const OUT = path.resolve(argOf("out", "/mnt/nas/projects/OpenCHQ/local/pb087-shots"));
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_MODULE,
    path.join(here, "node_modules", "playwright", "index.mjs"),
    "/home/gumbyender/agents/agent-relay/node_modules/playwright/index.mjs",
  ].filter(Boolean);
  for (const c of candidates) {
    if (c !== "playwright" && !existsSync(c)) continue;
    try { return await import(pathToFileURL(c).href); } catch { /* next */ }
  }
  return import("playwright");
}

const evidence = [];
const failures = [];
function mark(step, ok, detail) {
  evidence.push({ step, ok: Boolean(ok), detail });
  if (!ok) failures.push(step);
  console.log((ok ? "PASS " : "FAIL ") + step + " :: " + JSON.stringify(detail));
  writeFileSync(path.join(OUT, "pb087-concealed-ownership.json"), JSON.stringify(evidence, null, 2));
}

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
// The theme preference is client-side (localStorage, key openchq.theme); set it before the page
// boots so the shot is a named theme without a reload tearing the socket down mid-open.
await context.addInitScript(() => {
  try { localStorage.setItem("openchq.theme", "C"); } catch { /* first-party storage only */ }
});
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e && e.message ? e.message : e)));
page.on("dialog", (d) => d.accept());

const paint = () => page.evaluate(() => window.__chq.paintReport());
async function press(id) { await page.click("#" + id, { timeout: 5000 }); await sleep(500); }

try {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 30000 });
  const version = await page.evaluate(() => fetch("/api/version").then((r) => r.json()));
  mark("build under test", Boolean(version && version.commit), version);
  // The shell is behind a local account; a throwaway is the house pattern for a served legs shot.
  if (!(await page.evaluate(() => Boolean(window.__chq && window.__chq.me())))) {
    const name = "pb087" + Date.now().toString(36).slice(-8);
    await page.fill("#register input[name=username]", name);
    await page.fill("#register input[name=password]", "pw-" + Math.random().toString(36).slice(2, 12));
    await page.click("#register button[type=submit]");
    await page.waitForSelector("#play:not(.hidden)", { timeout: 30000 });
    mark("registered a throwaway user", true, name);
  }
  await page.waitForFunction(() => Boolean(window.__chq && window.__chq.me()), null, { timeout: 30000 });

  await page.selectOption('#launch select[name="era"]', "9999");
  await page.selectOption('#launch select[name="side"]', "blue");
  await page.click('#launch button[type=submit]');
  await page.waitForFunction(() => window.__chq.room() && String(window.__chq.room().era) === "9999",
    null, { timeout: 20000, polling: 100 });
  await page.evaluate(() => window.__chq.send({ op: "hold" }));
  await page.waitForFunction(() => window.__chq.room() && String(window.__chq.room().clock) === "held",
    null, { timeout: 15000 }).catch(() => {});
  await press("camFit");

  const room = await page.evaluate(() => window.__chq.room());
  const own = room && room.ownership;
  mark("concealed match opens held at round 0",
    String(room.era) === "9999" && Number(room.round) === 0 && room.clock === "held",
    { era: room.era, round: room.round, clock: room.clock });
  mark("served frame carries ownership.ready", Boolean(own && own.ready), { ready: own && own.ready, era: own && own.era });
  mark("ownership has one owner per region", Boolean(own && Array.isArray(own.owners) && own.owners.length === 184),
    { owners: own && own.owners && own.owners.length });
  mark("ownership tally covers every region",
    Boolean(own && own.tally && own.tally.blue + own.tally.red + own.tally.neutral === 184),
    own && own.tally);

  // Switch to Show Ownership by CLICKING the view button until the painter's own layer list agrees.
  let now = await paint();
  for (let i = 0; i < 4; i++) {
    if (((now && now.layers) || []).includes("ownership")) break;
    await press("viewToggle");
    now = await paint();
  }
  const layers = (now && now.layers) || [];
  mark("the painter's layer list carries ownership", layers.includes("ownership"), { layers });
  const file = path.join(OUT, "pb087-concealed-round0-ownership.png");
  await page.screenshot({ path: file });
  console.log("shot " + file);
  mark("page errors", pageErrors.length === 0, pageErrors.slice(0, 3));
} finally {
  await browser.close();
}
writeFileSync(path.join(OUT, "pb087-concealed-ownership.json"), JSON.stringify(evidence, null, 2));
console.log(failures.length ? "FAILURES: " + failures.join(" | ") : "PB087_SHOT_OK");
process.exit(failures.length ? 1 : 0);
