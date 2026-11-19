-- Sign-ins before the token-dropping adapter (src/server/auth/adapter.ts)
-- stored the GitHub provider tokens in plaintext. The app never uses them,
-- and the adapter only drops them for accounts linked from now on, so clear
-- the ones already stored. The columns stay, as the Auth.js adapter expects them.
UPDATE "account" SET "access_token" = NULL, "refresh_token" = NULL, "id_token" = NULL
WHERE "access_token" IS NOT NULL OR "refresh_token" IS NOT NULL OR "id_token" IS NOT NULL;
