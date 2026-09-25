# Fixture inventory: what is in the data before any code

Written in the first hour, before building. Every item below was found by reading the files
(scripts in the commit history are not needed to follow it). Each one says what the pipeline
does about it, or why it cannot be closed.

## Shape

Two tenants, `lumen` and `northwind`. Four sources each, delivered as 5 batches that cover
six days each (6 Jan to 4 Feb 2026), plus `finance_summary.csv` per tenant and a
`manifest.json` listing every batch the set is supposed to contain.

| Source | Format | Natural key |
|---|---|---|
| orders | CSV: `order_id, created_at, channel, gross, currency, customer_email` | `order_id` |
| refunds | CSV: `refund_id, refunded_at, order_id, amount, currency` | `refund_id` |
| ad_spend | CSV: `date, campaign_id, platform, spend` | `(date, campaign_id)` |
| email_events | NDJSON: `event_id, type, email, campaign_id, occurred_at` | `event_id` |

The two tenants use the same shapes but different vocabularies (channels `Meta/Google/Newsletter/Direct`
vs `facebook/google/email/direct`; event types upper vs lower case). Nothing in the code may depend on
which tenant it is reading, so vocabulary is normalised (case) or kept as the tenant sent it (channel names).

## Failures found

1. **Overlapping export (replay).** `northwind/orders/batch_03.csv` starts at 2026-01-17 12:23,
   inside batch 02's window. The 14 orders from 17 Jan appear in both files, byte-identical.
   A naive load double-counts $1,922.93 of 17 Jan revenue. Handled: raw rows are keyed by a
   content hash and staging by `(tenant, order_id)`, so the second copy is a no-op.

2. **Schema drift.** `ad_spend` renames `spend` to `cost_usd` from batch 04 onwards, for both
   tenants. The name change may also be a meaning change: lumen sells in EUR, and a column called
   `cost_usd` suggests the platform switched currency. Handled: unknown header, so the file is
   quarantined with an alert and the other sources keep flowing. A tenant can map the new name
   in config once someone confirms what it means (QUESTIONS.md Q2).

3. **A source that did not arrive.** `lumen/ad_spend/batch_03.csv` is listed in the manifest
   and missing from the delivery. Handled: `check-arrivals` compares the manifest against the
   file registry and exits non-zero, naming the missing batch.

4. **Late arrivals.**
   - Refunds land in whatever batch they were exported in, not the batch of their date. Refunds
     dated as early as 7 Jan arrive in batches 02 to 05, after those days could have been
     reported (10 for lumen, 8 for northwind, orphans included). 9 more are dated after the
     window, up to 11 Feb.
   - `northwind/email_events/batch_05.ndjson` carries 24 events from 12 to 17 Jan.
   Handled: a reported day is frozen; late data for it becomes a dated adjustment row
   (see the contradiction below).

5. **Orphan refunds.** Each tenant has 6 refunds (`rf-orphan-01..06`) pointing at order
   `XX-00000000`, which does not exist. $1,434.06 for lumen and $1,467.86 for northwind.
   Cannot be closed from the data: we do not know which order, channel or even which day they
   belong to. Handled: loaded into staging, flagged as unmatched, kept out of channel revenue and
   reported separately (QUESTIONS.md Q3).

6. **Currency mismatch (lumen).** Every lumen order is in EUR. Lumen's `finance_summary.csv`
   labels its figures USD, yet its gross equals the EUR order total to the cent on all 30 days.
   So either the label is wrong or finance converts somewhere we cannot see. Handled: we report
   in the order currency, reconcile on amounts, and ask (QUESTIONS.md Q4).

7. **Finance net cannot be reproduced.** `gross_reported` ties to the sum of order gross by UTC
   date, to the cent, for all 60 tenant-days. `net_reported` does not tie to anything in the
   data: on 17 of 30 days per tenant it is *higher* than gross, which no refund definition can
   produce. Handled: we tie gross to the cent and publish our net with its definition beside it;
   the net gap is reported per day by `reconcile`, not hidden (QUESTIONS.md Q1).

8. **Refund after the window.** Refunds dated 5 to 11 Feb exist for orders inside the window.
   They are real, and they land on days finance's summary does not cover.

## The client's two rules cannot both hold

"Every number ties to finance to the cent" and "a reported day is never restated" collide as soon
as a late record arrives for a reported day: either the published number moves, or it stops
tying. The design keeps both true for different numbers: the published day is an immutable
snapshot; the late record becomes an adjustment dated on the day it was discovered; the
current view (published + adjustments) is the one that ties. Which one the board sees is the
client's call (QUESTIONS.md Q5).

## Day boundary

Finance's gross ties when orders are bucketed by their UTC date. So the tenant "day" in this
data set is UTC, and both tenants are configured with `timezone: UTC`. A tenant whose finance
closes days in local time is a config change, not a code change.
