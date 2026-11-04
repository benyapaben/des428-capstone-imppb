// Express plumbing shared by every route: request id + traceparent, JWT auth (Bearer header or the
// monolith's edemand_token cookie — the gateway forwards both), the internal-token guard, and the one
// error handler that maps AppError to { error, requestId, details? }.
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { AppError, UnauthorizedError, ForbiddenError, BadRequestError } from "./errors.js";

export function requestContext(req, res, next) {
  const incoming = req.get("x-request-id");
  req.id = incoming && incoming.trim() ? incoming.trim() : randomUUID();
  req.traceparent = req.get("traceparent") || undefined;
  res.set("X-Request-Id", req.id);
  const started = Date.now();
  res.on("finish", () => {
    logger.info(
      { requestId: req.id, traceparent: req.traceparent, method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - started },
      "request"
    );
  });
  next();
}

function readToken(req) {
  const header = req.get("authorization");
  if (header && header.startsWith("Bearer ")) {
    const token = header.slice(7).trim();
    if (token) return token;
  }
  const raw = req.get("cookie");
  if (raw) {
    const m = raw.match(/(?:^|;\s*)edemand_token=([^;]+)/);
    if (m) return decodeURIComponent(m[1]);
  }
  return null;
}

// requireAuth() = any role; requireAuth("provider") / requireAuth(["a","b"]) = role-gated.
export function requireAuth(roles) {
  const allowed = roles ? (Array.isArray(roles) ? roles : [roles]) : null;
  return (req, _res, next) => {
    const token = readToken(req);
    if (!token) return next(new UnauthorizedError("missing bearer token"));
    try {
      req.auth = jwt.verify(token, config.jwtSecret);
    } catch (err) {
      return next(new UnauthorizedError(`invalid token: ${err.message}`));
    }
    if (allowed && !allowed.includes(req.auth.role)) {
      return next(new ForbiddenError(`this route requires role: ${allowed.join(" or ")}`));
    }
    next();
  };
}

export function requireInternal(req, _res, next) {
  if (req.get("x-internal-token") !== config.internalToken) {
    return next(new UnauthorizedError("invalid internal token"));
  }
  next();
}

export function parse(schema, data) {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new BadRequestError(
      "validation failed",
      result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }))
    );
  }
  return result.data;
}

export function parseId(value, label = "id") {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new BadRequestError(`invalid ${label}`);
  return n;
}

// Wrap an async handler so a rejected promise reaches the error handler (Express 4).
export const route = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function notFound(req, _res, next) {
  next(new AppError(404, `no route for ${req.method} ${req.path}`));
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "invalid JSON body", requestId: req.id });
  }
  const status = err instanceof AppError ? err.statusCode : 500;
  const body = { error: err.message || "internal server error", requestId: req.id };
  if (err instanceof AppError && err.details !== undefined) body.details = err.details;
  if (status >= 500) {
    logger.error({ requestId: req.id, err: err.stack || String(err) }, "unhandled error");
    body.error = "internal server error";
    delete body.details;
  } else {
    logger.warn({ requestId: req.id, status, err: err.message }, "request error");
  }
  res.status(status).json(body);
}
