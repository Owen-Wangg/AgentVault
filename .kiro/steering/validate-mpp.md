---
inclusion: manual
---

# Validate the MPP integration

Run this as the `/validate-mpp` slash command after changing anything under `app/vendor/api/report/**`, `app/openapi.json/**`, `src/server/vendor/report.ts`, or `src/rails/stripe-mpp/**`.

## Steps
1. Check that the dev server is running at `http://localhost:3000`. If it isn't, ask the user to start it in their own terminal with `pnpm dev`. Don't start it yourself, because it never exits.
2. Run `pnpm env:check` and confirm that `STRIPE_SECRET_KEY` and `STRIPE_PROFILE_ID` pass under "Stripe test mode". Don't open `.env.local`; the guard-shell hook blocks reading `.env` files, and the check never prints values.
3. Run:
   ```powershell
   pnpm mpp:validate
   ```
   It runs `npx mppx@latest validate http://localhost:3000`. The validator is given the origin, not `/vendor/api/report`: it finds the endpoint through `/openapi.json` and resolves its path against the URL it's given. The wrapper passes the `sk_test_` key to the validator as `MPPX_STRIPE_SECRET_KEY`, without printing it, so the validator completes a real $0.50 test-mode payment. Without the key it skips that step.
4. Report each check that passed or failed. A missing `/llms.txt` is only a suggestion. For a failure, find the cause in our code and propose a fix.
5. Add a line to `docs/KIRO_LOG.md` with the date and the result.
