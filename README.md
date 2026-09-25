# One pipeline, two clients

A TypeScript + Postgres service that ingests four sources (orders, refunds, ad spend, email
events) for any number of direct-to-consumer brands, models them into daily numbers and serves
them through an API. Two brands are configured, `lumen` and `northwind`.

What I chose to do properly: **replay** (a run that dies halfway, a file that arrives twice,
an export that overlaps the previous one), **tenant isolation**, and the collision between the
client's two rules (**tie to the cent** vs **never restate**). Drift and late arrivals are
handled with a deliberate, simple policy. The reasoning is in [TRADEOFFS.md](TRADEOFFS.md),
what I found in the data before building is in [NOTES-fixtures.md](NOTES-fixtures.md), and
what only the client can answer is in [QUESTIONS.md](QUESTIONS.md).

## Run it from a clean checkout

Requirements: Node 20+, and Docker (for Postgres 16) or a local Postgres 16.

```bash
docker compose up -d            # Postgres 16 on localhost:5432
cp .env.example .env            # Windows PowerShell: Copy-Item .env.example .env
npm ci
npm run db:migrate
npm test                        # 11 tests against the real database
npm run demo                    # the whole story below, end to end
```

If port 5432 is taken, run `PG_PORT=5433 docker compose up -d` and change the port in
`DATABASE_URL` in `.env`. With a local Postgres instead of Docker, just point `DATABASE_URL` at it.

## The commands

```bash
npm run ingest -- --tenant northwind                  # load everything delivered for a tenant
npm run ingest -- --tenant northwind --batches 1-3    # only batches 1..3 (replays delivery over time)
npm run ingest -- --tenant northwind --fail-at-row 43 # test hook: the run dies after 43 rows; rerun to resume
npm run report -- --tenant northwind --through 2026-01-23   # publish (freeze) every day up to that date
npm run reconcile -- --tenant northwind               # our numbers vs finance_summary.csv, per day
npm run check-arrivals                                # expected batches (manifest) vs what landed; exit 1 if any is missing
npm run api                                           # http://127.0.0.1:3000
```

```bash
curl -H "x-api-key: northwind-demo-key" "http://127.0.0.1:3000/v1/revenue?from=2026-01-20&to=2026-01-23"
curl -H "x-api-key: northwind-demo-key" "http://127.0.0.1:3000/v1/revenue?from=2026-01-20&to=2026-01-23&view=current"
curl -H "x-api-key: lumen-demo-key"     "http://127.0.0.1:3000/v1/marketing?from=2026-01-06&to=2026-01-11"
```

`view=reported` (the default) returns what was published, frozen, with the adjustments
discovered since listed beside it. `view=current` returns today's best numbers.

## What `npm run demo` shows

1. Northwind batches 1 to 3 arrive. Batch 03 repeats 14 orders from batch 02: loaded once.
2. Days up to 23 Jan are published.
3. Batches 4 and 5 arrive, carrying two refunds dated 22 and 23 Jan. The published days do not
   move; two adjustment rows appear instead (−28.61 on 22 Jan `google`, −84.47 on 23 Jan
   `facebook`). Published + adjustments = current, to the cent.
4. `ad_spend` batches 4 and 5 renamed `spend` to `cost_usd`: both are quarantined with an
   alert, and the other sources keep loading.
5. `reconcile`: gross ties to `finance_summary.csv` on 30 of 30 days. Net does not, and
   cannot (QUESTIONS.md Q1); the gap is printed per day, not hidden.
6. `check-arrivals`: lumen `ad_spend` batch 3 never arrived; four batches are quarantined.
   Exit code 1.

## How it works

```
fixtures/<tenant>/<source>/batch_NN.*        config/tenants.yaml
            │                                        │
            ▼                                        ▼
 1. register   ingest_files, unique (tenant, sha256): same bytes twice = skipped,
               a run that died = resumed
 2. header     canonical columns per source, after the tenant's configured aliases;
               anything else -> quarantine + ALERT; that file stops, the others continue
 3. raw        raw_records, unique (tenant, source, hash of the row), ON CONFLICT DO NOTHING,
               committed in chunks of 100: a crash leaves a partial file that the rerun completes
 4. staging    stg_orders / stg_refunds / stg_ad_spend / stg_email_events,
               upsert by natural key (tenant first), newest file wins
 5. marts      mart_daily_revenue, mart_daily_marketing, mart_daily_email, rebuilt from staging
 6. published  reported_days (append-only, enforced by a trigger)
               + adjustments (late data for a published day, dated when it was discovered)
```

Code map: `src/ingest/pipeline.ts` (steps 1 to 4), `src/ingest/sources.ts` (what each source
looks like), `src/model/mart.ts` (steps 5 and 6), `src/cli/*` (commands), `src/api/server.ts`,
`db/migrations/*` (every table, commented).

**Revenue definition.** `gross` = order value on the order's day. `refunds` = refunds matched to
their order, in the order's channel, on the day the refund happened. `net = gross − refunds`.
The day is the calendar date in the tenant's timezone (UTC for both tenants: that is the
boundary on which finance's gross ties). Refunds we cannot match to an order are kept in the
`unmatched_refunds` view, never dropped and never guessed into a channel.

**Where tenant isolation is enforced**, not just intended:

- Every table has `tenant_id NOT NULL` with a foreign key, and every primary and unique key
  starts with `tenant_id`. Two tenants can use the same order or refund id (they do:
  `rf-orphan-01` exists in both) without colliding. A test checks every table.
- All tenant data access goes through `withTenant(tenantId, …)` in `src/db/client.ts`.
- The API takes the tenant from the `x-api-key` header only (stored as a sha256). A tenant
  query parameter is ignored; a test proves it.
- No code branches on a tenant name: `grep -rn "lumen\|northwind" src/` returns nothing.

## Adding a third client (configuration only)

1. Add an entry to `config/tenants.yaml`: slug, name, `api_key_hash` (`npm run hash-key -- <key>`),
   timezone, currency, and the four sources with any `column_aliases`.
2. Put the files under `fixtures/<slug>/<source>/` and list the batches in `fixtures/manifest.json`
   so `check-arrivals` knows what to expect.
3. `npm run ingest -- --tenant <slug>`.

No new tables, no new models, no code. `test/tenants.test.ts` adds a tenant `acme` exactly this
way, in a different timezone, and checks that it loads.

## Finished, partial, not done

| Area | State |
|---|---|
| Ingestion of all 4 sources to raw, both tenants | Done |
| Replay: crash + rerun, duplicate file, overlapping export | Done, tested |
| Staging and daily marts (revenue, spend, email) | Done |
| Second tenant on the same code; third by config | Done, tested |
| Late arrivals: frozen published days + adjustments | Done, tested |
| Schema drift | Quarantine, or adapt through a configured alias. Done, tested. No guessing |
| "A source did not arrive" | Done against the manifest (`check-arrivals`). No time-based SLA yet |
| Reconcile against finance | Gross ties on 60/60 tenant-days. Net cannot (QUESTIONS.md Q1) |
| API | Two read endpoints, API-key auth. No pagination, no rate limiting |
| Row-Level Security in Postgres | Not done; `withTenant` already sets `app.tenant_id` for the policies |
| Scheduling, retries, alert delivery | Not done: alerts are stderr lines and exit codes |

## Tests

`npm test` runs 11 tests against the Postgres in `DATABASE_URL`. The schema is dropped and
re-created for each test, so do not point it at a database you care about.

## How this was built

With an AI coding agent under my direction. I read the fixtures first, made the design calls
recorded in TRADEOFFS.md, and reviewed every file; I can walk through any of it.
