// T-009 AC10: the live combat hand-check.
//
// One fight, on the deployed build, driven through the real page and the real socket: a bought tank
// is ordered into contact, and the enemy's strength delta is compared with the cell of the 0x18f0
// pairing matrix that the shipped config says applies. Every number below comes out of
// window.__chq.room(); the only local read is config/game.json, to name the expected cell.
//
//   node tests/e2e/combat-handcheck.mjs --url=https://openchq-web-production.up.railway.app
//   node tests/e2e/combat-handcheck.mjs --url=http://127.0.0.1:8094 --out=/tmp/hc
//
// Screenshots and the JSON evidence land in --out (default notes/t009/handcheck-live).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

function argOf(name, fallback = "") {
  const hit = process.argv.find((value) => value.startsWith("--" + name + "="));
  if (hit) return hit.slice(name.length + 3);
  const index = process.argv.indexOf("--" + name);
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith("--")) return process.argv[index + 1];
  return fallback;
}

const BASE = (argOf("url", process.env.E2E_URL || "") || "").replace(/\/+$/, "");
if (!BASE) {
  console.error("usage: node tests/e2e/combat-handcheck.mjs --url=<base url> [--out=<dir>]");
  process.exit(2);
}
const OUT = path.resolve(argOf("out", path.join(process.env.HOME || ".", "agents", "game", "notes", "t009", "handcheck-live")));
mkdirSync(OUT, { recursive: true });
const ERA = argOf("era", "1942");
const WAIT_MS = Number(argOf("wait", "600000")) || 600000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const config = JSON.parse(readFileSync(path.join(root, "config", "game.json"), "utf8"));
const matrix = config.combat.measured.value.damageMatrix;
const kindCode = matrix.kinds;
const cellFor = (attacker, defender) => {
  const a = Number(kindCode[attacker] || 0);
  let target = defender.kind;
  if (defender.entrenched === true && target === "infantry") target = "entrenched infantry";
  const d = Number(kindCode[target] || 0);
  if (!a || !d) return null;
  if (d === 9) return Number(matrix.kindNineColumn[String(a)]);
  return Number((matrix.rows[String(a)] || [])[d] || 0);
};

const evidence = [];
function mark(step, ok, detail) {
  evidence.push({ step, ok: Boolean(ok), detail });
  console.log((ok ? "OK   " : "FAIL ") + step + " :: " + JSON.stringify(detail));
  writeFileSync(path.join(OUT, "combat-handcheck.json"), JSON.stringify(evidence, null, 2));
}

async function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_MODULE,
    path.join(here, "node_modules", "playwright", "index.mjs"),
    path.join(root, "node_modules", "playwright", "index.mjs"),
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

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
page.on("pageerror", (err) => console.log("pageerror " + err.message));

const room = () => page.evaluate(() => window.__chq.room());
const stateOf = () => page.evaluate(() => window.__chq.state());
const boardNote = () => page.evaluate(() => (document.querySelector("#boardNote") || {}).textContent || "");
const dist = (a, b) => {
  const raw = Math.abs(Number(a.x) - Number(b.x));
  const dx = Math.min(raw, 320 - raw);
  return Math.max(dx, Math.abs(Number(a.y) - Number(b.y)));
};

async function shot(name) {
  const file = path.join(OUT, name);
  await page.screenshot({ path: file });
  console.log("shot " + file);
  return file;
}
async function shotAt(name, cell, box = { w: 640, h: 480 }) {
  const point = await page.evaluate(({ x, y }) => window.__chq.cellToScreen(x, y), cell);
  const vp = page.viewportSize();
  const clip = {
    x: Math.max(0, Math.min(vp.width - 40, point.x - box.w / 2)),
    y: Math.max(0, Math.min(vp.height - 40, point.y - box.h / 2)),
    width: Math.min(box.w, vp.width),
    height: Math.min(box.h, vp.height),
  };
  const file = path.join(OUT, name);
  await page.screenshot({ path: file, clip });
  console.log("shot " + file + " clip " + JSON.stringify(clip));
  return file;
}
async function clickCell(cell) {
  const point = await page.evaluate(({ x, y }) => window.__chq.cellToScreen(x, y), cell);
  const vp = page.viewportSize();
  if (point.x < 0 || point.y < 0 || point.x > vp.width || point.y > vp.height) {
    await page.click("#camFit");
    await sleep(250);
    return clickCell(cell);
  }
  await page.mouse.click(point.x, point.y);
  await sleep(180);
}
async function hoverCell(cell) {
  const point = await page.evaluate(({ x, y }) => window.__chq.cellToScreen(x, y), cell);
  await page.mouse.move(point.x, point.y);
  await sleep(120);
}

