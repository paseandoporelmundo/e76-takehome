import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import type { Query } from "../db/client.js";

// config/tenants.yaml is the one place a tenant is described. The schema below is the
// contract; anything else is rejected at startup. Nothing else in the code knows a tenant
// by name.

export const SOURCES = ["orders", "refunds", "ad_spend", "email_events"] as const;
export type Source = (typeof SOURCES)[number];

const sourceConfigSchema = z.object({
  column_aliases: z.record(z.string(), z.string()).default({}),
});

const tenantConfigSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/, "slug must be lowercase letters, digits or dashes"),
  name: z.string().min(1),
  api_key_hash: z.string().regex(/^[a-f0-9]{64}$/, "api_key_hash must be a sha256 hex digest"),
  timezone: z.string().min(1),
  currency: z.string().length(3),
  sources: z.record(z.enum(SOURCES), sourceConfigSchema),
});

const configSchema = z.object({ tenants: z.array(tenantConfigSchema).min(1) });

export type TenantConfig = z.infer<typeof tenantConfigSchema>;

export const CONFIG_PATH = process.env.E76_CONFIG ?? path.resolve(process.cwd(), "config", "tenants.yaml");
export const FIXTURES_DIR = process.env.E76_FIXTURES ?? path.resolve(process.cwd(), "fixtures");

export async function loadTenantsConfig(file = CONFIG_PATH): Promise<TenantConfig[]> {
  const parsed = configSchema.parse(parse(await readFile(file, "utf8")));
  const slugs = new Set<string>();
  for (const t of parsed.tenants) {
    if (slugs.has(t.slug)) throw new Error(`duplicate tenant slug in config: ${t.slug}`);
    slugs.add(t.slug);
    if (!isValidTimeZone(t.timezone)) throw new Error(`${t.slug}: unknown timezone ${t.timezone}`);
  }
  return parsed.tenants;
}

export async function findTenant(slug: string, file = CONFIG_PATH): Promise<TenantConfig> {
  const t = (await loadTenantsConfig(file)).find((x) => x.slug === slug);
  if (!t) throw new Error(`tenant "${slug}" is not in ${file}`);
  return t;
}

/** Upserts the tenant and its sources from config; returns the tenant id. */
export async function syncTenant(q: Query, t: TenantConfig): Promise<number> {
  const [row] = await q<{ id: number }>(
    `INSERT INTO tenants (slug, name, api_key_hash, timezone, currency)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (slug) DO UPDATE
       SET name = EXCLUDED.name, api_key_hash = EXCLUDED.api_key_hash,
           timezone = EXCLUDED.timezone, currency = EXCLUDED.currency
     RETURNING id`,
    [t.slug, t.name, t.api_key_hash, t.timezone, t.currency],
  );
  for (const [source, cfg] of Object.entries(t.sources)) {
    await q(
      `INSERT INTO tenant_sources (tenant_id, source, column_aliases) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, source) DO UPDATE SET column_aliases = EXCLUDED.column_aliases`,
      [row.id, source, JSON.stringify(cfg.column_aliases)],
    );
  }
  return row.id;
}

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
