// The Express app (no listen) — server.js boots it, tests mount it on an ephemeral port.
// Public routes keep the monolith's URLs (the nginx gateway sends them here); /intents and
// /internal/events are service-to-service only (internal token, never routed by the gateway).
import express from "express";
import { z } from "zod";
import { getPool } from "./db.js";
import { config } from "./config.js";
import * as service from "./service.js";
import { UnauthorizedError, BadRequestError } from "./errors.js";
import { requestContext, requireAuth, requireInternal, parse, route, notFound, errorHandler } from "./http.js";

const id = () => z.coerce.number().int().positive();

const intentSchema = z.object({
  order_id: id(),
  customer_id: id(),
  provider_id: id(),
  amount_cents: z.coerce.number().int().min(0),
});

const webhookSchema = z.object({
  gateway_event_id: z.string().min(1),
  type: z.string().min(1),
  gateway_ref: z.string().min(1),
});

const simulateSchema = z.object({ order_id: id() });

const eventSchema = z.object({
  source: z.string().min(1),
  id: id(),
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

  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  app.get("/ready", route(async (_req, res) => {
    try {
      await getPool().query("SELECT 1");
      res.json({ status: "ok" });
    } catch {
      res.status(503).json({ status: "error", error: "database unavailable" });
    }
  }));

  // ---- internal: called synchronously by Booking's placeBooking ----
  app.post("/intents", requireInternal, route(async (req, res) => {
    const input = parse(intentSchema, req.body);
    const key = req.get("idempotency-key");
    if (!key || key.trim() !== String(input.order_id)) {
      throw new BadRequestError("Idempotency-Key header must equal order_id");
    }
    const { created, intent } = await service.createIntent(input);
    res.status(created ? 201 : 200).json(intent);
  }));

  // ---- internal: event delivery from the monolith's outbox relay ----
  app.post("/internal/events", requireInternal, route(async (req, res) => {
    const envelope = parse(eventSchema, req.body);
    res.json({ received: true, ...(await service.handleEvent(envelope)) });
  }));

  // ---- public (via gateway) ----
  // Server-to-server callback from the gateway: shared-secret header, not JWT. Always 200 on a valid
  // event (including a replay) so the gateway stops retrying.
  app.post("/api/payments/webhook", route(async (req, res) => {
    if (req.get("x-webhook-secret") !== config.webhookSecret) {
      throw new UnauthorizedError("invalid webhook secret");
    }
    const input = parse(webhookSchema, req.body);
    res.json({ received: true, ...(await service.handleWebhook(input)) });
  }));

  app.post("/api/payments/simulate", requireAuth("customer"), route(async (req, res) => {
    const { order_id } = parse(simulateSchema, req.body);
    res.json(await service.simulateSucceeded(order_id, req.auth.sub));
  }));

  app.get("/api/provider/wallet", requireAuth("provider"), route(async (req, res) => {
    res.json(await service.getWallet(req.auth.sub));
  }));

  app.get("/api/customer/transactions", requireAuth("customer"), route(async (req, res) => {
    res.json(await service.listCustomerTransactions(req.auth.sub));
  }));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
