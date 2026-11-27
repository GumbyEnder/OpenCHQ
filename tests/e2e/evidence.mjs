// PB-184: where a leg's evidence lands.
//
// Every leg used to default --out to an absolute /mnt/nas path. On this host that directory exists,
// so the default silently worked; on a gate worktree on a host with no NAS mount the same leg throws
// on mkdir AFTER its assertions have printed - a green leg that lost its evidence. The default is
// now a directory under the worktree, named by the leg and stamped per run, so `git status` shows
// exactly one untracked directory and nothing is written outside the tree unless --out says so.
//
// An explicit --out is still honoured verbatim: /mnt/nas/... is a fine value to pass, never a default.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export function evidenceDir(name, explicit = "", now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const dir = explicit ? path.resolve(explicit) : path.join(here, name + "-" + stamp);
  mkdirSync(dir, { recursive: true });
  return dir;
}
