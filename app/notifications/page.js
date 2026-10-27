export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { getSession } from "#lib/http/session.js";
import * as notifications from "#lib/modules/notifications/service.js";
import { ActionButton } from "../_ui/client.js";

export default function NotificationsPage() {
  const session = getSession();
  if (!session) redirect("/login");
  const list = notifications.listForUser({ sub: session.sub, role: session.role });

  return (
    <div>
      <h1>Notifications</h1>
      {list.length === 0 ? <p className="muted">Nothing here yet.</p> : (
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
      )}
    </div>
  );
}
