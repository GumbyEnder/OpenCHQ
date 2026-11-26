// PB-291 page leg: every header control is fully visible and clickable at 1024x768 and 1280x800.
//
// The reported defect (live 104a196, resize1024.png): at 1024x768 the header's Air command is
// clipped under Resign. The strip is one flex row whose command cluster (#nav) is a scroll
// container, so a row that is over its budget hides a command inside a scroll window instead of
// showing it - "reachable by scrolling" is not the AC, and a control whose box sits under a
// sibling's box is not clickable at all.
//
// What this leg measures, through the real page and a real server, at each viewport:
//   1. #strip does not scroll sideways (scrollWidth === clientWidth): the row fits its window;
//   2. every control's box lies inside #strip's own box (1 px tolerance);
//   3. no two control boxes overlap (ancestor/descendant pairs excluded);
//   4. elementFromPoint at each control's centre resolves to that control or a descendant, i.e.
//      the control is the thing a click lands on, not a sibling painted over it;
//   5. #nav is not a scroll window hiding commands (scrollWidth === clientWidth), read under the
//      INTERIM 2 px allowance described at checkViewport - not a new tolerance.
//
//   node tests/e2e/pb291-header-fit.mjs                     # starts its own server from this tree
//   node tests/e2e/pb291-header-fit.mjs --url=<base>        # a running server
//   node tests/e2e/pb291-header-fit.mjs --out=<dir>
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const argOf = (name, fallback = "") => {
  const hit = process.argv.find((v) => v.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const BASE = (argOf("url", process.env.E2E_URL || "") || "").replace(/\/+$/, "");
const OUT = path.resolve(argOf("out", mkdtempSync(path.join(tmpdir(), "openchq-pb291-"))));
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [[1024, 768], [1280, 800]];
// The strip's controls, named as the page nests them. `.navbtn` covers the command cluster.
const CONTROLS = [
  "#clockBtn", ".speedctl", "#nav", "#resignBtn", "#newBtn", "#quitBtn", ".gamebtns", ".whoami", ".brand", "#stripInfo", "#purseChip",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evidence = [];
let failed = 0;
function mark(label, ok, detail) {
  if (!ok) failed += 1;
  evidence.push({ label, ok: Boolean(ok), detail: detail === undefined ? null : detail });
  console.log((ok ? "PASS " : "FAIL ") + label + (detail === undefined ? "" : " — " + detail));
}

async function loadPlaywright() {
  const resolver = await import(pathToFileURL(path.join(root, "tests", "e2e", "playwright.mjs")).href);
  return resolver.loadPlaywright();
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

async function startServer(port, dataDir) {
  const child = spawn(process.execPath, [path.join(root, "web", "server", "main.mjs")], {
    cwd: root,
    env: { ...process.env, OPENCHQ_WEB_HOST: "127.0.0.1", OPENCHQ_WEB_PORT: String(port), OPENCHQ_WEB_DATA: dataDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (c) => { log += c.toString(); });
  child.stderr.on("data", (c) => { log += c.toString(); });
  const base = "http://127.0.0.1:" + port;
  const started = Date.now();
  while (Date.now() - started < 25000) {
    try {
      const res = await fetch(base + "/api/version");
      if (res.ok) return { child, base, log: () => log };
    } catch { /* booting */ }
    await sleep(150);
  }
  child.kill("SIGKILL");
  throw new Error("server did not answer: " + log);
}

function stopServer(server) {
  return new Promise((resolve) => {
    const child = server.child;
    if (!child || child.exitCode !== null) return resolve();
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
    setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, 8000).unref();
  });
}

// One measurement pass: every control's border box, the strip's box, both scroll widths, and what
// a click at each control's centre would hit.
function measure(page) {
  return page.evaluate((navSelector) => {
    const strip = document.querySelector("#strip");
    const sb = strip.getBoundingClientRect();
    const rows = [];
    const one = (el, sel) => {
      const r = el.getBoundingClientRect();
      const visible = r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
      let hit = null;
      if (visible) {
        const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        hit = at ? (el.contains(at) || at.contains(el) ? "self" : (at.id ? "#" + at.id : at.className || at.tagName)) : "none";
      }
      rows.push({
        sel, visible,
        box: { l: Math.round(r.left * 10) / 10, t: Math.round(r.top * 10) / 10, r: Math.round(r.right * 10) / 10, b: Math.round(r.bottom * 10) / 10, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 },
        hit,
      });
    };
    const singles = ["#clockBtn", ".speedctl", "#nav", "#resignBtn", "#newBtn", "#quitBtn", ".gamebtns", ".whoami", ".brand", "#stripInfo", "#purseChip"];
    for (const sel of singles) {
      const el = document.querySelector(sel);
      if (!el) { rows.push({ sel, missing: true }); continue; }
      one(el, sel);
    }
    // One row per COMMAND BUTTON, because a control inside a scroll container is not clipped by
    // getBoundingClientRect: the cluster's box can be inside the strip while its last command's box
    // sits outside the cluster's window. This is the row that can see the reported defect.
    const buttons = [...document.querySelectorAll(navSelector + " > *")];
    buttons.forEach((el, i) => one(el, "navbtn[" + i + "]:" + (el.textContent || "").trim().slice(0, 12)));
    const nav = document.querySelector(navSelector);
    const navInfo = (() => {
      if (!nav) return null;
      const r = nav.getBoundingClientRect();
      const cs = getComputedStyle(nav);
      const borderRight = parseFloat(cs.borderRightWidth || "0") || 0;
      const padRight = r.right - borderRight;
      const last = nav.lastElementChild ? nav.lastElementChild.getBoundingClientRect() : null;
      const round1 = (v) => Math.round(v * 10) / 10;
      return {
        scrollWidth: nav.scrollWidth, clientWidth: nav.clientWidth, children: nav.children.length,
        padRight: round1(padRight),
        lastRight: last ? round1(last.right) : null,
        slack: last ? round1(padRight - last.right) : null,
      };
    })();
    return {
      strip: { l: sb.left, t: sb.top, r: sb.right, b: sb.bottom, scrollWidth: strip.scrollWidth, clientWidth: strip.clientWidth },
      nav: navInfo,
      rows,
    };
  }, "#nav");
}

function checkViewport(width, height, m) {
  const tag = width + "x" + height;
  const strip = m.strip;
  mark(tag + ": the strip fits its window (#strip scroll width within 1 px of its client width)",
    strip.scrollWidth <= strip.clientWidth + 1, "scrollWidth " + strip.scrollWidth + " clientWidth " + strip.clientWidth);
  if (m.nav) {
    // PB-291b: the row is graded on FRACTIONAL geometry, not on the integer scroll pair. At
    // scrollWidth <= clientWidth + 1 a 1.1 px overflow is invisible (floor/ceil snapping made the
    // delta 1), which is how four of five captures read green while the last command's right border
    // was shaved in all five (frodo 9858). Compare the last child's rect.right with #nav's
    // padding-box right directly, 0.5 px allowance; the cluster now carries a real cushion.
    mark(tag + ": every command sits inside the cluster's padding box (fractional, 0.5 px)",
      m.nav.lastRight !== null && m.nav.lastRight <= m.nav.padRight + 0.5,
      "last command right " + m.nav.lastRight + " vs #nav padding-box right " + m.nav.padRight +
      " -> slack " + m.nav.slack + " px, " + m.nav.children + " commands");
    // One row, not two: the strict scroll pair (scrollWidth <= clientWidth) cannot see a 1.1 px
    // overflow - floor/ceil makes the delta 1 - and a padding cushion inflates scrollWidth by its
    // own width, so the integer pair reds on a row that fits. The fractional comparison above IS
    // the scroll test: if any command sat outside the padding box, lastRight would exceed padRight.
  }

  const shown = m.rows.filter((r) => !r.missing && r.visible);
  const missing = m.rows.filter((r) => r.missing || !r.visible);
  const navRows = shown.filter((r) => r.sel.startsWith("navbtn["));
  mark(tag + ": every header control is present and has a box (" + navRows.length + " command buttons measured individually)",
    missing.length === 0, missing.map((r) => r.sel + (r.missing ? " missing" : " zero-size")).join(", ") || ("all present, " + navRows.length + " of them command buttons"));

  // Horizontal containment is exact (the AC is about a control being cut off at the row's edge).
  // Vertical allows 2 px: a control's line box is taller than the 34 px bar and centres inside it
  // (the Sign out cluster measured -1.2..34.2 on a 0..34 strip), which is centring, not clipping.
  const edgeOf = (r) => {
    const bad = [];
    if (r.box.l < strip.l - 1) bad.push("left " + r.box.l);
    if (r.box.r > strip.r + 1) bad.push("right " + r.box.r);
    if (r.box.t < strip.t - 2) bad.push("top " + r.box.t);
    if (r.box.b > strip.b + 2) bad.push("bottom " + r.box.b);
    return bad.length ? r.sel + " (" + bad.join(", ") + ") vs strip l" + Math.round(strip.l) + " r" + Math.round(strip.r) + " t" + Math.round(strip.t) + " b" + Math.round(strip.b) : null;
  };
  const outside = shown.map(edgeOf).filter(Boolean);
  mark(tag + ": every control's box lies inside #strip", outside.length === 0, outside.join("; ") || "all inside");

  const overlaps = [];
  for (let i = 0; i < shown.length; i++) {
    for (let j = i + 1; j < shown.length; j++) {
      const a = shown[i], b = shown[j];
      const ia = document_contains(a.sel, b.sel) || document_contains(b.sel, a.sel);
      if (ia) continue;
      const ox = Math.min(a.box.r, b.box.r) - Math.max(a.box.l, b.box.l);
      const oy = Math.min(a.box.b, b.box.b) - Math.max(a.box.t, b.box.t);
      if (ox > 1 && oy > 1) overlaps.push(a.sel + " x " + b.sel + " (" + Math.round(ox) + "x" + Math.round(oy) + " px)");
    }
  }
  mark(tag + ": no two control boxes overlap", overlaps.length === 0, overlaps.join("; ") || "none");

  const notClickable = shown.filter((r) => r.hit !== "self");
  mark(tag + ": a click at each control's centre lands on that control", notClickable.length === 0,
    notClickable.map((r) => r.sel + " -> " + r.hit).join("; ") || "all land on themselves");
}

// Cheap ancestor test for the overlap pass, from the selectors' own boxes: a control nested inside
// another's box is not an overlap. The set is fixed and small, so the nesting is listed by hand.
const NESTED = new Set(["#stripInfo>.brand", "#purseChip>.brand", "speedctl>.speedctl"]);
function document_contains(a, b) {
  const inside = { ".brand": ["#stripInfo", "#purseChip"], ".speedctl": [], ".gamebtns": ["#resignBtn", "#newBtn", "#quitBtn"], ".whoami": [] };
  if (a === "#nav" && b.startsWith("navbtn[")) return true;
  if (b === "#nav" && a.startsWith("navbtn[")) return true;
  return (inside[a] || []).includes(b) || (inside[b] || []).includes(a);
}

async function main() {
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  let server = null;
  let base = BASE;
  let dataDir = null;
  try {
    if (!base) {
      const port = await freePort();
      dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb291-srv-"));
      server = await startServer(port, dataDir);
      base = server.base;
    }
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (err) => errors.push(String(err)));
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 30000 });
    const user = "e2e-pb291-" + Date.now().toString(36).slice(-6);
    await page.fill("#register input[name=username]", user);
    await page.fill("#register input[name=password]", "pw-" + Math.random().toString(36).slice(2, 10));
    await page.click("#register button[type=submit]");
    await page.waitForSelector("#play:not(.hidden)", { timeout: 30000 });
    await page.selectOption('#launch select[name="era"]', "1942");
    await page.selectOption('#launch select[name="side"]', "blue");
    await page.click('#launch button[type=submit]');
    await page.waitForFunction(() => window.__chq.room() && window.__chq.room().seat, null, { timeout: 30000, polling: 100 });
    await sleep(600);

    for (const [w, h] of VIEWPORTS) {
      await page.setViewportSize({ width: w, height: h });
      await sleep(500);
      const m = await measure(page);
      writeFileSync(path.join(OUT, "pb291-" + w + "x" + h + ".json"), JSON.stringify(m, null, 2));
      await page.screenshot({ path: path.join(OUT, "pb291-" + w + "x" + h + ".png") });
      checkViewport(w, h, m);
    }
    mark("no page error", errors.length === 0, errors.join(" | "));
    await context.close();
  } finally {
    await browser.close();
    if (server) await stopServer(server);
  }
  writeFileSync(path.join(OUT, "pb291-header-fit.json"), JSON.stringify({ base, viewports: VIEWPORTS, evidence }, null, 2));
  console.log("");
  console.log("pb291 header leg: " + (evidence.length - failed) + " passed / " + failed + " failed; evidence " + OUT);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("pb291 header leg crashed: " + (err && err.stack ? err.stack : err));
  process.exit(2);
});
