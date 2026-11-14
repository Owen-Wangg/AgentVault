#!/usr/bin/env node
// PreToolUse hook for Kiro's shell tool. Reads the hook event as JSON on
// stdin and exits 2 to block the command, with the reason on stderr.
// Fails closed: input it can't read is blocked too.
import { collectStrings, findViolation } from "./lib/shell-rules.mjs";

const BLOCK = 2;

let raw = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) raw += chunk;

let event;
try {
  event = JSON.parse(raw);
} catch {
  process.stderr.write("guard-shell: could not parse the hook input, so the command was blocked.\n");
  process.exit(BLOCK);
}

for (const text of collectStrings(event?.tool_input)) {
  const reason = findViolation(text);
  if (reason) {
    process.stderr.write(`${reason}\n`);
    process.exit(BLOCK);
  }
}
process.exit(0);
