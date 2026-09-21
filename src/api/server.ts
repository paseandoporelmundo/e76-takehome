import "dotenv/config";
import Fastify from "fastify";

// `npm run api`: GET /v1/revenue?from&to&view=reported|current
// The tenant is derived from the x-api-key header only. Routes land in a later block.

const app = Fastify({ logger: true });

app.get("/health", async () => ({ ok: true }));

const port = Number(process.env.PORT ?? 3000);
app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