async function buy(kind, near) {
  await page.click('#nav button[data-dialog="buy"]');
  await sleep(200);
  await page.click('button.buyrow[data-kind="' + kind + '"]');
  await page.waitForFunction(() => window.__chq.state().placement === true, null, { timeout: 15000 }).catch(() => {});
  const cells = await page.evaluate(() => window.__chq.legalCells(6000));
  const first = await room();
  const had = new Set((first.pieces || []).map((p) => p.id));
  const taken = new Set((first.pieces || []).map((p) => p.x + "," + p.y));
  const target = [...cells].filter((c) => !taken.has(c.x + "," + c.y)).sort((a, b) => dist(a, near) - dist(b, near))[0];
  if (!target) return null;
  await clickCell(target);
  await page.waitForFunction((n) => window.__chq.room().pieces.some((p) => !n.includes(p.id)), [...had],
    { timeout: 20000 }).catch(() => {});
  const after = await room();
  return (after.pieces || []).find((p) => !had.has(p.id)) || null;
}

try {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 20000 });
  const version = await page.evaluate(() => fetch("/api/version").then((r) => r.json()));
  mark("live build", Boolean(version && version.short), version);

  let signedIn = await page.evaluate(() => Boolean(window.__chq && window.__chq.me()));
  if (!signedIn) {
    const name = "hc" + Date.now().toString(36).slice(-8);
    const password = "pw-" + Math.random().toString(36).slice(2, 12);
    await page.fill("#register input[name=username]", name);
    await page.fill("#register input[name=password]", password);
    await page.click("#register button[type=submit]");
    await page.waitForSelector("#play:not(.hidden)", { timeout: 20000 });
    mark("registered", true, name);
  } else {
    mark("signed in", true, "session");
  }

  if (await room()) {
    await page.click("#quitBtn");
    await page.waitForFunction(() => !window.__chq.room(), null, { timeout: 15000 }).catch(() => {});
  }
  await page.selectOption('#launch select[name="era"]', ERA);
  await page.selectOption('#launch select[name="side"]', "blue");
  await page.click('#launch button[type=submit]');
  await page.waitForFunction((wanted) => window.__chq.room() && String(window.__chq.room().era) === wanted, ERA,
    { timeout: 20000, polling: 100 });
  let r = await room();
  const capital = r.capitals[r.you];
  mark("match open", Boolean(r.id), { id: r.id, era: r.era, round: r.round, capital, speed: r.speed });

  // Speed 6: 0.6 s a round, so a fight resolves inside a minute.
  for (let i = 0; i < 8; i++) {
    const read = await page.evaluate(() => (document.querySelector("#speedReadout") || {}).textContent || "");
    if (/6/.test(read)) break;
    await page.click("#speedUp");
    await sleep(120);
  }
  mark("speed set", true, await page.evaluate(() => (document.querySelector("#speedReadout") || {}).textContent || ""));

  const tank = await buy("tank", capital);
  mark("tank bought", Boolean(tank), tank ? { id: tank.id, x: tank.x, y: tank.y, kind: tank.kind, strength: tank.strength } : null);
  if (!tank) throw new Error("no tank placed");
  let tankId = tank.id;

  await page.click("#clockBtn");
  await page.waitForFunction(() => { const x = window.__chq.room(); return x && x.clock === "running"; },
    null, { timeout: 15000 }).catch(() => {});
  await shot("01-match-open.png");

  // The bot marches on the capital. Wait until one of its land pieces is visible inside our tank's
  // reach, then order the tank onto a cell beside it.
  const deadline = Date.now() + WAIT_MS;
  let enemy = null;
  let lastRound = -1;
  while (Date.now() < deadline) {
    const cur = await room();
    if (!cur) break;
    const me = (cur.pieces || []).find((p) => p.id === tankId) || (cur.pieces || []).find((p) => p.side === cur.you && p.kind === "tank");
    if (me) tankId = me.id;
    const foes = (cur.pieces || []).filter((p) => p.side !== cur.you && p.domain === "land");
    if (me && foes.length) {
      foes.sort((a, b) => dist(a, me) - dist(b, me));
      if (dist(foes[0], me) <= 8) { enemy = foes[0]; break; }
    }
    if (Number(cur.round) >= lastRound + 20) {
      lastRound = Number(cur.round);
      console.log("round " + cur.round + " tank " + JSON.stringify(me && { x: me.x, y: me.y, s: me.strength }) + " foes " + foes.length);
    }
    await sleep(800);
  }
  const contact = await room();
  mark("enemy visible", Boolean(enemy), enemy ? { id: enemy.id, kind: enemy.kind, x: enemy.x, y: enemy.y, strength: enemy.strength, round: contact && contact.round } : { round: contact && contact.round });
  if (!enemy) throw new Error("the bot never came into sight");

  await page.click("#clockBtn"); // pause while we give the order
  await sleep(200);
  const meNow = (await room()).pieces.find((p) => p.id === tankId);
  await clickCell({ x: meNow.x, y: meNow.y });
  await page.waitForFunction(() => window.__chq.state().selected !== null, null, { timeout: 10000 }).catch(() => {});
  const selected = await page.evaluate(() => window.__chq.state().selected);

  let ordered = null;
  const rings = [1, 2, 3];
  for (const ring of rings) {
    const around = [[ring, 0], [0, ring], [-ring, 0], [0, -ring], [ring, ring], [-ring, -ring], [ring, -ring], [-ring, ring]];
    for (const [dx, dy] of around) {
      const cell = { x: (enemy.x + dx + 320) % 320, y: Math.max(0, Math.min(135, enemy.y + dy)) };
      await hoverCell(cell);
      if (/^Route:/.test(await boardNote())) { ordered = cell; break; }
    }
    if (ordered) break;
  }
  mark("contact order previewed", Boolean(ordered), { selected, ordered, enemy: { x: enemy.x, y: enemy.y } });
  if (!ordered) throw new Error("no accepted cell beside the enemy");
  await clickCell(ordered);
  await sleep(400);
  await page.click("#clockBtn");
  await page.waitForFunction(() => { const x = window.__chq.room(); return x && x.clock === "running"; },
    null, { timeout: 15000 }).catch(() => {});

  // Sample every round until the enemy's bar moves. Before/after screenshots at the fight.
  let beforeShot = null;
  let afterShot = null;
  let loss = null;
  let enemyNow = enemy;
  await shotAt("02-before-fight.png", { x: enemy.x, y: enemy.y });
  beforeShot = "02-before-fight.png";
  const fightDeadline = Date.now() + 240000;
  let previous = new Map();
  while (Date.now() < fightDeadline && !loss) {
    const cur = await room();
    if (!cur) break;
    const rows = cur.pieces || [];
    for (const p of rows) {
      const prev = previous.get(p.id);
      if (prev !== undefined && p.strength < prev && p.side !== cur.you) {
        // The enemy lost strength. Name the shooter: the only piece of ours within reach is the tank.
        const mine = rows.filter((q) => q.side === cur.you && dist(q, p) <= 4);
        loss = {
          round: Number(cur.round), enemy: { id: p.id, kind: p.kind, at: { x: p.x, y: p.y } },
          before: prev, after: p.strength, delta: prev - p.strength,
          shooter: mine.map((q) => ({ id: q.id, kind: q.kind, facing: q.facing, fighting: q.fighting })),
          enemyEntrenched: p.entrenched === true,
        };
        enemyNow = p;
        break;
      }
    }
    for (const p of rows) previous.set(p.id, p.strength);
    await sleep(120);
  }
  await shotAt("03-after-fight.png", { x: enemyNow.x, y: enemyNow.y });
  afterShot = "03-after-fight.png";
  await shot("04-after-fight-full.png");
  await page.click("#clockBtn").catch(() => {});

  if (!loss) throw new Error("no enemy strength loss observed in the window");
  const expected = cellFor("tank", { kind: loss.enemy.kind, entrenched: loss.enemyEntrenched });
  mark("matrix cell named", expected !== null, {
    attacker: "tank (kind 2)", defender: loss.enemy.kind + (loss.enemyEntrenched ? " (entrenched, kind 3)" : ""),
    cell: expected, config: "config.combat.measured.value.damageMatrix",
  });
  const multiplier = expected && loss.delta !== expected ? loss.delta / expected : 1;
  mark("fight matches the shipped cell", Boolean(expected) && Math.abs(loss.delta - expected) < 0.001,
    { ...loss, expectedCell: expected, multiplier, beforeShot, afterShot, note: multiplier !== 1 ? "flank/rear or a second shooter multiplied it; the base cell is still the one named" : "no modifier applied" });

  writeFileSync(path.join(OUT, "combat-handcheck.json"), JSON.stringify(evidence, null, 2));
  const failed = evidence.filter((row) => !row.ok).length;
  console.log("\nhand-check: " + (evidence.length - failed) + " ok, " + failed + " failed; evidence " + path.join(OUT, "combat-handcheck.json"));
  await browser.close();
  process.exit(failed ? 1 : 0);
} catch (err) {
  mark("hand-check aborted", false, String(err && err.stack || err));
  await shot("99-abort.png").catch(() => {});
  await browser.close();
  process.exit(1);
}
