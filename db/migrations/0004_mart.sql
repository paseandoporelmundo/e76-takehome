-- Mart (current truth), immutable reported snapshots, adjustments.

-- Revenue per day and channel. A refund is matched to its order, booked in the order's
-- channel, on the day the refund happened (the day the money went back).
CREATE TABLE mart_daily_revenue (
  tenant_id    smallint      NOT NULL REFERENCES tenants(id),
  date         date          NOT NULL,
  channel      text          NOT NULL,
  orders       integer       NOT NULL,
  gross        numeric(14,2) NOT NULL,
  refunds      numeric(14,2) NOT NULL,
  net          numeric(14,2) NOT NULL,   -- gross - refunds
  computed_at  timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, date, channel)
);

-- Refunds whose order we never received. Kept out of channel revenue, never dropped.
CREATE VIEW unmatched_refunds AS
SELECT r.*
FROM stg_refunds r
LEFT JOIN stg_orders o ON o.tenant_id = r.tenant_id AND o.order_id = r.order_id
WHERE o.order_id IS NULL;

CREATE TABLE mart_daily_marketing (
  tenant_id    smallint      NOT NULL REFERENCES tenants(id),
  date         date          NOT NULL,
  platform     text          NOT NULL,   -- ad platform, as the tenant names it
  spend        numeric(14,2) NOT NULL,
  computed_at  timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, date, platform)
);

CREATE TABLE mart_daily_email (
  tenant_id    smallint    NOT NULL REFERENCES tenants(id),
  date         date        NOT NULL,
  event_type   text        NOT NULL,
  events       integer     NOT NULL,
  computed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, date, event_type)
);

-- What was published for a day. Rows are never updated or deleted.
CREATE TABLE reported_days (
  tenant_id    smallint    NOT NULL REFERENCES tenants(id),
  date         date        NOT NULL,
  snapshot     jsonb       NOT NULL,   -- the mart_daily_revenue rows for that day at publication time
  reported_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, date)
);

-- Enforced in the database, not just in code: a published day cannot be edited or removed.
CREATE FUNCTION forbid_restatement() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'reported_days is append-only: tenant % day % was already published', OLD.tenant_id, OLD.date;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER reported_days_append_only
BEFORE UPDATE OR DELETE ON reported_days
FOR EACH ROW EXECUTE FUNCTION forbid_restatement();

-- Late data for an already-reported day lands here, dated on the day it was discovered.
-- published snapshot + sum(adjustments) = current truth, per (tenant, date, channel).
CREATE TABLE adjustments (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id        smallint      NOT NULL REFERENCES tenants(id),
  affected_date    date          NOT NULL,
  channel          text          NOT NULL,
  discovered_at    timestamptz   NOT NULL DEFAULT now(),
  delta_orders     integer       NOT NULL,
  delta_gross      numeric(14,2) NOT NULL,
  delta_refunds    numeric(14,2) NOT NULL,
  delta_net        numeric(14,2) NOT NULL,
  reason           text          NOT NULL   -- late_arrival
);
CREATE INDEX adjustments_day_idx ON adjustments (tenant_id, affected_date);
