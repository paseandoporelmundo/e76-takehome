import { Command } from "commander";
import { closePool } from "../db/client.js";
import { findTenant } from "../config/tenants.js";
import { ingestTenant, SimulatedCrash } from "../ingest/pipeline.js";

// npm run ingest -- --tenant <slug> [--source <name>] [--batches 1-3] [--fail-at-row N]

const program = new Command()
  .name("ingest")
  .description("Load a tenant's delivered files: register -> check header -> raw -> staging -> marts")
  .requiredOption("--tenant <slug>", "tenant slug from config/tenants.yaml")
  .option("--source <name>", "only this source (orders | refunds | ad_spend | email_events)")
  .option("--batches <range>", "only these manifest batches, e.g. 1-3 (replays delivery over time)")
  .option("--fail-at-row <n>", "test hook: crash after N raw rows to simulate a run dying halfway", Number)
  .parse(process.argv);

const opts = program.opts<{ tenant: string; source?: string; batches?: string; failAtRow?: number }>();

async function main() {
  const tenant = await findTenant(opts.tenant);
  let batches: { from: number; to: number } | undefined;
  if (opts.batches) {
    const [from, to = from] = opts.batches.split("-").map(Number);
    batches = { from, to };
  }
  console.log(`ingest ${tenant.slug}${batches ? ` batches ${batches.from}-${batches.to}` : ""}`);
  await ingestTenant(tenant, { source: opts.source, batches, failAtRow: opts.failAtRow, log: (l) => console.log(`  ${l}`) });
  console.log("done");
}

main()
  .catch((err) => {
    console.error(err instanceof SimulatedCrash ? `CRASH ${err.message} (rerun the same command to resume)` : err.message);
    process.exitCode = 1;
  })
  .finally(() => closePool());
