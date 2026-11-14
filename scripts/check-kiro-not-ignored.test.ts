import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findIgnored, kiroPaths } from "./check-kiro-not-ignored.mjs";

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "kiro-guard-"));
  spawnSync("git", ["init", "-q"], { cwd: repo });
  mkdirSync(join(repo, ".kiro", "specs", "demo"), { recursive: true });
  writeFileSync(join(repo, ".kiro", "specs", "demo", "tasks.md"), "# Tasks\n");
  writeFileSync(join(repo, ".kiro", "settings.json"), "{}\n");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

const check = (gitignore: string) => {
  writeFileSync(join(repo, ".gitignore"), gitignore);
  return findIgnored(repo, kiroPaths(repo));
};

describe("check-kiro-not-ignored", () => {
  it("lists .kiro, its folders, and its files", () => {
    expect(kiroPaths(repo)).toEqual(
      expect.arrayContaining([".kiro", ".kiro/specs", ".kiro/specs/demo/tasks.md", ".kiro/settings.json"]),
    );
  });

  it("passes with a normal .gitignore", () => {
    expect(check("node_modules\n.next\n.env*\n!.env.example\n")).toEqual({ ignored: [] });
  });

  it("passes with blank lines and comments, which git can misreport for paths ending in a slash", () => {
    expect(check("# Vercel\n.vercel/\n\n# OS\n.DS_Store\n\n")).toEqual({ ignored: [] });
  });

  it.each([".kiro\n", ".kiro/\n", ".*\n", "*.md\n", "specs/\n", "**/settings.json\n"])(
    "fails when a rule matches .kiro content: %j",
    (rule) => {
      const outcome = check(rule);
      expect("ignored" in outcome && outcome.ignored.length > 0).toBe(true);
    },
  );
});
