import { Command } from "commander";
import { closePool, withAdmin, withTenant } from "../db/client.js";
import { FIXTURES_DIR, loadTenantsConfig, syncTenant } from "../config/tenants.js";
import { readManifest } from "../ingest/read.js";

// npm run check-arrivals [-- --tenant <slug>]
// Compares what the manifest says should have arrived with what the file registry holds.
// Missing or quarantined batches are listed; exit code 1 if anything is missing or unusable,
// so a scheduler or CI job can alert on it.

const program = new Command()
  .name("check-arrivals")
  .option("--tenant <slug>", "only this tenant")
  .option("--through-batch <n>", "only expect batches up to this one", Number)
  .parse(process.argv);

const opts = program.opts<{ tenant?: string; throughBatch?: number }>();

async function main() {
  const manifest = await readManifest(FIXTURES_DIR);
  const tenants = (await loadTenantsConfig()).filter((t) => !opts.tenant || t.slug === opts.tenant);
  let problems = 0;

  for (const t of tenants) {
    const tenantId = await withAdmin((q) => syncTenant(q, t));
    const files = await withTenant(tenantId, (q) =>
      q<{ source: string; batch: number | null; status: string }>(
        "SELECT source, batch, status FROM ingest_files WHERE tenant_id = $1",
        [tenantId],
      ),
    );
    const expected = manifest.filter((m) => m.tenant === t.slug && (!opts.throughBatch || m.batch <= opts.throughBatch));
    for (const m of expected) {
      const got = files.filter((f) => f.source === m.source && f.batch === m.batch);
      const where = `${t.slug} ${m.source} batch ${m.batch} (${m.covers_from}..${m.covers_to})`;
      if (got.length === 0) {
        console.log(`MISSING      ${where}`);
        problems++;
      } else if (got.every((f) => f.status === "quarantined")) {
        console.log(`QUARANTINED  ${where}: arrived but not loaded, see the quarantine table`);
        problems++;
      } else if (got.some((f) => f.status === "processing")) {
        console.log(`INCOMPLETE   ${where}: a run died on it; rerun ingest to resume`);
        problems++;
      }
    }
  }
  console.log(problems ? `\n${problems} batch(es) need attention` : "all expected batches arrived and loaded");
  if (problems) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => closePool());
