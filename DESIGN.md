# Design: one pipeline, several tenants

A TypeScript + Postgres service that ingests storefront orders, email events and ad spend for
several direct-to-consumer brands, models them into daily revenue, and serves the result
through a small API. It is built to survive the ordinary failures of real sources: a run that
dies halfway, a file that arrives twice, a column renamed without warning, records that turn
up a day late. Adding a tenant is configuration, not code.

This document is the source of truth for the architecture. Code follows it; if code and this
document disagree, one of them is wrong and it is usually the code.

---

## 1. The three questions the design answers

### 1.1 Replay: the same file arrives twice, and the first run died at row 340

Three layers of protection. Each one alone is not enough.

1. **File registry.** Every incoming file is registered in `ingest_files` with its `sha256`,
   tenant, source and status (`received -> processing -> done | failed | quarantined`). The
   unique key is `(tenant_id, sha256)`. If the same bytes arrive again and the file is already
   `done`, it is skipped. If it is `failed` or stuck in `processing` (the run died), it is
   **resumed**: the whole file is read again, and layer 2 makes sure nothing is duplicated.
2. **Idempotent raw rows.** Every raw row goes to `raw_records` as JSONB with a `record_hash`
   (hash of the normalised content). Unique key `(tenant_id, source, record_hash)` plus
   `INSERT ... ON CONFLICT DO NOTHING`. The 340 rows that already landed are ignored, the
   remaining 660 go in. Result: 1,000. This also covers **overlapping exports** (file A holds
   rows 1 to 1,000, file B holds 800 to 1,200): the 200 repeated rows do not duplicate.
3. **Staging by natural key.** Raw to staging is `INSERT ... ON CONFLICT (tenant_id, order_id)
   DO UPDATE` with a "newest version wins" rule (`updated_at` from the source, or
   `ingested_at` when the source does not carry one). Even if raw holds two versions of the
   same order (a corrected price), staging holds one.

The key is never `order_id` alone: it is `(tenant_id, order_id)`. Two tenants may use the
same `order_id` and must not collide. Ad spend has no id, so its key is `(tenant_id,
platform, campaign_id, date)` and a re-export overwrites the previous row. Email events use
`(tenant_id, event_id)` or, when there is no id, a hash of `(email, event_type, timestamp)`.

**How it is proven:** a test runs the ingest with `--fail-at-row 340`, checks that
`ingest_files.status = 'failed'`, re-runs the same file and checks `count = 1000` in staging
and `status = 'done'`.

### 1.2 Late arrivals vs "never restate" vs "reconcile to the cent"

The two client requirements cannot both be true for the same number, and the design says so
in writing (see QUESTIONS.md) rather than choosing silently. The design makes **both** true
for **different numbers**:

- `mart_daily_revenue` is the **current truth**: rebuilt from staging on every run, always
  reconciles to the best we know.
- `reported_days` is the **ledger of what was published**: when a day is reported, an
  immutable snapshot is stored with `version`, `reported_at` and the figures. That row is
  **never edited**.
- When 12 Monday orders arrive on Thursday, the published Monday does not change. A row is
  written to `adjustments` with `(tenant_id, affected_date = Monday, discovered_date =
  Thursday, delta, reason = 'late_arrival', source_file_id)`. The adjustment shows up in
  **Thursday's** report as a separate line, the way accounting handles a prior-period
  correction.
- The API returns the published numbers by default (`view=reported`), optionally the current
  truth (`view=current`), and the pending adjustments.

The question put to the client, verbatim: *"When late orders arrive for a day the board has
already seen, do you want (a) the original day left untouched and the correction shown as a
dated adjustment line, or (b) the day restated with a change log? We reconcile to the cent
either way; the difference is which number the board sees. Until you answer, the pipeline
does (a)."*

### 1.3 A third tenant without touching code

