import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z } from "zod";
import { closePool, pool, withTenant } from "../db/client.js";

// Read-only API. The tenant comes from the x-api-key header and nothing else: there is no
// tenant parameter to tamper with. Every query below runs inside withTenant() for that id.

const dateRange = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  view: z.enum(["reported", "current"]).default("reported"),
});

async function tenantFromKey(req: FastifyRequest): Promise<number | null> {
  const key = req.headers["x-api-key"];
  if (typeof key !== "string" || key.length === 0) return null;
  const hash = createHash("sha256").update(key).digest("hex");
  const { rows } = await pool.query<{ id: number }>("SELECT id FROM tenants WHERE api_key_hash = $1", [hash]);
  return rows[0]?.id ?? null;
}

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: false });

  app.addHook("preHandler", async (req, reply) => {
    if (req.url === "/health") return;
    const tenantId = await tenantFromKey(req);
    if (tenantId === null) return reply.code(401).send({ error: "missing or unknown x-api-key" });
    (req as FastifyRequest & { tenantId: number }).tenantId = tenantId;
  });

  app.get("/health", async () => ({ ok: true }));

  /**
   * GET /v1/revenue?from=YYYY-MM-DD&to=YYYY-MM-DD&view=reported|current
   * reported (default): what was published, frozen, plus the adjustments discovered since,
   *   listed separately. Unpublished days are not returned.
   * current: today's best numbers, published or not.
   */
  app.get("/v1/revenue", async (req, reply) => {
    const parsed = dateRange.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: "from and to are required, as YYYY-MM-DD" });
    const { from, to, view } = parsed.data;
    const tenantId = (req as FastifyRequest & { tenantId: number }).tenantId;

    return withTenant(tenantId, async (q) => {
      if (view === "current") {
        const days = await q(
          `SELECT to_char(date, 'YYYY-MM-DD') AS date, channel, orders, gross, refunds, net
           FROM mart_daily_revenue WHERE tenant_id = $1 AND date BETWEEN $2 AND $3 ORDER BY date, channel`,
          [tenantId, from, to],
        );
        return { view, days };
      }
      const days = await q(
        `SELECT to_char(date, 'YYYY-MM-DD') AS date, reported_at, snapshot AS channels
         FROM reported_days WHERE tenant_id = $1 AND date BETWEEN $2 AND $3 ORDER BY date`,
        [tenantId, from, to],
      );
      const adjustments = await q(
        `SELECT to_char(affected_date, 'YYYY-MM-DD') AS affected_date, channel, discovered_at,
                delta_orders, delta_gross, delta_refunds, delta_net, reason
         FROM adjustments WHERE tenant_id = $1 AND affected_date BETWEEN $2 AND $3
         ORDER BY discovered_at, affected_date, channel`,
        [tenantId, from, to],
      );
      return { view, days, adjustments };
    });
  });

  /** Marketing side: ad spend by platform and email events by type, per day. */
  app.get("/v1/marketing", async (req, reply) => {
    const parsed = dateRange.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: "from and to are required, as YYYY-MM-DD" });
    const { from, to } = parsed.data;
    const tenantId = (req as FastifyRequest & { tenantId: number }).tenantId;
    return withTenant(tenantId, async (q) => ({
      spend: await q(
        `SELECT to_char(date, 'YYYY-MM-DD') AS date, platform, spend FROM mart_daily_marketing
         WHERE tenant_id = $1 AND date BETWEEN $2 AND $3 ORDER BY date, platform`,
        [tenantId, from, to],
      ),
      email: await q(
        `SELECT to_char(date, 'YYYY-MM-DD') AS date, event_type, events FROM mart_daily_email
         WHERE tenant_id = $1 AND date BETWEEN $2 AND $3 ORDER BY date, event_type`,
        [tenantId, from, to],
      ),
    }));
  });

  return app;
}

// `npm run api`
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = buildServer();
  const port = Number(process.env.PORT ?? 3000);
  app
    .listen({ port, host: "127.0.0.1" })
    .then(() => console.log(`api listening on http://127.0.0.1:${port}  (send x-api-key)`))
    .catch(async (err) => {
      console.error(err.message);
      await closePool();
      process.exit(1);
    });
}
