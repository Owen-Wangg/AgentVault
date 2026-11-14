// Rules for the guard-shell hook (.kiro/hooks/guard-shell.json).
// Blocks recursive force deletes, force pushes, hard resets, and any
// reference to a .env file other than .env.example.

const DELETE_COMMANDS = new Set(["rm", "remove-item", "ri", "del", "erase", "rd", "rmdir"]);

/** Split a command line into simple commands at ;, &&, ||, |, and newlines. */
function segments(command) {
  return command
    .split(/\r?\n|;|&&|\|\||\|/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Tokenize a simple command, dropping surrounding quotes. */
function tokens(segment) {
  return (segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((t) => t.replace(/^["']|["']$/g, ""));
}

/** Strip a leading invocation like `&`, `sudo`, or `cmd /c` so the real command is first. */
function commandTokens(segment) {
  const t = tokens(segment);
  while (t.length > 0) {
    const head = (t[0] ?? "").toLowerCase();
    if (head === "&" || head === "sudo" || head === "command" || head === "exec") t.shift();
    else if (head === "cmd" || head === "cmd.exe") {
      t.shift();
      if ((t[0] ?? "").toLowerCase() === "/c" || (t[0] ?? "").toLowerCase() === "/k") t.shift();
    } else break;
  }
  return t;
}

function isRecursiveForceDelete(t) {
  const name = (t[0] ?? "").toLowerCase().replace(/\.exe$/, "");
  if (!DELETE_COMMANDS.has(name)) return false;
  let recursive = false;
  let force = false;
  for (const raw of t.slice(1)) {
    const flag = raw.toLowerCase();
    if (flag.startsWith("/")) {
      // cmd.exe: rd /s, rmdir /s, del /s /q
      if (flag === "/s") recursive = true;
      if (flag === "/q" || ((name === "rd" || name === "rmdir") && flag === "/s")) force = true;
      continue;
    }
    if (!flag.startsWith("-")) continue;
    if (flag.startsWith("--")) {
      const long = flag.slice(2).split("=")[0] ?? "";
      if (long === "recursive") recursive = true;
      if (long === "force") force = true;
      continue;
    }
    const body = flag.slice(1).split(":")[0] ?? "";
    // PowerShell accepts any unambiguous prefix: -r, -rec, -recurse, -fo, -force.
    if (body.length >= 1 && "recurse".startsWith(body)) recursive = true;
    else if (body.length >= 2 && "force".startsWith(body)) force = true;
    // Unix short flag clusters: -rf, -fr, -Rf, -rfv, -f. Only rm's own short
    // flags, so a PowerShell option like -Filter isn't read as -r plus -f.
    else if (/^[rfidv]+$/.test(body)) {
      if (body.includes("r")) recursive = true;
      if (body.includes("f")) force = true;
    }
  }
  return recursive && force;
}

function isGitCommand(t, sub) {
  const gitAt = t.findIndex((x) => x.toLowerCase().replace(/\.exe$/, "") === "git");
  if (gitAt === -1) return null;
  // Skip global options such as -C <dir> or -c key=value.
  let i = gitAt + 1;
  while (i < t.length && (t[i] ?? "").startsWith("-")) {
    const opt = t[i] ?? "";
    i += opt === "-C" || opt === "-c" ? 2 : 1;
  }
  return (t[i] ?? "").toLowerCase() === sub ? t.slice(i + 1) : null;
}

function isForcePush(t) {
  const args = isGitCommand(t, "push");
  if (!args) return false;
  return args.some(
    (a) => a === "-f" || a.startsWith("--force") || (/^-[a-z]+$/i.test(a) && a.includes("f")) || /^\+\S/.test(a),
  );
}

function isHardReset(t) {
  const args = isGitCommand(t, "reset");
  return Boolean(args?.some((a) => a.toLowerCase() === "--hard"));
}

/** Matches .env, .env.local, .env.production, and so on, but not .env.example. */
const ENV_FILE = /(^|[\s"'=:\\/(])\.env(?:\.(?!example\b)[\w.-]+)?(?=$|[\s"';)|&>])/i;

/**
 * Return a reason string if the command must be blocked, otherwise null.
 * @param {string} command
 * @returns {string | null}
 */
export function findViolation(command) {
  if (ENV_FILE.test(command)) {
    return "Blocked: the command references a .env file. Secrets stay out of the agent's context. Ask the user to run it, or use `pnpm env:check`.";
  }
  for (const segment of segments(command)) {
    const t = commandTokens(segment);
    if (isRecursiveForceDelete(t)) return "Blocked: recursive force delete. Delete specific files, or ask the user to run it.";
    if (isForcePush(t)) return "Blocked: git push with force. Ask the user if a force push is really intended.";
    if (isHardReset(t)) return "Blocked: git reset --hard discards work. Ask the user first.";
  }
  return null;
}

/**
 * Collect every string inside a tool input, since the field that holds the
 * command string is not documented.
 * @param {unknown} value
 * @returns {string[]}
 */
export function collectStrings(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (value && typeof value === "object") return Object.values(value).flatMap(collectStrings);
  return [];
}
