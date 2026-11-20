CREATE INDEX "audit_events_workspace_type_seq_idx" ON "audit_events" USING btree ("workspace_id","type","seq");--> statement-breakpoint
CREATE INDEX "audit_events_decision_agent_idx" ON "audit_events" USING btree ("workspace_id",("payload"->>'agent_id'),"seq") WHERE "audit_events"."type" = 'decision';--> statement-breakpoint
CREATE INDEX "sessions_agent_idx" ON "sessions" USING btree ("agent_id");