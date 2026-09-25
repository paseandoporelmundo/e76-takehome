import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool } from "../src/db/client.js";
import { FIXTURES_DIR, loadTenantsConfig } from "../src/config/tenants.js";
import { ingestTenant } from "../src/ingest/pipeline.js";
import { buildServer } from "../src/api/server.js";
import { resetDb, scalar, tenant, tenantId } from "./helpers.js";

afterAll(() => closePool());
beforeEach(() => resetDb());

describe("tenant isolation", () => {
  it("both tenants load with the same code, and ids that collide across tenants do not clash", async () => {
    await ingestTenant(await tenant("lumen"));
    await ingestTenant(await tenant("northwind"));
    // rf-orphan-01 .. 06 exist in both tenants' refunds.
    for (const slug of ["lumen", "northwind"]) {
      const id = await tenantId(slug);
      expect(Number(await scalar(id, "SELECT count(*) FROM stg_refunds WHERE tenant_id = $1 AND refund_id LIKE 'rf-orphan-%'"))).toBe(6);
    }
  });

  it("the API serves each key only its own tenant's data, and nothing without a key", async () => {
    await ingestTenant(await tenant("lumen"), { source: "orders" });
    await ingestTenant(await tenant("northwind"), { source: "orders" });
    const app = buildServer();
    const get = (key?: string) =>
      app.inject({ method: "GET", url: "/v1/revenue?from=2026-01-06&to=2026-01-06&view=current", headers: key ? { "x-api-key": key } : {} });

    expect((await get()).statusCode).toBe(401);
    expect((await get("not-a-key")).statusCode).toBe(401);

    const lumen = (await get("lumen-demo-key")).json() as { days: { channel: string }[] };
    const northwind = (await get("northwind-demo-key")).json() as { days: { channel: string }[] };
    expect(new Set(lumen.days.map((d) => d.channel))).toEqual(new Set(["Direct", "Google", "Meta", "Newsletter"]));
    expect(new Set(northwind.days.map((d) => d.channel))).toEqual(new Set(["direct", "email", "facebook", "google"]));

    // A tenant query param is ignored: the key decides.
    const sneaky = await app.inject({
      method: "GET",
      url: "/v1/revenue?from=2026-01-06&to=2026-01-06&view=current&tenant=northwind",
      headers: { "x-api-key": "lumen-demo-key" },
    });
    expect((sneaky.json() as { days: { channel: string }[] }).days.every((d) => d.channel !== "facebook")).toBe(true);
    await app.close();
  });
});

describe("a third tenant is configuration only", () => {
  it("adds a tenant with a config entry and a fixtures folder, no code change", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "e76-"));
    await cp(path.join(FIXTURES_DIR, "northwind"), path.join(dir, "acme"), { recursive: true });
    const configPath = path.join(dir, "tenants.yaml");
    await writeFile(
      configPath,
      `tenants:
  - slug: acme
    name: Acme
    api_key_hash: ${"a".repeat(64)}
    timezone: America/New_York
    currency: USD
    sources:
      orders: { column_aliases: {} }
      refunds: { column_aliases: {} }
      ad_spend: { column_aliases: { cost_usd: spend } }
      email_events: { column_aliases: {} }
`,
    );
    const [acme] = await loadTenantsConfig(configPath);
    const res = await ingestTenant(acme, { fixturesDir: dir });
    expect(res.every((r) => r.status === "done")).toBe(true);
    const id = await tenantId("acme");
    expect(Number(await scalar(id, "SELECT count(*) FROM stg_orders WHERE tenant_id = $1"))).toBe(680);
    // Its own timezone moves orders across midnight: the day boundary is config, not code.
    expect(Number(await scalar(id, "SELECT count(*) FROM stg_orders WHERE tenant_id = $1 AND order_date <> (order_ts AT TIME ZONE 'UTC')::date"))).toBeGreaterThan(0);
    expect(await readFile(configPath, "utf8")).toContain("acme");
  });
});
