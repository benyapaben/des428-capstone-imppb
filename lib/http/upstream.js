// Server-Component helper for reading data that now lives in another service. The browser's
// httpOnly edemand_token cookie is forwarded as a Bearer token, X-Request-Id / traceparent are
// propagated from the incoming request, and cache: 'no-store' keeps Next from caching per-user data.
// traceparent is this request's current span (E3, lib/http/trace.js), so the service's spans join
// the page's trace; without an SDK the incoming traceparent is forwarded unchanged.
import { cookies, headers } from "next/headers";
import { withTraceHeaders } from "./trace.js";

export async function fetchUpstream(url) {
  const token = cookies().get("edemand_token")?.value;
  const h = { accept: "application/json" };
  if (token) h.authorization = `Bearer ${token}`;
  const incoming = headers();
  const rid = incoming.get("x-request-id");
  if (rid) h["x-request-id"] = rid;
  withTraceHeaders(h, { fallback: incoming.get("traceparent") });

  try {
    const res = await fetch(url, { headers: h, cache: "no-store", signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { ok: false, status: res.status, data: null };
    return { ok: true, status: res.status, data: await res.json() };
  } catch {
    return { ok: false, status: 503, data: null };
  }
}
