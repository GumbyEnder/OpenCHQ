// PB-181b page leg: at 1024x768 Sign out exists, is reachable and is clickable — and the fix did not
// buy that by collapsing the command window.
//
// The defect (PM 9690, frodo 9699 §4): `@media (max-width: 1100px) { body.in-match #account {
// display: none } }` hid the whole account cluster, so Sign out was 0x0 at every era at 1024x768.
// A DOM .click() still fired the handler, which is how the old click-only reading stayed green while
// no pointer could reach the control.
//
// The shape measured here (PM 9700 §2, "shape D"): inside a match at <=1100 px #account stays laid
// out and only `.who` (the handle text) is hidden; the Sign out button carries the full name in its
// title. That is the smallest change that makes the control paintable.
//
// What this leg asserts, at 1024x768 in ALL FOUR eras:
//   1. the strip does not overflow its own width;
//   2. #account is laid out and `.who` is not — the handle gives way, not the control;
//   3. Sign out is inside the viewport, its centre hit-tests to itself, and its left edge clears
//      #quitBtn's right edge by >= 8 px;
//   4. #nav keeps a usable window: clientWidth >= 100 px, all 8 commands scroll-reachable, and each
//      one passes Playwright's OWN actionability check (click({trial:true}) — it runs the whole
//      visible/stable/receives-events gate without dispatching the click, so no command fires).
//      The row carries TEN .navbtn at this base (PB-272 added Paths and Satellites), so the arm
//      counts the DOM's own set and requires all of it — the AC's 8 is a floor, not a cap.
//   5. a REAL click on Sign out (no force:true) returns the page to the sign-in gate.
// The 1280/1440 arms stay the PB-276 leg and the two host arms; this file is the 1024 half only.
//
//   node tests/e2e/pb181b-signout-1024.mjs                 # starts its own server from this tree
//   node tests/e2e/pb181b-signout-1024.mjs --url=<base>    # a running server
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright } from "./playwright.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const GIVEN = (process.argv.find((v) => v.startsWith("--url=")) || "").slice(6).replace(/\/+$/, "") ||
  (process.env.E2E_URL || "").replace(/\/+$/, "");
