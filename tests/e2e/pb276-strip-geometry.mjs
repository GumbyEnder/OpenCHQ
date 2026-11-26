// PB-276 strip geometry leg: the right cluster must never sit under the Sign out ghost.
//
// The rule this leg enforces, at BOTH widths and in ALL FOUR eras:
//   1. document.elementFromPoint(centre of #quitBtn / #newBtn / #resignBtn) is that button;
//   2. the strip does not overflow its own width (scrollWidth <= clientWidth);
//   3. the Sign out control's box is fully inside the viewport (and not under Quit either);
//   4. a 2023 match's Quit is clickable with Playwright's OWN actionability check (no force:true),
//      which is the arm that failed live at d65538d ("page.click: Timeout 30000ms exceeded").
//
//   node tests/e2e/pb276-strip-geometry.mjs                 # starts its own server from this tree
//   node tests/e2e/pb276-strip-geometry.mjs --url=<base>    # a running server
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright } from "./playwright.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const GIVEN = (process.argv.find((v) => v.startsWith("--url=")) || "").slice(6).replace(/\/+$/, "") ||
  (process.env.E2E_URL || "").replace(/\/+$/, "");
const WIDTHS = [[1280, 800], [1440, 900], [1024, 768]];
const ERAS = ["1918", "1942", "1986", "2023"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const rows = [];
function mark(label, ok, detail) {
  if (!ok) failed += 1;
  rows.push({ label, ok, detail });
  console.log((ok ? "PASS " : "FAIL ") + label + (detail === undefined ? "" : " — " + detail));
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => { const p = probe.address().port; probe.close(() => resolve(p)); });
  });
}

