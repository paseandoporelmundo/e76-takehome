# e76 take-home: one pipeline, several tenants

A TypeScript + Postgres service that ingests storefront orders, email events and ad spend for
several direct-to-consumer brands, models them into daily revenue, and serves the result
through a small API. Re-runs are safe, late data never restates a published day, a renamed
column quarantines the file instead of corrupting the numbers, and a new tenant is a config
entry, not a fork. The architecture is in [DESIGN.md](DESIGN.md).

**Status: scaffold only.** Schema, config loader, CLI entry points and migration runner are in
place; the pipeline itself is being built block by block (see the plan in DESIGN.md section 3).

## Requirements

- Node 20 or newer, npm.
- Postgres 16. Either Docker (`docker-compose.yml` is provided) or a native install.

## Run from a clean checkout

With Docker:

```bash
docker compose up -d
cp .env.example .env
npm ci
npm run db:migrate
```

With a native Postgres: create an empty database, put its connection string in `.env` as
`DATABASE_URL=postgres://user:pass@localhost:5432/e76`, then `npm ci` and `npm run db:migrate`.

Then:

```bash
npm run ingest -- --tenant brand-a        # ingest one tenant (all sources)
npm run ingest -- --tenant brand-b
npm run check-arrivals                    # exit 1 if an expected file is missing
npm run report -- --tenant brand-a --date 2025-01-06   # publish an immutable snapshot
npm run reconcile -- --tenant brand-a     # compare mart vs finance_summary.csv
npm run api                               # GET /v1/revenue with x-api-key header
npm test
```

On Windows PowerShell 5 replace `cp` with `Copy-Item` and run the commands one per line.

## Revenue definition

`net = gross - discount - refund`, in the tenant's currency, attributed to the order's date in
the tenant's timezone. See DESIGN.md section 2 for why, and QUESTIONS.md for what still needs
the client's answer.

## Adding a tenant

1. Add an entry to `config/tenants.yaml` (slug, name, api_key_hash, timezone, currency, sources).
2. Drop the files under `fixtures/<slug>/<source>/`.
3. `npm run ingest -- --tenant <slug>`.

No code changes, no new tables.

## What is done / partial / not done

Filled in at the end of the build. Until then, see the block plan in DESIGN.md.
