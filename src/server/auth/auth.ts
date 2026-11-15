import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { neon } from "@neondatabase/serverless";
import { drizzle as drizzleNeonHttp } from "drizzle-orm/neon-http";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import pg from "pg";
import { guardConnectionErrors, isNeonUrl } from "@/server/db/client";
import { accounts, authSessions, users, verificationTokens } from "@/server/db/schema";
import { env } from "@/server/env";

/**
 * Auth.js with GitHub (telemetry-dashboard UI-2). Auth.js reads
 * AUTH_SECRET, AUTH_GITHUB_ID, and AUTH_GITHUB_SECRET itself.
 *
 * Sessions are JWTs in an httpOnly cookie, so reading a session makes no
 * database query. The Drizzle adapter writes the user and account rows on
 * the OAuth callback only. On Neon it uses the HTTP driver: each query is
 * one HTTP request, so there is no pool that would outlive a serverless
 * request. Elsewhere (Docker Postgres in local dev) it shares one pool.
 */

let localPool: pg.Pool | undefined;

function adapterDb() {
  const url = env.databaseUrl();
  if (isNeonUrl(url)) return drizzleNeonHttp(neon(url));
  localPool ??= guardConnectionErrors(new pg.Pool({ connectionString: url, max: 2 }));
  return drizzlePg(localPool);
}

export const { handlers, auth, signIn, signOut } = NextAuth(() => ({
  adapter: DrizzleAdapter(adapterDb(), {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: authSessions,
    verificationTokensTable: verificationTokens,
  }),
  providers: env.githubAuthEnabled() ? [GitHub] : [],
  session: { strategy: "jwt" },
  callbacks: {
    // The user ID is the JWT subject. Workspace ownership is matched against it.
    session({ session, token }) {
      if (session.user && typeof token.sub === "string") session.user.id = token.sub;
      return session;
    },
  },
  logger: {
    // Only the error type and message: Auth.js errors can carry request or provider details.
    error(error) {
      const type = (error as { type?: unknown }).type;
      console.error(`Auth.js error ${typeof type === "string" ? type : error.name}: ${error.message}`);
    },
  },
}));
