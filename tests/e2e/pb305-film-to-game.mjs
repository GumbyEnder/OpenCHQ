// PB-305: Film to Game (manual p.38 l.1170) — the page leg, at 1280x800 and 1024x768.
//
// One real war per width (a 1986 bot war, clock run, then Resign), then War Films, then:
//   - the closing frame refuses with a sentence and creates no room (the film stays open);
//   - a mid-replay round forks a SOLO game that starts at the round on screen, on the side this
//     machine was playing, with the computer on the far side and the clock held;
//   - the toast names the era, the round and the side, and no raw piece id;
//   - a one-cell order lands and the clock advances two rounds, so it is a real game;
//   - zero page errors.
// Evidence (screenshots + verdicts.json) lands in tests/e2e/pb305-film-to-game-<stamp>/ unless --out.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright } from "./playwright.mjs";
import { evidenceDir } from "./evidence.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const argOf = (name, fallback = "") => {
  const hit = process.argv.find((value) => value.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const GIVEN = (argOf("url", process.env.E2E_URL || "") || "").replace(/\/+$/, "");
const OUT = evidenceDir("pb305-film-to-game", argOf("out"));
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const evidence = [];
let failed = 0;
function mark(label, ok, detail = "") {
  if (!ok) failed += 1;
  evidence.push({ label, ok: Boolean(ok), detail: String(detail || "") });
  console.log((ok ? "PASS " : "FAIL ") + label + (detail ? " — " + detail : ""));
  return Boolean(ok);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => { const port = probe.address().port; probe.close(() => resolve(port)); });
  });
}

function startServer(port, dataDir) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      OPENCHQ_WEB_HOST: "127.0.0.1",
      OPENCHQ_WEB_PORT: String(port),
      OPENCHQ_WEB_DATA: dataDir,
    };
    const child = spawn(process.execPath, ["web/server/main.mjs"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("server did not start: " + log)); }, 15000);
    child.stdout.on("data", (chunk) => {
      log += chunk.toString();
      if (log.includes("OpenCHQ web shell")) { clearTimeout(timer); resolve(child); }
    });
    child.stderr.on("data", (chunk) => { log += chunk.toString(); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error("server exited " + code + ": " + log)); });
  });
}

