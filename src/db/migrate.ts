import { closePool, pool } from "./client.js";
import { migrate } from "./migrator.js";

// `npm run db:migrate` applies pending migrations. `npm run db:reset` drops everything first
// (local development and tests only).
async function main() {
  if (process.argv.includes("--reset")) {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    console.log("schema dropped");
  }
  const applied = await migrate();
  console.log(applied.length ? `migrations applied: ${applied.join(", ")}` : "migrations: nothing to apply");
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => closePool());
