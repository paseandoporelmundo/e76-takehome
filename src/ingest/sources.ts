import { createHash } from "node:crypto";
import { z } from "zod";
import type { Query } from "../db/client.js";
import type { Source } from "../config/tenants.js";

// One entry per source: the canonical columns we expect, how a row is validated, and how it
// is upserted into staging. This file is the only place that knows what a source looks like;
// it knows nothing about tenants.

const money = z.string().regex(/^-?\d+(\.\d{1,2})?$/, "not a money amount");
const isoTs = z.string().datetime({ offset: true });
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "not a YYYY-MM-DD date");

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export interface SourceSpec {
  format: "csv" | "ndjson";
  columns: readonly string[];
  row: z.ZodTypeAny;
  /** Upsert one validated row into staging. `$1` is always the tenant id. */
  upsert: (q: Query, tenantId: number, tz: string, fileId: number, row: Record<string, string>) => Promise<void>;
}

export const SPECS: Record<Source, SourceSpec> = {
  orders: {
    format: "csv",
    columns: ["order_id", "created_at", "channel", "gross", "currency", "customer_email"],
    row: z.object({
      order_id: z.string().min(1),
      created_at: isoTs,
      channel: z.string().min(1),
      gross: money,
      currency: z.string().length(3),
      customer_email: z.string().min(1),
    }),
    upsert: (q, tenantId, tz, fileId, r) =>
      q(
        `INSERT INTO stg_orders (tenant_id, order_id, order_ts, order_date, channel, gross, currency, customer_hash, file_id)
         VALUES ($1, $2, $3::timestamptz, ($3::timestamptz AT TIME ZONE $4)::date, $5, $6, $7, $8, $9)
         ON CONFLICT (tenant_id, order_id) DO UPDATE SET
           order_ts = EXCLUDED.order_ts, order_date = EXCLUDED.order_date, channel = EXCLUDED.channel,
           gross = EXCLUDED.gross, currency = EXCLUDED.currency, customer_hash = EXCLUDED.customer_hash,
           file_id = EXCLUDED.file_id, updated_at = now()`,
        [tenantId, r.order_id, r.created_at, tz, r.channel, r.gross, r.currency, sha256(r.customer_email.toLowerCase()), fileId],
      ).then(() => undefined),
  },

  refunds: {
    format: "csv",
    columns: ["refund_id", "refunded_at", "order_id", "amount", "currency"],
    row: z.object({
      refund_id: z.string().min(1),
      refunded_at: isoTs,
      order_id: z.string().min(1),
      amount: money,
      currency: z.string().length(3),
    }),
    upsert: (q, tenantId, tz, fileId, r) =>
      q(
        `INSERT INTO stg_refunds (tenant_id, refund_id, order_id, refunded_ts, refund_date, amount, currency, file_id)
         VALUES ($1, $2, $3, $4::timestamptz, ($4::timestamptz AT TIME ZONE $5)::date, $6, $7, $8)
         ON CONFLICT (tenant_id, refund_id) DO UPDATE SET
           order_id = EXCLUDED.order_id, refunded_ts = EXCLUDED.refunded_ts, refund_date = EXCLUDED.refund_date,
           amount = EXCLUDED.amount, currency = EXCLUDED.currency, file_id = EXCLUDED.file_id, updated_at = now()`,
        [tenantId, r.refund_id, r.order_id, r.refunded_at, tz, r.amount, r.currency, fileId],
      ).then(() => undefined),
  },

  ad_spend: {
    format: "csv",
    columns: ["date", "campaign_id", "platform", "spend"],
    row: z.object({
      date: isoDate,
      campaign_id: z.string().min(1),
      platform: z.string().min(1),
      spend: money,
    }),
    upsert: (q, tenantId, _tz, fileId, r) =>
      q(
        `INSERT INTO stg_ad_spend (tenant_id, spend_date, campaign_id, platform, spend, file_id)
         VALUES ($1, $2::date, $3, $4, $5, $6)
         ON CONFLICT (tenant_id, spend_date, campaign_id) DO UPDATE SET
           platform = EXCLUDED.platform, spend = EXCLUDED.spend, file_id = EXCLUDED.file_id, updated_at = now()`,
        [tenantId, r.date, r.campaign_id, r.platform, r.spend, fileId],
      ).then(() => undefined),
  },

  email_events: {
    format: "ndjson",
    columns: ["event_id", "type", "email", "campaign_id", "occurred_at"],
    row: z.object({
      event_id: z.string().min(1),
      type: z.string().min(1),
      email: z.string().min(1),
      campaign_id: z.string().optional(),
      occurred_at: isoTs,
    }),
    upsert: (q, tenantId, tz, fileId, r) =>
      q(
        `INSERT INTO stg_email_events (tenant_id, event_id, event_type, email_hash, campaign_id, event_ts, event_date, file_id)
         VALUES ($1, $2, lower($3), $4, $5, $6::timestamptz, ($6::timestamptz AT TIME ZONE $7)::date, $8)
         ON CONFLICT (tenant_id, event_id) DO UPDATE SET
           event_type = EXCLUDED.event_type, email_hash = EXCLUDED.email_hash, campaign_id = EXCLUDED.campaign_id,
           event_ts = EXCLUDED.event_ts, event_date = EXCLUDED.event_date, file_id = EXCLUDED.file_id, updated_at = now()`,
        [tenantId, r.event_id, r.type, sha256(r.email.toLowerCase()), r.campaign_id ?? null, r.occurred_at, tz, fileId],
      ).then(() => undefined),
  },
};
