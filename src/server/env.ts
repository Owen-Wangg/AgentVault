import { z } from "zod";

/**
 * Server environment variables, validated with Zod (security-standards §7
 * and §8). Each getter validates its variable on first use, so a script
 * that only needs the database doesn't require every secret. Error
 * messages name the variable but never include its value.
 */

const SCHEMAS = {
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\/\S+$/, "must be a postgres:// connection string"),
} as const;

type Name = keyof typeof SCHEMAS;
type Value<N extends Name> = z.output<(typeof SCHEMAS)[N]>;

export class EnvError extends Error {
  constructor(name: string, problem: string) {
    super(`Environment variable ${name} ${problem}. See .env.example.`);
    this.name = "EnvError";
  }
}

const cache = new Map<Name, unknown>();

function read<N extends Name>(name: N): Value<N> {
  if (cache.has(name)) return cache.get(name) as Value<N>;
  const raw = process.env[name];
  const parsed = SCHEMAS[name].safeParse(raw === "" ? undefined : raw);
  if (!parsed.success) {
    // Only the message, never the value.
    const problem = raw === undefined || raw === "" ? "is not set" : (parsed.error.issues[0]?.message ?? "is invalid");
    throw new EnvError(name, problem);
  }
  cache.set(name, parsed.data);
  return parsed.data as Value<N>;
}

export const env = {
  databaseUrl: (): string => read("DATABASE_URL"),
};

/** For tests: forget cached values after changing process.env. */
export function resetEnvCache(): void {
  cache.clear();
}
