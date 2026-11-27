// PB-299 page leg: the Air panel's PLANE column names the plane, never its wire id.
//
// The reported defect (PM 9891 §4): the Air dialog's PLANE cell prints the internal id
// "blue:aircraft:1". A player reading "Show Air Power" cannot use that as a name.
//
//   node tests/e2e/pb299-plane-label.mjs                       # starts its own server
//   node tests/e2e/pb299-plane-label.mjs --url=<base>          # a running server
//   node tests/e2e/pb299-plane-label.mjs --out=<dir>
//   node tests/e2e/pb299-plane-label.mjs --mutant=raw-id       # planted mutant: expects RED
//
// Measured through a real page, a real socket and a real server, at 1280x800 AND 1024x768
// (frodo 9911 §3):
//   1. control: the Air table still has the four columns and a row for the plane this leg bought;
//   2. the PLANE cell reads "Aircraft <n>" - a readable label, and the n is the id's own number;
//   3. no visible element inside the panel's body matches /^[a-z]+:[a-z]+:\d+$/i, and the panel's
//      whole visible text contains no "…:aircraft:<n>" anywhere - the raw id is gone from the text,
//      not merely moved to another column;
//   4. the raw id is NOT lost: the PLANE cell carries data-piece and title = the wire id, which is
//      what the page legs use to pin a row to one plane;
//   5. clicking a mission still orders THAT plane: the toast reads "Aircraft <n>: … ordered." and
//      never the raw id, and the outgoing frame carries the wire id.
//
// --mutant=raw-id runs the same leg against a COPY of this tree whose app.js builds the PLANE cell
// from plane.id again (the defect restored). The negative assertions are expected to go red; if they
// stay green the mutant survived and this leg exits 1. A negative that has never been red is the
// cheapest false green in the repo (frodo 9911 §3).
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright } from "./playwright.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

