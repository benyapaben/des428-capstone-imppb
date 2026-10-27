export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { handle } from "#lib/http/handle.js";
import { json } from "#lib/http/respond.js";
import { getAuth } from "#lib/http/auth.js";
import * as notifications from "#lib/modules/notifications/service.js";

export const GET = handle(async (req) => {
  const auth = getAuth(req);
  return json(notifications.listForUser(auth));
});
