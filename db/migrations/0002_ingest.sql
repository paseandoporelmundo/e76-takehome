-- File registry + raw layer. This is where replay safety lives.

CREATE TABLE ingest_files (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id     smallint    NOT NULL REFERENCES tenants(id),
  source        text        NOT NULL,
  file_name     text        NOT NULL,
  sha256        text        NOT NULL,
  status        text        NOT NULL DEFAULT 'received'
                CHECK (status IN ('received', 'processing', 'done', 'failed', 'quarantined')),
  rows_total    integer,
  rows_loaded   integer,
  started_at    timestamptz,
  finished_at   timestamptz,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, sha256)          -- same bytes for the same tenant = same file, whatever its name
);

CREATE TABLE raw_records (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id     smallint    NOT NULL REFERENCES tenants(id),
  source        text        NOT NULL,
  record_hash   text        NOT NULL,   -- sha256 of the normalised row content
  file_id       bigint      NOT NULL REFERENCES ingest_files(id),
  row_number    integer     NOT NULL,
  payload       jsonb       NOT NULL,
  ingested_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source, record_hash)   -- ON CONFLICT DO NOTHING target: rerun + overlapping exports
);

CREATE TABLE quarantine (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id        smallint    NOT NULL REFERENCES tenants(id),
  file_id          bigint      NOT NULL REFERENCES ingest_files(id),
  reason           text        NOT NULL,
  header_received  text[]      NOT NULL,
  header_expected  text[]      NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
