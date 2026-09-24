import mongoose from "mongoose";
import { EMAIL_RENTAL_MODELS, TENANT_MODELS, PLATFORM_MODELS } from "./models.js";

export const LEGACY_TENANT_FILTER = { $or: [{ tenantId: { $exists: false } }, { tenantId: null }] };
export const INVALID_TENANT_FILTER = { tenantId: { $exists: true, $ne: null, $not: /^[A-Za-z0-9_-]{1,100}$/ } };

/** Read-only startup guard: rental mode must never silently hide legacy owner data. */
export async function assertTenantMigrationReady(): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) throw new Error("Database is not connected");
  const present = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name));
  const issues: string[] = [];
  const tenantNames = new Set<string>(TENANT_MODELS.map(model => model.modelName));
  const emailModelNames = new Set<string>(EMAIL_RENTAL_MODELS.map(model => model.modelName));
  const requiredModels = [...TENANT_MODELS.filter(model => !emailModelNames.has(model.modelName) || process.env.EMAIL_RENTAL_ENABLED === "true"), ...PLATFORM_MODELS];
  for (const model of requiredModels) {
    const name = model.collection.name;
    if (!present.has(name)) {
      issues.push(`${name}: tenant indexes have not been installed`);
      continue;
    }
    const collection = db.collection(name);
    const tenantOwned = tenantNames.has(model.modelName);
    if (tenantOwned && await collection.countDocuments(LEGACY_TENANT_FILTER, { limit: 1 })) issues.push(`${name}: legacy documents need a tenantId`);
    if (tenantOwned && await collection.countDocuments(INVALID_TENANT_FILTER, { limit: 1 })) issues.push(`${name}: invalid tenant identity found`);
    const indexes = await collection.indexes();
    if (tenantOwned && indexes.some(index => index.unique && index.name !== "_id_" && !Object.hasOwn(index.key, "tenantId"))) {
      issues.push(`${name}: a legacy global unique index remains`);
    }
    for (const [key, options] of model.schema.indexes()) {
      if (!indexes.some(index => JSON.stringify(index.key) === JSON.stringify(key)
        && Boolean(index.unique) === Boolean(options.unique)
        && Boolean(index.sparse) === Boolean(options.sparse)
        && index.expireAfterSeconds === options.expireAfterSeconds
        && JSON.stringify(index.partialFilterExpression) === JSON.stringify(options.partialFilterExpression))) {
        issues.push(`${name}: required tenant index missing or incompatible`);
      }
    }
  }
  if (issues.length) {
    const emailCollections = new Set(EMAIL_RENTAL_MODELS.map(model => model.collection.name));
    const emailIssues = issues.filter(issue => emailCollections.has(issue.split(":", 1)[0] ?? ""));
    if (emailIssues.length) throw new Error(`Email Rental migration required. Stop the application, back up MongoDB, run npm run migrate:email-rental as a dry-run, then apply it explicitly. ${emailIssues.join("; ")}`);
    throw new Error(`Tenant migration required. Stop the application, back up MongoDB, inspect npm run migrate:tenants, then apply it explicitly. ${issues.join("; ")}`);
  }
}
