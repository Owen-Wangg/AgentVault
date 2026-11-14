import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { collectStrings, findViolation } from "./lib/shell-rules.mjs";

const blocked = [
  "rm -rf node_modules",
  "rm -fr dist",
  "rm -r -f build",
  "rm --recursive --force out",
  "sudo rm -Rf /tmp/x",
  "Remove-Item -Recurse -Force .next",
  "Remove-Item .next -Force -Recurse",
  "remove-item -r -fo .next",
  "ri -Recurse:$true -Force:$true dist",
  "Write-Output hi; Remove-Item -Recurse -Force src",
  "cmd /c rd /s /q build",
  "rmdir /s dist",
  "del /s /q *.log",
  "git push --force",
  "git push -f origin main",
  "git push --force-with-lease",
  "git push origin +main",
  "git -C repo push --force",
  "git reset --hard",
  "git reset --hard HEAD~1",
  "cat .env",
  "Get-Content .env.local",
  'type ".env.production"',
  "node --env-file=.env.local app.js",
];

const allowed = [
  "rm file.txt",
  "rm -r empty-dir",
  "Remove-Item $msg",
  "Remove-Item -Recurse build",
  "Remove-Item -Force file.txt",
  "Remove-Item -Filter *.tmp -Path out",
  "git push",
  "git push origin main",
  "git reset --soft HEAD~1",
  "git reset HEAD file.ts",
  "Copy-Item .env.example .env.example.bak",
  "Get-Content .env.example",
  "pnpm env:check",
  "pnpm test --run",
  "echo environment",
];

describe("guard-shell rules", () => {
  it.each(blocked)("blocks: %s", (command) => {
    expect(findViolation(command)).not.toBeNull();
  });

  it.each(allowed)("allows: %s", (command) => {
    expect(findViolation(command)).toBeNull();
  });

  it("collects every string in a nested tool input", () => {
    expect(collectStrings({ command: "a", opts: { cwd: "b", list: ["c", 1] } })).toEqual(["a", "b", "c"]);
  });
});

describe("guard-shell hook process", () => {
  const run = (stdin: string) => spawnSync(process.execPath, ["scripts/guard-shell.mjs"], { input: stdin, encoding: "utf8" });

  it("exits 2 with the reason on stderr for a blocked command", () => {
    const result = run(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "execute_pwsh", tool_input: { command: "git reset --hard" } }));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("git reset --hard");
  });

  it("exits 0 for a safe command", () => {
    const result = run(JSON.stringify({ tool_name: "execute_pwsh", tool_input: { command: "pnpm test --run" } }));
    expect(result.status).toBe(0);
  });

  it("fails closed on input it can't parse", () => {
    expect(run("not json").status).toBe(2);
  });
});
