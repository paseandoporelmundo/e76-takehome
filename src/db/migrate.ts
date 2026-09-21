import { closePool } from "./client.js";
import { migrate } from "./migrator.js";

// Entry point for `npm run db:migrate`.
migrate()
  .then((applied) => {
    if (applied.length === 0) console.log("migrations: nothing to apply");
    else console.log(`migrations applied: ${applied.join(", ")}`);
    return closePool();
  })
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
