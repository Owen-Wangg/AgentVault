#!/usr/bin/env node
// PostFileSave hook for .gitignore files (.kiro/hooks/kiro-dir-guard.json).
// Devpost requires /.kiro in the public repo, so any ignore rule that
// matches .kiro or a file inside it fails this check.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `.kiro` and every path under it, with forward slashes. Folders are listed
 * without a trailing slash: git checks the disk to apply folder-only rules
 * such as `.kiro/`, and a trailing slash makes check-ignore report a false
 * match on a blank line.
 */
export function kiroPaths(root) {
  const out = [".kiro"];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      out.push(relative(root, full).split(sep).join("/"));
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(join(root, ".kiro"));
  return out;
}

/**
 * Ask git which of the paths its ignore rules match. `--no-index` checks the
 * rules even for files that are already tracked.
 * @returns {{ ignored: string[] } | { error: string }}
 */
export function findIgnored(root, paths) {
  const result = spawnSync("git", ["check-ignore", "--no-index", "--stdin"], {
    cwd: root,
    input: `${paths.join("\n")}\n`,
    encoding: "utf8",
  });
  // check-ignore exits 0 when something matched, 1 when nothing did.
  if (result.status === 1) return { ignored: [] };
  if (result.status === 0) return { ignored: result.stdout.split(/\r?\n/).filter(Boolean) };
  return { error: result.error?.message ?? result.stderr.trim() };
}

function main() {
  const root = process.cwd();
  const outcome = findIgnored(root, kiroPaths(root));
  if ("error" in outcome) {
    console.error(`check-kiro-not-ignored: git check-ignore failed: ${outcome.error}`);
    process.exit(1);
  }
  if (outcome.ignored.length > 0) {
    console.error(
      [
        "STOP: .kiro must never be gitignored. Devpost requires /.kiro in the public repo.",
        "These paths are now ignored:",
        ...outcome.ignored.map((p) => `  ${p}`),
        "Remove or narrow the .gitignore rule that matches them.",
      ].join("\n"),
    );
    process.exit(1);
  }
  console.log(`check-kiro-not-ignored: OK (${kiroPaths(root).length} paths checked)`);
}

// Windows paths can differ only in drive-letter case, so compare case-insensitively.
if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === process.argv[1].toLowerCase()) main();
