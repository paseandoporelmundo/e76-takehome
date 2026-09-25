-- File registry + raw layer. This is where replay safety lives.

CREATE TABLE ingest_files (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id     smallint    NOT NULL REFERENCES tenants(id),
  source        text        NOT NULL,
  file_name     text        NOT NULL,
  batch         integer,                 -- from the manifest, when the file is listed there
  sha256        text        NOT NULL,
  status        text        NOT NULL DEFAULT 'processing'
                CHECK (status IN ('processing', 'done', 'quarantined')),
  rows_total    integer,
  rows_new      integer,                 -- raw rows the completing run inserted (the rest were already there)
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  UNIQUE (tenant_id, sha256)             -- same bytes for the same tenant = same file, whatever its name
);

CREATE TABLE raw_records (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id     smallint    NOT NULL REFERENCES tenants(id),
  source        text        NOT NULL,
  record_hash   text        NOT NULL,   -- sha256 of the row after column mapping
  file_id       bigint      NOT NULL REFERENCES ingest_files(id),   -- first file that delivered it
  row_number    integer     NOT NULL,
  payload       jsonb       NOT NULL,
  ingested_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source, record_hash)   -- ON CONFLICT DO NOTHING target: reruns + overlapping exports
);

CREATE TABLE quarantine (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id        smallint    NOT NULL REFERENCES tenants(id),
  file_id          bigint      NOT NULL REFERENCES ingest_files(id),
  reason           text        NOT NULL,
  header_received  text[]      NOT NULL,
  header_expected  text[]      NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, file_id)
);
