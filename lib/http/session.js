// Server-Component session helper. Reads+verifies the httpOnly edemand_token cookie so layouts and
// pages can identify the browser user without going through a route handler. Returns the JWT
// payload { sub, role, email } or null. Used only by the UI (never by the API/test path), so its
// dependence on next/headers cookies() is safe.
import { cookies } from "next/headers";
import jwt from "jsonwebtoken";
import { config } from "../config.js";

export function getSession() {
  const token = cookies().get("edemand_token")?.value;
  if (!token) return null;
  try {
    return jwt.verify(token, config.jwtSecret);
  } catch {
    return null;
  }
}