// One width: a war, a film, the refusal at the end screen, and a mid-replay cutover that plays.
async function runWidth(browser, base, width, height) {
  const tag = width + "x" + height;
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(String(err && err.message ? err.message : err)));
  page.on("dialog", (dialog) => dialog.accept().catch(() => {}));
  const room = () => page.evaluate(() => window.__chq.room());
  const toast = () => page.evaluate(() => window.__chq.toast());
  const filmState = () => page.evaluate(() => {
    const value = window.__chq.film();
    return value ? { at: value.at, count: value.frames.length, id: value.meta && value.meta.id } : null;
  });

  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 20000 });
  const name = "ftg" + width + Date.now().toString(36).slice(-7);
  await page.fill("#register input[name=username]", name);
  await page.fill("#register input[name=password]", "pw-" + Math.random().toString(36).slice(2, 12));
  await page.click("#register button[type=submit]");
  await page.waitForSelector("#play:not(.hidden)", { timeout: 20000 });
  await page.selectOption('#launch select[name="era"]', "1986");
  await page.click('#launch button[type=submit]');
  await page.waitForFunction(() => window.__chq.room() && String(window.__chq.room().era) === "1986", null, { timeout: 20000 });
  for (let i = 0; i < 5; i += 1) await page.click("#speedUp").catch(() => {});
  await page.click("#clockBtn");
  const ran = await page.waitForFunction(() => Number((window.__chq.room() || {}).round) >= 3, null, { timeout: 120000 })
    .then(() => true).catch(() => false);
  mark(tag + ": the clock runs the war", ran, "round " + (await room()).round);
  await page.click("#resignBtn");
  const over = await page.waitForFunction(() => window.__chq.room() && window.__chq.room().over === true, null, { timeout: 20000 })
    .then(() => true).catch(() => false);
  mark(tag + ": Resign ends the war", over);
  await sleep(800);

  // The film list is a LOBBY dialogue: leave the finished room first.
  await page.evaluate(() => { const button = document.getElementById("quitBtn"); if (button) button.click(); });
  await page.waitForFunction(() => !window.__chq.room(), null, { timeout: 20000 }).catch(() => {});
  await page.click("#filmsBtn");
  const rowShown = await page.waitForSelector("button[data-film]", { timeout: 20000 }).then(() => true).catch(() => false);
  mark(tag + ": War Films lists the war", rowShown);
  if (!rowShown) throw new Error("no film row to watch");
  await page.evaluate(() => document.querySelector("button[data-film]").click());
  await page.waitForSelector("#filmbar:not(.hidden)", { timeout: 20000 }).catch(() => {});

  // (a) the closing frame is the end screen: the bar offers Film to Game and the press is refused.
  let stepped = await filmState();
  for (let i = 0; i < 400 && stepped && stepped.at + 1 < stepped.count; i += 1) {
    await page.click("#filmNext");
    await sleep(20);
    stepped = await filmState();
  }
  const atEnd = Boolean(stepped) && stepped.at + 1 === stepped.count;
  mark(tag + ": the film steps to its last frame", atEnd, JSON.stringify(stepped));
  const offered = await page.evaluate(() => {
    const button = document.getElementById("filmToGame");
    return Boolean(button) && button.offsetParent !== null && button.textContent === "Film to Game";
  });
  mark(tag + ": Film to Game is offered during the replay", offered);
  await page.click("#filmToGame");
  await sleep(400);
  const refused = await toast();
  mark(tag + ": the closing frame is refused with a sentence", /nothing left to play/.test(refused), refused);
  const stillFilming = await page.evaluate(() => Boolean(window.__chq.film()) && document.body.classList.contains("filming"));
  mark(tag + ": the refused press leaves the film open", stillFilming);
  mark(tag + ": the refused press creates no room", (await room()) === null);

  // (b)(c) a mid-replay round becomes a solo game from that round. The frame one step before the
  // closing frame is the mid-war moment this leg forks (a 4-round film has two; a short film's
  // frame 2 is still a war).
  const count = (await filmState()).count;
  const target = Math.max(0, count - 2);
  stepped = await filmState();
  for (let i = 0; i < 400 && stepped && stepped.at > target; i += 1) {
    await page.click("#filmPrev");
    await sleep(20);
    stepped = await filmState();
  }
  const wanted = stepped && stepped.at === target ? stepped : null;
  mark(tag + ": the film is stepped back to frame " + (target + 1), Boolean(wanted), JSON.stringify(stepped));
  if (!wanted) throw new Error("could not step the film back");
  const frameRound = await page.evaluate(() => {
    const value = window.__chq.film();
    return Number(value.frames[value.at].round);
  });
  await page.click("#filmToGame");
  const forked = await page.waitForFunction(() => Boolean(window.__chq.room()), null, { timeout: 20000 })
    .then(() => true).catch(() => false);
  mark(tag + ": Film to Game starts a game", forked);
  if (!forked) throw new Error("the cutover created no room; toast: " + (await toast()));
  const cut = await room();
  mark(tag + ": the game starts at the round on screen", Number(cut.round) === frameRound,
    "room round " + cut.round + ", film round " + frameRound);
  mark(tag + ": the human plays the side this machine played", cut.you === "blue" && cut.blue && cut.blue.kind === "human",
    "you " + cut.you);
  mark(tag + ": the far side is the computer", Boolean(cut.red) && cut.red.kind === "bot", cut.red && cut.red.kind);
  mark(tag + ": the cutover is a held game, not a replay", cut.clock === "held" && cut.over !== true, cut.clock);
  const left = await page.evaluate(() => !window.__chq.film() && document.getElementById("filmbar").classList.contains("hidden"));
  mark(tag + ": the film bar closes on the cutover", left);

  const said = await toast();
  mark(tag + ": the toast names the era, the round and the side",
    /^Film to Game: 1986 from round \d+\. You play blue\./.test(said), said);
  // (e): what the PLAYER can read, not the wire - a room frame legitimately carries piece ids in
  // data attributes; a toast or a visible line never may.
  const visible = await page.evaluate(() => [
    window.__chq.toast(),
    (document.getElementById("filmbar") || {}).textContent || "",
    document.body.innerText || "",
  ].join("\n"));
  const rawIds = visible.match(/\b(blue|red):[A-Za-z]+:\d+\b/g) || [];
  mark(tag + ": no raw piece id reaches the player's screen", rawIds.length === 0, rawIds.slice(0, 3).join(" "));

  const shot = path.join(OUT, "pb305-cutover-" + tag + ".png");
  await page.screenshot({ path: shot });

  // (d) a real game: one order lands, and the clock advances with a bot on the far side.
  // `__chq.wire()` keeps the frame LABELS, not the JSON, so the answer is "ordered" vs "error".
  const order = await page.evaluate(async () => {
    const live = window.__chq.room();
    const mine = (live.pieces || []).filter((piece) => piece.side === live.you && piece.domain !== "sat");
    for (const piece of mine) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const wireBefore = window.__chq.wire().length;
        window.__chq.send({ op: "order", id: "pb305-ui-" + Math.random().toString(36).slice(2, 9), piece: piece.id, to: { x: piece.x + dx, y: piece.y + dy } });
        const start = Date.now();
        while (Date.now() - start < 1200) {
          const fresh = window.__chq.wire().slice(wireBefore);
          if (fresh.includes("ordered")) return { ok: true, piece: piece.kind };
          if (fresh.some((line) => String(line).startsWith("error"))) break;
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
      }
    }
    return { ok: false };
  });
  mark(tag + ": the player can give an order after the cutover", order.ok, JSON.stringify(order).slice(0, 120));

  const beforeRound = Number((await room()).round);
  await page.evaluate(() => {
    window.__chq.send({ op: "speed", speed: 6 });
    window.__chq.send({ op: "run" });
  });
  const advanced = await page.waitForFunction(
    (from) => Number((window.__chq.room() || {}).round) >= from + 2, beforeRound, { timeout: 60000 })
    .then(() => true).catch(() => false);
  await page.evaluate(() => window.__chq.send({ op: "hold" }));
  const finalRound = Number((await room()).round);
  mark(tag + ": the cutover game advances two rounds", advanced, beforeRound + " -> " + finalRound);
  mark(tag + ": the far side is still the computer after ticking", Boolean((await room()).red) && (await room()).red.kind === "bot");

  const play = path.join(OUT, "pb305-playing-" + tag + ".png");
  await page.screenshot({ path: play });
  mark(tag + ": zero page errors", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));
  await context.close();
  return { width, height, frameRound, room: cut, shot, play, pageErrors };
}