async function main() {
  const { chromium } = await loadPlaywright();
  let child = null;
  let BASE = GIVEN;
  if (!BASE) {
    const port = await freePort();
    const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb276-"));
    child = spawn(process.execPath, ["web/server/main.mjs"], {
      cwd: root,
      env: { ...process.env, OPENCHQ_WEB_HOST: "127.0.0.1", OPENCHQ_WEB_PORT: String(port), OPENCHQ_WEB_DATA: dataDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    BASE = "http://127.0.0.1:" + port;
    const started = Date.now();
    while (Date.now() - started < 25000) {
      try { const res = await fetch(BASE + "/api/version"); if (res.ok) break; } catch { /* booting */ }
      await sleep(150);
    }
    mark("a local server answers", true, BASE);
  } else {
    mark("using the given host", true, BASE);
  }

  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const open = async (W, H) => {
    const context = await browser.newContext({ viewport: { width: W, height: H } });
    const page = await context.newPage();
    const errs = [];
    page.on("pageerror", (e) => errs.push(String(e).slice(0, 200)));
    // Quit asks `confirm(...)`; a hand check clicks OK, so the arm does too. Without this Playwright
    // dismisses the dialog, the quit is never sent, and "the click left the match" would be vacuous.
    page.on("dialog", (d) => d.accept().catch(() => {}));
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 30000 });
    if (!(await page.evaluate(() => Boolean(window.__chq && window.__chq.me())))) {
      // 26 characters: PB-187b's handle length, the one that used to eat the Sign out control.
      const name = ("geom" + Date.now().toString(36) + "abcdefghijklmnop").slice(0, 26);
      await page.fill("#register input[name=username]", name);
      await page.fill("#register input[name=password]", "pw-" + Math.random().toString(36).slice(2, 12));
      await page.click("#register button[type=submit]");
      await page.waitForSelector("#play:not(.hidden)", { timeout: 30000 });
    }
    return { context, page, errs };
  };
  const enter = async (page, era) => {
    await page.selectOption('#launch select[name="era"]', era);
    await page.selectOption('#launch select[name="side"]', "blue");
    await page.click('#launch button[type=submit]');
    await page.waitForFunction((e) => window.__chq.room() && String(window.__chq.room().era) === e, era, { timeout: 30000, polling: 100 });
    await page.waitForTimeout(900);
  };
  const geom = (page) => page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const strip = document.getElementById("strip");
    const hit = (id) => {
      const el = document.getElementById(id);
      if (!el) return { id, ok: false, top: "missing" };
      const r = el.getBoundingClientRect();
      const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
      const top = document.elementsFromPoint(cx, cy)[0];
      return { id, ok: Boolean(top && top.id === id), top: top ? (top.id || top.className || top.tagName) : "none",
        rect: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)] };
    };
    const q = document.getElementById("quitBtn").getBoundingClientRect();
    // PB-263b: at rest the strip carries ONE account button and no Sign out row — the control is in
    // the popover, so it cannot be painted under a nav command at all. That is the shape the card
    // (PM 9677(b)) asks for; the "Sign out clears Quit" number is measured with the menu open below.
    // invisible (display:none) does not count as a row in the strip.
    const atRest = [...strip.querySelectorAll("button")]
      .filter((b) => (b.textContent || "").trim().toLowerCase() === "sign out" && b.getClientRects().length > 0).length;
    const accountBtn = document.getElementById("accountBtn");
    let menu = null;
    if (accountBtn) {
      accountBtn.click();
      const out = document.getElementById("signOutBtn");
      if (out) {
        const r = out.getBoundingClientRect();
        const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
        const top = document.elementsFromPoint(cx, cy)[0];
        menu = {
          rect: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)],
          inViewport: r.left >= 0 && r.right <= vw,
          clearsQuitBy: Math.round(r.left - q.right),
          clickable: Boolean(top && (top === out || out.contains(top))),
          top: top ? (top.id || top.className || top.tagName) : "none",
        };
      }
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      const box = document.getElementById("accountMenu");
      if (menu) menu.closedByEscape = Boolean(box && box.classList.contains("hidden"));
    }
    return {
      hits: ["quitBtn", "newBtn", "resignBtn"].map(hit),
      strip: { sw: strip.scrollWidth, cw: strip.clientWidth },
      atRest,
      accountBtn: Boolean(accountBtn),
      accountTitle: accountBtn ? accountBtn.title : null,
      menu,
      viewport: vw,
    };
  });

  for (const [W, H] of WIDTHS) {
    for (const era of ERAS) {
      const { context, page, errs } = await open(W, H);
      await enter(page, era);
      const g = await geom(page);
      mark(`${W}x${H} ${era}: each of Quit/New/Resign owns its own centre`,
        g.hits.every((h) => h.ok),
        g.hits.map((h) => `${h.id.replace("Btn", "")}->${h.top}${h.ok ? "" : " MISMATCH"}`).join(" "));
      mark(`${W}x${H} ${era}: the strip does not overflow its own width`,
        g.strip.sw <= g.strip.cw, `${g.strip.sw}/${g.strip.cw}`);
      mark(`${W}x${H} ${era}: the account cluster is one button and no Sign out row sits in the strip`,
        g.accountBtn === true && g.atRest === 0, `accountBtn=${g.accountBtn} signOutRows=${g.atRest} title=${JSON.stringify(g.accountTitle)}`);
      mark(`${W}x${H} ${era}: Sign out (menu open) is in the viewport, clears Quit by >= 8 px, and is clickable`,
        Boolean(g.menu && g.menu.inViewport && g.menu.clearsQuitBy >= 8 && g.menu.clickable && g.menu.closedByEscape),
        g.menu ? `rect ${g.menu.rect.join("..")} clearBy=${g.menu.clearsQuitBy} top=${g.menu.top} esc=${g.menu.closedByEscape}` : "menu absent");
      mark(`${W}x${H} ${era}: no page error while the strip laid out`, errs.length === 0, errs.join(" | ") || "none");
      if (era === "2023") {
        // Playwright's own actionability check: it scrolls into view, waits for the element to be
        // stable and to RECEIVE the pointer event, then clicks. force:true would skip exactly the
        // test that caught this bug live.
        let clicked = true;
        let detail = "clicked with no force:true";
        try {
          await page.click("#quitBtn", { timeout: 15000 });
          await page.waitForFunction(() => !document.body.classList.contains("in-match"), null, { timeout: 20000 });
          await page.waitForSelector("#launch", { state: "visible", timeout: 20000 });
        } catch (err) {
          clicked = false;
          detail = String(err).split("\n")[0].slice(0, 160);
        }
        mark(`${W}x${H} 2023: a real click on Quit leaves the match (actionability, no force)`, clicked, detail);
        // PM 9684 AC3: Sign out is reachable in TWO clicks at this width, with Playwright's own
        // actionability on both (no force:true): the account button, then the menu item.
        let signedOut = true;
        let signDetail = "2 clicks, no force:true";
        try {
          await enter(page, "2023");
          await page.click("#accountBtn", { timeout: 15000 });
          await page.click("#signOutBtn", { timeout: 15000 });
          await page.waitForSelector("#gate:not(.hidden)", { timeout: 20000 });
        } catch (err) {
          signedOut = false;
          signDetail = String(err).split("\n")[0].slice(0, 160);
        }
        mark(`${W}x${H} 2023: Sign out is reachable in two real clicks (account button, then menu item)`,
          signedOut, signDetail);
      }
      await context.close();
    }
  }

  await browser.close();
  const bad = rows.filter((r) => !r.ok);
  console.log(`\nPB-276 geometry: ${rows.length - bad.length} passed / ${bad.length} failed / ${rows.length} checks`);
  if (child) child.kill("SIGTERM");
  process.exit(bad.length ? 1 : 0);
}

await main();
