import { readFile } from "node:fs/promises";
import { withAdmin, withTenant, type Query } from "../db/client.js";
import { FIXTURES_DIR, syncTenant, type TenantConfig } from "../config/tenants.js";
import { SPECS, sha256 } from "./sources.js";
import { discover, parse, type Delivery } from "./read.js";
import { rebuildMarts, recordAdjustments } from "../model/mart.js";

// The ingestion run for one tenant: every delivered file goes
//   register (sha256) -> check header -> raw (idempotent) -> staging (upsert) -> done
// and when all files are through, the marts are rebuilt and late data for published days
// becomes adjustments. Every step is safe to repeat.

export interface IngestOptions {
  fixturesDir?: string;
  source?: string;
  /** Only files from these manifest batches (simulates the passage of time). */
  batches?: { from: number; to: number };
  /** Test hook: throw after this many raw rows of the first file that gets that far. */
  failAtRow?: number;
  log?: (line: string) => void;
}

export interface FileResult {
  name: string;
  status: "done" | "skipped" | "quarantined";
  rowsTotal: number;
  rowsNew: number;
  note?: string;
}

const RAW_CHUNK = 100;

export class SimulatedCrash extends Error {}

export async function ingestTenant(t: TenantConfig, opts: IngestOptions = {}): Promise<FileResult[]> {
  const log = opts.log ?? (() => {});
  const tenantId = await withAdmin((q) => syncTenant(q, t));
  let deliveries = await discover(opts.fixturesDir ?? FIXTURES_DIR, t.slug);
  if (opts.source) deliveries = deliveries.filter((d) => d.source === opts.source);
  if (opts.batches) {
    const { from, to } = opts.batches;
    deliveries = deliveries.filter((d) => d.batch !== null && d.batch >= from && d.batch <= to);
  }

  const results: FileResult[] = [];
  for (const d of deliveries) {
    const r = await ingestFile(t, tenantId, d, opts);
    results.push(r);
    log(`${r.status.padEnd(11)} ${r.name}  rows=${r.rowsTotal} new=${r.rowsNew}${r.note ? `  (${r.note})` : ""}`);
  }

  await withTenant(tenantId, async (q) => {
    await rebuildMarts(q, tenantId);
    const adj = await recordAdjustments(q, tenantId);
    if (adj > 0) log(`late data for already-reported days: ${adj} adjustment row(s) recorded`);
  });
  return results;
}

async function ingestFile(t: TenantConfig, tenantId: number, d: Delivery, opts: IngestOptions): Promise<FileResult> {
  const spec = SPECS[d.source];
  const content = await readFile(d.file, "utf8");
  const hash = sha256(content);

  // 1. Register the file in its own transaction, so a crash later leaves a visible
  //    'processing' row behind. Same bytes already done or quarantined = nothing to do.
  const file = await withTenant(tenantId, async (q) => {
    const [existing] = await q<{ id: number; status: string }>(
      "SELECT id, status FROM ingest_files WHERE tenant_id = $1 AND sha256 = $2",
      [tenantId, hash],
    );
    if (existing) return existing;
    const [created] = await q<{ id: number; status: string }>(
      `INSERT INTO ingest_files (tenant_id, source, file_name, batch, sha256)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, status`,
      [tenantId, d.source, d.name, d.batch, hash],
    );
    return created;
  });
  if (file.status === "done" || file.status === "quarantined") {
    return { name: d.name, status: "skipped", rowsTotal: 0, rowsNew: 0, note: `already ${file.status}` };
  }

  const parsed = parse(content, spec.format);

  // 2. Schema drift: map known aliases, then the header must be exactly the canonical set.
  //    Anything else quarantines the whole file. We do not guess what a new column means.
  const aliases = t.sources[d.source]?.column_aliases ?? {};
  const mapped = parsed.header.map((h) => aliases[h] ?? h);
  const expected = [...spec.columns];
  const missing = expected.filter((c) => !mapped.includes(c) && !(d.source === "email_events" && c === "campaign_id"));
  const unknown = mapped.filter((c) => !expected.includes(c));
  if (missing.length || unknown.length) {
    const reason = `header mismatch: missing [${missing.join(", ")}], unexpected [${unknown.join(", ")}]`;
    await withTenant(tenantId, async (q) => {
      await q(
        `INSERT INTO quarantine (tenant_id, file_id, reason, header_received, header_expected)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (tenant_id, file_id) DO NOTHING`,
        [tenantId, file.id, reason, parsed.header, expected],
      );
      await q("UPDATE ingest_files SET status = 'quarantined', finished_at = now() WHERE tenant_id = $1 AND id = $2", [tenantId, file.id]);
    });
    console.error(`ALERT quarantined ${d.name}: ${reason}`);
    return { name: d.name, status: "quarantined", rowsTotal: parsed.rows.length, rowsNew: 0, note: reason };
  }

  const rows = parsed.rows.map((r) => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(r)) out[aliases[k] ?? k] = v;
    return out;
  });
  rows.forEach((r, i) => {
    const check = spec.row.safeParse(r);
    if (!check.success) throw new Error(`${d.name} row ${i + 2}: ${check.error.issues[0].message}`);
  });

  // 3. Raw, in committed chunks. The unique (tenant, source, record_hash) makes every
  //    insert a no-op the second time: reruns and overlapping exports cannot double-count.
  let rowsNew = 0;
  for (let start = 0; start < rows.length; start += RAW_CHUNK) {
    const chunk = rows.slice(start, start + RAW_CHUNK);
    const crashAt = opts.failAtRow !== undefined && opts.failAtRow >= start && opts.failAtRow < start + chunk.length
      ? opts.failAtRow - start
      : undefined;
    const toWrite = crashAt === undefined ? chunk : chunk.slice(0, crashAt);
    rowsNew += await withTenant(tenantId, (q) => insertRaw(q, tenantId, d.source, file.id, toWrite, start));
    if (crashAt !== undefined) {
      throw new SimulatedCrash(`simulated crash in ${d.name} after ${opts.failAtRow} rows`);
    }
  }

  // 4. Staging upsert by natural key + mark the file done, in one transaction.
  await withTenant(tenantId, async (q) => {
    for (const r of rows) await spec.upsert(q, tenantId, t.timezone, file.id, r);
    await q(
      `UPDATE ingest_files SET status = 'done', rows_total = $3, rows_new = $4, finished_at = now()
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, file.id, rows.length, rowsNew],
    );
  });
  const note = rowsNew < rows.length ? `${rows.length - rowsNew} row(s) already loaded` : undefined;
  return { name: d.name, status: "done", rowsTotal: rows.length, rowsNew, note };
}

async function insertRaw(
  q: Query,
  tenantId: number,
  source: string,
  fileId: number,
  rows: Record<string, string>[],
  offset: number,
): Promise<number> {
  let inserted = 0;
  for (const [i, r] of rows.entries()) {
    const payload = JSON.stringify(Object.fromEntries(Object.entries(r).sort(([a], [b]) => a.localeCompare(b))));
    const res = await q(
      `INSERT INTO raw_records (tenant_id, source, record_hash, file_id, row_number, payload)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (tenant_id, source, record_hash) DO NOTHING
       RETURNING id`,
      [tenantId, source, sha256(payload), fileId, offset + i + 1, payload],
    );
    inserted += res.length;
  }
  return inserted;
}
