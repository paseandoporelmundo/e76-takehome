import { Command } from "commander";

// `npm run check-arrivals -- [--tenant <slug>]`: lists expected deliveries with no file.
// Exit 1 when something is missing so a scheduler can alert on it.

const program = new Command()
  .name("check-arrivals")
  .description("Report expected source files that never arrived")
  .option("--tenant <slug>", "limit to one tenant")
  .parse(process.argv);

console.error(`check-arrivals: not implemented yet ${JSON.stringify(program.opts())}`);
process.exit(2);
