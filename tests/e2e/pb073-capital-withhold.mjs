// PB-073 live leg: the enemy capital is not drawn outside sight in the concealed era.
//
//   node tests/e2e/pb073-capital-withhold.mjs --url=http://127.0.0.1:8114 --out=local/pb073-shots
//
// The node pin (web/test/nodes/pb073_capital_withhold.mjs) proves the marker SET; this leg proves
// the PIXELS, on a real page with a real socket, in the era the defect was measured in (9999, the
// concealed start). At round 0 the blue seat's view withholds the red capital and hides every red
// piece, so the frame must carry none of the theme's red ink at all - the ring was stroked after
// the fog, so nothing dimmed it.
//
//   1. room().capitals names blue's capital and NOT red's (the view withholding it);
//   2. capitalLabels() - the page's own marker set - has no red side and no "Moscow";
//   3. a whole-canvas scan for the theme's own SCHEMATIC.red finds zero pixels;
//   4. a boxed scan around the enemy capital's cell (from the unfiltered board payload, which is
//      exactly what the defect used to read) finds zero red pixels there too;
//   5. CONTROL: the same page in era 1942 - where both capitals are sent - does carry red ink and
//      does label the red capital, so the sampler is proven live and the zero above is not a
//      dark canvas or an off-screen probe.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPlaywright } from "./playwright.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function argOf(name, fallback = "") {
  const hit = process.argv.find((value) => value.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const BASE = (argOf("url", process.env.E2E_URL || "") || "").replace(/\/+$/, "");
if (!BASE) {
  console.error("usage: node tests/e2e/pb073-capital-withhold.mjs --url=<base url> [--out=<dir>]");
  process.exit(2);
}
const OUT = path.resolve(argOf("out", path.join(process.env.HOME || ".", "agents", "game", "notes", "pb073", "shots")));
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const evidence = [];
let failed = 0;
function mark(step, ok, detail) {
  if (!ok) failed += 1;
  evidence.push({ step, ok: Boolean(ok), detail });
  console.log((ok ? "PASS " : "FAIL ") + step + " :: " + JSON.stringify(detail));
  writeFileSync(path.join(OUT, "pb073-capital-withhold.json"), JSON.stringify(evidence, null, 2));
}

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (err) => pageErrors.push(String(err && err.message ? err.message : err)));
// Quit and New ask once in a `confirm()`; without this the click never resolves and the launch
// panel stays hidden behind the in-match shell (seen on this leg's first run).
page.on("dialog", (dialog) => dialog.accept());

const room = () => page.evaluate(() => window.__chq.room());
const board = () => page.evaluate(() => window.__chq.board());
const labels = () => page.evaluate(() => window.__chq.capitalLabels());
// Every ink a red capital marker can be stroked with in this build: the theme's own schematic red
// plus the module-level side ink capitalMarkers reads (the two differ, and the sampler must not
// assume which one the painter used - the control arm proves the chosen ink is live).
const RED_INKS = ["#ff5a5a", "#c4473a"];
const redInk = () => page.evaluate((inks) => {
  const canvas = document.querySelector("#board");
  const ctx = canvas.getContext("2d");
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const counts = {};
  const wants = inks.map((hex) => [hex, [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16))]);
  for (const [hex] of wants) counts[hex] = 0;
  for (let i = 0; i < data.length; i += 4) {
    for (const [hex, want] of wants) {
      if (data[i] === want[0] && data[i + 1] === want[1] && data[i + 2] === want[2]) counts[hex] += 1;
    }
  }
  const pixels = Object.values(counts).reduce((sum, n) => sum + n, 0);
  return { counts, pixels, canvas: { w: canvas.width, h: canvas.height } };
}, RED_INKS);

// A box around one cell's centre, as a colour histogram: the same reading the node painter makes,
// taken off the pixels the browser actually composited.
async function boxInks(cell, cssSize) {
  return page.evaluate(({ x, y, cssSize }) => {
    const canvas = document.querySelector("#board");
    const ctx = canvas.getContext("2d");
    const point = window.__chq.cellToScreen(x + 0.5, y + 0.5);
    const rect = canvas.getBoundingClientRect();
    const ratio = canvas.width / Math.max(1, rect.width);
    const cx = Math.round((point.x - rect.left) * ratio);
    const cy = Math.round((point.y - rect.top) * ratio);
    const half = Math.max(1, Math.round((cssSize * ratio) / 2));
    const x0 = Math.max(0, cx - half), y0 = Math.max(0, cy - half);
    const w = Math.min(canvas.width - x0, half * 2), h = Math.min(canvas.height - y0, half * 2);
    const data = ctx.getImageData(x0, y0, w, h).data;
    const hist = {};
    for (let i = 0; i < data.length; i += 4) {
      const ink = "#" + [data[i], data[i + 1], data[i + 2]].map((v) => v.toString(16).padStart(2, "0")).join("");
      hist[ink] = (hist[ink] || 0) + 1;
    }
    return { box: { x0, y0, w, h, ratio, onScreen: cx >= 0 && cy >= 0 && cx < canvas.width && cy < canvas.height }, hist };
  }, { x: cell.x, y: cell.y, cssSize });
}

