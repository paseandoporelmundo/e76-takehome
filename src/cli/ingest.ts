import { Command } from "commander";

// Entry point for `npm run ingest -- --tenant <slug> [--source <name>] [--fail-at-row N]`.
// The pipeline itself lands in src/ingest/ in the next blocks.

const program = new Command()
  .name("ingest")
  .description("Ingest a tenant's source files: discover -> validate header -> raw -> staging -> mart")
  .requiredOption("--tenant <slug>", "tenant slug from config/tenants.yaml")
  .option("--source <name>", "only this source (orders | email_events | ad_spend)")
  .option("--fail-at-row <n>", "test hook: crash after N raw rows to simulate a dead run", (v) => Number(v))
  .parse(process.argv);

const opts = program.opts<{ tenant: string; source?: string; failAtRow?: number }>();
console.error(`ingest: not implemented yet (tenant=${opts.tenant})`);
process.exit(2);
