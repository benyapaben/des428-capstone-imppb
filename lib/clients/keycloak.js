// HTTP client for Keycloak, the identity provider (Step 3). The ONLY place the monolith talks to it:
//   - passwordGrant(): login. Direct Access Grant with the public `web` client, so the three existing
//     login forms keep working; Keycloak checks the password and returns the access token.
//   - createUser(): registration. The confidential `edemand-backend` service account creates the
//     Keycloak user with the attributes the token mappers read (app_id, role).
// Keycloak down / slow / answering 5xx is a 503 for our caller, never a 401.
import { config } from "../config.js";
import { ConflictError, UnauthorizedError, ServiceUnavailableError } from "../errors.js";

const realmUrl = () => `${config.keycloakUrl}/realms/${config.keycloakRealm}`;
const TIMEOUT_MS = 5000;

async function call(url, init) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
  } catch (err) {
    throw new ServiceUnavailableError(`identity provider unreachable: ${err.message}`);
  }
}

function form(params) {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  };
}

/** Logs a user in. Resolves to the raw access token; 401 on bad credentials. */
export async function passwordGrant(email, password) {
  const res = await call(`${realmUrl()}/protocol/openid-connect/token`, form({
    grant_type: "password",
    client_id: config.keycloakClientId,
    username: email,
    password,
    scope: "openid",
  }));
  if (res.status === 400 || res.status === 401) {
    // invalid_grant: unknown user, wrong password, disabled account. Same message for all of them.
    throw new UnauthorizedError("invalid email or password");
  }
  if (!res.ok) throw new ServiceUnavailableError(`identity provider answered ${res.status}`);
  const body = await res.json();
  return body.access_token;
}

async function serviceAccountToken() {
  const res = await call(`${realmUrl()}/protocol/openid-connect/token`, form({
    grant_type: "client_credentials",
    client_id: config.keycloakAdminClientId,
    client_secret: config.keycloakAdminSecret,
  }));
  if (!res.ok) throw new ServiceUnavailableError(`identity provider refused the service account (${res.status})`);
  return (await res.json()).access_token;
}

/**
 * Creates the Keycloak user for a freshly registered account. The username is the email, so an email
 * can exist only once across all roles: a duplicate is a 409.
 */
export async function createUser({ email, password, role, appId, name }) {
  const token = await serviceAccountToken();
  const [firstName, ...rest] = String(name || email).trim().split(/\s+/);
  const res = await call(`${config.keycloakUrl}/admin/realms/${config.keycloakRealm}/users`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      username: email,
      email,
      emailVerified: true,
      enabled: true,
      firstName,
      lastName: rest.join(" ") || firstName,
      attributes: { app_id: [String(appId)], role: [role] },
      credentials: [{ type: "password", value: password, temporary: false }],
      requiredActions: [],
    }),
  });
  if (res.status === 409) throw new ConflictError(`email ${email} is already registered`);
  if (res.status !== 201) throw new ServiceUnavailableError(`identity provider answered ${res.status} creating a user`);
}
