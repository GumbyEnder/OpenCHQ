// Stamp web/data/build.json with the commit being shipped.
//
// Only the `railway up` fallback needs this: an upload carries no .git, so /api/version
// cannot ask Railway for the commit. A push-triggered build reports
// RAILWAY_GIT_COMMIT_SHA instead and must NOT be stamped - a committed stamp goes stale
// the moment the next commit lands. tools/fire.sh stamps only when it uploads and
// restores the file afterwards.
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const commit = String(process.env.OPENCHQ_COMMIT || execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8" })).trim();
const short = commit.slice(0, 7);
const body = {
  commit,
  short,
  branch: execSync("git rev-parse --abbrev-ref HEAD", { cwd: root, encoding: "utf8" }).trim(),
  stamped: new Date().toISOString(),
};
const file = path.join(root, "web", "data", "build.json");
writeFileSync(file, JSON.stringify(body, null, 2) + "\n");
console.log("build stamp " + short + " -> " + path.relative(root, file));
