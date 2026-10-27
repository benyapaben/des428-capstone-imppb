export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { handle } from "#lib/http/handle.js";
import { json } from "#lib/http/respond.js";
import { getAuth } from "#lib/http/auth.js";
import { parseId } from "#lib/http/validate.js";
import * as notifications from "#lib/modules/notifications/service.js";

export const POST = handle(async (req, { params }) => {
  const auth = getAuth(req);
  return json(notifications.markRead(parseId(params.id, "notification id"), auth));
});
