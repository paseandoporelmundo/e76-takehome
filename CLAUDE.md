# e76 take-home: multi-tenant ingestion service

Rules for any coding agent working in this repo. The design is owned by Facundo Mariani;
agents implement it and keep it explainable.

## Design source

Before writing code, read `DESIGN.md` (English). If it does not exist yet, create it from the
design notes Facundo points you to, then follow it. Do not change the architecture without
asking and stating the tradeoff in two lines.

## Stack (fixed)

Node 20+, TypeScript, `pg` with hand-written SQL (no ORM), `zod`, `commander` (CLI),
`fastify` (API), `vitest`, numbered SQL migrations in `db/migrations/`. `docker-compose.yml`
provides Postgres 16 for reviewers; locally `DATABASE_URL` in `.env` points to a native
Postgres. Both paths must work and both are documented in README.

## Non-negotiables

- Every table has `tenant_id NOT NULL` with a FK; every unique key and PK starts with
  `tenant_id`. All DB access goes through one `withTenant(tenantId)` helper. The API derives
  the tenant from `x-api-key` only, never from a query param or body.
- Adding a tenant is configuration only (`config/tenants.yaml` + `fixtures/<slug>/`). No
  branching on tenant names anywhere in code.
- Idempotency: file registry by sha256 in `ingest_files`; `raw_records` inserted with
  `ON CONFLICT DO NOTHING` on `(tenant_id, source, record_hash)`; staging upserted by natural
  key, newest wins; mart rebuilt per `(tenant_id, date)`. Ship a `--fail-at-row N` flag and a
  replay test proving a crash + rerun yields the correct row count.
- Late arrivals: `reported_days` is immutable; late data creates `adjustments` rows dated on
  discovery. A reported day is never restated.
- Schema drift: compare the incoming header to the canonical one; a configured alias adapts
  and logs; an unknown header quarantines the whole file with an alert and does not block
  other sources.

## Working discipline

- Hour 1 is fixture reading only. Produce `NOTES-fixtures.md` listing every anomaly found
  before writing any pipeline code.
- Work in the block order in `DESIGN.md`. After each block: run tests, then commit with a
  message that says what and why. Never squash, never commit `.env` or secrets.
- Keep the codebase small and readable. Prefer one obvious way over a clever one.
- Time box is eight hours of work. At each block boundary state what is left and what to cut.
- At the end, write `WALKTHROUGH.md`: for each source file, two lines on what it does, plus
  three plausible "small change" requests (new mart column, third tenant, different drift
  policy) with the exact files to touch.