One thing changes: `config/tenants.yaml` (mirrored into the `tenants` table at startup). It
holds `slug`, `name`, `api_key_hash`, `timezone`, `currency`, and per source: file pattern,
expected cadence (for the "did not arrive" monitor) and `column_aliases` (for known drift).
The new client's files go under `fixtures/<slug>/`. `npm run ingest -- --tenant <slug>` and
that is it.

Where an `if (tenant === 'brandA')` could hide: nowhere, guaranteed by three things.
(1) Every table has `tenant_id NOT NULL` with a FK, and **every** unique key and PK starts
with `tenant_id`. (2) The API does not accept `tenant` as a query parameter: it derives it
from the API key, and every query carries `WHERE tenant_id = $1` through a `withTenant(tenantId)`
helper that is the single point of access to the database. (3) Time permitting, Row-Level
Security in Postgres: `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` plus a policy on
`current_setting('app.tenant_id')`, set by `withTenant` on every transaction. With that, even
a bug in one of my queries cannot cross tenants.

---

## 2. Architecture

```
fixtures/<tenant>/<source>/*.csv
        |
        v  npm run ingest -- --tenant X [--source Y] [--fail-at-row N]
+------------------------------------------------------------------+
| 1. discover: list files, compute sha256, register in ingest_files |
| 2. validate header: canonical vs received (+ tenant aliases)      |
|      ok -> continue . alias -> adapt and log . unknown ->          |
|      quarantine (whole file) + alert; other sources keep going    |
| 3. raw: each row -> raw_records (jsonb, record_hash, ON CONFLICT   |
|      DO NOTHING) in batches of 500                                 |
| 4. staging: raw -> stg_* (typed with zod, upsert by natural key)   |
| 5. mart: rebuild mart_daily_revenue for (tenant, touched dates)    |
|      with DELETE + INSERT per partition                            |
| 6. late arrivals: if a touched date is already in reported_days    |
|      -> row in adjustments, reported_days untouched                |
| 7. close: ingest_files.status = done, rows_loaded, duration        |
+------------------------------------------------------------------+
npm run check-arrivals                  -> expected_deliveries with no file -> list + exit 1
npm run report -- --tenant X --date D   -> publish snapshot into reported_days
npm run reconcile -- --tenant X         -> mart vs finance_summary.csv, deltas per day/channel
npm run api                             -> Fastify: GET /v1/revenue?from&to&view=reported|current
                                           (tenant from the x-api-key header)
```

### Tables (Postgres, numbered SQL migrations in `db/migrations/`)

| Table | Key | Purpose |
|---|---|---|
| `tenants` | `id`, unique `slug` | config: name, timezone, currency, api_key_hash |
| `tenant_sources` | `(tenant_id, source)` | file_pattern, expected_cadence, column_aliases jsonb |
| `ingest_files` | unique `(tenant_id, sha256)` | file_name, source, status, rows_total, rows_loaded, started_at, finished_at, error |
| `raw_records` | unique `(tenant_id, source, record_hash)` | file_id, row_number, payload jsonb, ingested_at |
| `stg_orders` | `(tenant_id, order_id)` | order_ts, order_date, channel, gross, discount, refund, net, currency, source_updated_at, file_id |
| `stg_email_events` | `(tenant_id, event_id)` | email_hash, event_type, event_ts, campaign |
| `stg_ad_spend` | `(tenant_id, platform, campaign_id, spend_date)` | spend, currency, impressions, clicks |
| `mart_daily_revenue` | `(tenant_id, date, channel)` | orders, gross, net, refunds, computed_at |
| `reported_days` | `(tenant_id, date, version)` | snapshot jsonb, reported_at (immutable) |
| `adjustments` | id | tenant_id, affected_date, discovered_date, channel, delta_net, reason, file_id |
| `expected_deliveries` | `(tenant_id, source, expected_date)` | received_file_id nullable, checked_at |
| `quarantine` | id | tenant_id, file_id, reason, header_received, header_expected |

### Fixed decisions

