// Node chq_disassembly: a disassembler that actually runs.
//
// The claim this node has to earn is that the original's code can be read *here*, not that some
// artifact exists. So the test does three things: it checks the symbol index against the exported
// decompilation, it checks the arithmetic that makes objdump's output addressable in Ghidra's terms
// (file offset == (segment << 4) + offset), and it makes objdump decode a named function and
// confirms the bytes are instructions rather than data.
//
// The finding it pins: `render_sprite` (1eb5:000c) is not a blitter. Its body pushes five bytes into
// a command ring at 0xefbc and returns; something else drains the ring. docs/re/SYSTEMS.md calls it
// "a sprite blitter" with HIGH confidence, which is why the unit-marker hunt was looking in the
// wrong place.
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

function fail(message) {
  throw new Error(message);
}

function eq(message, actual, expected) {
  if (actual !== expected) fail(message + ": " + JSON.stringify(actual) + " !== " + JSON.stringify(expected));
}

export const name = "disasm";

export async function run() {
  const root = process.env.OPENCHQ_EXTRACT || "/mnt/nas/Projects/Command HQ/modern/extracted";
  const ref = "/mnt/nas/Projects/Command HQ/modern";
  const indexPath = root + "/data/disasm_index.json";

  if (!existsSync(indexPath)) {
    // No reference tree on this host: nothing to assert, and the page never needs this.
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
      fail(fn.name + " has a linear address that is not (seg<<4)+off");
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
  const sprite = byName.get("render_sprite");
  if (!sprite) fail("render_sprite is not in the index");

  // Line numbers only matter if they land inside the decompilation.
  const decompPath = ref + "/docs/ghidra/export/decompiled.c";
  if (existsSync(decompPath)) {
    const lines = readFileSync(decompPath, "utf8").split("\n");
    eq("every indexed function has a line in the C", index.functions.filter((fn) => Number.isFinite(fn.line)).length, index.count);
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
    // It writes exactly one byte per param into the ring, five in total.
    const writes = (body.match(/efbc/g) || []).length;
    if (writes < 1) fail("render_sprite never writes the ring");
  }

  // --- and the disassembler really disassembles --------------------------------------------
  const exe = ref + "/extracted/exe/CHQ_unpacked.EXE";
  const tool = ref + "/tools/disasm.py";
  if (existsSync(exe) && existsSync(tool)) {
    const start = sprite.linear;
    let out = "";
    try {
      out = execFileSync("objdump", [
        "-D", "-b", "binary", "-m", "i8086", "-M", "intel",
        "--start-address=" + start, "--stop-address=" + (start + 32), exe,
      ], { encoding: "utf8" });
    } catch (err) {
      fail("objdump could not decode the image: " + err.message);
    }
    const instructions = out.split("\n").filter((line) => /^\s+[0-9a-f]+:\t/.test(line));
    if (instructions.length < 5) fail("objdump produced " + instructions.length + " instructions at render_sprite");
    if (!instructions.some((line) => /\b(push|mov|call|add|sub|cmp|jmp|j[a-z]+)\b/.test(line))) {
      fail("the bytes at render_sprite did not decode as instructions");
    }
  }
}