let server = null;
let browser = null;
let BASE = GIVEN;
try {
  if (!BASE) {
    const port = await freePort();
    server = await startServer(port, mkdtempSync(path.join(tmpdir(), "openchq-pb305-")));
    BASE = "http://127.0.0.1:" + port;
    mark("a local server answers", true, BASE);
  }
  const served = await fetch(BASE + "/api/version").then((res) => res.json()).catch(() => null);
  mark("the host names its build", Boolean(served && served.short), JSON.stringify(served));

  const { chromium } = await loadPlaywright();
  browser = await chromium.launch({ headless: true });
  const runs = [];
  for (const [width, height] of [[1280, 800], [1024, 768]]) {
    runs.push(await runWidth(browser, BASE, width, height));
  }
  writeFileSync(path.join(OUT, "evidence.json"), JSON.stringify({ base: BASE, served, runs }, null, 2));
  mark("evidence written", true, path.join(OUT, "evidence.json"));
} catch (err) {
  mark("the leg finished", false, String((err && err.stack) || err).split("\n")[0]);
} finally {
  writeFileSync(path.join(OUT, "verdicts.json"), JSON.stringify({
    passed: evidence.filter((row) => row.ok).length,
    failed, checks: evidence.length, evidence,
  }, null, 2));
  console.log("RESULT " + (evidence.length - failed) + " passed, " + failed + " failed, " + evidence.length + " checks");
  if (browser) await browser.close();
  if (server) server.kill("SIGKILL");
  process.exit(failed ? 1 : 0);
}
