import { readFile } from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { closePool, withAdmin, withTenant } from "../db/client.js";
import { FIXTURES_DIR, findTenant, syncTenant } from "../config/tenants.js";
import { parse } from "../ingest/read.js";

// npm run reconcile -- --tenant <slug>
// Compares our current daily numbers with the client's finance_summary.csv, day by day.
// Exit code 1 if gross does not tie to the cent (that is a bug by the client's rule).

const program = new Command()
  .name("reconcile")
  .requiredOption("--tenant <slug>", "tenant slug from config/tenants.yaml")
  .option("--verbose", "print every day, not only the ones that differ")
  .parse(process.argv);

const opts = program.opts<{ tenant: string; verbose?: boolean }>();

const cents = (v: string | number) => Math.round(Number(v) * 100);
const usd = (c: number) => (c / 100).toFixed(2);

async function main() {
  const tenant = await findTenant(opts.tenant);
  const tenantId = await withAdmin((q) => syncTenant(q, tenant));
  const finance = parse(await readFile(path.join(FIXTURES_DIR, tenant.slug, "finance_summary.csv"), "utf8"), "csv").rows;

  const ours = await withTenant(tenantId, (q) =>
    q<{ date: string; gross: string; net: string }>(
      `SELECT to_char(date, 'YYYY-MM-DD') AS date, sum(gross) AS gross, sum(net) AS net
       FROM mart_daily_revenue WHERE tenant_id = $1 GROUP BY date`,
      [tenantId],
    ),
  );
  const byDate = new Map(ours.map((r) => [r.date, r]));
  const unmatched = await withTenant(tenantId, (q) =>
    q<{ n: number; total: string | null }>("SELECT count(*)::int AS n, sum(amount) AS total FROM unmatched_refunds WHERE tenant_id = $1", [tenantId]),
  );

  let grossMisses = 0;
  let netMisses = 0;
  console.log(`reconcile ${tenant.slug} (orders in ${tenant.currency}; finance labels its figures ${[...new Set(finance.map((f) => f.currency))].join("/")})`);
  console.log("date        gross_ours  gross_fin   diff  |  net_ours    net_fin     diff");
  for (const f of finance) {
    const o = byDate.get(f.date);
    const dg = cents(o?.gross ?? 0) - cents(f.gross_reported);
    const dn = cents(o?.net ?? 0) - cents(f.net_reported);
    if (dg !== 0) grossMisses++;
    if (dn !== 0) netMisses++;
    if (opts.verbose || dg !== 0 || dn !== 0) {
      console.log(
        `${f.date}  ${usd(cents(o?.gross ?? 0)).padStart(9)}  ${f.gross_reported.padStart(9)}  ${usd(dg).padStart(6)}  |  ` +
          `${usd(cents(o?.net ?? 0)).padStart(9)}  ${f.net_reported.padStart(9)}  ${usd(dn).padStart(7)}`,
      );
    }
  }
  console.log(`\ngross: ${finance.length - grossMisses}/${finance.length} days tie to the cent`);
  console.log(`net:   ${finance.length - netMisses}/${finance.length} days tie (finance net is not reproducible from the data, see QUESTIONS.md Q1)`);
  console.log(`unmatched refunds held aside: ${unmatched[0].n} totalling ${unmatched[0].total ?? "0.00"}`);
  if (grossMisses > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => closePool());
