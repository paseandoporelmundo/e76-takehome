# Code tour, for whoever onboards the next client

Read in this order. Each file is short.

| File | What it does |
|---|---|
| `config/tenants.yaml` | Every tenant: slug, API key hash, timezone, currency, column aliases per source. The only file a new client touches. |
| `src/config/tenants.ts` | Validates that YAML (zod) and upserts it into `tenants` / `tenant_sources` on every run. |
| `db/migrations/0001..0004` | Every table, with comments. Every key starts with `tenant_id`. |
| `src/ingest/read.ts` | Finds a tenant's files, looks up their batch in `manifest.json`, parses CSV and NDJSON. No database. |
| `src/ingest/sources.ts` | One entry per source: canonical columns, row validation, staging upsert. The only place that knows what a source looks like. |
| `src/ingest/pipeline.ts` | The run: register file (sha256) → check header → raw (chunks, `ON CONFLICT DO NOTHING`) → staging → marts → adjustments. |
| `src/model/mart.ts` | Staging → marts; publishing days; turning late data into adjustments. |
| `src/db/client.ts` | `withTenant()`: the one door to tenant data. |
| `src/api/server.ts` | `/v1/revenue` and `/v1/marketing`; tenant from `x-api-key`. |
| `src/cli/*.ts` | `ingest`, `report`, `reconcile`, `check-arrivals`, `hash-key`. |
| `test/*.test.ts` | What is promised, proven against a real Postgres. |

## Common changes, and where they go

**A source renamed a column and the client confirmed it means the same thing.**
`config/tenants.yaml` → that tenant's source → `column_aliases: { new_name: canonical_name }`.
Rerun `ingest`: quarantined files are skipped by sha256, so either delete their `ingest_files`
row or wait for the next delivery. No code.

**A new column in the revenue mart** (say, distinct customers per day and channel).
1. New migration `db/migrations/0005_…sql`: `ALTER TABLE mart_daily_revenue ADD COLUMN customers integer NOT NULL DEFAULT 0;`
2. `src/model/mart.ts`, `rebuildMarts`: add `count(DISTINCT customer_hash) AS customers` to the
   `sales` CTE and to the INSERT column list.
3. Optional: add it to the `jsonb_build_object` in `publishDays` so published snapshots carry it.
4. `npm run db:migrate && npm run ingest -- --tenant <slug>`; the API returns it with no change.

**A new source** (say, `subscriptions`).
Add it to `SOURCES` in `src/config/tenants.ts`, add its entry to `SPECS` in
`src/ingest/sources.ts` (columns, zod row, upsert), add a `stg_subscriptions` migration, and
list it under each tenant in the YAML. The pipeline, the registry and replay need no change.

**A different drift policy** (adapt instead of quarantine).
The decision is in one block of `src/ingest/pipeline.ts` (step 2, "Schema drift"). To adapt,
map unknown columns through a rule there instead of quarantining; keep the alert.