const WIDTH = 1024;
const HEIGHT = 768;
const ERAS = ["1918", "1942", "1986", "2023"];
const NAV_FLOOR = 100;
const MIN_GAP = 8;
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
    const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb181b-"));
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
  const open = async () => {
    const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT } });
    const page = await context.newPage();
    const errs = [];
    page.on("pageerror", (e) => errs.push(String(e).slice(0, 200)));
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 30000 });
    if (!(await page.evaluate(() => Boolean(window.__chq && window.__chq.me())))) {
      // 26 characters: the handle length that used to eat the Sign out control (PB-187b), so `.who`
      // is genuinely wide when the CSS hides it instead of being empty for free.
      const name = ("who" + Date.now().toString(36) + "abcdefghijklmnopq").slice(0, 26);
      await page.fill("#register input[name=username]", name);
      await page.fill("#register input[name=password]", "pw-" + Math.random().toString(36).slice(2, 12));
      await page.click("#register button[type=submit]");
      await page.waitForSelector("#play:not(.hidden)", { timeout: 30000 });
      return { context, page, errs, name };
    }
    const name = await page.evaluate(() => window.__chq.me());
    return { context, page, errs, name };
  };
  const enter = async (page, era) => {
    await page.selectOption('#launch select[name="era"]', era);
    await page.selectOption('#launch select[name="side"]', "blue");
    await page.click('#launch button[type=submit]');
    await page.waitForFunction((e) => window.__chq.room() && String(window.__chq.room().era) === e, era, { timeout: 30000, polling: 100 });
    await page.waitForTimeout(900);
  };

  for (const era of ERAS) {
    const { context, page, errs, name } = await open();
    await enter(page, era);

    const g = await page.evaluate(({ navFloor, minGap }) => {
      const vw = document.documentElement.clientWidth;
      const strip = document.getElementById("strip");
      const box = (el) => [Math.round(el.getBoundingClientRect().left), Math.round(el.getBoundingClientRect().top),
        Math.round(el.getBoundingClientRect().right), Math.round(el.getBoundingClientRect().bottom)];
      const account = document.getElementById("account");
      const who = account ? account.querySelector(".who") : null;
      const ghost = account ? [...account.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "Sign out") : null;
      const quit = document.getElementById("quitBtn");
      const nav = document.getElementById("nav");
      let out = null;
      if (ghost) {
        const r = ghost.getBoundingClientRect();
        const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
        const top = document.elementsFromPoint(cx, cy)[0];
        out = {
          rect: box(ghost),
          title: ghost.title,
          inViewport: r.left >= 0 && r.right <= vw && r.height > 0,
          hitSelf: Boolean(top && (top === ghost || ghost.contains(top))),
          top: top ? (top.id || top.className || top.tagName) : "none",
          clearsQuitBy: quit ? Math.round(r.left - quit.getBoundingClientRect().right) : null,
        };
      }
      // every command: scroll it into the nav's window and see who owns its centre
      const cmds = [...nav.querySelectorAll(".navbtn")].map((b) => {
        b.scrollIntoView({ inline: "center", block: "nearest" });
        const r = b.getBoundingClientRect();
        const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
        const top = document.elementsFromPoint(cx, cy)[0];
        return {
          text: (b.textContent || "").trim().slice(0, 14),
          rect: box(b),
          inViewport: r.left >= 0 && r.right <= vw,
          hitSelf: Boolean(top && (top === b || b.contains(top))),
          top: top ? (top.id || top.className || top.tagName) : "none",
        };
      });
      nav.scrollLeft = 0;
      return {
        viewport: vw,
        strip: { sw: strip.scrollWidth, cw: strip.clientWidth },
        account: {
          present: Boolean(account),
          rects: account ? account.getClientRects().length : 0,
          rect: account ? box(account) : null,
          whoRects: who ? who.getClientRects().length : null,
        },
        ghost: out,
        nav: { rects: nav.getClientRects().length, cw: nav.clientWidth, sw: nav.scrollWidth, floor: navFloor, minGap },
        cmds,
      };
    }, { navFloor: NAV_FLOOR, minGap: MIN_GAP });

    mark(`1024x768 ${era}: the strip does not overflow its own width`,
      g.strip.sw <= g.strip.cw, `${g.strip.sw}/${g.strip.cw}`);
    mark(`1024x768 ${era}: #account is laid out and only the handle is hidden`,
      g.account.present && g.account.rects > 0 && g.account.whoRects === 0,
      `account=${g.account.rect ? g.account.rect.join("..") : "absent"} whoRows=${g.account.whoRects}`);
    mark(`1024x768 ${era}: Sign out is in the viewport, owns its centre and clears Quit by >= 8 px`,
      Boolean(g.ghost && g.ghost.inViewport && g.ghost.hitSelf && g.ghost.clearsQuitBy >= MIN_GAP),
      g.ghost ? `rect ${g.ghost.rect.join("..")} top=${g.ghost.top} clearBy=${g.ghost.clearsQuitBy}` : "Sign out absent");
    mark(`1024x768 ${era}: the Sign out title carries the full handle`,
      Boolean(g.ghost && typeof g.ghost.title === "string" && g.ghost.title.includes(name) && g.ghost.title.includes("Sign out")),
      JSON.stringify(g.ghost ? g.ghost.title : null));
    mark(`1024x768 ${era}: the command window keeps >= ${NAV_FLOOR} px`,
      g.nav.cw >= NAV_FLOOR, `#nav ${g.nav.cw}/${g.nav.sw} (floor ${NAV_FLOOR})`);
    mark(`1024x768 ${era}: all ${g.cmds.length} commands are scroll-reachable and own their centres`,
      g.cmds.length >= 8 && g.cmds.every((c) => c.hitSelf && c.inViewport),
      g.cmds.map((c) => `${c.text}->${c.top}${c.hitSelf ? "" : " MISS"}${c.inViewport ? "" : " OFFSCREEN"}`).join(" "));

    // Playwright's own actionability gate for each command: it scrolls the button into the nav's
    // window, waits for it to be stable and to RECEIVE the pointer event, then — with trial:true —
    // stops without dispatching. force:true would skip exactly the check this ticket is about.
    const n = await page.locator("#nav .navbtn").count();
    let blocked = [];
    for (let i = 0; i < n; i += 1) {
      const loc = page.locator("#nav .navbtn").nth(i);
      const label = (await loc.textContent() || "").trim().slice(0, 14);
      try {
        await loc.click({ trial: true, timeout: 8000 });
      } catch (err) {
        blocked.push(`${label}: ${String(err).split("\n")[0].slice(0, 90)}`);
      }
    }
    mark(`1024x768 ${era}: every command passes Playwright actionability (trial, no dispatch)`,
      n >= 8 && blocked.length === 0, blocked.join(" | ") || `${n}/${n} reachable`);

    // The arm the defect hid behind: a real pointer click, no force:true.
    let signedOut = true;
    let detail = "one real click, no force:true";
    try {
      await page.click("#account button.ghost", { timeout: 8000 });
      await page.waitForSelector("#gate:not(.hidden)", { timeout: 20000 });
      const room = await page.evaluate(() => Boolean(window.__chq && window.__chq.room()));
      if (room) { signedOut = false; detail = "room still set after the click"; }
    } catch (err) {
      signedOut = false;
      detail = String(err).split("\n")[0].slice(0, 160);
    }
    mark(`1024x768 ${era}: a real click on Sign out reaches the sign-in gate`, signedOut, detail);
    mark(`1024x768 ${era}: no page error while the strip laid out`, errs.length === 0, errs.join(" | ") || "none");

    await context.close();
  }

  await browser.close();
  if (child) child.kill("SIGTERM");
  const total = rows.length;
  console.log(`\npb181b-signout-1024: ${total - failed} passed / ${failed} failed / ${total} checks`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("LEG_CRASH", err && err.stack ? err.stack.split("\n").slice(0, 4).join(" | ") : String(err));
  process.exit(2);
});
