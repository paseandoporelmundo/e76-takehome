import type { Query } from "../db/client.js";

// Staging -> marts, and the rule that keeps published days frozen.
// The marts are recomputed from staging on every run (small data, simplest correct thing);
// published days live in reported_days and only ever change through adjustments.

export async function rebuildMarts(q: Query, tenantId: number): Promise<void> {
  await q("DELETE FROM mart_daily_revenue WHERE tenant_id = $1", [tenantId]);
  await q(
    `INSERT INTO mart_daily_revenue (tenant_id, date, channel, orders, gross, refunds, net)
     WITH sales AS (
       SELECT order_date AS date, channel, count(*) AS orders, sum(gross) AS gross
       FROM stg_orders WHERE tenant_id = $1
       GROUP BY 1, 2
     ),
     refunds AS (   -- only refunds we can match to an order; orphans are in unmatched_refunds
       SELECT r.refund_date AS date, o.channel, sum(r.amount) AS refunds
       FROM stg_refunds r
       JOIN stg_orders o ON o.tenant_id = r.tenant_id AND o.order_id = r.order_id
       WHERE r.tenant_id = $1
       GROUP BY 1, 2
     )
     SELECT $1, date, channel,
            coalesce(s.orders, 0), coalesce(s.gross, 0), coalesce(f.refunds, 0),
            coalesce(s.gross, 0) - coalesce(f.refunds, 0)
     FROM sales s FULL JOIN refunds f USING (date, channel)`,
    [tenantId],
  );

  await q("DELETE FROM mart_daily_marketing WHERE tenant_id = $1", [tenantId]);
  await q(
    `INSERT INTO mart_daily_marketing (tenant_id, date, platform, spend)
     SELECT $1, spend_date, platform, sum(spend) FROM stg_ad_spend WHERE tenant_id = $1 GROUP BY 2, 3`,
    [tenantId],
  );

  await q("DELETE FROM mart_daily_email WHERE tenant_id = $1", [tenantId]);
  await q(
    `INSERT INTO mart_daily_email (tenant_id, date, event_type, events)
     SELECT $1, event_date, event_type, count(*) FROM stg_email_events WHERE tenant_id = $1 GROUP BY 2, 3`,
    [tenantId],
  );
}

/**
 * For every published day, compare (published snapshot + adjustments so far) with the
 * current mart. Any difference is late data: it is written as a new adjustment row, and the
 * published snapshot is left alone. Running this twice records nothing the second time.
 */
export async function recordAdjustments(q: Query, tenantId: number): Promise<number> {
  const rows = await q(
    `WITH published AS (
       SELECT d.date, s.channel, s.orders, s.gross, s.refunds, s.net
       FROM reported_days d,
            jsonb_to_recordset(d.snapshot) AS s(channel text, orders int, gross numeric, refunds numeric, net numeric)
       WHERE d.tenant_id = $1
     ),
     adjusted AS (
       SELECT affected_date AS date, channel,
              sum(delta_orders) AS orders, sum(delta_gross) AS gross,
              sum(delta_refunds) AS refunds, sum(delta_net) AS net
       FROM adjustments WHERE tenant_id = $1 GROUP BY 1, 2
     ),
     known AS (   -- what we have told the client so far, per day and channel
       SELECT date, channel,
              sum(orders) AS orders, sum(gross) AS gross, sum(refunds) AS refunds, sum(net) AS net
       FROM (SELECT * FROM published UNION ALL SELECT * FROM adjusted) x
       GROUP BY 1, 2
     ),
     current AS (
       SELECT m.date, m.channel, m.orders, m.gross, m.refunds, m.net
       FROM mart_daily_revenue m
       JOIN reported_days d ON d.tenant_id = m.tenant_id AND d.date = m.date
       WHERE m.tenant_id = $1
     )
     INSERT INTO adjustments (tenant_id, affected_date, channel, delta_orders, delta_gross, delta_refunds, delta_net, reason)
     SELECT $1, date, channel,
            coalesce(c.orders, 0) - coalesce(k.orders, 0),
            coalesce(c.gross, 0) - coalesce(k.gross, 0),
            coalesce(c.refunds, 0) - coalesce(k.refunds, 0),
            coalesce(c.net, 0) - coalesce(k.net, 0),
            'late_arrival'
     FROM current c FULL JOIN known k USING (date, channel)
     WHERE coalesce(c.orders, 0) <> coalesce(k.orders, 0)
        OR coalesce(c.gross, 0) <> coalesce(k.gross, 0)
        OR coalesce(c.refunds, 0) <> coalesce(k.refunds, 0)
     RETURNING id`,
    [tenantId],
  );
  return rows.length;
}

/** Publishes every day up to and including `through` that is not published yet. */
export async function publishDays(q: Query, tenantId: number, through: string): Promise<string[]> {
  const rows = await q<{ date: string }>(
    `INSERT INTO reported_days (tenant_id, date, snapshot)
     SELECT $1, m.date,
            jsonb_agg(jsonb_build_object('channel', m.channel, 'orders', m.orders, 'gross', m.gross,
                                         'refunds', m.refunds, 'net', m.net) ORDER BY m.channel)
     FROM mart_daily_revenue m
     WHERE m.tenant_id = $1 AND m.date <= $2::date
       AND NOT EXISTS (SELECT 1 FROM reported_days d WHERE d.tenant_id = $1 AND d.date = m.date)
     GROUP BY m.date
     RETURNING to_char(date, 'YYYY-MM-DD') AS date`,
    [tenantId, through],
  );
  return rows.map((r) => r.date).sort();
}
