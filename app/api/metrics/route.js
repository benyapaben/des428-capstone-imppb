export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { handle } from "#lib/http/handle.js";
import { registry } from "#lib/metrics.js";

// Step 6 (E6): the Prometheus scrape target (Prometheus format, not JSON). No user token: only
// Prometheus calls it, from inside the compose network — gateway/nginx.conf answers 404 from outside.
export const GET = handle(async () =>
  new Response(await registry.metrics(), {
    status: 200,
    headers: { "content-type": registry.contentType, "cache-control": "no-store" },
  })
);
