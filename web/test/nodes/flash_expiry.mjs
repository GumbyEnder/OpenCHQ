// PB-137: a flash line never expires. `say()` wrote #flash and nothing ever cleared it, so
// "Order sent. 1 round to walk. Selection cleared." was still on screen six rounds later (measured
// on live 9c72c81, 6 of 6 round changes). This node pins the two halves of the fix with a fake clock,
// so it bites without a browser:
//
//   1. a flash clears itself within PB-137's 8 s ceiling, with no input;
//   2. a new flash replaces the old one and restarts the timer (no stacking, no early blank);
//   3. the match-over line lives outside #flash, survives past the ceiling and past a later say();
//   4. it is cleared only when the player leaves the match.
//
// It also pins the wiring: the page has to actually use this module and the markup has to have its
// own #result element, or the module-level assertions would be pinning a file nothing imports.
export const name = "flash_expiry";

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FLASH_MS, createFlashLine } from "../../public/flash.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function fakeClock() {
  const jobs = new Map();
  let seq = 0;
  let now = 0;
  const clock = {
    get now() { return now; },
    setTimer(fn, ms) {
      const id = ++seq;
      jobs.set(id, { fn, at: now + Number(ms) });
      return id;
    },
    clearTimer(id) { jobs.delete(id); },
    advance(ms) {
      const target = now + Number(ms);
      for (;;) {
        const due = [...jobs.entries()].filter(([, job]) => job.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        jobs.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = target;
    },
    pending: () => jobs.size,
  };
  return clock;
}

export function run(ctx) {
  const { fail } = ctx;

  // PB-137 AC1 says 8 s is the ceiling. The chosen value is stated in the module; pin the ceiling.
  if (!(FLASH_MS <= 8000)) fail("FLASH_MS is above PB-137's 8 s ceiling: " + FLASH_MS);
  if (!(FLASH_MS > 0)) fail("FLASH_MS must be positive: " + FLASH_MS);

  const { setTimer, clearTimer, advance, pending } = (() => {
    const clock = fakeClock();
    return {
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      advance: (ms) => clock.advance(ms),
      pending: clock.pending,
    };
  })();
  const flash = { textContent: "" };
  const result = { textContent: "" };
  const line = createFlashLine({ element: flash, resultElement: result, setTimer, clearTimer });

  // 1. A flash clears itself on the timer, with no interaction.
  line.say("Order sent. 1 round to walk. Selection cleared.");
  if (flash.textContent !== "Order sent. 1 round to walk. Selection cleared.") {
    fail("say() did not write the flash: " + JSON.stringify(flash.textContent));
  }
  advance(FLASH_MS - 1);
  if (flash.textContent === "") fail("the flash cleared before its timer (" + (FLASH_MS - 1) + " ms)");
  advance(1);
  if (flash.textContent !== "") fail("the flash outlived its timer with no input: " + JSON.stringify(flash.textContent));
  if (pending()) fail("the timer handle survived its own expiry");
  if (result.textContent !== "") fail("expiring a flash touched the result line: " + JSON.stringify(result.textContent));

  // 2. A new flash replaces the old one and restarts the clock. The first timer must not blank the
  // second line after 6 s, and the second line must live its own full window.
  line.say("First acknowledgement.");
  advance(3000);
  line.say("Second acknowledgement.");
  if (flash.textContent !== "Second acknowledgement.") fail("a new flash did not replace the old one: " + JSON.stringify(flash.textContent));
  advance(3000); // would have expired the FIRST line
  if (flash.textContent !== "Second acknowledgement.") fail("the old timer blanked the replacement flash: " + JSON.stringify(flash.textContent));
  advance(FLASH_MS - 3000 + 1);
  if (flash.textContent !== "") fail("the replacement flash did not restart the timer: " + JSON.stringify(flash.textContent));

  // say("") clears immediately, and leaves no timer behind to fire later.
  line.say("Something said.");
  line.say("");
  if (flash.textContent !== "") fail("say(\"\") did not clear the flash");
  if (pending()) fail("say(\"\") left a timer armed");
  advance(FLASH_MS * 2);

  // 3. The match-over line: written once, survives the ceiling, and survives a later say().
  line.result("Blue wins: Moscow fell at round 12. Capitals: Washington blue, Moscow red.");
  line.say("Order sent. 1 round to walk.");
  advance(FLASH_MS * 3);
  if (flash.textContent !== "") fail("the flash did not expire while a result was on screen");
  if (!/Blue wins: Moscow fell at round 12/.test(result.textContent)) {
    fail("a later say() overwrote or cleared the result line: " + JSON.stringify(result.textContent));
  }

  // 4. Only leaving the match clears it.
  line.clearResult();
  if (result.textContent !== "") fail("clearResult() did not clear the result line");

  // Wiring: the module is used by the page, sayResult() writes the result line rather than the
  // flash, and the markup carries #result as its own element outside #flash.
  const app = readFileSync(path.join(root, "public", "app.js"), "utf8");
  if (!/import\s*\{\s*createFlashLine\s*\}\s*from\s*"\.\/flash\.mjs"/.test(app)) {
    fail("app.js does not import createFlashLine from ./flash.mjs");
  }
  if (!/createFlashLine\(\{\s*element:\s*flash,\s*resultElement:\s*resultLine\s*\}\)/.test(app)) {
    fail("app.js does not build the flash line on #flash and #result");
  }
  const sayResult = app.slice(app.indexOf("function sayResult"), app.indexOf("function eraName"));
  if (!sayResult) fail("app.js has no sayResult() to inspect");
  const sayResultCode = sayResult.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  if (/\bsay\(/.test(sayResultCode)) fail("sayResult() still writes the expiring flash");
  if ((sayResult.match(/flashLine\.result\(/g) || []).length !== 3) {
    fail("sayResult() does not route every branch to the result line");
  }

  const html = readFileSync(path.join(root, "public", "index.html"), "utf8");
  if (!/<p id="result" class="result"/.test(html)) fail("index.html has no #result element");
  const flashTag = html.match(/<p id="flash"[^>]*>/);
  const resultTag = html.match(/<p id="result"[^>]*>/);
  if (!flashTag || !resultTag) fail("index.html is missing a flash or result element");
  if (flashTag[0] === resultTag[0]) fail("#result is the #flash element");

  const css = readFileSync(path.join(root, "public", "app.css"), "utf8");
  if (!/\.flash:empty\s*\{\s*display:\s*none;/.test(css)) fail("an emptied flash still paints a pill (.flash:empty missing)");
  if (!/\.result\s*\{[\s\S]*?\}/.test(css)) fail("app.css has no .result rule");
}
