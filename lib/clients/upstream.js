// GET a JSON resource from an extracted service as the logged-in user. The pieces of the incoming
// request it needs (the user's token, X-Request-Id, traceparent) are passed in, so this has no
// Next.js dependency: Server Components pass upstreamContext() (lib/http/upstream.js), and the Pact
// consumer tests (test/contracts/) call the same code against a Pact mock server.
//
// Never throws: { ok, status, data }. An unreachable service or a timeout is { ok: false, status: 503 },
// so a page can show "temporarily unavailable" instead of failing.
import { withTraceHeaders } from "../http/trace.js";

export async function getUpstreamJson(url, { token, requestId, traceparent, timeoutMs = 5000 } = {}) {
  const h = { accept: "application/json" };
  if (token) h.authorization = `Bearer ${token}`;
  if (requestId) h["x-request-id"] = requestId;
  withTraceHeaders(h, { fallback: traceparent });   // E3: the page's current span

  try {
    const res = await fetch(url, { headers: h, cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, status: res.status, data: null };
    return { ok: true, status: res.status, data: await res.json() };
  } catch {
    return { ok: false, status: 503, data: null };
  }
}
