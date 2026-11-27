// PB-273 page leg: chat between two humans, played from two real pages at 1280x800.
//
// The manual (p.32): "type whatever message you wish to send... appear on your opponent's message
// bar... If he replies, his messages will be displayed for you." This port sends on Enter (PM 9640's
// addendum makes live streaming optional); the sentence lands on the flash line the page already
// has (say(), the "message bar") and in the Log.
//
// What this leg does, with nothing stubbed:
//   1. two seats register, blue invites red to a 1986 two-player war, red accepts;
//   2. both pages show the chat field — the server's own `room.chatOpen`, not a guess from a name;
//   3. blue types and presses Enter: red's message bar reads "Blue: ..." and red's Log holds the line;
//   4. red replies: blue's message bar reads "Red: ..." and blue's Log holds it too;
//   5. a hostile string arrives as TEXT: no element is created, no script runs, and the flash shows
//      the characters the player typed;
//   6. a 500-character paste arrives as 200 characters (the server's cap, measured on the page);
//   7. a BOT room shows no chat field at all — the bot has no chat surface.
//
//   node tests/e2e/pb273-chat.mjs                 # starts its own server from this tree
//   node tests/e2e/pb273-chat.mjs --url=<base>    # a running server (the LIVE leg once shipped)
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
const GIVEN = (process.argv.find((v) => v.startsWith("--url=")) || "").slice(6).replace(/\/+$/, "") ||
  (process.env.E2E_URL || "").replace(/\/+$/, "");
const OUT = evidenceDir("pb273-chat", (process.argv.find((v) => v.startsWith("--out=")) || "").slice(6));
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evidence = [];
let failed = 0;
function mark(label, ok, detail) {
  if (!ok) failed += 1;
  evidence.push({ label, ok, detail });
  console.log((ok ? "PASS " : "FAIL ") + label + " — " + detail);
  writeFileSync(path.join(OUT, "pb273-chat.json"), JSON.stringify({ base: BASE, evidence }, null, 2));
}

let BASE = GIVEN;
let child = null;

// One exit path: a leg that dies mid-file reports the arm it crashed on and nothing else, which
// reads as "the cut failed" when the real finding is "the affordance is absent on this tree".
async function finish(browser, code) {
  const summary = "PB-273 chat: " + evidence.filter((row) => row.ok).length + " passed / " + failed +
    " failed / " + evidence.length + " checks";
  console.log(summary);
  writeFileSync(path.join(OUT, "pb273-chat.json"), JSON.stringify({ base: BASE, summary, evidence }, null, 2));
  if (browser) await browser.close();
  if (child) child.kill();
  process.exit(code === undefined ? (failed ? 1 : 0) : code);
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

async function signIn(page, name, password) {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 25000 });
  await page.fill("#register input[name=username]", name);
  await page.fill("#register input[name=password]", password);
  await page.click("#register button[type=submit]");
  await page.waitForSelector("#play:not(.hidden)", { timeout: 25000 });
}

// The Log is a dialog, so it is opened the way a player opens it; #roundLog only exists once it has
// been built, and reading it before that reads an empty string that looks like a lost line.
async function logText(page) {
  await page.click('.navbtn[data-dialog="log"]');
  await page.waitForSelector("#roundLog", { timeout: 10000 });
  const text = await page.evaluate(() => (document.getElementById("roundLog") || {}).textContent || "");
  await page.keyboard.press("Escape");
  await sleep(150);
  return text;
}

const chatState = (page) => page.evaluate(() => {
  const bar = document.getElementById("chatBar");
  const room = window.__chq.room();
  return {
    visible: Boolean(bar) && !bar.classList.contains("hidden"),
    chatOpen: room ? room.chatOpen : null,
    chat: room ? room.chat : null,
    toast: window.__chq.toast(),
    log: (document.getElementById("roundLog") || {}).textContent || "",
    hostileElements: document.querySelectorAll("#flash img, #flash script, #chatBar img").length,
  };
});

