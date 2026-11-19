// Node speed_row_pin: the speed readout holds a fixed width, so `+` does not move (PB-143).
//
// The defect this pins: `.speedreadout` sized itself from its own text (`min-width` is a floor, not
// a cap), and the group is laid out left to right. `Speed 1` is ~74 px and `Speed 0 · paused` is
// ~94.75 px at 12 px, so the readout grew 20.75 px to the right and pushed `#speedUp` with it. A
// player who taps `+` twice at one spot hits the readout's new right half instead of the button.
//
// What this file can honestly check, on the served page:
//   1. the markup carries #speedDown, #speedReadout, #speedUp in that order inside .speedctl;
//   2. the .speedreadout rule declares a fixed `width` wide enough for the longest string, and does
//      not rely on `min-width` alone as its sizing.
// The button positions themselves cannot be read off a stylesheet: the browser leg is
// tests/e2e/pb143-speed-row.mjs, which measures getBoundingClientRect().left of #speedDown and
// #speedUp at speed 0 and speed 1 and requires them equal. This is the structural half, not a
// substitute for that measurement.
function fail(message) {
  throw new Error(message);
}

export const name = "speed_row_pin";

// "Speed 0 · paused" measured 94.75 px at 12 px in the PB-129 hand-check (1440x900, era 1942).
// The slot has to be at least that wide; 90 is the floor of the useful assertion, not the fix.
const MIN_SLOT_PX = 90;

// Split a stylesheet into { selector, body } blocks. Comments are stripped first so a sentence
// about `min-width` in prose cannot be read as a declaration.
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

export async function run(ctx) {
  const root = ctx.base;
  const html = await (await fetch(root + "/")).text();
  const css = await (await fetch(root + "/app.css")).text();

  // --- 1. the markup carries the three, in order, inside the group ------------
  const group = html.indexOf('class="speedctl"');
  if (group < 0) fail("the served page has no .speedctl group");
  const down = html.indexOf('id="speedDown"');
  const readout = html.indexOf('id="speedReadout"');
  const up = html.indexOf('id="speedUp"');
  if (down < 0) fail("the served page has no #speedDown");
  if (readout < 0) fail("the served page has no #speedReadout");
  if (up < 0) fail("the served page has no #speedUp");
  if (!(group < down && down < readout && readout < up)) {
    fail("#speedDown / #speedReadout / #speedUp are not in order inside .speedctl");
  }

  // --- 2. the readout carries a fixed slot wide enough for the longest string --
  const readoutRules = rules(css).filter((rule) =>
    rule.selector.split(",").some((value) => value.trim() === ".speedreadout"));
  if (!readoutRules.length) fail("the stylesheet has no .speedreadout rule");

  const widthFrom = (body) => {
    const hit = /(?:^|;|\s)width\s*:\s*([0-9.]+)px(?:;|\s|$)/i.exec(body);
    return hit ? Number(hit[1]) : null;
  };
  const widths = readoutRules.map((rule) => widthFrom(rule.body)).filter((value) => value !== null);
  if (!widths.length) {
    fail("`.speedreadout` has no fixed `width`; a content-driven box moves #speedUp (PB-143)");
  }
  const slot = Math.max(...widths);
  if (!(slot >= MIN_SLOT_PX)) {
    fail("`.speedreadout` width is " + slot + " px, shorter than `Speed 0 \u00b7 paused` (>= "
      + MIN_SLOT_PX + " px): #speedUp still shifts when the text changes");
  }
}
