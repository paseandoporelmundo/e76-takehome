import "dotenv/config";
import pg from "pg";

// One pool for the whole process. DATABASE_URL comes from .env (native Postgres)
// or from the docker compose default documented in .env.example.
const { Pool } = pg;

// numeric(14,2) comes back as a string by default so no precision is lost.
// We keep it that way and convert explicitly where money is summed.

export const pool = new Pool({
  connectionString: requireDatabaseUrl(),
});

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env and adjust it.");
  }
  return url;
}

export type Row = Record<string, unknown>;

/** A query function bound to one connection, inside one transaction. */
export type Query = <T extends Row = Row>(sql: string, params?: unknown[]) => Promise<T[]>;

/**
 * The only way to touch tenant data. Opens a transaction, pins `app.tenant_id` on the
 * connection (so Row-Level Security policies can read it) and hands back a query
 * function. Callers still write `WHERE tenant_id = $1`; this helper makes sure the
 * value they pass is the one the transaction was opened for.
 */
export async function withTenant<T>(
  tenantId: number,
  fn: (q: Query, tenantId: number) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [String(tenantId)]);
    const q: Query = async (sql, params = []) => (await client.query(sql, params)).rows;
    const result = await fn(q, tenantId);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Tenant-agnostic access, only for tenants/tenant_sources maintenance and migrations. */
export async function withAdmin<T>(fn: (q: Query) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const q: Query = async (sql, params = []) => (await client.query(sql, params)).rows;
    const result = await fn(q);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