async function main() {
  const { chromium } = await loadPlaywright();
  if (BASE) {
    mark("using the given host", true, BASE);
  } else {
    const port = await freePort();
    const dataDir = mkdtempSync(path.join(tmpdir(), "openchq-pb273-chat-"));
    child = spawn(process.execPath, ["web/server/main.mjs"], {
      cwd: root,
      env: { ...process.env, OPENCHQ_WEB_HOST: "127.0.0.1", OPENCHQ_WEB_PORT: String(port), OPENCHQ_WEB_DATA: dataDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    BASE = "http://127.0.0.1:" + port;
    const started = Date.now();
    while (Date.now() - started < 20000) {
      try {
        const res = await fetch(BASE + "/api/version");
        if (res.ok) break;
      } catch {}
      await sleep(120);
    }
    mark("a local server answers", true, BASE);
  }

  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const tag = Date.now().toString(36).slice(-6);
  const blueName = "ChatBlue" + tag;
  const redName = "ChatRed" + tag;
  const ctxBlue = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const ctxRed = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const blue = await ctxBlue.newPage();
  const red = await ctxRed.newPage();
  const pageErrors = [];
  blue.on("pageerror", (err) => pageErrors.push("blue: " + String(err)));
  red.on("pageerror", (err) => pageErrors.push("red: " + String(err)));
  // Any element the hostile string would have created, or any script it ran, is a red.
  await red.addInitScript(() => { window.__xss = 0; });
  await blue.addInitScript(() => { window.__xss = 0; });

  await signIn(blue, blueName, "pw-blue-" + tag);
  await signIn(red, redName, "pw-red-" + tag);
  mark("both seats are in the lobby", true, blueName + " / " + redName);

  // A bot room FIRST, so the "no chat surface" arm is measured on a room this page really opened.
  const ctxBot = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const bot = await ctxBot.newPage();
  bot.on("pageerror", (err) => pageErrors.push("bot: " + String(err)));
  await signIn(bot, "ChatBot" + tag, "pw-bot-" + tag);
  await bot.selectOption('#launch select[name="era"]', "1986");
  await bot.selectOption('#launch select[name="side"]', "blue");
  await bot.evaluate(() => document.querySelector("#launch button[type=submit]").click());
  await bot.waitForFunction(() => window.__chq.room() && window.__chq.room().red && window.__chq.room().red.kind === "bot",
    null, { timeout: 25000, polling: 100 });
  await sleep(400);
  const botState = await chatState(bot);
  mark("a bot room shows no chat field", botState.visible === false && botState.chatOpen === false,
    "visible=" + botState.visible + " chatOpen=" + botState.chatOpen);
  const botFrame = await bot.evaluate(() => Boolean(window.__chq.room() && window.__chq.room().id));
  mark("the bot arm measures a real room frame, not an empty page", botFrame === true, "room id present");
  await ctxBot.close();

  // Two humans.
  await blue.selectOption('#launch select[name="era"]', "1986");
  await blue.selectOption('#launch select[name="side"]', "blue");
  await blue.waitForSelector("li.person", { timeout: 25000 });
  await blue.evaluate((name) => {
    const row = [...document.querySelectorAll("li.person")].find((li) => li.textContent.includes(name));
    row.querySelector("button").click();
  }, redName);
  await red.waitForSelector("#invites .invite button", { timeout: 25000 });
  await red.evaluate(() => document.querySelector("#invites .invite button").click());
  await blue.waitForFunction(() => window.__chq.room() && window.__chq.room().red && window.__chq.room().red.kind === "human",
    null, { timeout: 25000, polling: 100 });
  const roomId = await blue.evaluate(() => window.__chq.room().id);
  await red.waitForFunction((id) => window.__chq.room() && window.__chq.room().id === id, roomId,
    { timeout: 25000, polling: 100 });
  await sleep(400);

  for (const [who, page] of [["blue", blue], ["red", red]]) {
    const state = await chatState(page);
    mark("the " + who + " seat shows the chat field in a two-human room", state.visible === true && state.chatOpen === true,
      "visible=" + state.visible + " chatOpen=" + state.chatOpen);
  }

  // A tree without the field cannot run the message arms. That is a red on the arm, not a crash:
  // say so and reach the summary, so the control reads "the affordance is absent" instead of
  // "the browser timed out waiting for #chatInput".
  const canChat = await blue.evaluate(() => Boolean(document.getElementById("chatInput")));
  if (!canChat) {
    mark("the chat field exists on a two-human room, so the message arms can run", false, "no #chatInput on this tree");
    return finish(browser);
  }

  // --- blue sends ------------------------------------------------------------------------------
  await blue.click("#chatInput");
  await blue.type("#chatInput", "hello from blue");
  await blue.keyboard.press("Enter");
  await red.waitForFunction(() => /Blue: hello from blue/.test(window.__chq.toast()), null, { timeout: 15000, polling: 100 });
  const seenByRed = await chatState(red);
  mark("red's message bar reads the sentence", /Blue: hello from blue/.test(seenByRed.toast), seenByRed.toast);
  const redLog = await logText(red);
  mark("red's Log holds the same line", /hello from blue/.test(redLog), redLog.slice(0, 160));
  mark("red's room frame carries the message (the durable half is the server's)",
    Boolean(seenByRed.chat && seenByRed.chat.text === "hello from blue" && seenByRed.chat.side === "blue"),
    JSON.stringify(seenByRed.chat));
  mark("the field is cleared after sending", await blue.evaluate(() => document.getElementById("chatInput").value === ""), "cleared");

  // --- red replies ------------------------------------------------------------------------------
  await red.click("#chatInput");
  await red.type("#chatInput", "hello back");
  await red.keyboard.press("Enter");
  await blue.waitForFunction(() => /Red: hello back/.test(window.__chq.toast()), null, { timeout: 15000, polling: 100 });
  const replySeen = await chatState(blue);
  mark("blue's message bar reads the reply", /Red: hello back/.test(replySeen.toast), replySeen.toast);
  const blueLog = await logText(blue);
  mark("blue's Log holds the reply", /hello back/.test(blueLog), blueLog.slice(-160));

  // --- hostile string: text, not markup --------------------------------------------------------
  const hostile = '<img src=x onerror="window.__xss=1">';
  await blue.click("#chatInput");
  await blue.type("#chatInput", hostile);
  await blue.keyboard.press("Enter");
  await red.waitForFunction((h) => window.__chq.toast().includes(h), hostile, { timeout: 15000, polling: 100 });
  await sleep(300);
  const afterHostile = await chatState(red);
  const hostileProbe = await red.evaluate(() => ({ xss: window.__xss, imgs: document.querySelectorAll("#flash img").length,
    html: (document.getElementById("flash") || {}).innerHTML || "" }));
  mark("the hostile string reaches the message bar as TEXT", afterHostile.toast.includes(hostile), afterHostile.toast.slice(0, 80));
  mark("it creates no element and runs nothing", hostileProbe.xss === 0 && hostileProbe.imgs === 0,
    "xss=" + hostileProbe.xss + " imgs=" + hostileProbe.imgs + " html=" + hostileProbe.html.slice(0, 80));
  const hostileHtml = await red.evaluate(() => (window.__chq.room().chat || {}).html || "");
  mark("the server's HTML-safe form encodes the markup characters",
    hostileHtml.includes("&lt;img") && !hostileHtml.includes("<img"), hostileHtml.slice(0, 80));

  // --- the cap is the server's ---------------------------------------------------------------
  const long = "z".repeat(500);
  await blue.click("#chatInput");
  await blue.evaluate((text) => {
    const input = document.getElementById("chatInput");
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, long);
  await blue.keyboard.press("Enter");
  await red.waitForFunction(() => /Blue: z{5}/.test(window.__chq.toast()), null, { timeout: 15000, polling: 100 });
  await sleep(300);
  const capped = await red.evaluate(() => (window.__chq.room().chat || {}).text || "");
  mark("a 500-character message arrives as the 200-character cap", capped.length === 200, "len=" + capped.length);

  // --- one page error is a red ---------------------------------------------------------------
  mark("no page errors on either seat", pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 3)));

  return finish(browser);
}

main().catch((err) => {
  console.error("pb273-chat leg crashed: " + (err && err.stack ? err.stack : err));
  if (child) child.kill();
  process.exit(1);
});
