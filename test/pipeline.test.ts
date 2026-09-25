import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, withTenant } from "../src/db/client.js";
import { ingestTenant, SimulatedCrash } from "../src/ingest/pipeline.js";
import { publishDays } from "../src/model/mart.js";
import { resetDb, scalar, tenant, tenantId } from "./helpers.js";

afterAll(() => closePool());
beforeEach(() => resetDb());

describe("replay", () => {
  it("a run that dies a third of the way through resumes without double-counting", async () => {
    const nw = await tenant("northwind");

    // batch 01 of orders has 128 rows; die after 43.
    await expect(ingestTenant(nw, { source: "orders", batches: { from: 1, to: 1 }, failAtRow: 43 })).rejects.toBeInstanceOf(SimulatedCrash);
    const id = await tenantId("northwind");
    expect(await scalar(id, "SELECT status FROM ingest_files WHERE tenant_id = $1")).toBe("processing");
    expect(Number(await scalar(id, "SELECT count(*) FROM raw_records WHERE tenant_id = $1"))).toBe(43);
    expect(Number(await scalar(id, "SELECT count(*) FROM stg_orders WHERE tenant_id = $1"))).toBe(0);

    // Same command again: picks the file up, skips the 43 rows it already has, finishes.
    const [res] = await ingestTenant(nw, { source: "orders", batches: { from: 1, to: 1 } });
    expect(res).toMatchObject({ status: "done", rowsTotal: 128, rowsNew: 85 });
    expect(Number(await scalar(id, "SELECT count(*) FROM raw_records WHERE tenant_id = $1"))).toBe(128);
    expect(Number(await scalar(id, "SELECT count(*) FROM stg_orders WHERE tenant_id = $1"))).toBe(128);

    // And a third time is a no-op.
    const [again] = await ingestTenant(nw, { source: "orders", batches: { from: 1, to: 1 } });
    expect(again.status).toBe("skipped");
  });

  it("the overlapping export (batch 03 repeats 14 orders from batch 02) is counted once", async () => {
    const nw = await tenant("northwind");
    const res = await ingestTenant(nw, { source: "orders" });
    const b3 = res.find((r) => r.name.endsWith("orders/batch_03.csv"))!;
    expect(b3.rowsTotal - b3.rowsNew).toBe(14);
    const id = await tenantId("northwind");
    expect(Number(await scalar(id, "SELECT count(*) FROM stg_orders WHERE tenant_id = $1"))).toBe(680);
    // 17 Jan gross equals finance_summary to the cent (a double count would add 1,922.93).
    expect(await scalar(id, "SELECT sum(gross)::text FROM mart_daily_revenue WHERE tenant_id = $1 AND date = '2026-01-17'")).toBe("3627.70");
  });
});

describe("schema drift", () => {
  it("quarantines a file whose header changed and keeps the other sources flowing", async () => {
    const nw = await tenant("northwind");
    const res = await ingestTenant(nw);
    const quarantined = res.filter((r) => r.status === "quarantined").map((r) => r.name);
    expect(quarantined).toEqual(["northwind/ad_spend/batch_04.csv", "northwind/ad_spend/batch_05.csv"]);
    expect(res.filter((r) => r.status === "done")).toHaveLength(18);
  });

  it("a configured alias unblocks it without code changes", async () => {
    const nw = await tenant("northwind");
    await ingestTenant({ ...nw, sources: { ...nw.sources, ad_spend: { column_aliases: { cost_usd: "spend" } } } }, { source: "ad_spend" });
    const id = await tenantId("northwind");
    expect(Number(await scalar(id, "SELECT count(DISTINCT spend_date) FROM stg_ad_spend WHERE tenant_id = $1"))).toBe(30);
  });
});

describe("late arrivals and the no-restatement rule", () => {
  it("a published day never moves; late data becomes adjustments; published + adjustments = current", async () => {
    const nw = await tenant("northwind");
    await ingestTenant(nw, { batches: { from: 1, to: 3 } });
    const id = await tenantId("northwind");
    await withTenant(id, (q) => publishDays(q, id, "2026-01-23"));
    const before = await scalar(id, "SELECT jsonb_agg(snapshot ORDER BY date)::text FROM reported_days WHERE tenant_id = $1");

    await ingestTenant(nw, { batches: { from: 4, to: 5 } }); // refunds for published days arrive now

    const after = await scalar(id, "SELECT jsonb_agg(snapshot ORDER BY date)::text FROM reported_days WHERE tenant_id = $1");
    expect(after).toBe(before);
    expect(Number(await scalar(id, "SELECT count(*) FROM adjustments WHERE tenant_id = $1"))).toBeGreaterThan(0);

    const gap = await scalar(
      id,
      `WITH pub AS (SELECT d.date, s.channel, s.net FROM reported_days d,
                      jsonb_to_recordset(d.snapshot) s(channel text, net numeric) WHERE d.tenant_id = $1),
            adj AS (SELECT affected_date AS date, channel, delta_net AS net FROM adjustments WHERE tenant_id = $1),
            known AS (SELECT date, channel, sum(net) AS net FROM (SELECT * FROM pub UNION ALL SELECT * FROM adj) x GROUP BY 1, 2)
       SELECT count(*) FROM known k
       FULL JOIN (SELECT date, channel, net FROM mart_daily_revenue WHERE tenant_id = $1 AND date <= '2026-01-23') m USING (date, channel)
       WHERE coalesce(k.net, 0) <> coalesce(m.net, 0)`,
    );
    expect(Number(gap)).toBe(0);

    // Re-running changes nothing: adjustments are not recorded twice.
    const n = await scalar(id, "SELECT count(*) FROM adjustments WHERE tenant_id = $1");
    await ingestTenant(nw);
    expect(await scalar(id, "SELECT count(*) FROM adjustments WHERE tenant_id = $1")).toBe(n);
  });

  it("the database itself refuses to edit a published day", async () => {
    const nw = await tenant("northwind");
    await ingestTenant(nw, { source: "orders", batches: { from: 1, to: 1 } });
    const id = await tenantId("northwind");
    await withTenant(id, (q) => publishDays(q, id, "2026-01-06"));
    await expect(
      withTenant(id, (q) => q("UPDATE reported_days SET snapshot = '[]' WHERE tenant_id = $1", [id])),
    ).rejects.toThrow(/append-only/);
  });
});
