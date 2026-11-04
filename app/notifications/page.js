export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { getSession } from "#lib/http/session.js";
import { config } from "#lib/config.js";
import { fetchUpstream } from "#lib/http/upstream.js";
import { ActionButton } from "../_ui/client.js";

// Notifications live in their own service now. This page reads them over HTTP, forwarding the
// session cookie as a Bearer token (fetchUpstream) with cache: 'no-store'.
export default async function NotificationsPage() {
  const session = getSession();
  if (!session) redirect("/login");
  const res = await fetchUpstream(`${config.notificationsUrl}/api/notifications`);
  const list = res.ok ? res.data : [];

  return (
    <div>
      <h1>Notifications</h1>
      {!res.ok ? <div className="notice warn">Notifications are temporarily unavailable.</div> : null}
      {res.ok && list.length === 0 ? <p className="muted">Nothing here yet.</p> : null}
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
