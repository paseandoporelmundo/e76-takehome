# Tradeoffs

## What I prioritised, and why

1. **Replay.** It is where silent double-counting comes from, and the fixtures contain a real
   overlapping export. Three layers, each cheap: a file registry keyed by sha256 (the same bytes
   are skipped, a run that died is resumed), raw rows keyed by a hash of their content with
   `ON CONFLICT DO NOTHING`, and staging upserted by natural key. A test kills a run a third of
   the way through (row 43 of 128), reruns it, and checks the counts: 128 raw rows, 128 orders,
   85 new rows on the second run, a no-op on the third.

2. **Tenant isolation you can point at.** `tenant_id` leads every key, all access goes through
   one helper, and the API takes the tenant from the key and nothing else. The fixtures even
   reuse the same refund ids across the two brands, which only works because keys are scoped.

3. **The two client rules.** "Ties to the cent" and "never restated" cannot both hold for one
   number once a late record lands. So there are two numbers: the published day (frozen, the
   database refuses updates) and the current day. The difference is a list of dated
   adjustments, and published + adjustments = current. Which one the board sees is the client's
   choice (QUESTIONS.md Q5); the system supports either without a rebuild.

## Decisions and their cost

- **Drift policy: quarantine, adapt only through an explicit alias.** A renamed column can mean
  a changed meaning (`spend` → `cost_usd`, for a brand that sells in euros). Guessing would put
  numbers in the mart that nobody can vouch for. Cost: until someone answers, ad spend from
  24 Jan is missing. Missing and flagged beats present and wrong.
- **Refunds booked on the day they happened, in the order's channel.** That is when the money
  left. The alternative (book against the order's day) would reach back into published days
  every time a refund arrived, which is the thing the client asked us not to do. Cost: our net
  for a day is not "that day's orders minus their eventual refunds".
- **Orphan refunds are held aside, not dropped and not assigned.** Cost: channel revenue is
  higher than it would be if they belonged to a channel; the total is visible in
  `unmatched_refunds` and in every `reconcile` run.
- **Marts are rebuilt from staging on every run.** Correct by construction and fast at this size.
  At real volume I would rebuild only the dates a run touched.
- **Hand-written SQL, no ORM, no pipeline framework.** Every table and query is readable in a
  few files, which matters for the person onboarding the next client.
- **The day boundary is the tenant's timezone, set to UTC for both.** Finance's gross ties only
  on UTC dates. A tenant that closes days in local time changes one config value; a test does it.

## What I deliberately did not build

- Row-Level Security policies. The helper already pins `app.tenant_id` on every transaction, so
  adding them is a migration, but they only protect anything once the app connects as a
  non-owner role. I preferred to spend the time on replay tests.
- Scheduling, retries with backoff, and alert delivery (Slack, email). Alerts are stderr lines
  and non-zero exit codes, which any scheduler can act on.
- A time-based "the file is late" check. `check-arrivals` works from the manifest; an SLA per
  source (Q6) is config the client has to give us first.
- Per-row quarantine. A bad header quarantines the whole file, which is safer; a single bad row
  fails the run with the file and row number.
- Currency conversion. Nothing in the data says which rate to use (Q4).

## How the third client gets added

A new entry in `config/tenants.yaml` and a folder of files. No code, no tables. The test suite
does it with a tenant called `acme` in a different timezone. The README has the three steps.

## With another week

- RLS with a dedicated application role, plus a test that a query without the tenant filter
  returns nothing.
- Incremental marts (rebuild only touched dates) and a proper job runner with retries.
- Per-source arrival SLAs and alert delivery.
- Once Q1 is answered, make `reconcile` part of every run and fail the run when gross drifts.
- A small ops view: files by status, quarantine with the reason, adjustments by week.

## The hardest thing I hit

The finance net. Gross ties to the cent on every day for both brands, which says the data and
the day boundary are right. Net does not tie under any refund definition I tried (by refund
date, by order date, with and without the orphans), and on more than half the days it is
higher than gross. The temptation is to fit something until the numbers match. I stopped
there, published our net with its definition, printed the gap per day, and wrote the question.

## How the code was produced

AI coding agents under my direction. The design calls in this file are mine, and I can walk
through any file in the repo.
