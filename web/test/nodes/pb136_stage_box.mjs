// Node pb136_stage_box: the stage's box does not change when the clock starts (PB-136).
//
// The defect this pins: the map moved 45.42 px under a resting pointer at 1440x900 between "round 0,
// clock held" and "round 1, band up" - 17.42 px from #pauseBanner leaving the flex flow and 28.00 px
// from the 56 px band appearing under a centred canvas. Both are LAYOUT changes, so the fix is that
// neither element's box ever changes while a match is up, not a camera correction after the fact.
//
// What this file can honestly check on the served page:
//   1. the banner keeps its row in a match (visibility, not display) and only its ink is hidden;
//   2. the band reserves its 56 px before the first round (`.bandwait` keeps the box);
//   3. app.js measures the band's height without asking whether it is `hidden`;
//   4. app.js never re-fits the canvas because the band arrived;
//   5. the old shapes (a conditional banner sentence, `display:none` on the banner, the hidden-class
//      guard on the band height) are gone.
// The measurement itself is the browser leg: /mnt/nas/host-ops/openchq/pb136/ac-legs.mjs, which reads
// getBoundingClientRect().top at the three moments and clicks across the transition.
function fail(message) {
  throw new Error(message);
}

export const name = "pb136_stage_box";

const NEEDS = [
  ["the banner keeps its row in a match (visibility, not display)",
    /body\.in-match \.pausebanner\s*\{[^}]*visibility:\s*hidden/],
  ["a paused banner is shown again by visibility alone",
    /body\.in-match \.pausebanner\.paused\s*\{[^}]*visibility:\s*visible/],
  ["the band reserves its box before the first round",
    /body\.in-match \.chrome\.bandwait\s*\{[^}]*visibility:\s*hidden/],
  ["the band still refuses to be squeezed by the canvas",
    /body\.in-match \.chrome\s*\{[^}]*flex:\s*0 0 auto/],
];

// Shapes that were the defect: each one puts a box back in motion at the transition.
const FORBIDDEN_IN_APP = [
  ["the band's height is still measured only when it is not hidden",
    /classList\.contains\("hidden"\)\s*\)\s*\n?\s*\?\s*Math\.round\(band\.getBoundingClientRect\(\)\.height\)/],
  ["the canvas is still re-fitted when the band arrives",
    /wasHidden\) applyCanvasCss\(\)/],
  ["the banner sentence is still conditional on the pause",
    /banner\.textContent = paused \?/],
];

export async function run(ctx) {
  const root = ctx.base;
  const html = await (await fetch(root + "/")).text();
  const css = await (await fetch(root + "/app.css")).text();
  const app = await (await fetch(root + "/app.js")).text();

  if (!html.includes('id="pauseBanner"')) fail("the served page has no #pauseBanner");
  if (!html.includes('id="chrome"')) fail("the served page has no #chrome band");

  for (const [why, pattern] of NEEDS) {
    if (!pattern.test(css)) fail("the stylesheet does not reserve " + why);
  }

  if (!/const bandH = band \? Math\.round\(band\.getBoundingClientRect\(\)\.height\) : 0;/.test(app)) {
    fail("app.js does not measure the band's reserved height unconditionally");
  }
  if (!/chrome\.classList\.toggle\("bandwait", inMatch && !hasRound\);/.test(app)) {
    fail("app.js does not hand the band to .bandwait before the first round");
  }
  if (!/banner\.textContent = "Paused - press Play to resume";/.test(app)) {
    fail("the banner sentence is not written unconditionally (its box would change height on Play)");
  }
  if (!/banner\.classList\.toggle\("paused", paused\);/.test(app)) {
    fail("app.js does not toggle the banner's paused state");
  }

  for (const [why, pattern] of FORBIDDEN_IN_APP) {
    const hit = app.match(pattern);
    if (hit) fail(why + ": " + hit[0].split("\n")[0].trim());
  }

  // The band's own geometry is the original's and must not be re-cut by this ticket.
  if (!/height:\s*56px/.test(css)) fail("the band lost its 56 px height");
}
