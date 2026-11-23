// pb182_placement_refresh - the armed highlight follows the round, not the arm click (PB-182).
//
// What fails if this is removed:
//   - the mask is taken once and never refreshed -> a cell keeps its arm-time box while the clock
//     runs (the live read: yellow at identical rgba from r70 to r77, inspect saying "Ready.")
//   - the refresh is sent without the round actually advancing -> every delta re-asks the server
//     for the mask, so a hover frame or a same-round delta turns into wire traffic
//   - the refresh is sent while no unit is armed (or after the arm was cleared) -> the server
//     answers a placement frame the page did not ask for, and the next round's render can paint a
//     stale mask over a cleared cursor
//
// This is a source pin on web/public/app.js, the same shape pb147_buy_over.mjs uses: applyDelta is
// the delta path, and the re-request has to live inside it, guarded on round advance AND on an
// armed, live placement. The behaviour itself is proved by tests/e2e/pb182-armed-decay.mjs, which
// keeps ONE arm across the whole long->soon->ready decay; a mutant that drops this send reds it.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const name = "pb182_placement_refresh";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function fail(message) {
  throw new Error(message);
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function bodyOf(source, start) {
  const at = source.indexOf(start);
  if (at < 0) fail("missing in app.js: " + start);
  let depth = 0;
  for (let i = source.indexOf("{", at); i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(at, i + 1);
    }
  }
  return fail("unbalanced braces after " + start);
}

export function run(ctx) {
  if (!ctx || typeof ctx !== "object") fail("no test context");
  const app = readFileSync(path.join(root, "public", "app.js"), "utf8");
  const applyDelta = stripComments(bodyOf(app, "function applyDelta("));

  if (!/const\s+advanced\s*=\s*next\s*!==\s*here/.test(applyDelta)) {
    fail("applyDelta does not record whether the round advanced; the mask refresh has no guard");
  }
  const refresh = applyDelta.match(/if\s*\(\s*advanced\s*&&\s*placement\s*&&\s*buying\s*\)\s*send\(\s*\{\s*op:\s*"placement",\s*kind:\s*buying\s*\}\s*\)/);
  if (!refresh) {
    fail('applyDelta does not re-request the placement mask on a round advance '
      + '(expected: if (advanced && placement && buying) send({ op: "placement", kind: buying }))');
  }
  if (applyDelta.indexOf(refresh[0]) > applyDelta.indexOf("drawMatch()")) {
    fail("the mask re-request happens after drawMatch(), so the delta frame paints the stale mask first");
  }
  // One arm site, not two: the arm click is still the only other place that asks for the mask.
  const asks = (app.match(/op:\s*"placement"/g) || []).length;
  if (asks !== 2) fail("expected exactly two op:\"placement\" sites (arm click + delta refresh), found " + asks);
}
