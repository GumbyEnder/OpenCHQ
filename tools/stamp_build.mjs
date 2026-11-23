// Stamp web/data/build.json with the commit being shipped.
//
// Only the `railway up` fallback needs this: an upload carries no .git, so /api/version
// cannot ask Railway for the commit. A push-triggered build reports
// RAILWAY_GIT_COMMIT_SHA instead and must NOT be stamped - a committed stamp goes stale
// the moment the next commit lands. tools/fire.sh stamps only when it uploads and
// restores the file afterwards.
//
//   node tools/stamp_build.mjs            write the stamp for this tree (or OPENCHQ_COMMIT)
//   node tools/stamp_build.mjs --check    exit 1 if the stamp does not name this tree (no write)
//
// The committed file in this repo is therefore EXPECTED to be older than HEAD. What must never
// happen is an upload that carries it while it names a different commit, so the check exists for
// the moment before an upload, not for the tree: tools/fire.sh runs it after it re-stamps and
// aborts the deploy if the two disagree.
import { execSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const file = path.join(root, "web", "data", "build.json");
const check = process.argv.includes("--check");

const commit = String(process.env.OPENCHQ_COMMIT || execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8" })).trim();
const short = commit.slice(0, 7);

if (check) {
  let baked = {};
  try {
    baked = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    /* a missing or unreadable stamp is stale, not a separate failure to explain */
  }
  const stamped = String(baked.commit || "").trim();
  if (stamped === commit) {
    console.log("build stamp OK: " + short + " names this tree");
    process.exit(0);
  }
  let behind = "";
  if (stamped) {
    const n = spawnSync("git", ["rev-list", "--count", stamped + ".." + commit], { cwd: root, encoding: "utf8" });
    if (n.status === 0) behind = " (" + n.stdout.trim() + " ships behind)";
  }
  console.error(
    "BUILD_STAMP_STALE: web/data/build.json says " +
      (stamped ? stamped.slice(0, 7) + behind : "nothing") +
      ", this tree is " +
      short +
      ". An upload now would name the wrong commit on /api/version. " +
      "Run `node tools/stamp_build.mjs`, or set OPENCHQ_COMMIT, before uploading.",
  );
  process.exit(1);
}

const body = {
  commit,
  short,
  branch: execSync("git rev-parse --abbrev-ref HEAD", { cwd: root, encoding: "utf8" }).trim(),
  stamped: new Date().toISOString(),
};
writeFileSync(file, JSON.stringify(body, null, 2) + "\n");
console.log("build stamp " + short + " -> " + path.relative(root, file));
