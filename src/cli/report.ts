import { Command } from "commander";

// `npm run report -- --tenant <slug> --date YYYY-MM-DD`: publishes an immutable snapshot
// of that day's mart rows into reported_days.

const program = new Command()
  .name("report")
  .description("Publish a day's numbers as an immutable snapshot")
  .requiredOption("--tenant <slug>")
  .requiredOption("--date <yyyy-mm-dd>")
  .parse(process.argv);

console.error(`report: not implemented yet ${JSON.stringify(program.opts())}`);
process.exit(2);
