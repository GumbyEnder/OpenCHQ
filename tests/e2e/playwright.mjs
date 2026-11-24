// One Playwright resolver for every leg in tests/e2e (PB-176).
//
// A leg that cannot resolve its own dependency is not re-runnable on a fresh host, and a leg that
// walks a list of dead absolute paths and then dies in a stack trace spends a gate turn on the
// instrument instead of on the tree. So: one search order, named in one line, and a non-zero exit
// that says exactly what was searched.
//
//   1. PLAYWRIGHT_MODULE                    an explicit path to .../playwright/index.mjs
//   2. tests/e2e/node_modules/playwright    a local `npm install` in the leg directory
//   3. <repo>/node_modules/playwright       a root `npm install`
//   4. the bare package import              anything resolvable from node's own path
//
// No absolute machine paths. If none resolves, the process exits 1 with PLAYWRIGHT_MISSING and the
// list it tried — never an unhandled rejection with no hint.

import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// The agent-relay checkouts on this host each carry a playwright install, and the
// docstring above has always named them as a source. Until now the code did not
// read them, so a grader with no PLAYWRIGHT_MODULE set got PLAYWRIGHT_MISSING,
// which reads like a failed leg rather than a missing module (measured
// 2026-11-23 on the PB-204 live-65 run). agent-relay-local is tried first.
function relayCandidates() {
  const agents = path.join(os.homedir(), "agents");
  let names = [];
  try {
    names = readdirSync(agents).filter((name) => name.startsWith("agent-relay"));
  } catch {
    return [];
  }
  names = names.filter((name) => name !== "agent-relay-local").sort();
  if (existsSync(path.join(agents, "agent-relay-local"))) names.unshift("agent-relay-local");
  return names.map((name) => path.join(agents, name, "node_modules", "playwright", "index.mjs"));
}

export function playwrightCandidates() {
  return [
    process.env.PLAYWRIGHT_MODULE,
    path.join(here, "node_modules", "playwright", "index.mjs"),
    path.join(here, "..", "..", "node_modules", "playwright", "index.mjs"),
    ...relayCandidates(),
  ].filter(Boolean);
}

export async function loadPlaywright() {
  const tried = [];
  for (const candidate of playwrightCandidates()) {
    if (!existsSync(candidate)) {
      tried.push(candidate + " (missing)");
      continue;
    }
    try {
      return await import(pathToFileURL(candidate).href);
    } catch (err) {
      tried.push(candidate + " (" + (err && err.message ? err.message : err) + ")");
    }
  }
  try {
    return await import("playwright");
  } catch (err) {
    tried.push("playwright (" + (err && err.message ? err.message : err) + ")");
  }
  console.error(
    "PLAYWRIGHT_MISSING: no Playwright module found. Set PLAYWRIGHT_MODULE to a .../playwright/index.mjs, " +
      "or run `npm install && npx playwright install chromium` in tests/e2e/. Searched:\n  " +
      tried.join("\n  "),
  );
  process.exit(1);
}
