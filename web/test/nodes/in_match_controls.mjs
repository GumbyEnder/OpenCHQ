// Node in_match_controls: the six map controls are on screen in a live match (PB-078).
//
// The defect this pins: `#themeToggle`, `#viewToggle`, `#camIn`, `#camOut`, `#camFit` and
// `#camFollow` all live in `.matchhead`, and the in-match stylesheet hid `.matchhead` outright
// (`body.in-match .matchhead { display: none; }`, twice). The buttons were in the markup, wired to
// click handlers, and impossible to see or press, so zoom/view/theme were keyboard-only in a match.
//
// What this file can honestly check, on the served page:
//   1. the markup carries all six ids, inside the .cam row inside .matchhead;
//   2. no `body.in-match` rule that targets .matchhead, .cam or one of the six ids hides it
//      (display/visibility/pointer-events/height/opacity);
//   3. an in-match rule puts .matchhead back on screen;
//   4. app.js binds a click handler to each of the six ids.
// Non-zero rendered size and hit-testing cannot be read off a stylesheet: the browser leg is
// tests/e2e/t019-shots.mjs, which measures getBoundingClientRect and elementFromPoint for all six
// and then CLICKS them. This is the structural half, not a substitute for that measurement.
function fail(message) {
  throw new Error(message);
}

export const name = "in_match_controls";

const IDS = ["themeToggle", "viewToggle", "camIn", "camOut", "camFit", "camFollow"];

// The compounds that, if hidden in a match, remove the controls from the screen.
const HIDE_TARGETS = new Set(["#strip", ".cam", ".match", ".matchhead", "#camNote",
  ...IDS.map((id) => "#" + id)]);

const HIDING = [
  [/display\s*:\s*none/i, "display:none"],
  [/visibility\s*:\s*hidden/i, "visibility:hidden"],
  [/pointer-events\s*:\s*none/i, "pointer-events:none"],
  [/(?:^|;|\s)(?:max-)?height\s*:\s*0(?:px)?(?:;|\s|$)/i, "zero height"],
  [/opacity\s*:\s*0(?:\.0+)?(?:;|\s|$)/i, "opacity:0"],
];

// Split a stylesheet into { selector, body } blocks. Comments are stripped first so a sentence
// about "display: none" in prose cannot be read as a declaration.
function rules(css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out = [];
  for (const chunk of clean.split("}")) {
    const at = chunk.indexOf("{");
    if (at < 0) continue;
    out.push({ selector: chunk.slice(0, at).replace(/\s+/g, " ").trim(), body: chunk.slice(at + 1) });
  }
  return out;
}

// The last compound of a selector is the element the rule writes to; the rest is the context.
function targetOf(selector) {
  const parts = selector.split(/[\s>+~]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

export async function run(ctx) {
  const root = ctx.base;
  const html = await (await fetch(root + "/")).text();
  const css = await (await fetch(root + "/app.css")).text();
  const app = await (await fetch(root + "/app.js")).text();

  // --- 1. the markup carries the six, inside the row --------------------------
  const head = html.indexOf('class="matchhead"');
  const row = html.indexOf('class="cam"');
  const end = html.indexOf('id="pauseBanner"');
  if (head < 0) fail("the served page has no .matchhead");
  if (row < 0) fail("the served page has no .cam row");
  if (!(head < row)) fail(".cam is not inside .matchhead");
  for (const id of IDS) {
    const at = html.indexOf('id="' + id + '"');
    if (at < 0) fail("the served page has no #" + id);
    if (at < row) fail("#" + id + " is before the .cam row");
    if (end > 0 && at > end) fail("#" + id + " is outside the match panel");
  }

  // --- 2. no in-match rule hides the row or the buttons -----------------------
  const list = rules(css);
  let chainRules = 0;
  for (const rule of list) {
    if (!rule.selector.includes("body.in-match")) continue;
    for (const selector of rule.selector.split(",").map((value) => value.trim())) {
      const target = targetOf(selector);
      if (!HIDE_TARGETS.has(target)) continue;
      chainRules += 1;
      // A rule on a child (`body.in-match .matchhead > #room`, `> h1`) targets that child, so it does
      // not match here; hiding the retired chip row is legal and does not reach the .cam line.
      for (const [pattern, why] of HIDING) {
        if (pattern.test(rule.body)) fail("in-match rule hides " + target + " (" + why + "): " + rule.selector);
      }
    }
  }
  if (chainRules < 1) fail("the stylesheet has no in-match rule for the map-control row");

  // --- 3. the row is put back on screen in-match ------------------------------
  const shown = list.filter((rule) => rule.selector.includes("body.in-match")
    && rule.selector.split(",").some((value) => targetOf(value.trim()) === ".matchhead")
    && /display\s*:\s*(block|flex|grid|inline-flex|contents)/i.test(rule.body));
  if (!shown.length) fail("no in-match rule puts .matchhead on screen");

  // --- 4. every button has its click handler ---------------------------------
  for (const id of IDS) {
    const bound = app.includes('document.getElementById("' + id + '")?.addEventListener("click"');
    if (!bound) fail("app.js binds no click handler to #" + id);
  }
}
