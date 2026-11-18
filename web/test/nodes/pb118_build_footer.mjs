// Node pb118_build_footer: the footer's build stamp is re-read on reconnect and on focus (PB-118).
//
// The defect this pins: the footer was filled by ONE top-level `fetch("/api/version")` with no
// `cache` directive, no re-fetch, and `.catch(() => {})` at the end. A tab that outlived a deploy
// therefore kept naming the build it loaded, forever, and a failed read left the footer blank with
// no signal at all. Measured on the page (not by reading this file): at `origin/web` a server swap
// under an open tab reconnected — "Reconnected. The match is where you left it." — and the footer
// still read `build aaaaaaa` while `/api/version` answered `bbbbbbb`, with one `/api/version`
// request for the whole session.
//
// What this file can honestly check, on the served page:
//   1. one version fetch, and it carries `cache: "no-store"` (a cached answer is not a legal one);
//   2. `loadVersion` is a function and is called from the three places the ticket names — startup,
//      the top of connect(), and a window focus listener — because "re-fetch on reconnect" only
//      holds if the reconnect funnel itself calls it;
//   3. a failed read is not silent (a visible word in the footer, a console line, and a marker),
//      and a stale answer cannot overwrite a newer one;
//   4. the "blank until the answer" property of T-007 AC5 survives: empty is what the success path
//      writes when the server names no build, and `#buildCommit:empty` stays hidden.
//
// It is a source pin, not a behaviour pin: the browser half is tests/e2e/run.mjs (footer text and
// title against the live /api/version) and the version-leg harness on disk drives the swap.
function fail(message) {
  throw new Error(message);
}

export const name = "pb118_build_footer";

function occurrences(haystack, needle) {
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at >= 0) {
    count += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

// The body of a named function, from its `function name(` line to the next top-level `\n}` that a
// following line starts at column 0. Good enough for this file's style (no nested bare `}` at
// column 0 inside a function body) and it fails loudly instead of silently grading the whole file.
function bodyOf(source, signature, nextSignature) {
  const start = source.indexOf(signature);
  if (start < 0) fail("app.js no longer declares " + signature.trim());
  const end = source.indexOf(nextSignature, start);
  if (end < 0) fail("the function after " + signature.trim() + " (" + nextSignature.trim() + ") is gone");
  return source.slice(start, end);
}

export async function run(ctx) {
  const base = ctx.base;
  const app = await (await fetch(base + "/app.js")).text();
  const html = await (await fetch(base + "/")).text();
  const css = await (await fetch(base + "/app.css")).text();

  // 1. One fetch of the version endpoint, carrying no-store.
  if (occurrences(app, 'fetch("/api/version"') !== 1) {
    fail('expected exactly one fetch("/api/version") in app.js, found ' + occurrences(app, 'fetch("/api/version"'));
  }
  const fetchLine = app.slice(app.indexOf('fetch("/api/version"'), app.indexOf('fetch("/api/version"') + 80);
  if (!/fetch\("\/api\/version",\s*\{\s*cache:\s*"no-store"\s*\}\)/.test(fetchLine)) {
    fail('the version fetch does not carry cache: "no-store" — got ' + JSON.stringify(fetchLine.split("\n")[0]));
  }

  // 2. loadVersion is a declaration, and the three call sites exist.
  if (!/function loadVersion\(\)\s*\{/.test(app)) {
    fail("loadVersion is not declared as a function; the footer is a bare top-level fetch again");
  }
  const declarationAt = app.indexOf("function loadVersion()");
  const withoutDeclaration = app.slice(0, declarationAt) + app.slice(declarationAt + "function loadVersion()".length);
  if (occurrences(withoutDeclaration, "loadVersion()") !== 3) {
    fail("loadVersion() is called " + occurrences(withoutDeclaration, "loadVersion()") +
      " times besides its declaration; the ticket names three (startup, connect, focus)");
  }
  if (!/^loadVersion\(\);$/m.test(app)) {
    fail("no line starts with `loadVersion();` — the startup call is not there");
  }
  const connect = bodyOf(app, "function connect() {", "\nasync function signOut()");
  if (!/function connect\(\) \{\s*\n(?:[^\n]*\n){0,3}?\s*loadVersion\(\);/.test(connect)) {
    fail("connect() does not call loadVersion() near its top — a reconnect would not re-read the build");
  }
  if (!/window\.addEventListener\("focus",\s*\(\)\s*=>\s*loadVersion\(\)\)/.test(app)) {
    fail("no window focus listener calls loadVersion() — the focus leg of the ruling is missing");
  }

  // 3. A failed read is not silent, and an out-of-date answer cannot win.
  const loadVersion = bodyOf(app, "function loadVersion() {", "\nloadVersion();");
  if (/\.catch\(\(\)\s*=>\s*\{\s*\}\)/.test(loadVersion)) {
    fail("loadVersion still ends in an empty .catch(() => {}) — that is the silent failure the ticket names");
  }
  if (!/console\.warn\(\s*"PB-118/.test(loadVersion)) {
    fail("the version failure path writes nothing to the console");
  }
  if (!/line\.textContent = "build unknown"/.test(loadVersion)) {
    fail('the version failure path does not say anything a player can see (expected `line.textContent = "build unknown"`)');
  }
  if (!/line\.dataset\.build = "error"/.test(loadVersion)) {
    fail('the version failure path sets no marker (expected `line.dataset.build = "error"`)');
  }
  if (occurrences(loadVersion, "if (seq !== versionSeq) return;") !== 2) {
    fail("the sequence guard is not on both arms — a slow read could land after a newer one");
  }

  // 4. T-007 AC5 survives: blank until the answer, and the blank row stays invisible.
  if (!/line\.textContent = data && data\.short \? "build " \+ data\.short : "";/.test(loadVersion)) {
    fail('the success path no longer writes "" when the server names no build (T-007 AC5)');
  }
  if (!/<span id="buildCommit"><\/span>/.test(html)) {
    fail("the served page no longer ships an empty #buildCommit span");
  }
  if (!/#buildCommit:empty\s*\{\s*display:\s*none;?\s*\}/.test(css)) {
    fail("#buildCommit:empty is no longer hidden — an empty footer row would flash on the way in");
  }
}
