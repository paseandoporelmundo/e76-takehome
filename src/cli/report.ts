import { Command } from "commander";
import { closePool, withAdmin, withTenant } from "../db/client.js";
import { findTenant, syncTenant } from "../config/tenants.js";
import { publishDays } from "../model/mart.js";

// npm run report -- --tenant <slug> --through YYYY-MM-DD
// Publishes (freezes) every day up to --through that is not published yet.

const program = new Command()
  .name("report")
  .description("Publish days: snapshot the revenue mart into reported_days, which is append-only")
  .requiredOption("--tenant <slug>", "tenant slug from config/tenants.yaml")
  .requiredOption("--through <date>", "publish every unpublished day up to this date (YYYY-MM-DD)")
  .parse(process.argv);

const opts = program.opts<{ tenant: string; through: string }>();

async function main() {
  const tenant = await findTenant(opts.tenant);
  const tenantId = await withAdmin((q) => syncTenant(q, tenant));
  const days = await withTenant(tenantId, (q) => publishDays(q, tenantId, opts.through));
  console.log(days.length ? `published ${days.length} day(s): ${days[0]} .. ${days[days.length - 1]}` : "nothing new to publish");
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => closePool());
