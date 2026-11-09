#!/usr/bin/env node
// Check the Ghidra rename table against the export, address for address.
//
// The 2026-10-03 pass resolved addresses with (segment << 4) | offset, which put names on the
// wrong functions above offset 15. This script is the guard: every row of rename-table.tsv must
// name the function at that exact entry in functions.txt.
//
// Usage:
//   node tools/check_renames.mjs
//   OPENCHQ_REFERENCE="/path/to/Command HQ/modern" node tools/check_renames.mjs
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function referenceRoot() {
  if (process.env.OPENCHQ_REFERENCE) return path.resolve(process.env.OPENCHQ_REFERENCE);
  const extract = process.env.OPENCHQ_DATA || process.env.OPENCHQ_EXTRACT;
  if (extract) return path.resolve(path.resolve(extract), "..");
  const pointer = path.join(projectDir, "local", "data_root.txt");
  if (existsSync(pointer)) {
    for (const line of readFileSync(pointer, "utf8").split("\n")) {
      const text = line.trim();
      if (!text || text.startsWith("#")) continue;
      return path.resolve(projectDir, text, "..");
    }
  }
  return "";
}

const root = referenceRoot();
const tablePath = root ? path.join(root, "docs", "ghidra", "rename-table.tsv") : "";
const funcsPath = root ? path.join(root, "docs", "ghidra", "export", "functions.txt") : "";
if (!tablePath || !existsSync(tablePath) || !existsSync(funcsPath)) {
  console.log("rename check: SKIPPED — no reference tree (set OPENCHQ_REFERENCE)");
  process.exit(2);
}

const rows = readFileSync(tablePath, "utf8").split("\n").slice(1).filter((line) => line.trim());
const table = rows.map((line) => {
  const [entry, name] = line.split("\t");
  return { entry: entry.trim(), name: name.trim() };
});
const funcs = new Map();
for (const line of readFileSync(funcsPath, "utf8").split("\n").slice(1)) {
  const parts = line.split("\t");
  if (parts.length >= 3) funcs.set(parts[0].trim(), parts[2].trim());
}

let matched = 0;
const bad = [];
for (const row of table) {
  const got = funcs.get(row.entry) ?? "(missing)";
  if (got === row.name) matched += 1;
  else bad.push(`${row.entry}: ${got} != ${row.name}`);
}

console.log(`rename check: ${matched}/${table.length} match`);
for (const line of bad) console.log("  mismatch " + line);
if (matched !== table.length) process.exit(1);
if (funcs.get("107e:3bd0") !== "ai_turn_process") {
  console.log("  mismatch 107e:3bd0 is not ai_turn_process");
  process.exit(1);
}
console.log("rename check: 107e:3bd0 = ai_turn_process");
