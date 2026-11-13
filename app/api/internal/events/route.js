export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { z } from "zod";
import { handle } from "#lib/http/handle.js";
import { json } from "#lib/http/respond.js";
import { parse, readJson } from "#lib/http/validate.js";
import { config } from "#lib/config.js";
import { UnauthorizedError } from "#lib/errors.js";
import { receiveEvent } from "#lib/outbox/inbound.js";

// HTTP entry point for events INTO the monolith, left over from the Step 2 transport. Since Step 4
// no relay calls it: live events arrive through the booking.events RabbitMQ consumer, which runs the
// same receiveEvent(). Kept because tests drive receiveEvent() through it. Authenticated by the
// shared internal token, never by a user JWT, and blocked at the nginx gateway so a browser can never
// reach it. Always 200 for a valid event — including a duplicate.
const schema = z.object({
  source: z.string().min(1),
  id: z.coerce.number().int().positive(),
  type: z.string().min(1),
  aggregate_type: z.string().optional(),
  aggregate_id: z.coerce.number().int().optional(),
  payload: z.record(z.any()),
  occurred_at: z.string().optional(),
});

export const POST = handle(async (req) => {
  if (req.headers.get("x-internal-token") !== config.internalToken) {
    throw new UnauthorizedError("invalid internal token");
  }
  const envelope = parse(schema, await readJson(req));
  return json({ received: true, ...receiveEvent(envelope) });
});
