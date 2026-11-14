ALTER TABLE "approvals" ADD COLUMN "rerun_decision_seq" integer;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "recheck_reasons" jsonb;