// data_root_env: pins the loader's env-name contract, because a name that only half the code
// reads is how a correctly pointed with-extract leg turned into 6 silent skips (59/0/6 at
// t008-measure, 2026-11-12). env.mjs always read OPENCHQ_DATA and OPENCHQ_EXTRACT; board.mjs
// read only OPENCHQ_DATA, so the six nodes that ask the board for its root fell back to the
// bundled data while the rest saw the extract.
//
// This needs no reference tree: `usable()` only tests for data/tmap.bin and data/sites.json, so
// two empty marker files make a directory that resolves, and the assertions stay honest on a
// host with no original bytes.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveDataRoot } from "../../server/board.mjs";

export const name = "data_root_env";

function markerDir(tag) {
  const dir = mkdtempSync(path.join(tmpdir(), "openchq-root-" + tag + "-"));
  mkdirSync(path.join(dir, "data"));
  writeFileSync(path.join(dir, "data", "tmap.bin"), "");
  writeFileSync(path.join(dir, "data", "sites.json"), "{}");
  return dir;
}

export async function run(ctx) {
  const a = markerDir("a");
  const b = markerDir("b");
  const bogus = path.join(tmpdir(), "openchq-root-does-not-exist-" + process.pid);
  try {
    // 1. the older name alone must resolve: this is the regression the fix closed.
    if (resolveDataRoot({ OPENCHQ_EXTRACT: a }) !== path.resolve(a)) {
      ctx.fail("resolveDataRoot ignores OPENCHQ_EXTRACT (the 6-skip regression is back)");
    }
    // 2. OPENCHQ_DATA keeps precedence over OPENCHQ_EXTRACT.
    if (resolveDataRoot({ OPENCHQ_DATA: a, OPENCHQ_EXTRACT: b }) !== path.resolve(a)) {
      ctx.fail("OPENCHQ_DATA no longer wins over OPENCHQ_EXTRACT");
    }
    // 3. the deterministic no-extract leg wins over both names.
    if (resolveDataRoot({ OPENCHQ_NO_EXTRACT: "1", OPENCHQ_DATA: a, OPENCHQ_EXTRACT: b }) !== "") {
      ctx.fail("OPENCHQ_NO_EXTRACT=1 did not suppress a set extract root");
    }
    // 4. a set-but-missing path behaves like unset, not like a root.
    const fell = resolveDataRoot({ OPENCHQ_EXTRACT: bogus });
    if (fell === bogus || fell === path.resolve(bogus)) {
      ctx.fail("a missing OPENCHQ_EXTRACT path resolved as a data root");
    }
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
}
