// The Express app (no listen) — server.js boots it, tests mount it on an ephemeral port.
import express from "express";
import { z } from "zod";
import { query } from "./db.js";
import * as service from "./service.js";
import {
  requestContext, requireAuth, requireInternal, parse, parseId, route, notFound, errorHandler,
} from "./http.js";

const eventSchema = z.object({
  source: z.string().min(1),
  id: z.coerce.number().int().positive(),
  type: z.string().min(1),
  aggregate_type: z.string().optional(),
  aggregate_id: z.coerce.number().int().optional(),
  payload: z.record(z.any()),
  occurred_at: z.string().optional(),
});

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use(requestContext);
  app.use(express.json({ limit: "100kb" }));

  // Liveness never touches the database; readiness must reach Postgres.
  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  app.get("/ready", route(async (_req, res) => {
    try {
      await query("SELECT 1");
      res.json({ status: "ok" });
    } catch {
      res.status(503).json({ status: "error", error: "database unavailable" });
    }
  }));

  // ---- public API (reached through the nginx gateway at the monolith's old URLs) ----
  app.get("/api/notifications", requireAuth(), route(async (req, res) => {
    res.json(await service.listForUser(req.auth));
  }));

  app.post("/api/notifications/:id/read", requireAuth(), route(async (req, res) => {
    res.json(await service.markRead(parseId(req.params.id, "notification id"), req.auth));
  }));

  // ---- internal: event delivery from the monolith / payments outbox relays ----
  app.post("/internal/events", requireInternal, route(async (req, res) => {
    const envelope = parse(eventSchema, req.body);
    res.json({ received: true, ...(await service.handleEvent(envelope)) });
  }));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
