-- Staging: typed, one row per natural key per tenant. A later delivery of the same key
-- overwrites the earlier one (newest file wins).

CREATE TABLE stg_orders (
  tenant_id     smallint      NOT NULL REFERENCES tenants(id),
  order_id      text          NOT NULL,
  order_ts      timestamptz   NOT NULL,
  order_date    date          NOT NULL,   -- order_ts in the tenant's timezone
  channel       text          NOT NULL,
  gross         numeric(14,2) NOT NULL,
  currency      char(3)       NOT NULL,
  customer_hash text          NOT NULL,   -- sha256 of the email; the address itself is not kept
  file_id       bigint        NOT NULL REFERENCES ingest_files(id),
  updated_at    timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, order_id)
);
CREATE INDEX stg_orders_date_idx ON stg_orders (tenant_id, order_date);

CREATE TABLE stg_refunds (
  tenant_id     smallint      NOT NULL REFERENCES tenants(id),
  refund_id     text          NOT NULL,
  order_id      text          NOT NULL,   -- may point at an order we never received (orphan)
  refunded_ts   timestamptz   NOT NULL,
  refund_date   date          NOT NULL,
  amount        numeric(14,2) NOT NULL,
  currency      char(3)       NOT NULL,
  file_id       bigint        NOT NULL REFERENCES ingest_files(id),
  updated_at    timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, refund_id)
);

CREATE TABLE stg_ad_spend (
  tenant_id     smallint      NOT NULL REFERENCES tenants(id),
  spend_date    date          NOT NULL,
  campaign_id   text          NOT NULL,
  platform      text          NOT NULL,
  spend         numeric(14,2) NOT NULL,
  file_id       bigint        NOT NULL REFERENCES ingest_files(id),
  updated_at    timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, spend_date, campaign_id)   -- a re-export overwrites the previous row
);

CREATE TABLE stg_email_events (
  tenant_id     smallint    NOT NULL REFERENCES tenants(id),
  event_id      text        NOT NULL,
  event_type    text        NOT NULL,   -- lower-cased: tenants disagree on case
  email_hash    text        NOT NULL,
  campaign_id   text,
  event_ts      timestamptz NOT NULL,
  event_date    date        NOT NULL,
  file_id       bigint      NOT NULL REFERENCES ingest_files(id),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, event_id)
);
