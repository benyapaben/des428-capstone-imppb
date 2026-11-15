// Server-Component helpers for reading data that now lives in another service. upstreamContext() takes
// what the call needs from the incoming request: the browser's httpOnly edemand_token cookie (forwarded
// as a Bearer token), X-Request-Id and traceparent. The calls themselves live in lib/clients/
// (payments.getWallet, notifications.listNotifications), which is what the Pact consumer tests exercise.
// cache: 'no-store' (in getUpstreamJson) keeps Next from caching per-user data.
import { cookies, headers } from "next/headers";
import { getUpstreamJson } from "../clients/upstream.js";

export function upstreamContext() {
  const incoming = headers();
  return {
    token: cookies().get("edemand_token")?.value,
    requestId: incoming.get("x-request-id") ?? undefined,
    traceparent: incoming.get("traceparent") ?? undefined,
  };
}

// For a one-off read that has no client function yet.
export function fetchUpstream(url) {
  return getUpstreamJson(url, upstreamContext());
}
