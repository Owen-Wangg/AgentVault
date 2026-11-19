-- PayPal receivers must be sandbox account addresses, the same rule as
-- SANDBOX_RECEIVER in src/rails/destination.ts. NOT VALID: rows written
-- under the old, looser rule are not rechecked, so the migration can't fail
-- on an old sandbox row; every insert and update from now on is checked.
ALTER TABLE "vendors" DROP CONSTRAINT "vendors_paypal_receiver_check";--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_paypal_receiver_check" CHECK ("vendors"."paypal_receiver" IS NULL OR (length("vendors"."paypal_receiver") <= 254 AND "vendors"."paypal_receiver" ~ '^[A-Za-z0-9._%+-]{1,64}@(personal|business)\.example\.com$')) NOT VALID;
