// PB-157 / PB-158 hand-check: two real pages, one real socket each, one real match.
//
// The node pins (web/test/nodes/pb157_bomb.mjs, pb158_intel_server.mjs) prove the rules against a
// hand-built board. This leg proves the two cards from a player's seat: two throwaway accounts open
// a HUMAN 1986 match (blue invites red), blue buys aircraft and bombs a red city and a red oil
// field, red buys an Intel pass. Every number below is read from window.__chq.room() on the seat
// that can see it - blue's own purse and briefing for the raider's half, red's own purse, sites and
// round log for the victim's half. No debug endpoint, no server module, no stubbed board.
//
// The three facts the card asks for:
//   1. an empty red city: red's purse falls by exactly 125 M, the site is unready for exactly 5
//      rounds from the round the bomb landed in, and red's own round log says so;
//   2. a red oil field (kind facility, type 5): the loss is oil, not cash - red's log says
//      "oil cut next round", blue's says "oil loss queued", and red's next settlement takes
//      exactly 1000 raw units off the reserve (unless the reserve caps first, which is reported);
//   3. an Intel pass: every enemy piece that reaches red's socket while the pass runs sits inside
//      the moving bar's own span, sampled every 25 ms from the page's decoded state.
//
//   node tests/e2e/pb157-158-handcheck.mjs --url=http://127.0.0.1:8094 --out=/mnt/nas/host-ops/openchq/pb157-158/handcheck
//
// RUNNING IT (PB-168 (d)): the browser module is resolved from PLAYWRIGHT_MODULE (an absolute path
// to a playwright `index.mjs`) or the same fallback list run.mjs uses, so a host without
// ./node_modules works:
//   PLAYWRIGHT_MODULE=/home/gumbyender/agents/agent-relay-beezilla/node_modules/playwright/index.mjs \
//     node tests/e2e/pb157-158-handcheck.mjs --url=http://127.0.0.1:8094 --out=<dir>
// PORT ASSUMPTION: --url is required and nothing is defaulted; the historical local target was
// 127.0.0.1:8094 (the port tools/fire.sh's sibling loop serves on), and a live run passes the
// deployed https URL instead. --out defaults to a directory beside the script's own run.
// The numbers below were produced by a real Chromium against a real server; a skipped browser is a
// failed run, not a pass.
//
// Playwright is resolved the same way run.mjs resolves it.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

function argOf(name, fallback = "") {
  const hit = process.argv.find((v) => v.startsWith("--" + name + "="));
  if (hit) return hit.slice(name.length + 3);
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
}

const BASE = (argOf("url", process.env.E2E_URL || "") || "").replace(/\/+$/, "");
if (!BASE) {
  console.error("usage: node tests/e2e/pb157-158-handcheck.mjs --url=<base url> [--out=<dir>] [--era=1986]");
  process.exit(2);
}
const ERA = argOf("era", "1986");
const OUT = path.resolve(argOf("out", path.join(process.env.HOME || ".", "agents", "game", "notes", "pb157")));
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadPlaywright() {
  for (const c of [process.env.PLAYWRIGHT_MODULE,
    path.join(here, "node_modules", "playwright", "index.mjs"),
    "/home/gumbyender/agents/agent-relay-lanes/node_modules/playwright/index.mjs",
    "/home/gumbyender/agents/agent-relay-local/node_modules/playwright/index.mjs"].filter(Boolean)) {
    if (c !== "playwright" && !existsSync(c)) continue;
    try { return await import(pathToFileURL(c).href); } catch { /* next */ }
  }
  return import("playwright");
}

const rows = [];
let failed = 0;
function mark(ok, label, detail = "") {
  if (!ok) failed += 1;
  rows.push({ ok: Boolean(ok), label, detail });
  const tail = detail === "" ? "" : " :: " + (typeof detail === "string" ? detail : JSON.stringify(detail));
  console.log((ok ? "PASS " : "FAIL ") + label + tail);
  writeFileSync(path.join(OUT, "handcheck.json"), JSON.stringify({ base: BASE, era: ERA, checks: rows }, null, 2));
  return Boolean(ok);
}

const roomOf = (page) => page.evaluate(() => window.__chq.room());
const stateOf = (page) => page.evaluate(() => window.__chq.state());
const toast = (page) => page.evaluate(() => window.__chq.toast());
const logOf = (page) => page.evaluate(() => (window.__chq.room() && window.__chq.room().log) || []);

