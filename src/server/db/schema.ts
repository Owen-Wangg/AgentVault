import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { Micros } from "@/core/money";

/**
 * Database schema (audit-and-approvals design, "Database schema").
 * Money columns are bigint micros read as JS bigint (`mode: "bigint"`).
 * Timestamps are timestamptz read as JS Date.
 */

const micros = (name: string) => bigint(name, { mode: "bigint" }).$type<Micros>();
const createdAt = () => timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow();
const tz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

// ---------------------------------------------------------------------------
// Auth.js tables (the standard Drizzle adapter schema). Wired up in
// telemetry-dashboard task 3; Auth.js uses the singular table names.
// ---------------------------------------------------------------------------

export const users = pgTable("user", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name"),
  email: text("email").unique(),
  emailVerified: timestamp("emailVerified", { mode: "date" }),
  image: text("image"),
});

export const accounts = pgTable(
  "account",
  {
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("providerAccountId").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (t) => [primaryKey({ columns: [t.provider, t.providerAccountId] })],
);

export const authSessions = pgTable("session", {
  sessionToken: text("sessionToken").primaryKey(),
  userId: text("userId")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { mode: "date" }).notNull(),
});

export const verificationTokens = pgTable(
  "verificationToken",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { mode: "date" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.identifier, t.token] })],
);

// ---------------------------------------------------------------------------
// Workspaces, agents, and policy state
// ---------------------------------------------------------------------------

export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    isSandbox: boolean("is_sandbox").notNull().default(false),
    /** The one member of a workspace. Null for sandbox workspaces. */
    ownerUserId: text("owner_user_id").references(() => users.id),
    createdAt: createdAt(),
    retiredAt: tz("retired_at"),
  },
  (t) => [index("workspaces_current_sandbox_idx").on(t.createdAt).where(sql`${t.isSandbox} AND ${t.retiredAt} IS NULL`)],
);

export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    name: text("name").notNull(),
    /** SHA-256 hex of the agent's API key. The key itself is never stored (PXY-1). */
    apiKeyHash: text("api_key_hash").notNull().unique(),
    frozenAt: tz("frozen_at"),
    revokedAt: tz("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [index("agents_workspace_idx").on(t.workspaceId)],
);

/** Envelope JSON columns hold amounts as micros strings; see envelope-json.ts. */
export const envelopes = pgTable("envelopes", {
  agentId: uuid("agent_id")
    .primaryKey()
    .references(() => agents.id),
  limits: jsonb("limits").notNull(),
  vendorLimits: jsonb("vendor_limits").notNull(),
  toolLimits: jsonb("tool_limits").notNull(),
  allowedVendors: jsonb("allowed_vendors").notNull(),
  allowedTools: jsonb("allowed_tools").notNull(),
  version: integer("version").notNull().default(1),
});

export const tasks = pgTable("tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id),
  description: text("description").notNull(),
  allowedVendorCategories: jsonb("allowed_vendor_categories").$type<string[]>().notNull(),
  allowedTools: jsonb("allowed_tools").$type<string[]>().notNull(),
  budgetMicros: micros("budget_micros").notNull(),
});

/** Agent sessions (taint-and-intent). Not the Auth.js `session` table. */
export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agents.id),
  taskId: uuid("task_id")
    .notNull()
    .references(() => tasks.id),
  taintedAt: tz("tainted_at"),
  taintSourceUrl: text("taint_source_url"),
  taintContentSha256: text("taint_content_sha256"),
  createdAt: createdAt(),
});

