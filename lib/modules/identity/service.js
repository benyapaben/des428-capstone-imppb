// Identity business logic: registration, login, and the /me projection for each role.
//
// Step 3: Keycloak owns credentials and issues the tokens. Login is a Direct Access Grant against
// Keycloak (lib/clients/keycloak.js); the monolith no longer checks passwords or signs JWTs.
// Registration still creates the monolith row (its id becomes the token's app_id) and THEN creates
// the Keycloak user. The DB write is synchronous and committed first; if Keycloak refuses (409) or is
// unreachable (503) the row is deleted again — a compensation, like placeBooking's call to Payments.
// password_hash is still filled for the legacy NOT NULL column but is never read any more.
// A provider register is one transaction that also creates the provider_profiles row, so a provider
// can never exist without its profile. (The wallet belongs to Payments, which creates it on the
// provider's first credit.)
import bcrypt from "bcryptjs";
import { config } from "../../config.js";
import { getDb } from "../../db/index.js";
import { verifyToken } from "../../http/auth.js";
import * as keycloak from "../../clients/keycloak.js";
import * as repository from "./repository.js";
import * as providersRepository from "../providers/repository.js";
import { ConflictError, UnauthorizedError, NotFoundError } from "../../errors.js";

// Keycloak authenticates the person; the endpoint they used decides which role they may log in as.
async function loginAs(role, { email, password }) {
  const token = await keycloak.passwordGrant(email, password);
  const auth = await verifyToken(token);
  if (auth.role !== role) throw new UnauthorizedError("invalid email or password");
  return { token, auth };
}

// Runs after the monolith row is committed. On any failure, undo the row and rethrow.
async function createKeycloakUserOrUndo({ email, password, name }, role, appId, undo) {
  try {
    await keycloak.createUser({ email, password, name, role, appId });
  } catch (err) {
    undo(appId);
    throw err;
  }
}

function publicCustomer(row) {
  return { id: row.id, email: row.email, name: row.name, phone: row.phone, created_at: row.created_at };
}
function publicProvider(row) {
  return { id: row.id, email: row.email, name: row.name, phone: row.phone, created_at: row.created_at };
}

export async function registerCustomer({ email, password, name, phone }) {
  if (repository.findCustomerByEmail(email)) {
    throw new ConflictError(`email ${email} is already registered`);
  }
  const passwordHash = bcrypt.hashSync(password, config.bcryptRounds);
  const id = Number(repository.insertCustomer({ email, passwordHash, name, phone }));
  await createKeycloakUserOrUndo({ email, password, name }, "customer", id, repository.deleteCustomer);
  return publicCustomer(repository.findCustomerById(id));
}

export async function loginCustomer(credentials) {
  const { token, auth } = await loginAs("customer", credentials);
  const customer = repository.findCustomerById(auth.sub);
  if (!customer) throw new UnauthorizedError("invalid email or password");
  return { token, customer: publicCustomer(customer) };
}

export async function registerProvider({ email, password, name, phone, company_name }) {
  if (repository.findProviderByEmail(email)) {
    throw new ConflictError(`email ${email} is already registered`);
  }
  const passwordHash = bcrypt.hashSync(password, config.bcryptRounds);
  const create = getDb().transaction(() => {
    const id = repository.insertProvider({ email, passwordHash, name, phone });
    repository.insertProviderProfile(id, company_name);
    return id;
  });
  const id = Number(create());
  await createKeycloakUserOrUndo({ email, password, name }, "provider", id, repository.deleteProvider);
  return publicProvider(repository.findProviderById(id));
}

export async function loginProvider(credentials) {
  const { token, auth } = await loginAs("provider", credentials);
  const profile = providersRepository.findProfile(auth.sub);
  return { token, is_approved: profile ? Boolean(profile.is_approved) : false };
}

export async function loginAdmin(credentials) {
  const { token } = await loginAs("admin", credentials);
  return { token };
}

// The /me projection, role-appropriate.
export function getMe(auth) {
  if (auth.role === "customer") {
    const c = repository.findCustomerById(auth.sub);
    if (!c) throw new NotFoundError("customer not found");
    return { role: "customer", ...publicCustomer(c) };
  }
  if (auth.role === "provider") {
    const p = repository.findProviderById(auth.sub);
    if (!p) throw new NotFoundError("provider not found");
    const profile = providersRepository.findProfile(auth.sub);
    return { role: "provider", ...publicProvider(p), profile: profile ?? null };
  }
  const a = repository.findAdminById(auth.sub);
  if (!a) throw new NotFoundError("admin not found");
  return { role: "admin", id: a.id, email: a.email, name: a.name };
}