async function clickCell(page, cell) {
  const point = await page.evaluate(({ x, y }) => window.__chq.cellToScreen(x, y), cell);
  const size = page.viewportSize();
  if (!point || point.x < 0 || point.y < 0 || point.x > size.width || point.y > size.height) {
    await page.click("#camFit").catch(() => {});
    await sleep(150);
    return clickCell(page, cell);
  }
  await page.mouse.click(point.x, point.y);
  await sleep(120);
  return point;
}

async function waitFor(fn, label, timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await fn()) return true;
    await sleep(100);
  }
  console.log("TIMEOUT " + label);
  return false;
}

// The nav buttons toggle their dialog. A hand-check that presses one when it is already open
// closes it, so every open goes through this.
async function openDialog(page, id) {
  const open = await page.evaluate(() => !document.querySelector("#dialog").classList.contains("hidden"));
  if (open) {
    const current = await page.evaluate(() => (document.querySelector("#dialog h2, #dialogTitle") || {}).textContent || "");
    if (!current) { /* fall through: reopen */ }
    await page.keyboard.press("Escape").catch(() => {});
    await page.evaluate(() => {
      const close = document.querySelector("#dialog .close, #dialogClose, #dialog button.ghost");
      if (close) close.click();
    });
    await sleep(200);
  }
  await page.click('#nav button[data-dialog="' + id + '"]');
  await page.waitForSelector("#dialog:not(.hidden)", { timeout: 10000 });
}

async function register(page, name) {
  await page.goto(BASE + "/");
  await page.waitForSelector("#register", { timeout: 20000 });
  await page.fill("#register input[name=username]", name);
  await page.fill("#register input[name=password]", "hc-Passw0rd-" + Math.floor(Math.random() * 1e6));
  const mail = page.locator("#register input[name=email]");
  if (await mail.count()) await mail.fill(name + "@example.com");
  await page.click("#register button[type=submit]");
  await page.waitForSelector("#play:not(.hidden)", { timeout: 20000 });
}

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ headless: true });
const stamp = Date.now().toString(36);
let evidence = {};

