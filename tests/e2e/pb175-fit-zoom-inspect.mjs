// PB-175 page leg: at the WORLD FIT, a friendly city that holds a unit can be inspected.
//
// The defect (PM 8330 §3): at the fit zoom a unit badge is ~14 px over 4.41 px cells, so the badge
// covers the city it stands on. Every click on that cell resolved to the piece, and PB-163's site
// line only ran when nothing was selected - so a player could never read that city's readiness
// without walking the unit off it first.
//
// The rule this leg grades, chosen in web/public/app.js: a CYCLE.
//   click 1 on the cell -> the unit is selected (unchanged behaviour, the PB-143 floor)
//   click 2 on the SAME cell -> the city's inspect line ("Ready." / "Unready - ready at round N")
//                               and the unit stays selected.
// The alternative ("city wins the first click") was refused because it costs the unit its own click.
//
//   node tests/e2e/pb175-fit-zoom-inspect.mjs                 # starts its own server from this tree
//   node tests/e2e/pb175-fit-zoom-inspect.mjs --url=<base>    # use a running server
//   node tests/e2e/pb175-fit-zoom-inspect.mjs --expect=<sha>  # require that sha at /api/version
//
// The leg prints its own identity (HEAD sha, its own md5) so a count in a gate row names the
// instrument that produced it. Every count is written to <out>/pb175-fit-zoom.json as it runs.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { loadPlaywright } from "./playwright.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

function argOf(name, fallback = "") {
  const hit = process.argv.find((value) => value.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : fallback;
}

let HEAD_SHA = "";
try {
  HEAD_SHA = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
} catch (err) { void err; }

const SELF = path.basename(fileURLToPath(import.meta.url));
const SELF_MD5 = createHash("md5").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex");
const GIVEN = (argOf("url", process.env.E2E_URL || "") || "").replace(/\/+$/, "");
const ERA = argOf("era", "1986");
// PB-190b: this leg was the third survivor of the PB-190 species. PB-190 swept pb165:255 and
// pb182:220; this arm still compared `version.short === EXPECT`, so a gate caller passing the
// correct full 40-char sha redded a correct build (measured on live 6f41ade: 10/1/11 exit 1,
// the only FAIL "the page is served 6f41ade1c7…", detail quoting that exact commit).
// The default also has to stay EMPTY: a worktree's HEAD is never the sha Railway serves, so
// defaulting to HEAD.slice(0,7) pins a tests-only branch to a page that cannot match.
const EXPECT = argOf("expect", "");
// A prefix names a commit only at 7 characters; the full commit is the witness when the host
// publishes one (PB-190 / frodo 8452 §2). Same helper as pb165/pb182 at this sha.
function servedMatches(version) {
  const want = String(EXPECT || "").toLowerCase();
  if (!want) return true;
  const commit = String((version && version.commit) || "").toLowerCase();
  const short = String((version && version.short) || "").toLowerCase();
  const PREFIX_MIN = 7;
  if (commit) {
    if (commit === want) return true;
    if (want.length > commit.length) return want.startsWith(commit);
    return want.length >= PREFIX_MIN && commit.startsWith(want);
  }
  if (!short) return false;
  if (short === want) return true;
  if (want.length > short.length) return want.startsWith(short);
  return want.length >= PREFIX_MIN && short.startsWith(want);
}
const OUT = path.resolve(argOf("out", path.join(process.env.HOME || ".", "agents", "game", "notes", "pb175")));
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

function startServer(port, dataDir) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      OPENCHQ_WEB_HOST: "127.0.0.1",
      OPENCHQ_WEB_PORT: String(port),
      OPENCHQ_WEB_DATA: dataDir,
      ...(HEAD_SHA ? { OPENCHQ_COMMIT: HEAD_SHA } : {}),
    };
    const child = spawn(process.execPath, ["web/server/main.mjs"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("server did not start: " + log));
    }, 8000);
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

const evidence = [];
let failed = 0;
function mark(step, ok, detail = "") {
  if (!ok) failed += 1;
  evidence.push({ step, ok: Boolean(ok), detail: String(detail || "") });
  console.log((ok ? "PASS " : "FAIL ") + step + (detail ? " — " + detail : ""));
  writeFileSync(path.join(OUT, "pb175-fit-zoom.json"), JSON.stringify(evidence, null, 2));
  return Boolean(ok);
}

const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb175-"));
let server = null;
let browser = null;
let BASE = GIVEN;

