# Questions for the client

Everything I could not settle from the materials, written as I would send it, with what the
pipeline assumes until you answer. Numbers are from the fixtures.

---

**Q1. How is `net_reported` in your finance summary calculated?**

> Your gross ties to our order totals to the cent on every day. Your net does not, and on 17 of
> 30 days it is *higher* than gross, which refunds alone cannot produce (it moves between −2.5%
> and +3.2% of gross). Does your net include something we are not receiving, such as
> shipping, fees, chargebacks or a currency adjustment? If you can send the formula or one
> day's breakdown, we can match it.

*Meanwhile:* we publish our own net (gross − refunds, defined in the README) and `reconcile`
prints the per-day gap. Gross is the number we guarantee to the cent.

---

**Q2. The ad spend export changed a column from `spend` to `cost_usd` on 24 Jan. Same number, new name?**

> From batch 4 onwards, ad spend arrives with `cost_usd` instead of `spend`. Is it the same
> amount under a new name, or did the platform start reporting in US dollars? Lumen sells in
> euros, so for Lumen this matters. A yes/no per brand is enough.

*Meanwhile:* both files are quarantined, so spend from 24 Jan onwards is missing rather than
possibly wrong. If the answer is "same number", it is one line in `config/tenants.yaml`
(`column_aliases: { cost_usd: spend }`) and a rerun.

---

**Q3. Six refunds per brand point at order `…-00000000`, which does not exist. What are they?**

> Lumen has 6 refunds totalling €1,434.06 and Northwind 6 totalling $1,467.86, all against
> order id `00000000`. Are they manual refunds, refunds for orders placed outside the store, or
> test data? Should they reduce revenue, and on which day?

*Meanwhile:* they are loaded and kept in `unmatched_refunds`, out of channel revenue, and
reported by `reconcile` so they cannot be forgotten.

---

**Q4. Lumen: your finance summary says USD, the orders say EUR. Which is right?**

> Every Lumen order is in EUR. Your finance summary labels Lumen's numbers USD, yet they equal
> the EUR order totals to the cent. Is the label wrong, or should we convert, and at which rate?

*Meanwhile:* we report Lumen in EUR, the currency of the orders, with no conversion.

---

**Q5. When late data arrives for a day the board has already seen, which number should the board see?**

> Your two rules collide when a record arrives late: "every number ties to finance" and "a
> reported day never moves". Example from this data: a refund for 23 Jan arrived with the
> 24 to 29 Jan export. Do you want (a) 23 Jan left exactly as published, with the −$84.47
> shown as a dated adjustment in the next report, or (b) 23 Jan corrected, with a note of
> what changed?

*Meanwhile:* (a). Published days are frozen in the database; late data becomes an adjustment
row dated on the day we found it. Published + adjustments always ties to the current numbers.

---

**Q6. Lumen's ad spend for 18 to 23 Jan never arrived. Can you resend it?**

> The manifest lists Lumen ad spend batch 3 (18 to 23 Jan), but the file was not delivered.
> Could you resend it? And going forward, what is the latest time a daily file should land
> before we alert you?

*Meanwhile:* `check-arrivals` flags it and exits with an error; those six days show no Lumen
spend rather than an estimate.
