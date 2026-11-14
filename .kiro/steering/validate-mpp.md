---
inclusion: manual
---

# Validate the MPP integration

Run this as the `/validate-mpp` slash command after changing anything under `app/vendor/api/report/**` or `src/rails/stripe-mpp/**`.

## Steps
1. Check that the dev server is running at `http://localhost:3000`. If it isn't, ask the user to start it in their own terminal with `pnpm dev`. Don't start it yourself, because it never exits.
2. Run `pnpm env:check` and confirm that `STRIPE_SECRET_KEY` and `STRIPE_PROFILE_ID` pass. Don't open `.env.local`; the guard-shell hook blocks reading `.env` files, and the check never prints values.
3. Run:
   ```powershell
   npx mppx@latest validate http://localhost:3000/vendor/api/report
   ```
4. Report each check that passed or failed. For a failure, find the cause in our code and propose a fix.
5. Add a line to `docs/KIRO_LOG.md` with the date and the result.