export const vendors = pgTable(
  "vendors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    /** The name requests and allow-lists use, for example "nimbus-weather". */
    name: text("name").notNull(),
    origin: text("origin").notNull(),
    category: text("category").notNull(),
    trusted: boolean("trusted").notNull().default(false),
    /** The paid endpoint for x402.pay, under `origin` (rail-adapters RAIL-23, RAIL-25). */
    x402Url: text("x402_url"),
    /** The paid endpoint for mpp.pay, under `origin` (rail-adapters RAIL-23, RAIL-25). */
    mppUrl: text("mpp_url"),
    /** Where payout.create sends money: a Stripe recipient account (payout-rails PO-4). Changed only by payee.update. */
    stripeAccount: text("stripe_account"),
    /** Where paypal.payout sends money: a PayPal sandbox receiver email (PO-4). Changed only by payee.update. */
    paypalReceiver: text("paypal_receiver"),
  },
  (t) => [
    uniqueIndex("vendors_workspace_name_idx").on(t.workspaceId, t.name),
    // RAIL-25: a payment URL must be the origin followed by a path, so "https://a.example"
    // can't register "https://a.example.evil.test/pay".
    check("vendors_x402_url_origin_check", sql`${t.x402Url} IS NULL OR left(${t.x402Url}, length(${t.origin}) + 1) = ${t.origin} || '/'`),
    check("vendors_mpp_url_origin_check", sql`${t.mppUrl} IS NULL OR left(${t.mppUrl}, length(${t.origin}) + 1) = ${t.origin} || '/'`),
    // payout-rails design, "Vendor registry": the same formats src/rails/destination.ts checks.
    check("vendors_stripe_account_check", sql`${t.stripeAccount} IS NULL OR ${t.stripeAccount} ~ '^acct_[A-Za-z0-9]{1,64}$'`),
    check(
      "vendors_paypal_receiver_check",
      sql`${t.paypalReceiver} IS NULL OR (length(${t.paypalReceiver}) <= 254 AND ${t.paypalReceiver} ~ '^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(\\.[A-Za-z0-9-]+)+$')`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Spend, idempotency, and approvals
// ---------------------------------------------------------------------------

export const RESERVATION_STATUSES = ["reserved", "settled", "released"] as const;

export const spendReservations = pgTable(
  "spend_reservations",
  {
    /** Also the rail idempotency key, so a reused client key can't collide on the rail. */
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id),
    vendor: text("vendor").notNull(),
    tool: text("tool").notNull(),
    amountMicros: micros("amount_micros").notNull(),
    status: text("status").$type<(typeof RESERVATION_STATUSES)[number]>().notNull().default("reserved"),
    rail: text("rail").notNull(),
    railIdempotencyKey: text("rail_idempotency_key").notNull().unique(),
    decisionSeq: integer("decision_seq").notNull(),
    createdAt: createdAt(),
    resolvedAt: tz("resolved_at"),
  },
  (t) => [
    check("spend_reservations_status_check", sql`${t.status} IN ('reserved', 'settled', 'released')`),
    check("spend_reservations_amount_check", sql`${t.amountMicros} >= 0`),
    index("spend_reservations_agent_created_idx").on(t.agentId, t.createdAt),
    index("spend_reservations_session_idx").on(t.sessionId),
    index("spend_reservations_unresolved_idx").on(t.status, t.createdAt).where(sql`${t.status} = 'reserved'`),
  ],
);

export const idempotency = pgTable(
  "idempotency",
  {
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    key: text("key").notNull(),
    requestHash: text("request_hash").notNull(),
    /** Null while the original request is still running (PXY-14). */
    response: jsonb("response"),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.key] }), index("idempotency_agent_created_idx").on(t.agentId, t.createdAt)],
);

export const APPROVAL_STATUSES = ["pending", "approved", "denied", "expired", "failed_recheck", "executed"] as const;

export const approvals = pgTable(
  "approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    request: jsonb("request").notNull(),
    reasons: jsonb("reasons").notNull(),
    status: text("status").$type<(typeof APPROVAL_STATUSES)[number]>().notNull().default("pending"),
    expiresAt: tz("expires_at").notNull(),
    /** A user ID, `sandbox_visitor`, or `system` (HITL-8). */
    decidedBy: text("decided_by"),
    decidedAt: tz("decided_at"),
    /** The re-run's decision event, once an approved request was re-run (HITL-2). */
    rerunDecisionSeq: integer("rerun_decision_seq"),
    /** The reasons the re-run failed on, for `failed_recheck` (HITL-3). `reasons` keeps the original hold reasons. */
    recheckReasons: jsonb("recheck_reasons"),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      "approvals_status_check",
      sql`${t.status} IN ('pending', 'approved', 'denied', 'expired', 'failed_recheck', 'executed')`,
    ),
    index("approvals_workspace_status_idx").on(t.workspaceId, t.status),
  ],
);

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

/**
 * Append-only: a migration adds triggers that reject UPDATE, DELETE, and
 * TRUNCATE (AUD-3). Rows are hash-chained per workspace (AUD-2, CJ-7).
 */
export const auditEvents = pgTable(
  "audit_events",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    prevHash: text("prev_hash").notNull(),
    hash: text("hash").notNull(),
    /** Set by the application at millisecond precision, so the hashed value survives a round trip (CJ-6). */
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date", precision: 3 }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.seq] }), check("audit_events_seq_check", sql`${t.seq} >= 1`)],
);

/** The signed checkpoint of each workspace's chain (AUD-7). Mutable by design. */
export const auditHeads = pgTable("audit_heads", {
  workspaceId: uuid("workspace_id")
    .primaryKey()
    .references(() => workspaces.id),
  seq: integer("seq").notNull(),
  hash: text("hash").notNull(),
  mac: text("mac").notNull(),
  updatedAt: tz("updated_at").notNull().defaultNow(),
});

/** Per-IP fixed windows for sandbox actions. The key is a SHA-256 of the IP and action. */
export const rateLimits = pgTable(
  "rate_limits",
  {
    key: text("key").notNull(),
    windowStart: tz("window_start").notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.key, t.windowStart] })],
);
