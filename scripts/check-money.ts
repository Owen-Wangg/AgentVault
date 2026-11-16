// PostFileSave hook for .ts/.tsx files (.kiro/hooks/no-float-money.json).
// Flags float handling of money (security-standards.md section 1).
// Line-based heuristics: they catch the common mistakes, not every one.
// A line can opt out with `// money-check: ok <reason>` (for example, a
// deliberately broken test fixture).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface Finding {
  file: string;
  line: number;
  rule: string;
  text: string;
}

const MONEY_WORD = /micros|amount|cents|price|cost|spend|budget|balance|refund/i;
const OPT_OUT = /\/\/\s*money-check:\s*ok\b\s*\S/;

type Rule = { id: string; test: (code: string) => boolean };

const RULES: readonly Rule[] = [
  { id: "parseFloat", test: (c) => /\bparseFloat\s*\(|\bNumber\.parseFloat\s*\(/.test(c) },
  { id: "toFixed", test: (c) => /\.toFixed\s*\(/.test(c) },
  {
    id: "Number() on an amount",
    test: (c) => [...c.matchAll(/\bNumber\s*\(([^)]*)\)/g)].some((m) => MONEY_WORD.test(m[1] ?? "")),
  },
  {
    id: "Math rounding on an amount",
    test: (c) => [...c.matchAll(/\bMath\.(?:round|floor|ceil|trunc)\s*\(([^)]*)\)/g)].some((m) => MONEY_WORD.test(m[1] ?? "")),
  },
  {
    id: "unary + on an amount",
    test: (c) => /(?:^|[=(,:?]|return)\s*\+\s*[\w.]*(?:micros|amount|cents)/i.test(c),
  },
  {
    id: "number-typed money field",
    test: (c) => /\b\w*(?:Micros|_micros|Cents|_cents|Amount|_amount)\??\s*:\s*number\b/.test(c) || /\bamount\??\s*:\s*number\b/.test(c),
  },
];

/** Remove comments and the text of string literals so only code is checked. */
function codeOnly(line: string, inBlock: boolean): { code: string; inBlock: boolean } {
  let out = "";
  let i = 0;
  let block = inBlock;
  while (i < line.length) {
    if (block) {
      const end = line.indexOf("*/", i);
      if (end === -1) return { code: out, inBlock: true };
      i = end + 2;
      block = false;
      continue;
    }
    const ch = line[i];
    const next = line[i + 1];
    if (ch === "/" && next === "/") break;
    if (ch === "/" && next === "*") {
      block = true;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i += 1;
      while (i < line.length && line[i] !== quote) i += line[i] === "\\" ? 2 : 1;
      i += 1;
      out += `${quote}${quote}`;
      continue;
    }
    out += ch;
    i += 1;
  }
  return { code: out, inBlock: block };
}

export function scanSource(text: string, file: string): Finding[] {
  const findings: Finding[] = [];
  let inBlock = false;
  text.split(/\r?\n/).forEach((raw, index) => {
    const { code, inBlock: stillInBlock } = codeOnly(raw, inBlock);
    inBlock = stillInBlock;
    if (OPT_OUT.test(raw)) return;
    for (const rule of RULES) {
      if (rule.test(code)) findings.push({ file, line: index + 1, rule: rule.id, text: raw.trim() });
    }
  });
  return findings;
}

const ROOTS = ["src", "app", "scripts"];
const SKIP_DIRS = new Set(["node_modules", ".next", ".next-e2e", "__fixtures__", "coverage"]);
// This checker and its tests contain the banned patterns on purpose.
const SKIP_FILES = new Set(["scripts/check-money.ts", "scripts/check-money.test.ts"]);

export function listSourceFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
      } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
        const rel = relative(root, full).split(sep).join("/");
        if (!SKIP_FILES.has(rel)) files.push(rel);
      }
    }
  };
  for (const r of ROOTS) walk(join(root, r));
  return files;
}

function main() {
  const root = process.cwd();
  const files = listSourceFiles(root).filter((f) => statSync(join(root, f)).isFile());
  const findings = files.flatMap((f) => scanSource(readFileSync(join(root, f), "utf8"), f));
  if (findings.length === 0) {
    console.log(`check-money: OK (${files.length} files)`);
    return;
  }
  console.error("check-money: float handling of money found (security-standards.md section 1):");
  for (const f of findings) console.error(`  ${f.file}:${f.line}  [${f.rule}]  ${f.text}`);
  console.error("Use the Micros helpers from @/core/money. A deliberate exception needs `// money-check: ok <reason>`.");
  process.exit(1);
}

const invokedDirectly = process.argv[1] !== undefined && fileURLToPath(import.meta.url).toLowerCase() === process.argv[1].toLowerCase();
if (invokedDirectly) main();
