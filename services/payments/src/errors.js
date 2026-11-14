// Same typed-error hierarchy as the monolith, so every service returns the same JSON error shape.
export class AppError extends Error {
  constructor(statusCode, message, details) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
  }
}
export class BadRequestError extends AppError {
  constructor(message = "bad request", details) { super(400, message, details); }
}
export class UnauthorizedError extends AppError {
  constructor(message = "unauthorized") { super(401, message); }
}
export class ForbiddenError extends AppError {
  constructor(message = "forbidden") { super(403, message); }
}
export class NotFoundError extends AppError {
  constructor(message = "not found") { super(404, message); }
}
export class ConflictError extends AppError {
  constructor(message = "conflict") { super(409, message); }
}
export class ServiceUnavailableError extends AppError {
  constructor(message = "service unavailable") { super(503, message); }
}
