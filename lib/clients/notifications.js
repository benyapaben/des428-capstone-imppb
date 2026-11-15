// HTTP client for the notifications service: the monolith's only call to it is reading the user's
// inbox for the /notifications page. Marking one read is a browser call through the gateway.
// Covered by the Pact contract edemand -> notifications (test/contracts/notifications.pact.test.js).
import { config } from "../config.js";
import { getUpstreamJson } from "./upstream.js";

// ctx = { token, requestId, traceparent } — upstreamContext() in a Server Component.
export function listNotifications(ctx) {
  return getUpstreamJson(`${config.notificationsUrl}/api/notifications`, ctx);
}
