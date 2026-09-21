import { Command } from "commander";

// `npm run reconcile -- --tenant <slug>`: compares mart_daily_revenue with the client's
// finance_summary.csv and prints the deltas per day and channel.

const program = new Command()
  .name("reconcile")
  .description("Compare the mart against the client's finance export")
  .requiredOption("--tenant <slug>")
  .parse(process.argv);

console.error(`reconcile: not implemented yet ${JSON.stringify(program.opts())}`);
process.exit(2);
