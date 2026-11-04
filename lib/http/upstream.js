// Server-Component helper for reading data that now lives in another service. The browser's
// httpOnly edemand_token cookie is forwarded as a Bearer token, X-Request-Id / traceparent are
// propagated from the incoming request, and cache: 'no-store' keeps Next from caching per-user data.
import { cookies, headers } from "next/headers";

export async function fetchUpstream(url) {
  const token = cookies().get("edemand_token")?.value;
  const h = { accept: "application/json" };
  if (token) h.authorization = `Bearer ${token}`;
  const incoming = headers();
  const rid = incoming.get("x-request-id");
  const tp = incoming.get("traceparent");
  if (rid) h["x-request-id"] = rid;
  if (tp) h.traceparent = tp;

  try {
    const res = await fetch(url, { headers: h, cache: "no-store", signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { ok: false, status: res.status, data: null };
    return { ok: true, status: res.status, data: await res.json() };
  } catch {
    return { ok: false, status: 503, data: null };
  }
}