async function launch(era) {
  if (await room()) {
    await page.click("#quitBtn");
    await page.waitForFunction(() => !window.__chq.room(), null, { timeout: 15000 }).catch(() => {});
  }
  // The saved theme is per player; pin C so the red ink this leg scans for is the one on screen.
  await page.evaluate(() => { try { localStorage.setItem("openchq.theme", "C"); } catch (err) { void err; } });
  await page.selectOption('#launch select[name="era"]', era);
  await page.selectOption('#launch select[name="side"]', "blue");
  await page.click('#launch button[type=submit]');
  await page.waitForFunction((wanted) => window.__chq.room() && String(window.__chq.room().era) === wanted, era,
    { timeout: 20000, polling: 100 });
  await page.evaluate(() => window.__chq.send({ op: "hold" }));
  await page.waitForFunction(() => window.__chq.room() && String(window.__chq.room().clock) === "held", null,
    { timeout: 15000 }).catch(() => {});
  await page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
  await page.keyboard.press("0"); // fit
  await sleep(400);
}

try {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 30000 });
  const version = await page.evaluate(() => fetch("/api/version").then((r) => r.json()));
  mark("build under test", Boolean(version && version.short), version);

  if (!(await page.evaluate(() => Boolean(window.__chq && window.__chq.me())))) {
    const name = "pb073" + Date.now().toString(36).slice(-8);
    await page.fill("#register input[name=username]", name);
    await page.fill("#register input[name=password]", "pw-" + Math.random().toString(36).slice(2, 12));
    await page.click("#register button[type=submit]");
    await page.waitForSelector("#play:not(.hidden)", { timeout: 30000 });
    mark("registered", true, name);
  } else {
    mark("signed in", true, "session");
  }

  // --- the concealed era: the view withholds the enemy capital -------------------------------
  await launch("9999");
  const concealedRoom = await room();
  const concealedBoard = await board();
  mark("era 9999 opens held at round 0",
    String(concealedRoom.era) === "9999" && Number(concealedRoom.round) === 0 && concealedRoom.clock === "held",
    { era: concealedRoom.era, round: concealedRoom.round, clock: concealedRoom.clock });

  const viewCapitals = concealedRoom.capitals || {};
  mark("the seat view sends its own capital and withholds the enemy's",
    Boolean(viewCapitals.blue) && !viewCapitals.red,
    { sent: Object.keys(viewCapitals) });

  const boardRed = concealedBoard.capitals && concealedBoard.capitals.red;
  mark("the unfiltered board payload still names the enemy capital (the leak this leg tests)",
    Boolean(boardRed) && Number.isFinite(Number(boardRed.x)),
    boardRed || null);

  const concealedLabels = await labels();
  mark("no red capital marker is drawn", !concealedLabels.some((marker) => marker.side === "red"),
    concealedLabels.map((marker) => [marker.side, marker.name]));
  mark("the enemy capital's name never reaches the frame",
    !concealedLabels.some((marker) => String(marker.name) === "Moscow"),
    concealedLabels.map((marker) => marker.name));

  const wholeConcealed = await redInk();
  mark("no red ink anywhere in the concealed frame", wholeConcealed.pixels === 0, wholeConcealed);

  if (boardRed) {
    const box = await boxInks({ x: Number(boardRed.x), y: Number(boardRed.y) }, 24);
    const redPixels = RED_INKS.reduce((sum, ink) => sum + (box.hist[ink] || 0), 0);
    mark("no red ring pixel within a 24 px box of the enemy capital's cell",
      redPixels === 0 && box.box.onScreen === true, { box: box.box, redPixels, inks: RED_INKS });
  }

  // --- CONTROL: a file era sends both capitals, so the sampler sees red ----------------------
  await launch("1942");
  const openLabels = await labels();
  mark("the control era labels the red capital",
    openLabels.some((marker) => marker.side === "red" && String(marker.name) === "Berlin"),
    openLabels.map((marker) => [marker.side, marker.name]));
  const wholeOpen = await redInk();
  mark("the control frame does carry red ink (the concealed zero is not a dark canvas)",
    wholeOpen.pixels > 0, wholeOpen);

  mark("no page errors", pageErrors.length === 0, pageErrors.slice(0, 5));
  await page.screenshot({ path: path.join(OUT, "pb073-9999-as-blue.png") });
  console.log("shot " + path.join(OUT, "pb073-9999-as-blue.png"));
} finally {
  await browser.close();
}

console.log(failed === 0 ? "PB073_OK" : `PB073_FAILED ${failed}`);
process.exit(failed === 0 ? 0 : 1);
