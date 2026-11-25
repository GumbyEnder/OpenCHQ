// T-031 step 3 §4 (i)-(iii): the digest the page shows, the .film file round-trip, and one 1280x800
// screenshot of EACH of the four Shows.
//
//   node tests/e2e/t031-film-shows.mjs                    # starts its own server from this tree
//   node tests/e2e/t031-film-shows.mjs --url=<base>       # against a running host
//   --out=<dir>                                            # where the PNGs and evidence.json go
//
// The film this leg watches is a real one: a 1986 match against the bot, the clock run, then Resign.
// That ending is the one PM 9159 found empty on live (PB-248), so this leg also proves the fix in a
// page: the war appears in War Films, the closing frame's digest verifies against the header, the
// film survives a save-to-file and a load-back with the SAME digest, and every Show paints.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright } from "./playwright.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const argOf = (name, fallback = "") => {
  const hit = process.argv.find((value) => value.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const GIVEN = (argOf("url", process.env.E2E_URL || "") || "").replace(/\/+$/, "");
const OUT = path.resolve(argOf("out", path.join(process.env.HOME || ".", "agents", "game", "notes", "t031-shows")));
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const evidence = [];
let failed = 0;
// mark(label, ok, detail) - the label first, like every other harness line, so a run reads as
// sentences and the booleans stay in one column.
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
    const env = { ...process.env, OPENCHQ_WEB_HOST: "127.0.0.1", OPENCHQ_WEB_PORT: String(port), OPENCHQ_WEB_DATA: dataDir };
    const child = spawn(process.execPath, ["web/server/main.mjs"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("server did not start: " + log)); }, 10000);
    child.stdout.on("data", (chunk) => {
      log += chunk.toString();
      if (log.includes("OpenCHQ web shell")) { clearTimeout(timer); resolve(child); }
    });
    child.stderr.on("data", (chunk) => { log += chunk.toString(); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error("server exited " + code + ": " + log)); });
  });
}

