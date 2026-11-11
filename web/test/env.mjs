// Where the reference tree lives, for tests that need bytes from the original.
//
// No test may hard-code a mount path: a host without the NAS is a supported host, and a test
// that quietly returns there reports a pass for work it did not do. Callers ask for the root
// and throw ctx.skip when it is absent.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const warned = new Set();

// The extracted data root. OPENCHQ_DATA is the runner's variable; OPENCHQ_EXTRACT is the older
// name the single-node scripts used. An untracked local/data_root.txt can name it too, but only on
// a dev checkout: `local/` is in .gitignore and in no ref (`git log --all -- local/` is empty), so
// a published tree has no pointer, resolves from env alone, and skips when env is unset. Never call
// that file "committed" - that wording has already been mistaken for a shipped fallback.
export function extractRoot() {
  for (const key of ["OPENCHQ_DATA", "OPENCHQ_EXTRACT"]) {
    const value = process.env[key];
    if (!value) continue;
    const resolved = path.resolve(value);
    // A set-but-wrong path has to behave like an unset one. Returned unchecked it is worse than a
    // skip: this host measured `OPENCHQ_DATA=/nope/nothing` as 58 passed / 0 failed / 2 skipped and
    // exit 0, a green summary over a run that never saw the original bytes.
    if (existsSync(resolved)) return resolved;
    if (!warned.has(key)) {
      warned.add(key);
      console.error("env.mjs: " + key + " is set to " + value + ", which does not exist; treating it as unset");
    }
  }
  const pointer = path.join(projectDir, "local", "data_root.txt");
  if (existsSync(pointer)) {
    for (const line of readFileSync(pointer, "utf8").split("\n")) {
      const text = line.trim();
      if (!text || text.startsWith("#")) continue;
      return path.resolve(projectDir, text);
    }
  }
  return "";
}

// The reference tree root (the directory that holds tools/, docs/ and extracted/).
export function referenceRoot() {
  if (process.env.OPENCHQ_REFERENCE) return path.resolve(process.env.OPENCHQ_REFERENCE);
  const extract = extractRoot();
  return extract ? path.resolve(extract, "..") : "";
}

export function hasFile(...parts) {
  const [first, ...rest] = parts;
  if (!first) return false;
  return existsSync(path.join(first, ...rest));
}
