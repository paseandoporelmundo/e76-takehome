import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";

// config/tenants.yaml is the one place a new tenant is described.
// The schema below is the contract; anything else is rejected at startup.

export const SOURCES = ["orders", "email_events", "ad_spend"] as const;
export type Source = (typeof SOURCES)[number];

const sourceConfigSchema = z.object({
  file_pattern: z.string().min(1),
  expected_cadence: z.enum(["daily", "weekly"]),
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

const configSchema = z.object({
  tenants: z.array(tenantConfigSchema).min(1),
});

export type TenantConfig = z.infer<typeof tenantConfigSchema>;
export type SourceConfig = z.infer<typeof sourceConfigSchema>;

export const CONFIG_PATH = path.resolve(process.cwd(), "config", "tenants.yaml");

export async function loadTenantsConfig(file = CONFIG_PATH): Promise<TenantConfig[]> {
  const raw = parse(await readFile(file, "utf8"));
  const parsed = configSchema.parse(raw);
  const slugs = new Set<string>();
  for (const t of parsed.tenants) {
    if (slugs.has(t.slug)) throw new Error(`duplicate tenant slug in config: ${t.slug}`);
    slugs.add(t.slug);
  }
  return parsed.tenants;
}
