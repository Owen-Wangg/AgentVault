import { z } from "zod";

/**
 * Server environment variables, validated with Zod (security-standards §7
 * and §8). Each getter validates its variable on first use, so a script
 * that only needs the database doesn't require every secret. Error
 * messages name the variable but never include its value.
 */

const base64Key = (bytes: number) =>
  z
    .string()
    .regex(/^[A-Za-z0-9+/]+={0,2}$|^[A-Za-z0-9_-]+$/, "must be base64")
    .transform((s) => Uint8Array.from(Buffer.from(s, s.includes("-") || s.includes("_") ? "base64url" : "base64")))
    .refine((k) => k.length === bytes, `must decode to exactly ${bytes} bytes`);

/** The .env.example placeholders ("replace-…", "your-…"). */
export const isPlaceholder = (value: string | undefined): boolean => value !== undefined && /^(replace|your)[-_]/i.test(value);

/** An optional variable whose .env.example placeholder counts as unset, so a copied example file leaves the feature off. */
const optionalUnlessPlaceholder = (schema: z.ZodString) => z.preprocess((v) => (typeof v === "string" && isPlaceholder(v) ? undefined : v), schema.optional());

const SCHEMAS = {
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\/\S+$/, "must be a postgres:// connection string"),
  /** 32 random bytes, base64. Signs the audit chain heads (AUD-7). Never logged. */
  AUDIT_HEAD_KEY: base64Key(32),
  /** Vercel Cron sends it as a bearer token on /api/cron/* routes. */
  CRON_SECRET: z.string().min(32, "must be at least 32 characters"),
  /** The deployment's origin, used for the sandbox's demo vendor. */
  APP_ORIGIN: z.url({ protocol: /^https?$/ }).default("http://localhost:3000"),
  /** Auth.js signs session cookies with it. Optional: without it and the GitHub pair, sign-in is off. */
  AUTH_SECRET: optionalUnlessPlaceholder(z.string().min(32, "must be at least 32 characters")),
  AUTH_GITHUB_ID: optionalUnlessPlaceholder(z.string().min(1)),
  AUTH_GITHUB_SECRET: optionalUnlessPlaceholder(z.string().min(1)),
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
  auditHeadKey: (): Uint8Array => read("AUDIT_HEAD_KEY"),
  cronSecret: (): string => read("CRON_SECRET"),
  appOrigin: (): string => new URL(read("APP_ORIGIN")).origin,
  /**
   * Whether GitHub sign-in is set up: AUTH_SECRET, AUTH_GITHUB_ID, and
   * AUTH_GITHUB_SECRET are all set (Auth.js reads them itself). Throws if
   * one is set but invalid, such as a short AUTH_SECRET.
   */
  githubAuthConfigured: (): boolean =>
    read("AUTH_SECRET") !== undefined && read("AUTH_GITHUB_ID") !== undefined && read("AUTH_GITHUB_SECRET") !== undefined,
  /**
   * Like githubAuthConfigured, but an invalid value turns sign-in off
   * instead of throwing, so a bad AUTH_ variable can't take the dashboard
   * or the approval routes down. Nobody is signed in then (fail closed),
   * and `pnpm env:check` reports which variable is wrong.
   */
  githubAuthEnabled: (): boolean => {
    try {
      return env.githubAuthConfigured();
    } catch (error) {
      console.error(error instanceof Error ? error.message : "AUTH_ variables are invalid", "GitHub sign-in is off.");
      return false;
    }
  },
};

/** For tests: forget cached values after changing process.env. */
export function resetEnvCache(): void {
  cache.clear();
}
