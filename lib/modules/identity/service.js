// Identity business logic: registration, login, and the /me projection for each role. Password
// hashing (bcryptjs, synchronous) and JWT issuance live here, at the service layer, not in routes.
// A provider register is one transaction that also creates the provider_profiles + provider_wallets
// rows, so a provider can never exist without its profile/wallet.
import bcrypt from "bcryptjs";
import { config } from "../../config.js";
import { getDb } from "../../db/index.js";
import { signToken } from "../../http/auth.js";
import * as repository from "./repository.js";
import * as providersRepository from "../providers/repository.js";
import { ConflictError, UnauthorizedError, NotFoundError } from "../../errors.js";

function publicCustomer(row) {
  return { id: row.id, email: row.email, name: row.name, phone: row.phone, created_at: row.created_at };
}
function publicProvider(row) {
  return { id: row.id, email: row.email, name: row.name, phone: row.phone, created_at: row.created_at };
}

export function registerCustomer({ email, password, name, phone }) {
  if (repository.findCustomerByEmail(email)) {
    throw new ConflictError(`email ${email} is already registered`);
  }
  const passwordHash = bcrypt.hashSync(password, config.bcryptRounds);
  const id = repository.insertCustomer({ email, passwordHash, name, phone });
  return publicCustomer(repository.findCustomerById(id));
}

export function loginCustomer({ email, password }) {
  const customer = repository.findCustomerByEmail(email);
  if (!customer || !bcrypt.compareSync(password, customer.password_hash)) {
    throw new UnauthorizedError("invalid email or password");
  }
  const token = signToken({ sub: customer.id, role: "customer", email: customer.email });
  return { token, customer: publicCustomer(customer) };
}

export function registerProvider({ email, password, name, phone, company_name }) {
  if (repository.findProviderByEmail(email)) {
    throw new ConflictError(`email ${email} is already registered`);
  }
  const passwordHash = bcrypt.hashSync(password, config.bcryptRounds);
  const create = getDb().transaction(() => {
    const id = repository.insertProvider({ email, passwordHash, name, phone });
    repository.insertProviderProfile(id, company_name);
    repository.insertProviderWallet(id);
    return id;
  });
  const id = create();
  return publicProvider(repository.findProviderById(id));
}

export function loginProvider({ email, password }) {
  const provider = repository.findProviderByEmail(email);
  if (!provider || !bcrypt.compareSync(password, provider.password_hash)) {
    throw new UnauthorizedError("invalid email or password");
  }
  const profile = providersRepository.findProfile(provider.id);
  const token = signToken({ sub: provider.id, role: "provider", email: provider.email });
  return { token, is_approved: profile ? Boolean(profile.is_approved) : false };
}

export function loginAdmin({ email, password }) {
  const admin = repository.findAdminByEmail(email);
  if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
    throw new UnauthorizedError("invalid email or password");
  }
  const token = signToken({ sub: admin.id, role: "admin", email: admin.email });
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
