// Stamp web/data/build.json with the commit being shipped.
//
// Railway's builder does not reliably carry .git, so /api/version cannot always ask git. This
// runs after the commit and before the upload: the number on the page is the commit the user
// pushed, not a guess. Run it by hand when deploying without tools/fire.sh.
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