function argOf(name, fallback = "") {
  const hit = process.argv.find((value) => value.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const GIVEN = (argOf("url", process.env.E2E_URL || "") || "").replace(/\/+$/, "");
const MUTANT = argOf("mutant", "");
const ERA = "1986";
const OUT = path.resolve(argOf("out", path.join(process.env.HOME || ".", "agents", "game", "notes", "pb299-page")));
mkdirSync(OUT, { recursive: true });

const RAW_ID = /^[a-z]+:[a-z]+:\d+$/i;
const ANY_RAW_ID = /[a-z]+:[a-z]+:\d+/i;
const VIEWPORTS = [[1280, 800], [1024, 768]];
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

function startServer(port, dataDir, tree) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, OPENCHQ_WEB_HOST: "127.0.0.1", OPENCHQ_WEB_PORT: String(port), OPENCHQ_WEB_DATA: dataDir };
    const child = spawn(process.execPath, ["web/server/main.mjs"], { cwd: tree, env, stdio: ["ignore", "pipe", "pipe"] });
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

// A mutant is served from a copy of the tree, so the leg's own checkout is never written.
function mutantTree(kind) {
  const dir = mkdtempSync(path.join(tmpdir(), "openchq-pb299-mut-"));
  cpSync(root, dir, {
    recursive: true,
    filter: (src) => !src.includes("/.git/") && !src.endsWith("/.git") && !src.includes("/node_modules"),
  });
  const appPath = path.join(dir, "web", "public", "app.js");
  const before = readFileSync(appPath, "utf8");
  let after = before;
  if (kind === "raw-id") {
    after = before
      .replace("const planeName = cell(pieceLabel(plane.id));", "const planeName = cell(plane.id);")
      .replace("say(pieceLabel(plane.id) + \": \" + mission.label + \" ordered.\");", "say(plane.id + \": \" + mission.label + \" ordered.\");");
  } else {
    throw new Error("unknown mutant: " + kind);
  }
  if (after === before) throw new Error("the mutant could not be planted: the fixed source shape moved");
  writeFileSync(appPath, after);
  return dir;
}

const evidence = [];
let failed = 0;
function mark(step, ok, detail = "") {
  if (!ok) failed += 1;
  evidence.push({ step, ok: Boolean(ok), detail: String(detail || "") });
  console.log((ok ? "PASS " : "FAIL ") + step + (detail ? " — " + detail : ""));
  return Boolean(ok);
}

const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb299-"));
let server = null;
let browser = null;
let BASE = GIVEN;
let serverTree = root;

try {
  if (!BASE) {
    const tree = MUTANT ? mutantTree(MUTANT) : root;
    serverTree = tree;
    const port = await freePort();
    server = await startServer(port, dataDir, tree);
    BASE = "http://127.0.0.1:" + port;
    mark("a local server answers", true, BASE + " tree=" + (MUTANT ? "mutant(" + MUTANT + ")" : "the checkout"));
  } else {
    mark("a given server answers", true, BASE);
  }

  const { chromium } = await loadPlaywright();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  const room = () => page.evaluate(() => window.__chq.room());

  async function clickCell(cell) {
    const point = await page.evaluate(({ x, y }) => window.__chq.cellToScreen(x, y), cell);
    const vp = page.viewportSize();
    if (!point || point.x < 2 || point.y < 2 || point.x > vp.width - 2 || point.y > vp.height - 2) {
      await page.click("#camFit").catch(() => {});
      await sleep(250);
      const again = await page.evaluate(({ x, y }) => window.__chq.cellToScreen(x, y), cell);
      if (!again) return false;
      await page.mouse.click(again.x, again.y);
      await sleep(160);
      return true;
    }
    await page.mouse.click(point.x, point.y);
    await sleep(160);
    return true;
  }

  // ---------------------------------------------------------------- sign in and open a match
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 25000 });
  const name = "e2e-pb299-" + Date.now().toString(36).slice(-8);
  await page.fill("#register input[name=username]", name);
  await page.fill("#register input[name=password]", "pw-" + Math.random().toString(36).slice(2, 12));
  await page.click("#register button[type=submit]");
  await page.waitForSelector("#play:not(.hidden)", { timeout: 25000 });
  await page.selectOption('#launch select[name="era"]', ERA);
  await page.selectOption('#launch select[name="side"]', "blue");
  await page.click('#launch button[type=submit]');
  await page.waitForFunction((wanted) => window.__chq.room() && String(window.__chq.room().era) === wanted, ERA, { timeout: 25000, polling: 100 });
  let cur = await room();
  mark("Play a bot opens a 1986 match", Boolean(cur && cur.seat), "round " + (cur && cur.round));
  if (cur && cur.clock === "running") {
    await page.click("#clockBtn").catch(() => {});
    await sleep(300);
    cur = await room();
  }
  mark("the clock is held, so no round moves under the measurement", Boolean(cur && cur.clock !== "running"), "clock " + (cur && cur.clock));

  // ---------------------------------------------------------------- buy and berth an aircraft
  const board0 = await page.evaluate(() => (window.__chq.boardWidth ? window.__chq.boardWidth() : 320)).catch(() => 320);
  const WIDTH = Number(board0) || 320;
  const awayOn = (a, b) => {
    const dx = Math.abs(Number(a.x) - Number(b.x));
    return Math.max(Math.min(dx, Math.abs(WIDTH - dx)), Math.abs(Number(a.y) - Number(b.y)));
  };
  const before = new Set(((await room()).pieces || []).map((p) => p.id));
  await page.click('.navbtn[data-dialog="buy"]').catch(() => {});
  await sleep(250);
  await page.click('button.buyrow[data-kind="aircraft"]');
  const armed = await page.waitForFunction(() => window.__chq.state().placement === true, null, { timeout: 6000, polling: 100 })
    .then(() => true).catch(() => false);
  if (!armed) throw new Error("the aircraft purchase did not arm a placement");
  {
    const view = await room();
    const mine = new Set(((view.sites || []).filter((s) => s.owner === "blue")).map((s) => s.x + "," + s.y));
    const taken = new Set((view.pieces || []).map((p) => p.x + "," + p.y));
    const ports = (view.sites || []).filter((s) => s.owner === "red" && (s.kind === "city" || s.kind === "base"));
    const cells = await page.evaluate(() => window.__chq.legalCells(8000));
    const scored = (cells || [])
      .filter((c) => mine.has(c.x + "," + c.y) && !taken.has(c.x + "," + c.y))
      .map((c) => ({ c, near: ports.length ? Math.min(...ports.map((s) => awayOn(c, s))) : 999 }));
    const inside = scored.filter((s) => s.near <= 6).sort((a, b) => b.near - a.near || b.c.x - a.c.x);
    const berth = inside[0] || scored.sort((a, b) => a.near - b.near)[0] || null;
    if (!berth) throw new Error("no free friendly city/base cell for the aircraft (legal " + (cells || []).length + ")");
    await clickCell(berth.c);
  }
  await page.waitForFunction((ids) => (window.__chq.room().pieces || []).some((p) => !ids.includes(p.id)), [...before], { timeout: 20000, polling: 100 })
    .catch(() => {});
  const plane = ((await room()).pieces || []).find((p) => !before.has(p.id));
  if (!plane) throw new Error("the aircraft never appeared on the board");
  const planeId = String(plane.id);
  const planeNumber = planeId.split(":")[2];
  mark("an aircraft is bought and berthed", true, "plane " + planeId);

  // ---------------------------------------------------------------- the Air panel, both viewports
  async function openAir() {
    await page.evaluate(() => {
      const el = document.querySelector("#dialogClose");
      if (el) el.click();
    }).catch(() => {});
    await page.keyboard.press("Escape").catch(() => {});
    await sleep(120);
    await page.click('.navbtn[data-dialog="air"]').catch(() => {});
    await page.waitForFunction(() => document.querySelectorAll("#dialogBody .airtable .buyrow").length > 0, null, { timeout: 8000, polling: 100 })
      .catch(() => {});
    await sleep(150);
  }

  function readPanel(id) {
    return page.evaluate((wanted) => {
      const table = document.querySelector("#dialogBody .airtable");
      if (!table) return { table: false };
      const rows = [...table.querySelectorAll(".buyrow")];
      const head = rows.find((r) => r.classList.contains("head"));
      const body = rows.filter((r) => !r.classList.contains("head"));
      const row = body.find((r) => r.children[0] && String(r.children[0].dataset.piece || "") === String(wanted))
        || body.find((r) => r.children[0] && String(r.children[0].textContent || "").trim() === String(wanted));
      if (!row) return { table: true, row: false };
      const nameCell = row.children[0];
      // Every leaf element inside the panel body: what the player can actually read.
      const leaves = [...document.querySelectorAll("#dialogBody *")].filter((el) => el.children.length === 0
        && el.tagName !== "SCRIPT" && el.tagName !== "STYLE");
      const visible = leaves.filter((el) => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      });
      const rawLeaves = visible.map((el) => String(el.textContent || "").trim()).filter((t) => /^[a-z]+:[a-z]+:\d+$/i.test(t));
      const bodyText = document.querySelector("#dialogBody").textContent || "";
      return {
        table: true,
        row: true,
        head: head ? [...head.children].map((c) => String(c.textContent || "").trim()) : [],
        name: String(nameCell.textContent || "").trim(),
        dataPiece: nameCell.dataset.piece || "",
        title: nameCell.getAttribute("title") || "",
        rawAircraftId: /[a-z]+:aircraft:\d+/i.test(bodyText),
        rawLeaves,
        rowCount: body.length,
      };
    }, id);
  }

  const panels = {};
  for (const [w, h] of VIEWPORTS) {
    await page.setViewportSize({ width: w, height: h });
    await sleep(200);
    await openAir();
    const panel = await readPanel(planeId);
    panels[w + "x" + h] = panel;
    const tag = "[" + w + "x" + h + "] ";
    mark(tag + "the Air panel renders a table with a row for the plane bought", Boolean(panel.table && panel.row), "rows " + (panel.rowCount || 0));
    mark(tag + "the columns are still Plane / Base / Away / Missions", JSON.stringify(panel.head) === JSON.stringify(["Plane", "Base", "Away", "Missions"]), JSON.stringify(panel.head));
    mark(tag + "the PLANE cell reads a readable label, not the wire id", panel.name === "Aircraft " + planeNumber, "cell \"" + panel.name + "\" for " + planeId);
    mark(tag + "no visible cell in the panel matches a raw piece id", Boolean(panel.rawLeaves && panel.rawLeaves.length === 0), JSON.stringify(panel.rawLeaves || []));
    mark(tag + "the panel's visible text contains no :aircraft: id at all", panel.rawAircraftId === false);
    mark(tag + "the raw id is kept on the cell as data-piece and title", panel.dataPiece === planeId && panel.title === planeId,
      "data-piece=" + panel.dataPiece + " title=" + panel.title);
    await page.screenshot({ path: path.join(OUT, "air-panel-" + w + "x" + h + ".png") });
  }

  // ---------------------------------------------------------------- the order still targets that plane
  // The page's own toast is composed synchronously in the click handler, so it is read in the same
  // evaluate as the click: a later server note (a CAP carries one) overwrites #flash within a frame
  // or two, and polling for it would be a race. The outgoing frame is captured at the socket so the
  // wire id is proved to still be the order's subject.
  const order = await page.evaluate(() => {
    window.__pb299Sent = [];
    if (!window.__pb299Patched) {
      const original = window.WebSocket.prototype.send;
      window.WebSocket.prototype.send = function (data) {
        try { window.__pb299Sent.push(String(data)); } catch (err) { /* not a frame */ }
        return original.call(this, data);
      };
      window.__pb299Patched = true;
    }
    const table = document.querySelector("#dialogBody .airtable");
    const rows = [...(table ? table.querySelectorAll(".buyrow") : [])].filter((r) => !r.classList.contains("head"));
    for (const row of rows) {
      const button = [...row.querySelectorAll(".airmissions button")].find((b) => /Scramble/i.test(String(b.textContent || "")));
      if (button && !button.disabled) {
        button.click();
        const el = document.querySelector("#flash") || document.querySelector("#flashLine");
        return { clicked: String(button.textContent || "").trim(), toast: el ? String(el.textContent || "").trim() : "", sent: window.__pb299Sent.slice() };
      }
    }
    return { clicked: "", toast: "", sent: [] };
  }).catch(() => ({ clicked: "", toast: "", sent: [] }));
  await sleep(400);
  const afterNote = await page.evaluate(() => {
    const el = document.querySelector("#flash") || document.querySelector("#flashLine");
    return el ? String(el.textContent || "").trim() : "";
  }).catch(() => "");
  const frames = (order.sent || []).map((raw) => {
    try { return JSON.parse(raw); } catch (err) { return null; }
  }).filter(Boolean);
  const missionFrame = frames.find((f) => f && f.op === "mission" && f.mode !== undefined);
  mark("a mission button is clicked", Boolean(order.clicked), order.clicked);
  mark("the toast names the plane by label and never by wire id",
    order.toast.includes("Aircraft " + planeNumber) && !ANY_RAW_ID.test(order.toast), "toast \"" + order.toast + "\"");
  mark("the order frame still carries the wire id as its piece",
    Boolean(missionFrame) && String(missionFrame.piece) === planeId,
    missionFrame ? JSON.stringify({ op: missionFrame.op, piece: missionFrame.piece, mode: missionFrame.mode }) : "no mission frame");
  mark("no visible toast text carries a raw id after the server's note", !ANY_RAW_ID.test(afterNote), "flash \"" + afterNote + "\"");
  mark("no page error", pageErrors.length === 0, pageErrors.join(" | "));

  writeFileSync(path.join(OUT, MUTANT ? "pb299-page-mutant-" + MUTANT + ".json" : "pb299-page.json"), JSON.stringify({
    base: BASE, tree: serverTree, mutant: MUTANT || null, planeId, planeNumber, panels,
    clicked: order.clicked, toast: order.toast, afterNote, missionFrame: missionFrame || null, pageErrors,
    steps: evidence, passed: evidence.filter((e) => e.ok).length, failed,
  }, null, 2));
} catch (err) {
  mark("the leg ran to its end", false, String(err && err.stack || err));
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.kill("SIGKILL");
}

const passed = evidence.filter((e) => e.ok).length;
// The mutant verdict: the two negative assertions must be RED under the planted defect, and the
// leg must have reached them. Any of them green means the mutant survived.
const NEGATIVES = ["the PLANE cell reads a readable label, not the wire id",
  "no visible cell in the panel matches a raw piece id",
  "the panel's visible text contains no :aircraft: id at all",
  "the toast names the plane by label and never by wire id"];
let verdict = failed === 0;
if (MUTANT) {
  const survived = evidence.filter((e) => e.ok && NEGATIVES.some((needle) => e.step.includes(needle)));
  const sawRed = evidence.some((e) => !e.ok && NEGATIVES.some((needle) => e.step.includes(needle)));
  verdict = survived.length === 0 && sawRed;
  console.log("pb299 mutant " + MUTANT + ": " + (verdict ? "KILLED" : "SURVIVED")
    + (survived.length ? " — still green: " + survived.map((s) => s.step).join(" | ") : ""));
} else {
  console.log("pb299 plane label: " + passed + " passed / " + failed + " failed");
}
console.log("evidence " + OUT);
process.exit(verdict ? 0 : 1);
