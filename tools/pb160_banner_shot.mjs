// PB-160 frame: the Intel shop row and the transcript banner, drawn with the page's own stylesheet.
//
// The strings come from the code, not from this script: shopLabel() for the row and the intel use's
// event.note for the banner. This is a render harness at a fixed viewport, not a live match frame;
// the live frame is part of the PM's hand-check.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPlaywright } from "../tests/e2e/playwright.mjs";

// PB-189: the resolver, not a host path (PLAYWRIGHT_MODULE -> tests/e2e/node_modules -> repo
// node_modules -> bare import). A missing module says PLAYWRIGHT_MISSING; it does not stack-trace.
const { chromium } = await loadPlaywright();

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "local", "t022-shots", "pb160");
mkdirSync(outDir, { recursive: true });

const { openMatch } = await import(pathToFileURL(path.join(root, "web/server/match.mjs")).href);
const { useTool } = await import(pathToFileURL(path.join(root, "web/server/late.mjs")).href);
const { priceOf } = await import(pathToFileURL(path.join(root, "web/server/rules.mjs")).href);
const { shopLabel } = await import(pathToFileURL(path.join(root, "web/public/command.mjs")).href);

const match = openMatch("1986", []);
match.clock = "running";
match.round = 4;
match.sides.blue.cash = 50000;
match.sides.red.cash = 50000;
match.pieces = [
  { id: "blue:land", side: "blue", domain: "land", kind: "infantry", x: 79, y: 44, path: [], pace: 1, facing: null, fighting: null, shots: 0, movedRound: -1 },
  { id: "red:sea", side: "red", domain: "sea", kind: "submarine", x: 200, y: 100, path: [], pace: 1, facing: null, fighting: null, shots: 0, movedRound: -1 },
];
const used = useTool(match, "blue", "intel");
if (used.error) throw new Error("intel refused: " + used.error);
const event = used.events.find((e) => e.type === "intel");
const row = shopLabel({ kind: "intelScan", price: priceOf("intelScan") });

const pub = path.join(root, "web", "public");
const html = `<!doctype html><html><head><link rel="stylesheet" href="/app.css"></head>
<body style="margin:0;background:#0b1018;width:720px;height:220px">
<style>.flash{position:static;transform:none;display:inline-block;margin:16px 12px}</style>
<div class="shop" style="padding:16px 12px"><button>${row}</button></div>
<p id="flash" class="flash"></p>
<script>document.getElementById("flash").textContent = ${JSON.stringify(event.note)};</script>
</body></html>`;

const server = spawn(process.execPath, ["-e", `
const http = require("http"), fs = require("fs"), path = require("path");
const pub = ${JSON.stringify(pub)};
http.createServer((req, res) => {
  if (req.url === "/__banner.html") { res.writeHead(200, {"content-type": "text/html"}); return res.end(${JSON.stringify(html)}); }
  const file = path.join(pub, decodeURIComponent(req.url.split("?")[0]));
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end("no"); }
    res.writeHead(200, {"content-type": path.extname(file) === ".css" ? "text/css" : "application/octet-stream"});
    res.end(buf);
  });
}).listen(0, "127.0.0.1", function () { console.log(this.address().port); });
`], { stdio: ["ignore", "pipe", "inherit"] });
const port = await new Promise((resolve) => {
  let buf = "";
  server.stdout.on("data", (d) => { buf += d; const m = buf.match(/(\d+)/); if (m) resolve(Number(m[1])); });
});

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 720, height: 220 }, deviceScaleFactor: 1 });
await page.goto(`http://127.0.0.1:${port}/__banner.html`);
await page.waitForTimeout(150);
await page.screenshot({ path: path.join(outDir, "banner.png") });
const text = await page.locator("#flash").textContent();
const button = await page.locator(".shop button").textContent();
writeFileSync(path.join(outDir, "banner.json"), JSON.stringify({ event, shopRow: button, banner: text }, null, 2));
console.log("shop row:", button);
console.log("banner:  ", text);
await browser.close();
server.kill();
console.log("saved " + outDir);
