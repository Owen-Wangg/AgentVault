/**
 * Canonical JSON for hashing audit events (CJ-1 to CJ-5). One value has
 * exactly one encoding, so anyone can recompute an event's hash.
 *
 * Close to RFC 8785 (JCS) but stricter: numbers must be safe integers, and
 * bigints are encoded as strings of digits.
 */

/** The value can't be canonically encoded. `path` points at the bad part, like `$.payload.items[2]`. */
export class CanonicalJsonError extends Error {
  readonly code = "CANONICAL_JSON";
  constructor(
    readonly path: string,
    reason: string,
  ) {
    super(`Can't canonically encode ${path}: ${reason}`);
    this.name = "CanonicalJsonError";
  }
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (typeof value !== "object") return typeof value;
  const name = (Object.getPrototypeOf(value) as { constructor?: { name?: string } } | null)?.constructor?.name;
  return name ? `a ${name}` : "an object";
}

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function encode(value: unknown, path: string, ancestors: Set<object>): string {
  switch (typeof value) {
    case "string":
      // CJ-2: escaped exactly as JSON.stringify does, with no Unicode normalization.
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "bigint":
      // CJ-3: a JSON string of the base-10 digits.
      return `"${value.toString()}"`;
    case "number":
      // CJ-4: safe integers only; -0 becomes 0.
      if (!Number.isSafeInteger(value)) throw new CanonicalJsonError(path, `${String(value)} is not a safe integer`);
      return Object.is(value, -0) ? "0" : String(value);
    case "object":
      break;
    default:
      // undefined (outside an object property), functions, and symbols (CJ-5).
      throw new CanonicalJsonError(path, `${typeof value} is not allowed`);
  }
  if (value === null) return "null";
  if (ancestors.has(value)) throw new CanonicalJsonError(path, "the value contains a cycle");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const parts: string[] = [];
      for (let i = 0; i < value.length; i += 1) {
        const itemPath = `${path}[${i}]`;
        // CJ-5: undefined elements, including holes, are rejected rather than turned into null.
        if (!(i in value) || value[i] === undefined) throw new CanonicalJsonError(itemPath, "undefined array elements are not allowed");
        parts.push(encode(value[i], itemPath, ancestors));
      }
      return `[${parts.join(",")}]`;
    }
    // CJ-5: Date, Map, Set, class instances, typed arrays, and boxed primitives are rejected.
    if (!isPlainObject(value)) throw new CanonicalJsonError(path, `${describe(value)} is not a plain object`);
    if (Object.getOwnPropertySymbols(value).length > 0) throw new CanonicalJsonError(path, "symbol keys are not allowed");
    const record = value as Record<string, unknown>;
    // CJ-1: keys sorted by UTF-16 code units, which is what the default sort() compares.
    const keys = Object.keys(record).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const item = record[key];
      if (item === undefined) continue; // CJ-5: undefined properties are omitted.
      parts.push(`${JSON.stringify(key)}:${encode(item, `${path}.${key}`, ancestors)}`);
    }
    return `{${parts.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

/** Encode a value canonically (CJ-1 to CJ-5). Throws CanonicalJsonError for anything it can't encode. */
export function canonicalJson(value: unknown): string {
  return encode(value, "$", new Set());
}
