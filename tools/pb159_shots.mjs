// PB-159 before/after frames: the intel bar at lead 0, mid-pass, the seam and the tail-out.
//
// Loads the tree's own web/public/render.mjs in headless Chromium at a fixed 640x272 viewport,
// paints a board with the scan armed at four leads, and saves one PNG per lead under
// local/t022-shots/pb159/. Bar-body ink is recorded per frame and its x spans printed, so the
// screenshot and the number agree.
//
// Usage: node tools/pb159_shots.mjs --root <tree> --out <dir> --prefix before|after
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPlaywright } from "../tests/e2e/playwright.mjs";

// PB-189: the resolver, not a host path (PLAYWRIGHT_MODULE -> tests/e2e/node_modules -> repo
// node_modules -> bare import). A missing module says PLAYWRIGHT_MISSING; it does not stack-trace.
const { chromium } = await loadPlaywright();

function arg(name, fallback = null) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const root = path.resolve(arg("root", path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")));
const outDir = path.resolve(arg("out", path.join(root, "local", "t022-shots", "pb159")));
const prefix = String(arg("prefix", "after"));
const pub = path.join(root, "web", "public");
mkdirSync(outDir, { recursive: true });

const PAGE = `<!doctype html><html><body style="margin:0;background:#000">
<canvas id="c" width="640" height="272"></canvas>
<script type="module">
import { cellToPixel, fitViewport, paintMatch } from "/render.mjs";
import { SCAN, scanSpec } from "/scan.mjs";
const view = { ...fitViewport(640, 272), scale: 2, left: 0, top: 0, viewW: 640, viewH: 272 };
const board = { source: "extract", width: 320, height: 136, terrain: ["ocean"],
  cells: new Array(320 * 136).fill(0), capitals: null };
const room = { era: "1986", round: 4, clock: "held", you: "blue", pieces: [
  { id: "own", side: "blue", domain: "land", kind: null, x: 10, y: 40 },
  { id: "seen", side: "red", domain: "land", kind: null, x: 300, y: 40 },
]};
const canvas = document.getElementById("c");
const ctx = canvas.getContext("2d");
const original = ctx.fillRect.bind(ctx);
window.__fills = [];
ctx.fillRect = (x, y, w, h) => {
  if (String(ctx.fillStyle).toLowerCase() === SCAN.barInk.toLowerCase()) window.__fills.push({ x, w, y, h });
  original(x, y, w, h);
};
window.__draw = (lead) => {
  window.__fills = [];
  const spec = scanSpec(320);
  const state = { spec, lead, trail: lead - spec.barCells };
  const result = paintMatch(ctx, board, room, {
    view, own: "blue", scan: { state, active: true, intelIds: new Set() },
  });
  const ox = cellToPixel(0, 0, view).x;
  const boardRect = {
    x: Math.max(0, Math.min(ox, cellToPixel(320, 136, view).x)),
    right: Math.min(view.viewW, Math.max(ox, cellToPixel(320, 136, view).x)),
  };
  const spans = window.__fills
    .map((f) => ({ x1: f.x, x2: f.x + f.w }))
    .filter((s) => s.x2 > boardRect.x && s.x1 < boardRect.right)
    .map((s) => [Math.max(boardRect.x, s.x1), Math.min(boardRect.right, s.x2)]);
  return { lead, state: { trail: state.trail, barCells: spec.barCells }, board: boardRect,
    spans, fills: window.__fills.length, layers: result.layers, scanBar: result.scanBar };
};
window.__ready = true;
</script></body></html>`;

const MIME = { ".mjs": "text/javascript", ".js": "text/javascript", ".html": "text/html", ".json": "application/json", ".png": "image/png" };
const server = spawn(process.execPath, ["-e", `
const http = require("http"), fs = require("fs"), path = require("path");
const pub = ${JSON.stringify(pub)};
const mime = ${JSON.stringify(MIME)};
http.createServer((req, res) => {
  if (req.url === "/__shot.html") { res.writeHead(200, {"content-type": "text/html"}); return res.end(${JSON.stringify(PAGE)}); }
  const file = path.join(pub, decodeURIComponent(req.url.split("?")[0]));
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end("no"); }
    res.writeHead(200, { "content-type": mime[path.extname(file)] || "application/octet-stream" });
    res.end(buf);
  });
}).listen(0, "127.0.0.1", function () { console.log(this.address().port); });
`], { stdio: ["ignore", "pipe", "inherit"] });
const port = await new Promise((resolve, reject) => {
  let buf = "";
  server.stdout.on("data", (d) => {
    buf += d.toString();
    const m = buf.match(/(\d+)/);
    if (m) resolve(Number(m[1]));
  });
  server.on("exit", (code) => reject(new Error("static server exited " + code)));
});

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 640, height: 272 }, deviceScaleFactor: 1 });
await page.goto(`http://127.0.0.1:${port}/__shot.html`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });
const canvas = page.locator("#c");

const cases = [
  { name: "lead0", lead: 0, note: "pass start: the bar is still off the left edge, no right-edge strip" },
  { name: "mid", lead: 160, note: "mid-pass: one bar at half the crossing" },
  { name: "seam", lead: 330, note: "seam: the tail is on the right edge, nothing at the left" },
  { name: "end", lead: 340, note: "tail out: the board is dark again" },
];
const report = { root, prefix, viewport: { width: 640, height: 272 }, frames: [] };
for (const c of cases) {
  const state = await page.evaluate((lead) => window.__draw(lead), c.lead);
  const file = path.join(outDir, `${prefix}-${c.name}.png`);
  await canvas.screenshot({ path: file });
  report.frames.push({ ...c, file, ...state });
  console.log(`${prefix}-${c.name}: lead ${state.lead} trail ${state.state.trail} spans ${JSON.stringify(state.spans)} layers ${state.layers.join(",")}`);
}
writeFileSync(path.join(outDir, `${prefix}-spans.json`), JSON.stringify(report, null, 2));

await browser.close();
server.kill();
console.log("saved " + outDir);