- **Revenue definition** in the mart: `net = gross - discount - refund`, in the tenant's
  currency, by `order_date` in the tenant's timezone. Declared in the README. If finance uses
  a different definition (for example without refunds), `reconcile` shows it and the question
  goes to QUESTIONS.md.
- **Schema drift:** policy is "quarantine the file and alert", unless an alias is configured.
  Reason: a silent rename can change meaning (`amount` -> `amount_net`), and guessing is worse
  than pausing one source for a day. The README documents how to add the alias in config to
  unblock the source.
- **Stack:** Node 20+, TypeScript, `pg` with hand-written SQL (no ORM: it reads better),
  `zod` for row typing, `commander` for the CLI, `fastify` for the API, `vitest` for tests,
  `docker compose` with Postgres 16. `npm run db:migrate` applies the migrations in order.
- **No ORM and no pipeline framework**, deliberately: the codebase must be readable end to
  end by one person in one sitting.

---

## 3. Build plan (eight hours of work)

| Block | What | Commit when done |
|---|---|---|
| 0 | Repo, compose, migrations skeleton, config skeleton, CLI entry points. | `chore: scaffold, compose, migrations skeleton` |
| H1 | **Read the fixtures.** Unzip, list every file per tenant and source, open each one. Write `NOTES-fixtures.md`: which column is renamed and from which file on, which files overlap, which one arrives late, which one is missing, which one is duplicated, what `finance_summary.csv` looks like. **No pipeline code until this exists.** | `docs: fixture inventory and failure cases found` |
| H2 | Full migrations, tenant config synced to the DB, `ingest` CLI with discover + registration in `ingest_files`. | `feat: tenant config, migrations, file registry` |
| H3-H4 | Idempotent raw + staging orders with upsert + replay test (`--fail-at-row`). Run with both tenants. | `feat: idempotent raw + staging with replay test` |
| H5 | Daily mart + `reconcile` against `finance_summary.csv`. Record unexplained deltas. | `feat: daily revenue mart and finance reconcile` |
| H6 | Drift (quarantine + alias), `expected_deliveries` + `check-arrivals`, `reported_days` + `adjustments` for late arrivals. | `feat: schema drift quarantine, arrival monitor, immutable reports` |
| H7 | Fastify API with API key -> tenant. Email events and ad spend into staging **if time allows**; otherwise they stay in raw and the README says so. | `feat: tenant-scoped API` |
| H8 | README, TRADEOFFS, QUESTIONS, WALKTHROUGH. | `docs: README, TRADEOFFS, QUESTIONS` |

If H6 cannot be completed: **replay and tenant isolation done fully are worth more than drift
done halfway.** Whatever is not built goes to TRADEOFFS.md with one line on why.

---

## 4. The written deliverables

- **README.md:** what it does in five lines. Requirements (Node 20+, Postgres 16 via Docker or
  native). `docker compose up -d`, `npm ci`, `npm run db:migrate`, `npm run ingest -- --tenant
  brand-a`, `npm test`, `npm run api`. The revenue definition. What is finished, partial and
  not done (an honest table). How the third tenant is added (five lines, config only).
- **TRADEOFFS.md:** what was prioritised (replay + isolation) and why. What was deliberately
  not built and why (orchestrator, scheduler, retries with backoff, RLS if it did not make it).
  The client's contradiction and how it was resolved. What a further week would go to. The
  hardest thing found in the fixtures. How the code was produced.
- **QUESTIONS.md:** four to six sharp questions, each with "what I assumed meanwhile". At
  minimum: restate vs adjustment; finance's revenue definition; what to do with a source
  quarantined by drift (wait for an alias or stop reporting); the timezone that closes the
  day; currency and conversion if there is more than one.
- **WALKTHROUGH.md:** for each source file, two lines on what it does, plus three plausible
  "small change" requests (a new mart column, a third tenant, a different drift policy) with
  the exact files to touch.
