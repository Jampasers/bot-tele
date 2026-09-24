import "dotenv/config";
import mongoose from "mongoose";
import type { IndexSpecification } from "mongodb";
import { EMAIL_RENTAL_MODELS } from "../tenant/models.js";
import { INVALID_TENANT_FILTER, LEGACY_TENANT_FILTER } from "../tenant/migration.js";

/** Read-only by default. New rental collections never inherit legacy IMAP secrets. */
async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is required");
  await mongoose.connect(uri, {
    dbName: process.env.DATABASE_NAME || "danka-telegram", autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 5000,
  });
  const db = mongoose.connection.db!;
  const present = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((item) => item.name));
  console.log(apply
    ? "Applying Email Rental indexes. No legacy IMAP credentials are copied."
    : "DRY RUN: no database writes. Back up MongoDB and stop all bot processes before --apply.");

  // Check data/unique conflicts before the first write, so a partial index
  // rollout cannot silently weaken the email+service uniqueness rule.
  for (const model of EMAIL_RENTAL_MODELS) {
    const name = model.collection.name;
    if (!present.has(name)) continue;
    const collection = db.collection(name);
    const legacy = await collection.countDocuments(LEGACY_TENANT_FILTER, { limit: 1 });
    const invalid = await collection.countDocuments(INVALID_TENANT_FILTER, { limit: 1 });
    if (legacy || invalid) throw new Error(`${name}: unexpected legacy/invalid tenant rows; inspect and resolve manually before migration.`);
    for (const [keys, options] of model.schema.indexes()) {
      if (!options.unique) continue;
      const groupId = Object.fromEntries(Object.keys(keys).map((field) => [field, "$" + field]));
      const conflicts = await collection.aggregate([
        ...(options.partialFilterExpression ? [{ $match: options.partialFilterExpression }] : []),
        { $group: { _id: groupId, count: { $sum: 1 } } }, { $match: { count: { $gt: 1 } } }, { $limit: 1 },
      ]).toArray();
      if (conflicts.length) throw new Error(`${name}: duplicate values prevent a required unique index; resolve manually before migration.`);
    }
  }

  for (const model of EMAIL_RENTAL_MODELS) {
    const name = model.collection.name;
    const exists = present.has(name);
    const collection = db.collection(name);
    const existingIndexes = exists ? await collection.indexes() : [];
    const obsoleteGlobalUnique = existingIndexes.filter((index) => index.unique && index.name !== "_id_" && !Object.hasOwn(index.key, "tenantId"));
    console.log(`${name}: ${exists ? "exists" : "will create"}; ${model.schema.indexes().length} required indexes; ${obsoleteGlobalUnique.length} obsolete global unique indexes`);
    if (!apply) continue;
    if (!exists) await db.createCollection(name);
    for (const [keys, options] of model.schema.indexes()) {
      const { background: _background, name: _name, unique, ...safeOptions } = options;
      await collection.createIndex(keys as IndexSpecification, {
        ...safeOptions, ...(unique === undefined ? {} : { unique: Array.isArray(unique) ? true : unique }),
      });
    }
    // Retire unscoped unique indexes only after tenant-scoped indexes are ready.
    for (const index of obsoleteGlobalUnique) await collection.dropIndex(index.name!);
  }

  if (apply) {
    for (const model of EMAIL_RENTAL_MODELS) {
      const indexes = await db.collection(model.collection.name).indexes();
      for (const [keys, options] of model.schema.indexes()) {
        if (!indexes.some((index) => JSON.stringify(index.key) === JSON.stringify(keys) && Boolean(index.unique) === Boolean(options.unique))) {
          throw new Error(`${model.collection.name}: index verification failed after apply.`);
        }
      }
    }
    console.log("Email Rental indexes installed and verified. Configure providers/services, then set EMAIL_RENTAL_ENABLED=true.");
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error && !error.name.startsWith("Mongo") ? error.message : "Email Rental migration failed; inspect MongoDB connectivity privately.");
  process.exitCode = 1;
}).finally(async () => { await mongoose.disconnect(); });
