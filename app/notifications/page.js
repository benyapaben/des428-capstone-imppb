export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { getSession } from "#lib/http/session.js";
import { config } from "#lib/config.js";
import { ActionButton } from "../_ui/client.js";

// Notifications live in their own service now. This page reads them over HTTP: the browser's
// httpOnly edemand_token cookie is forwarded as a Bearer token, X-Request-Id / traceparent are
// propagated, and cache: 'no-store' stops Next from caching one user's inbox for another.
async function loadNotifications() {
  const token = cookies().get("edemand_token")?.value;
  const incoming = headers();
  const h = { accept: "application/json" };
  if (token) h.authorization = `Bearer ${token}`;
  if (incoming.get("x-request-id")) h["x-request-id"] = incoming.get("x-request-id");
  if (incoming.get("traceparent")) h.traceparent = incoming.get("traceparent");

  try {
    const res = await fetch(`${config.notificationsUrl}/api/notifications`, {
      headers: h,
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { ok: false, list: [] };
    return { ok: true, list: await res.json() };
  } catch {
    return { ok: false, list: [] };
  }
}

export default async function NotificationsPage() {
  const session = getSession();
  if (!session) redirect("/login");
  const { ok, list } = await loadNotifications();

  return (
    <div>
      <h1>Notifications</h1>
      {!ok ? <div className="notice warn">Notifications are temporarily unavailable.</div> : null}
      {ok && list.length === 0 ? <p className="muted">Nothing here yet.</p> : null}
      {list.length > 0 ? (
        <ul className="plain">
          {list.map((n) => (
            <li key={n.id} style={{ opacity: n.read_at ? 0.55 : 1 }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <div>
                  <strong>{n.title}</strong> <span className="muted small">· {n.type}</span>
                  <div className="small">{n.body}</div>
                </div>
                {!n.read_at ? <ActionButton url={`/api/notifications/${n.id}/read`} label="Mark read" className="secondary" /> : <span className="muted small">read</span>}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}