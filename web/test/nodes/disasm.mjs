// Node chq_disassembly: a disassembler that actually runs.
//
// The claim this node has to earn is that the original's code can be read *here*, not that some
// artifact exists. So the test does three things: it checks the symbol index against the exported
// decompilation, it checks the arithmetic that makes Ghidra's addresses file offsets, and it reads
// the *known bytes* of a known function at the computed offset.
//
// The mapping, verified 2026-11-09 against render_sprite's body: Ghidra segments are relocated
// 0x1000 above the file's segments, and the load image starts at file 0x3600, so
//
//     file offset = 0x3600 + ((segment - 0x1000) << 4) + offset
//
// render_sprite is 1eb5:000c, which lands on 0x1215C. The signature there is unambiguous: the
// prologue (55 8b ec 83 ec 0a 56), the call through DS:0xE48C, the wrap compare against DS:0xE42A,
// and the five-byte write loop that stores into DS:0xEFBC (encoded as [bx-0x1044]).
//
// Naming note: `rename-table.tsv` puts the name `render_sprite` on 1eb5:00d8, a *different* 115-byte
// five-param ring writer (ring 0xE18A, wrap 0x50, head DS:0xC8D4). The body marker_hunt.md §4
// describes is the 203-byte function at 1eb5:000c. This test therefore pins the bytes at the entry,
// not the label: a name disagreement must not make a verified offset look wrong.
//
// The finding it pins: `render_sprite` is not a blitter. Its body pushes five bytes into a command
// ring at 0xEFBC and returns; something else drains the ring. docs/re/SYSTEMS.md called it "a sprite
// blitter" with HIGH confidence, which is why the unit-marker hunt was looking in the wrong place.
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { extractRoot, referenceRoot } from "../env.mjs";

const IMAGE_START = 0x3600;
const SEGMENT_DELTA = 0x1000;

function fail(message) {
  throw new Error(message);
}

function eq(message, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) fail(message + ": " + a + " !== " + b);
}

export function fileOffset(segment, offset) {
  return IMAGE_START + ((segment - SEGMENT_DELTA) << 4) + offset;
}

export const name = "disasm";

