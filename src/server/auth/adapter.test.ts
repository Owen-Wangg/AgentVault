import type { Adapter, AdapterAccount } from "next-auth/adapters";
import { describe, expect, it, vi } from "vitest";
import { withoutProviderTokens } from "./adapter";

const account: AdapterAccount = {
  userId: "user-1",
  type: "oauth",
  provider: "github",
  providerAccountId: "12345",
  access_token: "gho_secret_access",
  refresh_token: "ghr_secret_refresh",
  id_token: "secret.id.token",
  token_type: "bearer",
  scope: "read:user",
};

describe("UI-2: withoutProviderTokens", () => {
  it("UI-2: links the account without the provider's tokens, and keeps the rest", async () => {
    const linkAccount = vi.fn(async () => undefined);
    const wrapped = withoutProviderTokens({ linkAccount } as unknown as Adapter);
    await wrapped.linkAccount?.(account);
    expect(linkAccount).toHaveBeenCalledOnce();
    const [stored] = linkAccount.mock.calls[0] as unknown as [AdapterAccount];
    expect(stored).toEqual({ userId: "user-1", type: "oauth", provider: "github", providerAccountId: "12345", token_type: "bearer", scope: "read:user" });
    expect(JSON.stringify(stored)).not.toMatch(/secret/);
  });

  it("UI-2: doesn't change the account it was given", async () => {
    const wrapped = withoutProviderTokens({ linkAccount: vi.fn(async () => undefined) } as unknown as Adapter);
    await wrapped.linkAccount?.(account);
    expect(account.access_token).toBe("gho_secret_access");
  });

  it("UI-2: leaves the adapter's other methods alone", () => {
    const getUser = vi.fn();
    const wrapped = withoutProviderTokens({ getUser, linkAccount: vi.fn() } as unknown as Adapter);
    expect(wrapped.getUser).toBe(getUser);
  });

  it("UI-2: returns an adapter with no linkAccount unchanged", () => {
    const adapter = {} as Adapter;
    expect(withoutProviderTokens(adapter)).toBe(adapter);
  });
});