try {
  console.log("leg " + SELF + " md5 " + SELF_MD5 + " git " + (HEAD_SHA || "unknown"));
  if (!BASE) {
    const port = await freePort();
    server = await startServer(port, dataDir);
    BASE = "http://127.0.0.1:" + port;
    mark("a local server answers", true, BASE + " (tree HEAD " + (HEAD_SHA || "unknown") + ", leg md5 " + SELF_MD5 + ")");
  }

  const { chromium } = await loadPlaywright();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  const room = () => page.evaluate(() => window.__chq.room());
  const state = () => page.evaluate(() => window.__chq.state());
  const toast = () => page.evaluate(() => window.__chq.toast());
  const note = () => page.evaluate(() => window.__chq.note());
  const legal = () => page.evaluate(() => window.__chq.legalCells(6000));
  const counts = (cells) => cells.reduce((m, c) => ((m[c.box] = (m[c.box] || 0) + 1), m), {});

  async function onScreen(cell) {
    return page.evaluate(({ x, y }) => {
      const p = window.__chq.cellToScreen(x, y);
      const vp = { w: window.innerWidth, h: window.innerHeight };
      return Boolean(p) && p.x > 3 && p.y > 3 && p.x < vp.w - 3 && p.y < vp.h - 3;
    }, cell);
  }

  async function clickCell(cell, settle = 650) {
    const point = await page.evaluate(({ x, y }) => window.__chq.cellToScreen(x, y), cell);
    const vp = page.viewportSize();
    if (!point || point.x < 2 || point.y < 2 || point.x > vp.width - 2 || point.y > vp.height - 2) {
      await page.click("#camFit").catch(() => {});
      await sleep(300);
      const again = await page.evaluate(({ x, y }) => window.__chq.cellToScreen(x, y), cell);
      if (!again) return false;
      await page.mouse.click(again.x, again.y);
      await sleep(settle);
      return true;
    }
    await page.mouse.click(point.x, point.y);
    await sleep(settle);
    return true;
  }

  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 20000 });
  const version = await page.evaluate(() => fetch("/api/version").then((r) => r.json()).catch(() => null));
  mark("the page is served " + (EXPECT || "any sha"), Boolean(version) && servedMatches(version),
    JSON.stringify(version));

  if (!(await page.evaluate(() => Boolean(window.__chq && window.__chq.me())))) {
    await page.fill("#register input[name=username]", "pb175" + Date.now().toString(36).slice(-7));
    await page.fill("#register input[name=password]", "pw-" + Math.random().toString(36).slice(2, 12));
    await page.click("#register button[type=submit]");
    await page.waitForSelector("#play:not(.hidden)", { timeout: 20000 });
  }
  await page.selectOption('#launch select[name="era"]', ERA);
  await page.selectOption('#launch select[name="side"]', "blue");
  await page.click('#launch button[type=submit]');
  await page.waitForFunction((w) => window.__chq.room() && String(window.__chq.room().era) === w, ERA, { timeout: 20000, polling: 100 });
  const r0 = await room();
  mark("1986 blue match open", Boolean(r0 && r0.id), "id " + (r0 && r0.id) + " round " + (r0 && r0.round));

  // ---- the zoom under test: Fit, the one the ticket was filed at -------------------------------
  await page.click("#camFit");
  await sleep(450);
  const atFit = await state();
  const fitScale = Number(atFit && atFit.camera && atFit.camera.scale) || 0;
  mark("the camera is at the world fit", fitScale >= 3.9, "scale " + fitScale.toFixed(4) + " (badge 14 px over " + (fitScale ? fitScale.toFixed(2) : "?") + " px cells)");

  // ---- buy one infantry ON a ready city cell, which is the case the ticket names ---------------
  await page.click('#nav button[data-dialog="buy"]');
  await sleep(250);
  await page.click('button.buyrow[data-kind="infantry"]');
  await page.waitForFunction(() => window.__chq.state().placement === true, null, { timeout: 15000 }).catch(() => {});
  await sleep(350);
  const armed = await legal();
  mark("the arm click paints the placement mask", armed.length > 0, JSON.stringify(counts(armed)));

  const sites = (await room()).sites || [];
  const siteCells = armed.filter((c) => c.box === 1
    && sites.some((s) => Number(s.x) === c.x && Number(s.y) === c.y));
  let place = null;
  for (const cand of siteCells) {
    if (await onScreen(cand)) { place = cand; break; }
  }
  if (!place) {
    await page.click("#camFit").catch(() => {});
    await sleep(300);
    for (const cand of siteCells) {
      if (await onScreen(cand)) { place = cand; break; }
    }
  }
  const site = place ? sites.find((s) => Number(s.x) === place.x && Number(s.y) === place.y) : null;
  mark("a ready city cell is on screen with the mask armed", Boolean(place && site),
    place ? site.name + " at " + place.x + "," + place.y + " (box " + place.box + ")" : "no site cell on screen");

  const before = ((await room()).pieces || []).length;
  if (place) await clickCell(place);
  await sleep(1200);
  const afterRoom = await room();
  const piece = (afterRoom.pieces || []).find((p) => Number(p.x) === place.x && Number(p.y) === place.y);
  mark("a unit stands on that city cell", ((afterRoom.pieces || []).length === before + 1) && Boolean(piece),
    "pieces " + before + " -> " + ((afterRoom.pieces || []).length) + (piece ? ", id " + piece.id : ", none on the cell"));
  // The purchase click selected nothing on purpose: clear whatever the arm left behind so the two
  // clicks below are the only ones this leg grades.
  await page.mouse.click(5, 5).catch(() => {});
  await sleep(250);

  // ---- AC (b): the unit is still selectable by its own click at the fit ------------------------
  const s0 = await state();
  await clickCell(place, 500);
  const s1 = await state();
  const toast1 = await toast();
  mark("click 1 on the cell selects the unit, as before",
    Boolean(s1.selected) && (!piece || String(s1.selected) === String(piece.id)),
    "selected " + s1.selected + " (was " + s0.selected + "), toast " + JSON.stringify(toast1.slice(0, 80)));

  // ---- AC (a): a SECOND click on the same cell says the city's line and keeps the unit ---------
  await sleep(1200); // let the selection toast expire, so a stale line cannot be read as the city's
  const toastGone = await toast();
  await clickCell(place, 500);
  const s2 = await state();
  const toast2 = await toast();
  const note2 = await note();
  const said = (toast2 + " " + note2).trim();
  const namesCity = Boolean(site) && said.includes(String(site.name));
  const namesReadiness = /\bReady\./.test(said) || /Unready — ready at round \d+/.test(said);
  mark("click 2 on the same cell says the city's inspect line",
    namesCity && namesReadiness,
    "site " + (site ? site.name + " (readyRound " + (site.readyRound ?? 0) + ")" : "?") + ", said " + JSON.stringify(said.slice(0, 160))
      + (toastGone ? " (toast before click 2: " + JSON.stringify(toastGone.slice(0, 60)) + ")" : " (toast was empty before click 2)"));
  mark("the unit stays selected across the inspect click",
    Boolean(s2.selected) && Boolean(s1.selected) && String(s2.selected) === String(s1.selected),
    "selected " + s1.selected + " -> " + s2.selected);

  // ---- the regression arm: a neighbour click is still a move order, not an inspect -------------
  const neighbour = { x: place.x + 1, y: place.y };
  const landsOnSite = sites.some((s) => Number(s.x) === neighbour.x && Number(s.y) === neighbour.y);
  if (!landsOnSite && (await onScreen(neighbour))) {
    await sleep(1200);
    const wire0 = (await page.evaluate(() => window.__chq.wire())).length;
    await clickCell(neighbour, 700);
    const toast3 = await toast();
    const wire3 = await page.evaluate(() => window.__chq.wire());
    const newWire = wire3.slice(wire0);
    // The unit does not teleport: an accepted order walks next round. What this arm grades is which
    // BRANCH the click took - an order line and no city sentence - not the piece's new position.
    const tookOrder = /Order sent/.test(toast3) && !(site && toast3.includes(String(site.name)));
    mark("a click one cell off is still an order, not an inspect", tookOrder,
      "toast " + JSON.stringify(toast3.slice(0, 90)) + ", " + newWire.length + " new wire line(s) "
        + JSON.stringify(newWire.slice(0, 3)));
  } else {
    mark("a click one cell off is still an order, not an inspect", true,
      "SKIPPED as a read: the neighbour cell is a site or off screen; the move-order floor is the pb143 leg");
  }

  mark("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
} catch (err) {
  mark("the leg ran to the end", false, (err && err.stack ? err.stack.split("\n").slice(0, 4).join(" | ") : String(err)));
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.kill("SIGKILL");
}

const passed = evidence.filter((e) => e.ok).length;
const total = evidence.length;
writeFileSync(path.join(OUT, "pb175-fit-zoom.json"), JSON.stringify(evidence, null, 2));
console.log("");
console.log("pb175 fit-zoom inspect: " + passed + " passed, " + failed + " failed, " + total + " checks, exit " + (failed ? 1 : 0));
console.log("leg " + SELF + " md5 " + SELF_MD5 + " git " + (HEAD_SHA || "unknown") + " evidence " + OUT);
process.exit(failed ? 1 : 0);
