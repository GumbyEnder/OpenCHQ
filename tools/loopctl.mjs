#!/usr/bin/env node
// OpenCHQ loop controller. The graph in docs/web-loop.graph.json is the authority;
// this file only reads it, picks the next ready node, and records progress.
// One pass = one node. The state file lives in the repo so the counter survives reboots.
//
//   node tools/loopctl.mjs status          what is done, what is ready, where the counter sits
//   node tools/loopctl.mjs next            claim the next ready node, bump the iteration
//   node tools/loopctl.mjs current         print the claimed node id, or nothing
//   node tools/loopctl.mjs done [id]       mark a node done (defaults to the claimed node)
//   node tools/loopctl.mjs fail [id] "why" record a red pass, leave the node todo
//
// Exit codes: 0 ok, 2 nothing to do (complete or cap reached), 1 misuse.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const graphPath = path.join(root, "docs", "web-loop.graph.json");
const statePath = path.join(root, "docs", "loop-state.json");

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function loadGraph() {
  const graph = readJson(graphPath);
  if (!Array.isArray(graph.nodes)) throw new Error("graph has no nodes array");
  return graph;
}

function loadState(graph) {
  let state = null;
  try {
    state = readJson(statePath);
  } catch {
    state = null;
  }
  if (!state || typeof state !== "object") state = {};
  if (!Number.isInteger(state.iteration)) state.iteration = 0;
  if (!Number.isInteger(state.cap)) state.cap = Number(graph.cap) || 40;
  if (!("current" in state)) state.current = null;
  if (!("lastNodeId" in state)) state.lastNodeId = null;
  if (!("lastResult" in state)) state.lastResult = "";
  if (!("lastRunAt" in state)) state.lastRunAt = "";
  if (!Array.isArray(state.history)) state.history = [];
  return state;
}

function saveState(state) {
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
}

function isDone(node) {
  return node.status === "done";
}

function readyNodes(graph) {
  const done = new Set(graph.nodes.filter(isDone).map((node) => node.id));
  return graph.nodes
    .filter((node) => !isDone(node) && (node.depends || []).every((id) => done.has(id)))
    .sort((a, b) => Number(a.order) - Number(b.order));
}

function counts(graph) {
  const total = graph.nodes.length;
  const done = graph.nodes.filter(isDone).length;
  return { total, done };
}

function cmdStatus() {
  const graph = loadGraph();
  const state = loadState(graph);
  const { total, done } = counts(graph);
  const ready = readyNodes(graph);
  const next = ready[0];
  console.log(
    `iteration ${state.iteration}/${state.cap} | done ${done}/${total} | ` +
      `ready ${next ? next.id : "none"} | current ${state.current ?? "none"} | ` +
      `last ${state.lastNodeId ?? "none"} ${state.lastResult || ""}`.trim()
  );
  return 0;
}

function cmdNext() {
  const graph = loadGraph();
  const state = loadState(graph);
  const { total, done } = counts(graph);
  if (done === total) {
    console.log("COMPLETE: every node is done. Nothing to claim.");
    return 2;
  }
  if (state.iteration >= state.cap) {
    console.log(`CAP: iteration ${state.iteration}/${state.cap}. Nothing to claim.`);
    return 2;
  }
  if (state.current) {
    console.log(`CLAIMED_ALREADY ${state.current}: finish or fail that node before claiming another.`);
    return 2;
  }
  const ready = readyNodes(graph);
  if (!ready.length) {
    console.log("BLOCKED: no node has all dependencies done. Inspect the graph.");
    return 2;
  }
  const node = ready[0];
  state.iteration += 1;
  state.current = node.id;
  state.lastResult = "claimed";
  state.lastRunAt = new Date().toISOString();
  saveState(state);
  console.log(`NODE ${node.id}`);
  console.log(`ORDER ${node.order}`);
  console.log(`TITLE ${node.title}`);
  console.log(`DEPS ${(node.depends || []).join(",") || "none"}`);
  console.log(`WORK ${node.work}`);
  console.log(`PROVE ${node.prove}`);
  console.log(`ITERATION ${state.iteration}/${state.cap}`);
  return 0;
}

function cmdCurrent() {
  const graph = loadGraph();
  const state = loadState(graph);
  if (state.current) console.log(state.current);
  return 0;
}

function mark(status, id, note) {
  const graph = loadGraph();
  const state = loadState(graph);
  const target = id || state.current;
  if (!target) {
    console.error("no node given and none claimed; run 'next' first");
    return 1;
  }
  const node = graph.nodes.find((item) => item.id === target);
  if (!node) {
    console.error(`unknown node ${target}`);
    return 1;
  }
  node.status = status;
  writeFileSync(graphPath, JSON.stringify(graph, null, 2) + "\n");
  state.current = null;
  state.lastNodeId = target;
  state.lastResult = note;
  state.lastRunAt = new Date().toISOString();
  state.history.push({ node: target, status, note, at: state.lastRunAt });
  if (state.history.length > 60) state.history = state.history.slice(-60);
  saveState(state);
  const { total, done } = counts(graph);
  console.log(`${status === "done" ? "DONE" : "LEFT_TODO"} ${target} | done ${done}/${total} | ${note}`);
  return 0;
}

const [command, arg1, arg2] = process.argv.slice(2);
let code = 1;
try {
  if (command === "status") code = cmdStatus();
  else if (command === "next") code = cmdNext();
  else if (command === "current") code = cmdCurrent();
  else if (command === "done") code = mark("done", arg1, arg2 || "WEB_OK");
  else if (command === "fail") code = mark("todo", arg1, arg2 || "red");
  else {
    console.error("usage: loopctl.mjs status|next|current|done [id]|fail [id] [note]");
    code = 1;
  }
} catch (err) {
  console.error(err && err.stack ? err.stack : err);
  code = 1;
}
process.exit(code);
