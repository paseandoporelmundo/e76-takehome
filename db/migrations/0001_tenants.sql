-- Tenants and their configured sources. Mirrors config/tenants.yaml; the CLI
-- upserts this from the YAML at startup so the file stays the source of truth.

CREATE TABLE tenants (
  id            smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug          text        NOT NULL UNIQUE,
  name          text        NOT NULL,
  api_key_hash  text        NOT NULL UNIQUE,   -- sha256 hex of the API key; the key itself is never stored
  timezone      text        NOT NULL,          -- IANA name, e.g. America/New_York; defines the "day" of an order
  currency      char(3)     NOT NULL,          -- reporting currency of the tenant
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenant_sources (
  tenant_id         smallint NOT NULL REFERENCES tenants(id),
  source            text     NOT NULL,             -- orders | email_events | ad_spend | ...
  file_pattern      text     NOT NULL,             -- glob relative to fixtures/<slug>/<source>/
  expected_cadence  text     NOT NULL,             -- daily | weekly (used by check-arrivals)
  column_aliases    jsonb    NOT NULL DEFAULT '{}'::jsonb,  -- {"received_name": "canonical_name"}
  PRIMARY KEY (tenant_id, source)
);
