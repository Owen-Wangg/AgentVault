import type { Adapter } from "next-auth/adapters";

/**
 * Sign-in only needs to know who the user is. The provider's access,
 * refresh, and ID tokens would otherwise be stored in the `account` table
 * as plain text, where a database leak exposes them, and nothing in the app
 * uses them. The wrapped adapter links the account without them.
 */
export function withoutProviderTokens(adapter: Adapter): Adapter {
  const { linkAccount } = adapter;
  if (!linkAccount) return adapter;
  return {
    ...adapter,
    linkAccount: (account) => {
      const stored = { ...account };
      delete stored.access_token;
      delete stored.refresh_token;
      delete stored.id_token;
      return linkAccount(stored);
    },
  };
}