let server = null;
let browser = null;
let BASE = GIVEN;
try {
  if (!BASE) {
    const port = await freePort();
    server = await startServer(port, mkdtempSync(path.join(tmpdir(), "openchq-t031-shows-")));
    BASE = "http://127.0.0.1:" + port;
    mark("a local server answers", true, BASE);
  }
  const served = await fetch(BASE + "/api/version").then((res) => res.json()).catch(() => null);
  mark("the host names its build", Boolean(served && served.short), JSON.stringify(served));

  const { chromium } = await loadPlaywright();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.on("dialog", (dialog) => dialog.accept().catch(() => {}));
  const room = () => page.evaluate(() => window.__chq.room());
  const toast = () => page.evaluate(() => window.__chq.toast());
  const digestLine = () => page.evaluate(() => (document.getElementById("filmDigest") || {}).textContent || "");

  // ---- a real war, ended by Resign (the PM's own path) --------------------------------
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 20000 });
  const name = "film" + Date.now().toString(36).slice(-8);
  await page.fill("#register input[name=username]", name);
  await page.fill("#register input[name=password]", "pw-" + Math.random().toString(36).slice(2, 12));
  await page.click("#register button[type=submit]");
  await page.waitForSelector("#play:not(.hidden)", { timeout: 20000 });
  await page.selectOption('#launch select[name="era"]', "1986");
  await page.click('#launch button[type=submit]');
  await page.waitForFunction(() => window.__chq.room() && String(window.__chq.room().era) === "1986", null, { timeout: 20000 });
  const opened = await room();
  mark("a 1986 match opens", Boolean(opened && opened.id), opened && opened.id);
  for (let i = 0; i < 5; i += 1) await page.click("#speedUp").catch(() => {});
  await page.click("#clockBtn");
  const ran = await page.waitForFunction(() => Number((window.__chq.room() || {}).round) >= 3, null, { timeout: 120000 })
    .then(() => true).catch(() => false);
  const atRound = (await room()).round;
  mark("the clock runs the war", ran, "round " + atRound);
  const matchId = (await room()).id;
  await page.click("#resignBtn");
  const over = await page.waitForFunction(() => window.__chq.room() && window.__chq.room().over === true, null, { timeout: 20000 })
    .then(() => true).catch(() => false);
  const result = (await room()).result || {};
  mark("Resign ends the war", over, JSON.stringify(result));
  await sleep(900);

  // ---- PB-248: the film is closed and listed ------------------------------------------
  // Read the list from the PAGE: /api/matches is per-account, and a bare Node fetch carries no
  // session, so it answers an empty list for a war the signed-in page can see.
  const listed = await page.evaluate(async () => {
    const response = await fetch("/api/matches?limit=5", { headers: { accept: "application/json" } });
    return response.ok ? response.json() : { matches: [], status: response.status };
  }).catch(() => null);
  const rows = listed && Array.isArray(listed.matches) ? listed.matches : [];
  const row = rows.find((film) => film.id === matchId) || null;
  mark("the resigned war is in /api/matches", Boolean(row), rows.length + " row(s)");
  mark("the header has ended_at", Boolean(row && row.ended_at), row ? String(row.ended_at) : "none");
  mark("the header has a final digest", Boolean(row && row.final_digest), row ? String(row.final_digest) : "none");

  // The film list is a LOBBY dialogue: leave the finished room first, then open War Films.
  await page.evaluate(() => { const button = document.getElementById("quitBtn"); if (button) button.click(); });
  await page.waitForFunction(() => !window.__chq.room(), null, { timeout: 20000 }).catch(() => {});
  await page.click("#filmsBtn");
  const rowShown = await page.waitForSelector("button[data-film]", { timeout: 20000 }).then(() => true).catch(() => false);
  mark("War Films lists the war", rowShown);
  if (!rowShown) throw new Error("no film row to watch");
  await page.evaluate(() => document.querySelector("button[data-film]").click());
  await page.waitForSelector("#filmbar:not(.hidden)", { timeout: 20000 }).catch(() => {});
  const verified = await page.waitForFunction(
    () => /digest verified|DIGEST MISMATCH|digest unverified|digest unread/.test(
      (document.getElementById("filmDigest") || {}).textContent || ""),
    null, { timeout: 30000 }).then(() => true).catch(() => false);
  const line = await digestLine();
  mark("the page verifies the last frame against finalDigest", verified && line === "digest verified", line);

  // Step to the closing frame: the bar says "frame N of N".
  let label = "";
  let frames = { at: 0, count: 0 };
  for (let i = 0; i < 400; i += 1) {
    label = await page.evaluate(() => (document.getElementById("filmLabel") || {}).textContent || "");
    const m = /frame (\d+) of (\d+)/.exec(label);
    frames = m ? { at: Number(m[1]), count: Number(m[2]) } : frames;
    if (frames.count && frames.at >= frames.count) break;
    await page.click("#filmNext");
    await sleep(30);
  }
  mark("the film steps to its last frame", Boolean(frames.count) && frames.at === frames.count, label);

  // ---- §4 (iii): one screenshot per Show, 1280x800 -----------------------------------
  const shows = ["Red", "Blue", "Common", "Both"];
  const shots = [];
  for (const show of shows) {
    await page.click("#filmShow" + show);
    await sleep(250);
    const pressed = await page.evaluate((name) => {
      const button = document.getElementById("filmShow" + name);
      return button ? button.getAttribute("aria-pressed") : null;
    }, show);
    const file = path.join(OUT, "t031-show-" + show.toLowerCase() + ".png");
    await page.screenshot({ path: file });
    const paint = await page.evaluate(() => window.__chq.paintReport());
    shots.push({ show, file, pressed, paint });
    mark("Show " + show + " is armed", pressed === "true", String(pressed));
  }
  const sized = shots.every((shot) => readFileSync(shot.file).length > 10000);
  mark("four screenshots were written at 1280x800", sized, shots.map((shot) => path.basename(shot.file)).join(" "));

  // ---- §4 (ii): Save → a .film file → Load → the SAME digest -------------------------
  const downloadWait = page.waitForEvent("download", { timeout: 20000 }).catch(() => null);
  await page.click("#filmSave");
  const download = await downloadWait;
  let savedPath = null;
  let savedDigest = null;
  let savedFrames = 0;
  if (download) {
    savedPath = path.join(OUT, download.suggestedFilename());
    await download.saveAs(savedPath);
    const parsed = JSON.parse(readFileSync(savedPath, "utf8"));
    savedDigest = parsed && parsed.film && parsed.film.meta ? parsed.film.meta.finalDigest : null;
    savedFrames = parsed && parsed.film && Array.isArray(parsed.film.frames) ? parsed.film.frames.length : 0;
    mark("Save wrote a .film file", parsed.format === "openchq.film" && savedFrames > 0,
      download.suggestedFilename() + " · " + savedFrames + " frames");
  } else {
    mark("Save wrote a .film file", false, "no download event");
  }
  mark("the file carries the header's digest", Boolean(savedDigest && row && savedDigest === row.final_digest),
    String(savedDigest));

  if (savedPath) {
    const beforeLine = await digestLine();
    await page.setInputFiles("#filmFile", savedPath);
    const loaded = await page.waitForFunction(() => /^Loaded /.test(window.__chq.toast()), null, { timeout: 15000 })
      .then(() => toast()).catch(() => "");
    mark("Load reads the file back", /^Loaded /.test(loaded), loaded);
    const reverified = await page.waitForFunction(
      () => /digest verified|DIGEST MISMATCH/.test((document.getElementById("filmDigest") || {}).textContent || ""),
      null, { timeout: 20000 }).then(() => true).catch(() => false);
    const afterLine = await digestLine();
    mark("the re-imported film gives the same verified digest", reverified && afterLine === "digest verified",
      beforeLine + " -> " + afterLine);
  }

  writeFileSync(path.join(OUT, "evidence.json"), JSON.stringify({
    base: BASE, served, matchId, name, header: row || null,
    digestLine: await digestLine(), shots,
  }, null, 2));
  mark("evidence written", true, path.join(OUT, "evidence.json"));
} catch (err) {
  mark("the leg finished", false, String((err && err.stack) || err).split("\n")[0]);
} finally {
  writeFileSync(path.join(OUT, "verdicts.json"), JSON.stringify({ passed: evidence.filter((row) => row.ok).length,
    failed, checks: evidence.length, evidence }, null, 2));
  console.log("RESULT " + (evidence.length - failed) + " passed, " + failed + " failed, " + evidence.length + " checks");
  if (browser) await browser.close();
  if (server) server.kill("SIGKILL");
  process.exit(failed ? 1 : 0);
}
