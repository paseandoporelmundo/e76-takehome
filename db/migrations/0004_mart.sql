-- Mart (current truth), immutable reported snapshots, adjustments, arrival monitor.

CREATE TABLE mart_daily_revenue (
  tenant_id    smallint      NOT NULL REFERENCES tenants(id),
  date         date          NOT NULL,
  channel      text          NOT NULL,
  orders       integer       NOT NULL,
  gross        numeric(14,2) NOT NULL,
  refunds      numeric(14,2) NOT NULL,
  net          numeric(14,2) NOT NULL,
  computed_at  timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, date, channel)
);

-- What was published for a day. Rows are never updated or deleted; a new
-- publication of the same day gets a new version.
CREATE TABLE reported_days (
  tenant_id    smallint    NOT NULL REFERENCES tenants(id),
  date         date        NOT NULL,
  version      integer     NOT NULL,
  snapshot     jsonb       NOT NULL,   -- the mart rows for that day at publication time
  reported_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, date, version)
);

-- Late data for an already-reported day lands here, dated on the day it was discovered.
CREATE TABLE adjustments (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id        smallint      NOT NULL REFERENCES tenants(id),
  affected_date    date          NOT NULL,
  discovered_date  date          NOT NULL,
  channel          text          NOT NULL,
  delta_orders     integer       NOT NULL,
  delta_net        numeric(14,2) NOT NULL,
  reason           text          NOT NULL,   -- late_arrival | correction
  file_id          bigint        REFERENCES ingest_files(id),
  created_at       timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX adjustments_discovered_idx ON adjustments (tenant_id, discovered_date);

-- One row per (source, day) we expect a file for; check-arrivals fills received_file_id.
CREATE TABLE expected_deliveries (
  tenant_id         smallint    NOT NULL REFERENCES tenants(id),
  source            text        NOT NULL,
  expected_date     date        NOT NULL,
  received_file_id  bigint      REFERENCES ingest_files(id),
  checked_at        timestamptz,
  PRIMARY KEY (tenant_id, source, expected_date)
);
