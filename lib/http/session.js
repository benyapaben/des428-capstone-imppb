// Server-Component session helper. Reads+verifies the httpOnly edemand_token cookie (a Keycloak
// access token) so layouts and pages can identify the browser user without going through a route
// handler. Resolves to { sub, role, email, kcSub } or null. Used only by the UI (never by the
// API/test path), so its dependence on next/headers cookies() is safe. Async since Step 3: verifying
// against Keycloak's JWKS is async — call it as `await getSession()` from an async Server Component.
import { cookies } from "next/headers";
import { verifyToken } from "./auth.js";

export async function getSession() {
  const token = cookies().get("edemand_token")?.value;
  if (!token) return null;
  try {
    return await verifyToken(token);
  } catch {
    return null;
  }
}
