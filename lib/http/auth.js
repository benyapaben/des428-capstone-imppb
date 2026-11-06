// Keycloak token verification + role gates for route handlers (Step 3: the monolith no longer issues
// or accepts its own HS256 JWT). A token is a Keycloak RS256 access token, checked against the realm's
// JWKS for signature, iss, aud (edemand-api) and exp. It can arrive two ways and BOTH verify the same:
//   - Authorization: Bearer <jwt>   (API clients + the test suite)
//   - Cookie: edemand_token=<jwt>    (the browser UI, set httpOnly by the login handlers)
// The returned identity is { sub, role, email, kcSub }: `sub` is the token's app_id — the monolith DB
// id of that role's table — so every existing owner check (`order.customer_id === auth.sub`) keeps
// working; kcSub is Keycloak's own user id. ids are NOT unique across roles: compare (role, sub).
import { jwtVerify, errors as joseErrors } from "jose";
import { config } from "../config.js";
import { getKeySet, refreshAfterUnknownKey } from "./jwks.js";
import { UnauthorizedError, ForbiddenError, ServiceUnavailableError } from "../errors.js";

const ROLES = new Set(["customer", "provider", "admin"]);

function readToken(req) {
  const header = req.headers.get("authorization");
  if (header && header.startsWith("Bearer ")) {
    const token = header.slice("Bearer ".length).trim();
    if (token) return token;
  }
  // NextRequest exposes parsed cookies; a plain Request (tests) does not, so fall back to the
  // raw Cookie header.
  const cookieVal = req.cookies?.get?.("edemand_token")?.value;
  if (cookieVal) return cookieVal;
  const raw = req.headers.get("cookie");
  if (raw) {
    const m = raw.match(/(?:^|;\s*)edemand_token=([^;]+)/);
    if (m) return decodeURIComponent(m[1]);
  }
  return null;
}

async function verifyWith(token, keySet) {
  return jwtVerify(token, keySet, {
    issuer: config.keycloakIssuer,
    audience: config.jwtAudience,
    algorithms: ["RS256"],
  });
}

/**
 * Verifies a Keycloak access token and returns { sub, role, email, kcSub }.
 * Throws UnauthorizedError for any bad token, ServiceUnavailableError if Keycloak's keys can't be
 * fetched (that is our problem, not the caller's).
 */
export async function verifyToken(token) {
  let payload;
  try {
    ({ payload } = await verifyWith(token, await getKeySet()));
  } catch (err) {
    if (err instanceof ServiceUnavailableError) throw err;
    if (err instanceof joseErrors.JWKSNoMatchingKey) {
      // Unknown key id: Keycloak may have rotated its keys (e.g. it restarted). Re-fetch once.
      const fresh = await refreshAfterUnknownKey();
      if (fresh) {
        try {
          ({ payload } = await verifyWith(token, fresh));
        } catch (retryErr) {
          throw new UnauthorizedError(`invalid token: ${retryErr.message}`);
        }
      } else {
        throw new UnauthorizedError(`invalid token: ${err.message}`);
      }
    } else {
      throw new UnauthorizedError(`invalid token: ${err.message}`);
    }
  }
  if (!ROLES.has(payload.role) || !Number.isInteger(payload.app_id) || payload.app_id <= 0) {
    throw new UnauthorizedError("invalid token: missing app_id or role claim");
  }
  return { sub: payload.app_id, role: payload.role, email: payload.email, kcSub: payload.sub };
}

// Authenticates AND (optionally) authorizes in one step. `roles` may be a single role string or an
// array; omit it for "any authenticated user". Resolves to { sub, role, email, kcSub }.
export async function getAuth(req, roles) {
  const token = readToken(req);
  if (!token) throw new UnauthorizedError("missing bearer token");

  const auth = await verifyToken(token);

  if (roles) {
    const allowed = Array.isArray(roles) ? roles : [roles];
    if (!allowed.includes(auth.role)) {
      throw new ForbiddenError(`this route requires role: ${allowed.join(" or ")}`);
    }
  }
  return auth;
}

const COOKIE = "edemand_token";
const TWELVE_HOURS = 12 * 60 * 60; // = the realm's access token lifespan

// The httpOnly session cookie the browser UI carries. API clients ignore it and use Bearer; both
// verify the same Keycloak token.
export function tokenCookie(token) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TWELVE_HOURS}`;
}
export function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
