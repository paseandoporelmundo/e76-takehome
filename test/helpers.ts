import { pool, withTenant, type Query } from "../src/db/client.js";
import { migrate } from "../src/db/migrator.js";
import { findTenant, type TenantConfig } from "../src/config/tenants.js";

// DB-backed tests share one database (DATABASE_URL) and start from an empty schema.

export async function resetDb(): Promise<void> {
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate();
}

export const tenant = (slug: string): Promise<TenantConfig> => findTenant(slug);

export async function tenantId(slug: string): Promise<number> {
  const { rows } = await pool.query<{ id: number }>("SELECT id FROM tenants WHERE slug = $1", [slug]);
  return rows[0].id;
}

export async function scalar<T = number>(id: number, sql: string, params: unknown[] = []): Promise<T> {
  return withTenant(id, async (q: Query) => {
    const [row] = await q(sql, [id, ...params]);
    return Object.values(row)[0] as T;
  });
}
