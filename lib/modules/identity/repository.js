// Identity context owns customers, providers, admins. SQL only.
import { getDb } from "../../db/index.js";

// ---- customers ----
export function findCustomerByEmail(email) {
  return getDb().prepare("SELECT * FROM customers WHERE email = ?").get(email);
}
export function findCustomerById(id) {
  return getDb().prepare("SELECT * FROM customers WHERE id = ?").get(id);
}
export function insertCustomer({ email, passwordHash, name, phone }) {
  return getDb()
    .prepare("INSERT INTO customers (email, password_hash, name, phone) VALUES (?, ?, ?, ?)")
    .run(email, passwordHash, name, phone ?? null).lastInsertRowid;
}
// Compensation only: undo a registration whose Keycloak user could not be created.
export function deleteCustomer(id) {
  return getDb().prepare("DELETE FROM customers WHERE id = ?").run(id).changes;
}

// ---- providers ----
export function findProviderByEmail(email) {
  return getDb().prepare("SELECT * FROM providers WHERE email = ?").get(email);
}
export function findProviderById(id) {
  return getDb().prepare("SELECT * FROM providers WHERE id = ?").get(id);
}
export function insertProvider({ email, passwordHash, name, phone }) {
  return getDb()
    .prepare("INSERT INTO providers (email, password_hash, name, phone) VALUES (?, ?, ?, ?)")
    .run(email, passwordHash, name, phone ?? null).lastInsertRowid;
}
// Compensation only: undo a registration whose Keycloak user could not be created. The
// provider_profiles row goes with it (ON DELETE CASCADE).
export function deleteProvider(id) {
  return getDb().prepare("DELETE FROM providers WHERE id = ?").run(id).changes;
}
export function insertProviderProfile(providerId, companyName) {
  getDb()
    .prepare("INSERT INTO provider_profiles (provider_id, company_name) VALUES (?, ?)")
    .run(providerId, companyName ?? null);
}

// ---- admins ----
export function findAdminByEmail(email) {
  return getDb().prepare("SELECT * FROM admins WHERE email = ?").get(email);
}
export function findAdminById(id) {
  return getDb().prepare("SELECT * FROM admins WHERE id = ?").get(id);
}
