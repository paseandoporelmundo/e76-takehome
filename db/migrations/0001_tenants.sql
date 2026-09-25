-- Tenants and their configured sources. Mirrors config/tenants.yaml; every CLI run
-- upserts this from the YAML so the file stays the source of truth.

CREATE TABLE tenants (
  id            smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug          text        NOT NULL UNIQUE,
  name          text        NOT NULL,
  api_key_hash  text        NOT NULL UNIQUE,   -- sha256 hex of the API key; the key itself is never stored
  timezone      text        NOT NULL,          -- IANA name; defines which calendar day an event belongs to
  currency      char(3)     NOT NULL,          -- currency the tenant's orders are in
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenant_sources (
  tenant_id         smallint NOT NULL REFERENCES tenants(id),
  source            text     NOT NULL,             -- orders | refunds | ad_spend | email_events
  column_aliases    jsonb    NOT NULL DEFAULT '{}'::jsonb,  -- {"received_name": "canonical_name"}
  PRIMARY KEY (tenant_id, source)
);