try {
  // ---- two players, one human match --------------------------------------------------
  const ctxBlue = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const ctxRed = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const blue = await ctxBlue.newPage();
  const red = await ctxRed.newPage();
  const blueName = "hcb" + stamp;
  const redName = "hcr" + stamp;

  // Red first, so the invite has somebody to name in the people list.
  await register(red, redName);
  await sleep(600);
  await register(blue, blueName);
  await sleep(1200);
  mark(true, "two throwaway accounts are in the lobby", blueName + " / " + redName);

  await blue.selectOption('#launch select[name="era"]', ERA);
  await blue.selectOption('#launch select[name="side"]', "blue");
  const invited = await blue.evaluate((who) => {
    const rowsList = [...document.querySelectorAll("#people li.person")];
    const row = rowsList.find((li) => (li.querySelector("span") || {}).textContent === who);
    const button = row && row.querySelector("button");
    if (!button) return false;
    button.click();
    return true;
  }, redName);
  mark(invited, "blue found red in the people list and pressed Invite", blueName);
  if (!invited) throw new Error("no invite button for " + redName);

  await red.waitForSelector("#invites .invite button", { timeout: 20000 });
  await red.evaluate(() => {
    const button = [...document.querySelectorAll("#invites .invite button")].find((b) => /accept/i.test(b.textContent));
    (button || document.querySelector("#invites .invite button")).click();
  });

  const inRoom = async (page, side) => {
    await page.waitForFunction(() => Boolean(window.__chq.room() && window.__chq.room().seat), null, { timeout: 25000, polling: 100 }).catch(() => {});
    const room = await roomOf(page);
    return Boolean(room && room.you === side);
  };
  const blueIn = await inRoom(blue, "blue");
  const redIn = await inRoom(red, "red");
  mark(blueIn && redIn, "the invited match opened with blue and red each holding a seat",
    JSON.stringify({ blue: blueIn, red: redIn }));
  if (!blueIn || !redIn) throw new Error("the human match did not open");

  const room0 = await roomOf(blue);
  evidence.round0 = { round: room0.round, blue: room0.seat.cash, red: (await roomOf(red)).seat.cash, clock: room0.clock };

  // A human room starts held; hold it explicitly so no clock runs under the buying.
  if (room0.clock === "running") {
    await blue.click("#clockBtn").catch(() => {});
    await sleep(400);
  }

  // ---- buy two aircraft, on ring cells so the plane has a clean click target -------------
  const bought = [];
  for (let n = 0; n < 2; n += 1) {
    const before = await roomOf(blue);
    await openDialog(blue, "buy");
    await blue.click('button.buyrow[data-kind="aircraft"]');
    await waitFor(async () => (await stateOf(blue)).placement === true, "the aircraft placement mask");
    const cells = await blue.evaluate(() => window.__chq.legalCells(600));
    const live = await roomOf(blue);
    const mine = (live.pieces || []).filter((p) => p.side === "blue");
    const siteCells = new Set((live.sites || []).map((s) => s.x + "," + s.y));
    const capital = (before.capitals && before.capitals[before.you]) || { x: 0, y: 0 };
    const near = (c) => Math.abs(c.x - capital.x) + Math.abs(c.y - capital.y);
    // A ready ring cell of a friendly city: legal, not a site cell, and at least two cells from
    // every other own piece so the click resolves to the aircraft's own icon and not a neighbour's
    // badge box (the badge has a minimum pixel size when the camera is fitted to the world).
    const clear = (c) => mine.every((p) => Math.max(Math.abs(p.x - c.x), Math.abs(p.y - c.y)) >= 2);
    const ring = cells.filter((c) => c.ready !== false && !siteCells.has(c.x + "," + c.y) && clear(c));
    const target = ring.sort((a, b) => near(a) - near(b))[0]
      || cells.filter((c) => c.ready !== false).sort((a, b) => near(a) - near(b))[0];
    mark(Boolean(target), "the server offered a ready cell for aircraft " + (n + 1), JSON.stringify(target));
    await clickCell(blue, target);
    const got = await waitFor(async () => {
      const room = await roomOf(blue);
      return (room.pieces || []).filter((p) => p.side === "blue" && p.kind === "aircraft").length > n;
    }, "the bought aircraft", 20000);
    const room = await roomOf(blue);
    const planes = (room.pieces || []).filter((p) => p.side === "blue" && p.kind === "aircraft");
    mark(got && planes.length === n + 1, "aircraft " + (n + 1) + " is on the board",
      JSON.stringify(planes.map((p) => p.id + "@" + p.x + "," + p.y)));
    mark(Number(room.seat.cash) === Number(before.seat.cash) - 20000,
      "the aircraft was charged at the roster price (20b)", before.seat.cash + " -> " + room.seat.cash);
    bought.push(planes[planes.length - 1]);
    await blue.evaluate(() => {
      const close = document.querySelector("#dialog .close, #dialogClose");
      if (close) close.click();
    });
    await sleep(200);
  }

  const planes = async () => (await roomOf(blue)).pieces.filter((p) => p.side === "blue" && p.kind === "aircraft");
  const briefing = async () => (await roomOf(blue)).seat.air || [];

  // Order one bombing run through the page, the way a player does: select the plane on the map,
  // open Kit, press the Bomb row (which arms the target), then click the target cell.
  async function bomb(planeId, target, label) {
    const b0 = (await briefing()).find((p) => p.id === planeId);
    mark(Boolean(b0 && (b0.missions || []).some((m) => m.mode === "bomb")),
      label + ": the seat's own briefing offers a bombing run",
      JSON.stringify((b0 && b0.missions) || []));

    await blue.evaluate(() => {
      const close = document.querySelector("#dialog .close, #dialogClose");
      if (close) close.click();
    });
    await sleep(150);
    const piece = (await roomOf(blue)).pieces.find((p) => p.id === planeId);
    await clickCell(blue, { x: piece.x, y: piece.y });
    const selected = await stateOf(blue);
    mark(selected.selected === planeId, label + ": clicking the aircraft selects it", String(selected.selected));

    await openDialog(blue, "kit");
    const armed = await blue.evaluate(() => {
      const buttons = [...document.querySelectorAll("#dialogBody .shop.tools button")];
      const button = buttons.find((b) => /^bomb\b/i.test(b.textContent.trim()));
      if (!button) return { ok: false, seen: buttons.map((b) => b.textContent.trim()) };
      if (button.disabled) return { ok: false, disabled: true, title: button.title };
      button.click();
      return { ok: true, label: button.textContent.trim(), title: button.title };
    });
    mark(armed.ok, label + ": the Kit panel arms a bombing run", JSON.stringify(armed));
    if (!armed.ok) return { ok: false, stage: "arm" };
    await sleep(150);
    const said = await toast(blue);
    mark(/bomb/i.test(said), label + ": the page asks for an empty enemy city, base or oil field", said);

    const redBefore = await roomOf(red);
    const roundOfBomb = (await roomOf(blue)).round;
    await clickCell(blue, target);

    const landed = await waitFor(async () => {
      const room = await roomOf(blue);
      const plane = (room.pieces || []).find((p) => p.id === planeId);
      return Boolean(plane && Number(plane.inactive) > 0);
    }, label + ": the accepted mission", 15000);
    const planeNow = (await roomOf(blue)).pieces.find((p) => p.id === planeId);
    const saidAfter = await toast(blue);
    return { ok: landed, round: roundOfBomb, redBefore, saidAfter, away: planeNow && Number(planeNow.inactive) };
  }

  // Tools are refused while the clock is held ("Start the clock first."): the pass and the round
  // tick are the same clock in the original. Mission orders do not need it, which is why the bombs
  // above were ordered with the board held.
  async function runRound(pages, label) {
    const round0 = (await roomOf(blue)).round;
    const clock = (await roomOf(blue)).clock;
    if (clock !== "running") await blue.click("#clockBtn").catch(() => {});
    const moved = await waitFor(async () => (await roomOf(blue)).round > round0, label, 30000);
    if ((await roomOf(blue)).clock === "running") await blue.click("#clockBtn").catch(() => {});
    await sleep(600);
    void pages;
    return moved;
  }

  // ---- check 1: an empty red city -------------------------------------------------------
  {
    const room = await roomOf(blue);
    const redSites = (room.sites || []).filter((s) => s.owner === "red" && (s.kind === "city" || s.kind === "base"));
    // The enemy fleet is not in this seat's view; a defended target is refused by the server and
    // says so, so the check walks the list until one is accepted.
    const plane = (await planes())[0];
    let hit = null;
    for (const site of redSites.slice(0, 8)) {
      const res = await bomb(plane.id, { x: site.x, y: site.y }, "city");
      if (res.ok) { hit = { site, res }; break; }
      console.log("  refused at " + site.name + ": " + res.saidAfter);
    }
    mark(Boolean(hit), "a red city accepted the bombing run", hit ? (hit.site.name || "#" + hit.site.id) : "none accepted");
    if (hit) {
      const cashAfter = (await roomOf(red)).seat.cash;
      mark(Number(hit.res.redBefore.seat.cash) - Number(cashAfter) === 125,
        "red's own purse fell by exactly 125 M",
        hit.res.redBefore.seat.cash + " -> " + cashAfter);
      const redRoom = await roomOf(red);
      const site = (redRoom.sites || []).find((s) => s.id === hit.site.id);
      mark(Boolean(site) && Number(site.readyRound) === Number(hit.res.round) + 5,
        "red's own site record is unready for exactly 5 rounds",
        JSON.stringify({ readyRound: site && site.readyRound, round: hit.res.round }));
      // The round log is written when the round closes, not when the order lands.
      const ticked = await runRound([blue, red], "the round that writes the bombing into the logs");
      mark(ticked, "the clock closed the round the bombing landed in", "");
      const redLog = ((await roomOf(red)).log || []).map((line) => line.text || line);
      const ownerLine = redLog.find((text) => /bombed/i.test(text));
      mark(Boolean(ownerLine) && /lost 0\.125b/.test(ownerLine) && /unready 5 rounds/.test(ownerLine),
        "red's own round log reads the loss and the readiness", ownerLine || JSON.stringify(redLog.slice(-3)));
      const blueLog = ((await roomOf(blue)).log || []).map((line) => line.text || line);
      const raiderLine = blueLog.find((text) => /bombing run hit/i.test(text));
      mark(Boolean(raiderLine) && /0\.125b taken/.test(raiderLine) && /unready 5 rounds/.test(raiderLine),
        "blue's own round log reads what it took", raiderLine || JSON.stringify(blueLog.slice(-3)));
      const firstPlane = (await planes())[0];
      void firstPlane;
      mark(Number(hit.res.away) === 8, "the aircraft is away for the strike's 8 rounds at the moment it flies", String(hit.res.away));
      evidence.city = { site: hit.site, round: hit.res.round, redCash: cashAfter, readyRound: site && site.readyRound };
    }
  }

  // ---- check 2: an oil field takes oil, not cash -----------------------------------------
  {
    const room = await roomOf(blue);
    const fields = (room.sites || []).filter((s) => s.owner === "red" && s.kind === "facility" && Number(s.type) === 5);
    mark(fields.length > 0, "red owns a type-5 oil field on this board", String(fields.length));
    const plane = (await planes())[1];
    let hit = null;
    for (const site of fields.slice(0, 6)) {
      const res = await bomb(plane.id, { x: site.x, y: site.y }, "field");
      if (res.ok) { hit = { site, res }; break; }
      console.log("  refused at field #" + site.id + ": " + res.saidAfter);
    }
    mark(Boolean(hit), "a red oil field accepted the bombing run", hit ? "#" + hit.site.id + "@" + hit.site.x + "," + hit.site.y : "none accepted");
    if (hit) {
      const cashAfter = (await roomOf(red)).seat.cash;
      mark(Number(cashAfter) === Number(hit.res.redBefore.seat.cash),
        "the oil field took no cash (the facility branch is oil, not money)",
        hit.res.redBefore.seat.cash + " -> " + cashAfter);
      // The queued loss lands on red's next settlement: one round of the clock, and red's own oil
      // readout must fall by exactly 1000 raw units relative to what its own flow says it should be.
      // The round log is written when that round closes, so both log lines are read here too.
      const oilBefore = (await roomOf(red)).seat.oil;
      const roundBefore = (await roomOf(red)).round;
      await blue.click("#clockBtn").catch(() => {});
      await waitFor(async () => (await roomOf(red)).round > roundBefore, "the round after the bombing", 30000);
      await blue.click("#clockBtn").catch(() => {});
      await sleep(400);
      const redRoom = await roomOf(red);
      const oilAfter = redRoom.seat.oil;
      if (oilBefore && oilAfter) {
        const flowIn = Number(oilAfter.in);
        const flowOut = Number(oilAfter.out);
        const cap = Number(oilAfter.cap);
        const expected = Math.min(cap, Number(oilBefore.held) + flowIn - flowOut);
        const expectedWithBomb = Math.max(0, expected - 1000);
        const clamped = expected - 1000 < 0;
        mark(clamped || Number(oilAfter.held) === expectedWithBomb,
          "red's own reserve fell by exactly 1000 on the settlement",
          JSON.stringify({ heldBefore: oilBefore.held, heldAfter: oilAfter.held, in: flowIn, out: flowOut, cap, expected, expectedWithBomb }));
        evidence.field = { site: hit.site, oilBefore: oilBefore.held, oilAfter: oilAfter.held, flowIn, flowOut, cap };
        const redLog = ((await roomOf(red)).log || []).map((line) => line.text || line);
        const ownerLine = redLog.find((text) => /bombed/i.test(text) && /oil cut next round/i.test(text));
        mark(Boolean(ownerLine), "red's own round log says the oil was cut", ownerLine || JSON.stringify(redLog.slice(-3)));
        const blueLog = ((await roomOf(blue)).log || []).map((line) => line.text || line);
        const raiderLine = blueLog.find((text) => /bombing run hit/i.test(text) && /oil loss queued/i.test(text));
        mark(Boolean(raiderLine), "blue's own round log says the oil loss was queued", raiderLine || JSON.stringify(blueLog.slice(-3)));
      } else {
        mark(false, "red's own oil readout was available to compare", JSON.stringify({ oilBefore, oilAfter }));
      }
    }
  }

  // ---- check 3: an Intel pass reveals nothing outside the bar ------------------------------
  {
    // Red scans blue. The sampler lives inside the page, so the bar's clock and every frame it
    // decodes share one Date.now(): 25 ms is under a fiftieth of the bar's own dwell over one
    // column-group, and the origin is the click that buys the pass (local round trip, a few ms).
    await red.evaluate(() => {
      window.__hc = { samples: [] };
      window.__hc.timer = setInterval(() => {
        const room = window.__chq.room();
        if (!room) return;
        window.__hc.samples.push({
          t: Date.now(),
          enemies: (room.pieces || []).filter((p) => p.side !== room.you).map((p) => ({ id: p.id, x: Number(p.x) })),
          round: room.round,
        });
      }, 25);
    });

    // The pass needs the clock running: the tool is refused on a held board.
    const clocked = await runRound([blue, red], "a round of the clock before the pass");
    mark(clocked, "the clock ran, so the Kit rows are live", "");
    if ((await roomOf(blue)).clock !== "running") await blue.click("#clockBtn").catch(() => {});

    // Red buys the pass from the Kit panel, the way a player does.
    await openDialog(red, "kit");
    const used = await red.evaluate(() => {
      const buttons = [...document.querySelectorAll("#dialogBody .shop.tools button")];
      const button = buttons.find((b) => /^intel$/i.test(b.textContent.trim()));
      if (!button) return { ok: false, seen: buttons.map((b) => b.textContent.trim()) };
      if (button.disabled) return { ok: false, disabled: true, title: button.title };
      const cashBefore = (window.__chq.room() || {}).seat.cash;
      const tArm = Date.now();
      button.click();
      return { ok: true, cashBefore, tArm };
    });
    mark(used.ok, "red's Kit panel offers and takes the Intel row", JSON.stringify({ ok: used.ok, seen: used.seen }));
    const tArm = used.tArm;
    await sleep(600);
    mark(Number((await roomOf(red)).seat.cash) === Number(used.cashBefore) - 10000,
      "the pass was charged at the roster price (10b)", used.cashBefore + " -> " + (await roomOf(red)).seat.cash);

    // The pass crosses the board in 15.85 s; sample the whole crossing (three rounds at speed 1).
    await sleep(17500);
    const sampled = await red.evaluate(() => {
      clearInterval(window.__hc.timer);
      return { samples: window.__hc.samples };
    });
    if ((await roomOf(blue)).clock === "running") await blue.click("#clockBtn").catch(() => {});

    const boardW = 320;
    const barCells = 20;
    const cellsPerSecond = boardW / 15.85;
    // The frame that carries a reveal is built by the lobby's own 250 ms sampler, not on the instant
    // of the click: a unit whose trailing edge has just cleared can ride one broadcast interval
    // longer. So the rule the payload must satisfy is "the bar covered it at some instant in the
    // last broadcast interval", not "at this millisecond". 300 ms is that cadence plus one 25 ms
    // sample and the local hop - and a piece the bar never touched is still miles outside it.
    const cadenceMs = 300;
    const tol = 1;
    const revealed = new Set();
    const violations = [];
    const lateness = [];
    let before = 0;
    let beforeWithEnemies = 0;
    for (const s of sampled.samples) {
      if (s.t < tArm) {
        before += 1;
        if (s.enemies.length) beforeWithEnemies += 1;
        continue;
      }
      const lead = ((s.t - tArm) / 1000) * cellsPerSecond;
      const trailAt = (((s.t - cadenceMs - tArm) / 1000) * cellsPerSecond) - barCells;
      const leadNow = Math.max(0, lead);
      for (const enemy of s.enemies) {
        revealed.add(enemy.id + "@" + enemy.x);
        if (enemy.x < trailAt - tol || enemy.x >= leadNow + tol) {
          const late = (leadNow - barCells - enemy.x) / cellsPerSecond * 1000;
          lateness.push(Number(late.toFixed(0)));
          violations.push({ t: s.t - tArm, id: enemy.id, x: enemy.x, trailAt: Number(trailAt.toFixed(2)), lead: Number(leadNow.toFixed(2)), lateMs: Number(late.toFixed(0)) });
        }
      }
    }
    mark(beforeWithEnemies === 0, "control: the enemy board was withheld before the pass",
      beforeWithEnemies + " of " + before + " pre-pass samples carried an enemy piece");
    mark(revealed.size >= 1, "the pass revealed enemy pieces at all", revealed.size + " id@column");
    mark(violations.length === 0,
      "no enemy piece reached red's socket unless the bar covered it in the last " + cadenceMs + " ms",
      violations.length + " violations, latest " + (lateness.length ? Math.max(...lateness) : 0) + " ms; first " + JSON.stringify(violations.slice(0, 3)));
    const columns = [...revealed].map((key) => Number(key.split("@")[1]));
    mark(new Set(columns).size >= 2, "the reveal moved with the bar, not a single column",
      JSON.stringify([...new Set(columns)].sort((a, b) => a - b)));
    evidence.intel = {
      tArm, samples: sampled.samples.length, revealed: [...revealed].sort(),
      violations: violations.slice(0, 20), violationCount: violations.length,
    };
  }

  const shot = path.join(OUT, "pb157-158-two-seats.png");
  await blue.screenshot({ path: shot }).catch(() => {});
  writeFileSync(path.join(OUT, "handcheck.json"), JSON.stringify({ base: BASE, era: ERA, checks: rows, evidence }, null, 2));
  console.log("\nhandcheck (" + BASE + ", era " + ERA + ")");
  console.log("  " + (rows.length - failed) + " passed, " + failed + " failed, " + rows.length + " checks");
  console.log("  evidence " + OUT + "/handcheck.json");
} finally {
  await browser.close().catch(() => {});
}
process.exit(failed ? 1 : 0);
