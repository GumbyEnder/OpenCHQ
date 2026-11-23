// T-020 evidence shots (D-023): the 1942 round-0 board with tokens, both sides, at the whole-world
// fit and at the maximum zoom, on Classic (D) and the dark tactical theme (C), with a selected unit.
//
// Fog is a DATA property of the era, not a theme: 1942 draws no fog at round 0 (T-019's own matrix
// records "a missing fog in 1942 is NOT a fail"). The brief asks for tokens with fog visible, so the
// fog exhibit is the Concealed (9999) era, where the painter really does draw the fog layer; the
// shot records paintReport().fogged and the layer list from the frame itself.
//
//   node t020-shots.mjs --url=http://127.0.0.1:8120 --out=/mnt/nas/projects/OpenCHQ/local/t020-shots
//
// Screenshots are board pixels of a live match: they belong outside the repo, under local/.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadPlaywright } from "./playwright.mjs";

const arg = (name, fallback = "") => {
  const hit = process.argv.find((v) => v.startsWith("--" + name + "="));
  if (hit) return hit.slice(name.length + 3);
  return fallback;
};
const BASE = (arg("url", "") || "").replace(/\/+$/, "");
const OUT = arg("out", "/mnt/nas/projects/OpenCHQ/local/t020-shots");
if (!BASE) { console.error("usage: node t020-shots.mjs --url=<base> --out=<dir>"); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const THEME = { C: "Dark tactical", D: "Classic" };

async function main() {
  mkdirSync(OUT, { recursive: true });
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  // #quitBtn asks with a native confirm(); Playwright dismisses it by default, so the quit click
  // silently did nothing and the lobby never came back (measured: room() still true after reload).
  page.on("dialog", (dialog) => dialog.accept());

  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 30000 });
  if (!(await page.evaluate(() => Boolean(window.__chq && window.__chq.me())))) {
    const name = "t020" + Date.now().toString(36).slice(-8);
    const password = "pw-" + Math.random().toString(36).slice(2, 12);
    await page.fill("#register input[name=username]", name);
    await page.fill("#register input[name=password]", password);
    await page.click("#register button[type=submit]");
    await page.waitForSelector("#play:not(.hidden)", { timeout: 30000 });
  }

  // Theme is a client-side preference with a one-click in-match switch (T-019 AC1/AC4). Switching
  // in the room avoids a reload, and a reload can auto-resume the seat and hide the launch form.
  const themeLabel = () => page.evaluate(() => (document.getElementById("themeToggle").textContent || "").replace(/^Map:\s*/, ""));
  const setTheme = async (label) => {
    for (let i = 0; i < 3 && (await themeLabel()) !== label; i++) {
      await page.click("#themeToggle");
      await sleep(250);
    }
    return themeLabel();
  };
  const quitRoom = async () => {
    if (await page.evaluate(() => Boolean(window.__chq.room()))) {
      await page.click("#quitBtn");
      await page.waitForFunction(() => !window.__chq.room(), null, { timeout: 15000 }).catch(() => {});
    }
  };
  const newGame = async (era) => {
    await quitRoom();
    await page.waitForFunction(() => !window.__chq.toast(), null, { timeout: 12000 }).catch(() => {});
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
    await page.evaluate(() => window.__chq.send({ op: "hold" })).catch(() => {});
    await page.waitForFunction(() => (window.__chq.room().pieces || []).length > 0, null, { timeout: 30000, polling: 100 });
    await page.evaluate(() => document.getElementById("camFit").click());
    await sleep(300);
  };

  const version = await (await page.request.get(BASE + "/api/version")).json();
  const shots = [];
  const shot = async (name, note) => {
    const file = path.join(OUT, "t020-" + name + ".png");
    await page.screenshot({ path: file });
    const report = await page.evaluate(() => window.__chq.paintReport());
    shots.push({ name, file, note, fogged: report && report.fogged, layers: report && report.layers, pieces: report && report.pieces });
    return file;
  };

  // Centre a cell (or a midpoint) with the page's own right-drag pan, at the camera's max zoom.
  const centreOn = async (cx, cy) => {
    await page.evaluate(() => document.getElementById("camFit").click());
    await sleep(200);
    for (let i = 0; i < 14; i++) {
      await page.evaluate(() => document.getElementById("camIn").click());
      await sleep(45);
    }
    for (let pass = 0; pass < 3; pass++) {
      const at = await page.evaluate(([x, y]) => window.__chq.cellToScreen(x, y), [cx, cy]);
      const box = await page.locator("#board").boundingBox();
      const want = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      const dx = want.x - at.x;
      const dy = want.y - at.y;
      if (Math.hypot(dx, dy) < 4) break;
      await page.mouse.move(want.x, want.y);
      await page.mouse.down({ button: "right" });
      await page.mouse.move(want.x + dx, want.y + dy, { steps: 6 });
      await page.mouse.up({ button: "right" });
      await sleep(120);
    }
    return page.evaluate(() => window.__chq.state().camera.scale);
  };

  const results = {};
  const room1942 = [];
  await newGame("1942");
  for (const theme of ["C", "D"]) {
    const actual = await setTheme(THEME[theme]);
    const room = await page.evaluate(() => {
      const r = window.__chq.room();
      const list = (r.pieces || []).map((p) => ({ id: p.id, side: p.side, kind: p.kind, x: p.x, y: p.y }));
      let best = null;
      for (const b of list.filter((p) => p.side === "blue")) {
        for (const e of list.filter((p) => p.side === "red")) {
          const d = Math.max(Math.abs(b.x - e.x), Math.abs(b.y - e.y));
          if (!best || d < best.d) best = { d, blue: b, red: e };
        }
      }
      return { era: r.era, round: r.round, count: list.length,
        blue: list.filter((p) => p.side === "blue").length,
        red: list.filter((p) => p.side === "red").length,
        kinds: [...new Set(list.map((p) => p.kind || "untyped"))],
        best, sample: list.find((p) => p.side === r.you) || list[0] };
    });
    room1942.push(room);
    const label = THEME[theme];
    const fit = await shot(theme + "-fit", "1942 round 0, both sides, whole-world fit, theme " + label);
    const scale = await centreOn((room.best.blue.x + room.best.red.x) / 2, (room.best.blue.y + room.best.red.y) / 2);
    const max = await shot(theme + "-max", "1942 round 0, max zoom (" + scale + " px/cell) on the closest blue/red pair, Chebyshev " + room.best.d + ", theme " + label);
    // Select the blue member of the pair - it is the piece in the middle of the frame.
    const blueAt = await page.evaluate((p) => window.__chq.cellToScreen(p.x, p.y), room.best.blue);
    await page.mouse.click(blueAt.x, blueAt.y);
    await sleep(250);
    const selected = await page.evaluate(() => window.__chq.state().selected);
    const sel = await shot(theme + "-selected", "1942 round 0, selected " + (selected || "none") + " (white ring), theme " + label);
    results[theme] = { label, actual, scale, selected, fit, max, selectedShot: sel };
  }

  // Fog: the Concealed era is the one that darkens the ground at round 0 (T-019 matrix).
  const fog = {};
  await quitRoom();
  await newGame("9999");
  for (const theme of ["C", "D"]) {
    await setTheme(THEME[theme]);
    const room = await page.evaluate(() => {
      const r = window.__chq.room();
      return { era: r.era, round: r.round, count: (r.pieces || []).length,
        blue: (r.pieces || []).filter((p) => p.side === "blue").length,
        red: (r.pieces || []).filter((p) => p.side === "red").length };
    });
    const file = await shot("fog-" + theme, "Concealed (9999) round 0, tokens under the fog layer, theme " + THEME[theme]);
    fog[theme] = { room, file, label: THEME[theme] };
  }

  // Stack exhibit. 1942 round 0 has no co-located or badge-width-adjacent friends (measured on the
  // room payload), so the disc is exhibited from the shipped painter itself with three friendly
  // pieces on one cell - the same group badgeGroups() makes on a stored stack.
  const stackFile = path.join(OUT, "t020-stack-exhibit.png");
  const stack = await page.evaluate(async () => {
    const badges = await import("/badges.mjs");
    const render = await import("/render.mjs");
    document.body.innerHTML = "";
    document.body.style.background = "#0d1220";
    const canvas = document.createElement("canvas");
    canvas.width = 360; canvas.height = 150;
    canvas.style.cssText = "margin:12px;background:#0d1220;border:1px solid #22314c";
    document.body.append(canvas);
    const ctx = canvas.getContext("2d");
    const pieces = [
      { id: "s1", kind: "tank", side: "blue", x: 0, y: 0, strength: 90, maxStrength: 100, path: [], facing: null, fighting: null },
      { id: "s2", kind: "infantry", side: "blue", x: 0, y: 0, strength: 60, maxStrength: 100, path: [], facing: null, fighting: null },
      { id: "s3", kind: "infantry", side: "blue", x: 0, y: 0, strength: 30, maxStrength: 100, path: [], facing: null, fighting: null },
    ];
    const draw = (side, cx) => {
      const list = side === "blue" ? pieces : pieces.map((p) => ({ ...p, id: p.id + "r", side: "red" }));
      const [group] = badges.badgeGroups(list, 20, 14);
      render.paintBadge(ctx, group, { scale: 20, left: cx - 10, top: 40, viewW: canvas.width, viewH: canvas.height, boardW: 320, boardH: 136 }, { badgeMinPx: 14 });
      return { side, count: group.count, hover: badges.badgeHoverText(group) };
    };
    ctx.font = "12px ui-sans-serif,system-ui,sans-serif";
    ctx.fillStyle = "#9fb4d8";
    ctx.fillText("blue stack (3)", 40, 20);
    ctx.fillText("red stack (3)", 230, 20);
    const blue = draw("blue", 70);
    const red = draw("red", 260);
    return { blue, red };
  });
  await sleep(150);
  await page.screenshot({ path: stackFile });

  const summary = { url: BASE, rooms: room1942, version, themes: results, fog, stack: { file: stackFile, ...stack },
    shots, pageErrors: errors, at: new Date().toISOString() };
  writeFileSync(path.join(OUT, "t020-summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  await browser.close();
  const fogged = shots.filter((s) => Number(s.fogged) > 0).length;
  console.log("SHOTS=" + shots.length + " FOGGED=" + fogged);
}

main().catch((error) => { console.error("FAIL " + (error && error.stack ? error.stack : error)); process.exit(1); });
