export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { getSession } from "#lib/http/session.js";
import { upstreamContext } from "#lib/http/upstream.js";
import { listNotifications } from "#lib/clients/notifications.js";
import { ActionButton } from "../_ui/client.js";

// Notifications live in their own service now. This page reads them over HTTP through
// lib/clients/notifications.js: the browser's httpOnly edemand_token cookie is forwarded as a Bearer
// token, X-Request-Id / traceparent are propagated, and cache: 'no-store' stops Next from caching one
// user's inbox for another.
export default async function NotificationsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const res = await listNotifications(upstreamContext());
  const ok = res.ok;
  const list = ok ? res.data : [];

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