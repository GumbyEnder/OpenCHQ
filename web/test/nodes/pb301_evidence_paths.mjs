// PB-301: a leg's evidence default must not leave the worktree.
//
// PB-184 gave six legs `evidenceDir()` and closed the throw class: an absolute /mnt/nas default
// throws on mkdir on a host with no NAS, after the assertions have printed. What it did not close is
// everything else - at e43ed70, 61 sites in 58 files of `tests/e2e` + `tools/` still assembled their
// own output path: 51 of the 76 legs under `$HOME/agents/game/notes/<pb>` (or, in four of them,
// `$HOME/agents/game/worktrees/<pb>`), and seven `tools/` probes on a NAS absolute. The HOME ones do
// not throw, which is why they survived: they write into ONE directory shared by every run and every
// lane, so somebody's gate silently overwrites somebody else's evidence (measured: a reviewer's
// default-out arm wrote its PNGs and JSON into another lane's notes dir mid-gate).
//
// This node is the census as an assertion. Any path assembled from the home directory, or an
// absolute NAS/home path, is forbidden in either tree outside two documented LOOKUPS and the
// resolver itself:
//   HOME-relative  process.env.HOME ... or os.homedir() ...  - outside the worktree by definition,
//                                                             whether the tail is `notes` or not
//   absolute       /mnt/nas/... or /home/<user>/...          - a path no worktree on another host has
// Comment lines are stripped first: prose that documents an old default is not a default.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const name = "pb301_evidence_paths";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// The census is over these two trees, by the rule the card was filed with.
const TREES = ["tests/e2e", "tools"];

// Files that may carry the shapes, each with the reason, kept exact so a new file cannot inherit an
// exemption by matching a prefix.
const ALLOWED = new Map([
  ["tests/e2e/evidence.mjs", "the resolver itself: it is the one place a path rule lives"],
  ["tests/e2e/playwright.mjs", "Playwright install LOOKUP: it scans $HOME/agents for an existing module, never writes"],
  ["tools/bake_territory.mjs", "CHQ-install try-list: a lookup of an installed game, never a write"],
]);

// Strip // line comments (quote-aware) and /* */ blocks, keeping line structure so a hit can be
// reported with its real line number.
function strippedLines(source) {
  const noBlocks = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return noBlocks.split("\n").map((line) => {
    let out = "";
    let quote = "";
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (quote) {
        out += ch;
        if (ch === quote && line[i - 1] !== "\\") quote = "";
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch;
        out += ch;
        continue;
      }
      if (ch === "/" && line[i + 1] === "/") break;
      out += ch;
    }
    return out;
  });
}

const SHAPES = [
  {
    label: "HOME-relative path",
    // Any output path assembled from the home directory: `process.env.HOME`, or `os.homedir()`
    // reached through an import. The tail does not matter - `notes`, `worktrees` and a bare join
    // are all outside the worktree, and keying on the tail is how four legs escaped the first rule.
    test: (text) => /process\.env\.HOME/.test(text) || /\b(?:os\.)?homedir\s*\(/.test(text),
  },
  {
    label: "absolute NAS path",
    test: (text) => /\/mnt\/nas\//.test(text),
  },
  {
    label: "absolute home path",
    test: (text) => /\/home\/[a-z][\w.-]*\//.test(text),
  },
];

export async function run(ctx) {
  const offenders = [];
  let scanned = 0;

  for (const tree of TREES) {
    const dir = path.join(root, tree);
    let files = [];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".mjs")).sort();
    } catch {
      continue;
    }
    for (const file of files) {
      const rel = tree + "/" + file;
      if (ALLOWED.has(rel)) continue;
      const lines = strippedLines(readFileSync(path.join(dir, file), "utf8"));
      scanned += 1;
      lines.forEach((line, index) => {
        for (const shape of SHAPES) {
          if (shape.test(line)) offenders.push(rel + ":" + (index + 1) + "  " + shape.label);
        }
      });
    }
  }

  // A census that scanned nothing is not a pass: it means the trees moved.
  if (scanned < 60) throw new Error("the census walked only " + scanned + " files; the trees moved");

  if (offenders.length) {
    throw new Error(
      offenders.length + " site(s) still default outside the worktree, first ten:\n  " +
        offenders.slice(0, 10).join("\n  ")
    );
  }
}
