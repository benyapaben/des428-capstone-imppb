// JWT verification + role gates for route handlers. Tokens carry { sub, role, email } with
// role ∈ {customer, provider, admin}. The token can arrive two ways and BOTH verify the same JWT:
//   - Authorization: Bearer <jwt>   (API clients + the test suite)
//   - Cookie: edemand_token=<jwt>    (the browser UI, set httpOnly by the login handlers)
import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { UnauthorizedError, ForbiddenError } from "../errors.js";

export function signToken(payload) {
  return jwt.sign(payload, config.jwtSecret, { expiresIn: config.jwtExpiresIn });
}

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

// Authenticates AND (optionally) authorizes in one step. `roles` may be a single role string or an
// array; omit it for "any authenticated user". Returns the JWT payload { sub, role, email }.
export function getAuth(req, roles) {
  const token = readToken(req);
  if (!token) throw new UnauthorizedError("missing bearer token");

  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret);
  } catch (err) {
    throw new UnauthorizedError(`invalid token: ${err.message}`);
  }

  if (roles) {
    const allowed = Array.isArray(roles) ? roles : [roles];
    if (!allowed.includes(payload.role)) {
      throw new ForbiddenError(`this route requires role: ${allowed.join(" or ")}`);
    }
  }
  return payload;
}

const COOKIE = "edemand_token";
const TWELVE_HOURS = 12 * 60 * 60;

// The httpOnly session cookie the browser UI carries. API clients ignore it and use Bearer; both
// verify the same JWT.
export function tokenCookie(token) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TWELVE_HOURS}`;
}
export function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
