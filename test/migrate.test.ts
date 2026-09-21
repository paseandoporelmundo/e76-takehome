import { afterAll, describe, expect, it } from "vitest";
import { closePool, pool } from "../src/db/client.js";
import { migrate } from "../src/db/migrator.js";

// Needs DATABASE_URL. Proves the schema applies cleanly and that re-running is a no-op.
describe("db:migrate", () => {
  afterAll(() => closePool());

  it("applies all migrations and is idempotent", async () => {
    await migrate();
    const second = await migrate();
    expect(second).toEqual([]);

    const { rows } = await pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1",
    );
    const names = rows.map((r) => r.table_name);
    for (const t of ["tenants", "ingest_files", "raw_records", "stg_orders", "mart_daily_revenue", "reported_days", "adjustments"]) {
      expect(names).toContain(t);
    }
  });

  it("every tenant-scoped table has tenant_id NOT NULL", async () => {
    const { rows } = await pool.query<{ table_name: string; is_nullable: string }>(`
      SELECT t.table_name, c.is_nullable
      FROM information_schema.tables t
      LEFT JOIN information_schema.columns c
        ON c.table_name = t.table_name AND c.table_schema = t.table_schema AND c.column_name = 'tenant_id'
      WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
        AND t.table_name NOT IN ('tenants', 'schema_migrations')
    `);
    for (const r of rows) {
      expect(r.is_nullable, `${r.table_name}.tenant_id`).toBe("NO");
    }
  });
});
