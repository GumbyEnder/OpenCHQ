// Renders the shipped badge painter big, so a human (or a vision pass) can actually look at the
// shapes instead of guessing at 14 px. Uses the real render.mjs paintBadge and the real badges.mjs
// geometry - not the SVG mockup path.
//
//   node badge-board.mjs --url=http://127.0.0.1:8107 --out=/mnt/nas/projects/OpenCHQ/local/t014-shots
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const arg = (name, fallback = "") => {
  const hit = process.argv.find((v) => v.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const BASE = (arg("url", "") || "").replace(/\/+$/, "");
const OUT = arg("out", "/mnt/nas/projects/OpenCHQ/local/t014-shots");
if (!BASE) { console.error("usage: node badge-board.mjs --url=<base> [--out=dir]"); process.exit(2); }

const { chromium } = await import("playwright");
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 1 })).newPage();
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => !document.body.classList.contains("booting"), null, { timeout: 30000 });

const result = await page.evaluate(async () => {
  const render = await import("/render.mjs");
  const badges = await import("/badges.mjs");
  document.body.innerHTML = "";
  document.body.style.background = "#0d1220";

  const kinds = [...badges.BADGE_KINDS, "transport"];
  const states = [["idle", null], ["selected", "selected"], ["moving", "moving"], ["combat", "combat"]];
  const S = 3;          // cells per badge
  const scale = 20;     // device px per cell -> a 60 px badge
  const pad = 14;
  const cellW = 64;
  const cellH = 76;
  const canvas = document.createElement("canvas");
  canvas.width = pad * 2 + cellW * kinds.length;
  canvas.height = pad * 2 + cellH * (states.length + 2) + 40;
  canvas.style.cssText = "margin:12px;background:#0a1020;border:1px solid #22314c";
  document.body.append(canvas);
  const ctx = canvas.getContext("2d");

  const draw = (kind, side, state, cx, cy, extra = {}) => {
    const piece = {
      id: kind + ":" + side + ":" + state, kind: kind === "transport" ? "infantry" : kind, side,
      domain: kind === "transport" ? "land" : (badges.BADGE_DOMAIN[kind] || "land"),
      x: (cx - pad) / scale, y: (cy - pad) / scale, strength: 100, maxStrength: 100,
      transport: kind === "transport", path: [], facing: null, fighting: null, ...extra,
    };
    // badgeGroups() needs cell coordinates; the view maps cells to pixels 1:1 at `scale`.
    const view = { scale, left: 0, top: 0, viewW: canvas.width, viewH: canvas.height, boardW: 320, boardH: 136 };
    const [group] = badges.badgeGroups([piece], scale, 14);
    // The badge is drawn centred on its cell, so shifting the view puts its centre where we want it.
    render.paintBadge(ctx, { ...group, x: 0, y: 0 },
      { ...view, left: cx - scale / 2, top: cy - scale / 2 }, { badgeMinPx: 14, selectedId: piece.id });
  };

  ctx.fillStyle = "#e6ecf7";
  ctx.font = "13px ui-sans-serif,system-ui,sans-serif";
  kinds.forEach((kind, i) => {
    ctx.fillStyle = "#9fb4d8";
    ctx.fillText(kind, pad + i * cellW + 2, pad - 2);
  });

  states.forEach(([stateLabel, state], row) => {
    kinds.forEach((kind, col) => {
      const cy = pad + 40 + row * cellH;
      const cx = pad + col * cellW + 32;
      draw(kind, "blue", state, cx, cy - 8);
      draw(kind, "red", state, cx, cy + 30);
    });
    ctx.fillStyle = "#8296b8";
    ctx.fillText(state || "idle", 4, pad + 40 + row * cellH);
  });

  // A bottom row: damaged, entrenched, stacked, and 14 px real size.
  const rowY = pad + 40 + states.length * cellH;
  const strip = [
    { label: "damaged 30", extra: { strength: 30 } },
    { label: "entrenched", extra: { entrenched: true } },
    { label: "pinned", extra: { pinned: true } },
  ];
  strip.forEach((item, i) => {
    const cx = pad + 32 + i * cellW * 1.6;
    draw("infantry", "blue", "idle", cx, rowY, item.extra);
    ctx.fillStyle = "#8296b8";
    ctx.fillText(item.label, cx - 24, rowY + 34);
  });
  // 14 px, exactly the floor the PM set, blue then red infantry + tank.
  const smallX = pad + cellW * 6;
  [["infantry", "blue"], ["infantry", "red"], ["tank", "blue"], ["tank", "red"]].forEach(([kind, side], i) => {
    const piece = { id: "s" + i, kind, side, domain: "land", strength: 100, maxStrength: 100, x: 0, y: 0, path: [], facing: null, fighting: null };
    const [group] = badges.badgeGroups([piece], 4, 14);
    render.paintBadge(ctx, group, { scale: 4, left: smallX + i * 22 - 2, top: rowY - 2, viewW: 999, viewH: 999, boardW: 320, boardH: 136 }, { badgeMinPx: 14 });
  });
  ctx.fillStyle = "#8296b8";
  ctx.fillText("14 px floor", smallX, rowY + 34);

  // ---- the 14 px floor, measured ------------------------------------------------
  // Every kind is drawn at the PM's floor into its own tiny canvas: the point is to prove that at
  // that size each type is still its own picture (a distinct pixel signature, not a blank square)
  // and that the two sides differ by more than hue.
  const thumb = (kind, side) => {
    const c = document.createElement("canvas");
    c.width = 14; c.height = 14;
    const tctx = c.getContext("2d");
    const piece = { id: kind + side, kind: kind === "transport" ? "infantry" : kind, side,
      domain: kind === "transport" ? "land" : (badges.BADGE_DOMAIN[kind] || "land"),
      x: 0, y: 0, strength: 100, maxStrength: 100, transport: kind === "transport",
      path: [], facing: null, fighting: null };
    const [group] = badges.badgeGroups([piece], 4, 14);
    render.paintBadge(tctx, { ...group, x: 0, y: 0 },
      { scale: 4, left: 5, top: 5, viewW: 999, viewH: 999, boardW: 320, boardH: 136 }, { badgeMinPx: 14 });
    const data = tctx.getImageData(0, 0, 14, 14).data;
    let sum = 0; let ink = 0;
    const rowSigs = [];
    for (let y = 0; y < 14; y++) {
      let row = "";
      for (let x = 0; x < 14; x++) {
        const i = (y * 14 + x) * 4;
        const v = (data[i] + data[i + 1] + data[i + 2]) * data[i + 3];
        sum = (sum * 31 + v) >>> 0;
        row += (data[i + 3] > 8 ? "1" : "0");
      }
      rowSigs.push(row);
    }
    ink = rowSigs.join("").split("1").length - 1;
    return { signature: sum, ink, bitmap: rowSigs };
  };

  const floor = [];
  for (const kind of kinds) {
    const blue = thumb(kind, "blue");
    const red = thumb(kind, "red");
    floor.push({ kind, blueInk: blue.ink, redInk: red.ink,
      signaturesDiffer: blue.signature !== red.signature });
  }
  const blueSigs = new Set(kinds.map((k) => thumb(k, "blue").signature));
  const redSigs = new Set(kinds.map((k) => thumb(k, "red").signature));

  return { width: canvas.width, height: canvas.height,
    floor, distinctBlue: blueSigs.size, distinctRed: redSigs.size, kinds: kinds.length };
});

const file = path.join(OUT, "badge-painter-large.png");
await page.locator("canvas").screenshot({ path: file });
writeFileSync(path.join(OUT, "badge-painter-large.json"), JSON.stringify({ file, ...result }, null, 2));
console.log("wrote", file, JSON.stringify(result));
await browser.close();
