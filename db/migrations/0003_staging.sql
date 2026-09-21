-- Staging: typed, one row per natural key per tenant, newest version wins.

CREATE TABLE stg_orders (
  tenant_id          smallint      NOT NULL REFERENCES tenants(id),
  order_id           text          NOT NULL,
  order_ts           timestamptz   NOT NULL,
  order_date         date          NOT NULL,   -- order_ts in the tenant's timezone
  channel            text          NOT NULL,
  gross              numeric(14,2) NOT NULL,
  discount           numeric(14,2) NOT NULL DEFAULT 0,
  refund             numeric(14,2) NOT NULL DEFAULT 0,
  net                numeric(14,2) NOT NULL,   -- gross - discount - refund
  currency           char(3)       NOT NULL,
  source_updated_at  timestamptz,              -- from the source when present; else ingested_at is the tiebreak
  file_id            bigint        NOT NULL REFERENCES ingest_files(id),
  updated_at         timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, order_id)
);
CREATE INDEX stg_orders_date_idx ON stg_orders (tenant_id, order_date);

CREATE TABLE stg_email_events (
  tenant_id    smallint    NOT NULL REFERENCES tenants(id),
  event_id     text        NOT NULL,   -- source id, or hash(email, event_type, event_ts) when absent
  email_hash   text        NOT NULL,   -- we never keep the address itself
  event_type   text        NOT NULL,
  event_ts     timestamptz NOT NULL,
  campaign     text,
  file_id      bigint      NOT NULL REFERENCES ingest_files(id),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, event_id)
);

CREATE TABLE stg_ad_spend (
  tenant_id    smallint      NOT NULL REFERENCES tenants(id),
  platform     text          NOT NULL,
  campaign_id  text          NOT NULL,
  spend_date   date          NOT NULL,
  spend        numeric(14,2) NOT NULL,
  currency     char(3)       NOT NULL,
  impressions  integer,
  clicks       integer,
  file_id      bigint        NOT NULL REFERENCES ingest_files(id),
  updated_at   timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, platform, campaign_id, spend_date)   -- a re-export overwrites the previous row
);