export async function run(ctx) {
  const root = extractRoot();
  const ref = referenceRoot();
  const indexPath = root ? path.join(root, "data", "disasm_index.json") : "";
  if (!indexPath || !existsSync(indexPath)) {
    ctx.skip("no extracted reference tree (set OPENCHQ_DATA or OPENCHQ_EXTRACT)");
    return;
  }
  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  if (!index.image || !index.image.mapping) fail("the index does not name its address mapping");
  if (!Array.isArray(index.functions)) fail("the index has no function list");
  eq("the index counts what it holds", index.count, index.functions.length);
  if (index.count < 800) fail("only " + index.count + " functions indexed; the export has 880");

  // --- the arithmetic that makes addresses meaningful --------------------------------------
  const byName = new Map();
  const seen = new Set();
  for (const fn of index.functions) {
    if (fn.linear !== ((fn.segment << 4) + fn.offset)) {
      fail(fn.name + " has a Ghidra linear address that is not (seg<<4)+off");
    }
    const computed = fileOffset(fn.segment, fn.offset);
    if (fn.file_offset !== computed) {
      fail(fn.name + " file offset " + fn.file_offset + " is not 0x3600+((seg-0x1000)<<4)+off (" + computed + ")");
    }
    if (!Number.isInteger(fn.size) || fn.size <= 0) fail(fn.name + " has no size");
    // Two entries can carry one name: Ghidra names thunks after what they thunk to. Entries are
    // unique; names are not.
    if (seen.has(fn.entry)) fail("two functions at the same entry " + fn.entry);
    seen.add(fn.entry);
    if (!byName.has(fn.name)) byName.set(fn.name, fn);
  }
  for (let i = 1; i < index.functions.length; i++) {
    if (index.functions[i].linear < index.functions[i - 1].linear) fail("the index is not ordered");
  }

  const main = byName.get("main_game_loop");
  if (!main) fail("main_game_loop is not in the index");
  eq("main_game_loop is where the docs say", main.entry, "1000:0000");
  eq("main_game_loop is the size the docs say", main.size, 473);
  if (!byName.get("get_terrain_type")) fail("get_terrain_type is not in the index");
  if (!byName.get("render_sprite")) fail("render_sprite is not in the index");
  // The signature function is identified by its entry: marker_hunt.md §4's body, 203 bytes.
  const sprite = index.functions.find((fn) => fn.entry === "1eb5:000c");
  if (!sprite) fail("the 203-byte ring writer at 1eb5:000c is not in the index");
  eq("the signature function is where marker_hunt puts it", sprite.entry, "1eb5:000c");
  eq("the signature function is the size the export gives", sprite.size, 203);

  // --- the signature, read at the formula's offset -----------------------------------------
  const exe = path.join(ref, "extracted", "exe", "CHQ_unpacked.EXE");
  if (!existsSync(exe)) {
    ctx.skip("no CHQ_unpacked.EXE under the reference tree (" + exe + ")");
    return;
  }
  const image = readFileSync(exe);
  const start = fileOffset(sprite.segment, sprite.offset);
  eq("render_sprite's computed file offset", start, 0x1215c);
  const bytes = (at, count) => Array.from(image.subarray(start + at, start + at + count));

  eq("render_sprite prologue bytes", bytes(0, 7), [0x55, 0x8b, 0xec, 0x83, 0xec, 0x0a, 0x56]);
  // call DWORD PTR ds:0xe48c — the ring drain thunk the finding names.
  eq("call through DS:0xE48C", bytes(0x4c, 4), [0xff, 0x1e, 0x8c, 0xe4]);
  // mov ax,ds:0xe42a — the ring head the wrap compare reads.
  eq("head read from DS:0xE42A", bytes(0x50, 3), [0xa1, 0x2a, 0xe4]);
  // cmp WORD PTR [bp-0xa],0x5 — the loop bound is five params.
  eq("five-param loop bound", bytes(0x65, 4), [0x83, 0x7e, 0xf6, 0x05]);
  // mov BYTE PTR [bx-0x1044],al — 0x10000-0x1044 = 0xEFBC, the five-byte ring write.
  eq("write into the DS:0xEFBC ring", bytes(0x77, 4), [0x88, 0x87, 0xbc, 0xef]);

  // --- the decompilation agrees, when the export is beside the extract ----------------------
  const decompPath = path.join(ref, "docs", "ghidra", "export", "decompiled.c");
  if (existsSync(decompPath)) {
    const lines = readFileSync(decompPath, "utf8").split("\n");
    eq(
      "every indexed function has a line in the C",
      index.functions.filter((fn) => Number.isFinite(fn.line)).length,
      index.count
    );
    for (const fn of index.functions.slice(0, 40)) {
      const line = lines[fn.line - 1] || "";
      if (!line.includes(fn.entry)) fail(fn.name + "'s line does not name its entry: " + line);
    }

    // --- the finding: render_sprite is a queue append, not a blit ---------------------------
    const body = lines.slice(sprite.line - 1, sprite.line + 60).join("\n");
    if (!/0xefbc/.test(body)) {
      fail("render_sprite's body does not touch the 0xefbc ring the finding is about");
    }
    if (/memcpy|memset|outp|0xA000/.test(body)) {
      fail("render_sprite looks like it draws pixels after all; the finding needs revisiting");
    }
    const writes = (body.match(/efbc/g) || []).length;
    if (writes < 1) fail("render_sprite never writes the ring");
  }

  // --- and the disassembler really disassembles at the same offset --------------------------
  let out = "";
  try {
    out = execFileSync("objdump", [
      "-D", "-b", "binary", "-m", "i8086", "-M", "intel",
      "--start-address=" + start, "--stop-address=" + (start + 32), exe,
    ], { encoding: "utf8" });
  } catch (err) {
    // objdump is a system tool, not a fixture: its absence is a skip, not a green line.
    ctx.skip("objdump is not installed (" + String(err.message).split("\n")[0] + ")");
    return;
  }
  const instructions = out.split("\n").filter((line) => /^\s+[0-9a-f]+:\t/.test(line));
  if (instructions.length < 5) fail("objdump produced " + instructions.length + " instructions at render_sprite");
  if (!instructions[0].includes("push")) fail("the first decoded instruction is not the prologue: " + instructions[0]);
}
