ALTER TABLE "vendors" ADD COLUMN "x402_url" text;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "mpp_url" text;--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_x402_url_origin_check" CHECK ("vendors"."x402_url" IS NULL OR left("vendors"."x402_url", length("vendors"."origin") + 1) = "vendors"."origin" || '/');--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_mpp_url_origin_check" CHECK ("vendors"."mpp_url" IS NULL OR left("vendors"."mpp_url", length("vendors"."origin") + 1) = "vendors"."origin" || '/');