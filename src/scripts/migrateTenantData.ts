import "dotenv/config";
import mongoose from "mongoose";
import type { IndexSpecification } from "mongodb";
import { TENANT_MODELS, PLATFORM_MODELS } from "../tenant/models.js";
import { LEGACY_TENANT_FILTER, INVALID_TENANT_FILTER, assertTenantMigrationReady } from "../tenant/migration.js";
import { PLATFORM_TENANT_ID } from "../tenant/context.js";

/** Dry-run by default. Stop all bot instances and take an external backup before --apply. */
async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is required");
  await mongoose.connect(uri, {
    dbName: process.env.DATABASE_NAME || "danka-telegram",
    autoIndex: false,
    autoCreate: false,
    serverSelectionTimeoutMS: 5_000,
  });
  const db = mongoose.connection.db!;
  const present = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name));
  const tenantNames = new Set<string>(TENANT_MODELS.map(model => model.modelName));
  const allModels = [...TENANT_MODELS, ...PLATFORM_MODELS];
  console.log(apply ? "Applying tenant migration (no document deletion)." : "DRY RUN: no database changes. Use --apply only with the bot stopped and a verified backup.");

  // Check all unique constraints before the first write. Old missing/null tenantId becomes platform.
  for (const model of allModels) {
    if (!present.has(model.collection.name)) continue;
    const collection = db.collection(model.collection.name);
    const tenantOwned = tenantNames.has(model.modelName);
    if (tenantOwned && await collection.countDocuments(INVALID_TENANT_FILTER, { limit: 1 })) {
      throw new Error(`${model.collection.name}: invalid tenant identity found. Resolve manually before migration.`);
    }
    for (const [keys, options] of model.schema.indexes()) {
      if (!options.unique) continue;
      const groupKey: Record<string, unknown> = {};
      for (const field of Object.keys(keys)) groupKey[field] = field === "tenantId" && tenantOwned ? { $ifNull: ["$tenantId", PLATFORM_TENANT_ID] } : `$${field}`;
      const duplicates = await collection.aggregate([
        ...(options.partialFilterExpression ? [{ $match: options.partialFilterExpression }] : []),
        { $group: { _id: groupKey, count: { $sum: 1 } } },
        { $match: { count: { $gt: 1 } } },
        { $limit: 1 },
      ]).toArray();
      if (duplicates.length) throw new Error(`${model.collection.name}: duplicate values prevent the tenant unique index. Resolve manually; migration will not merge/delete records.`);
    }
  }
  for (const model of allModels) {
    const name = model.collection.name;
    const collection = db.collection(name);
    const exists = present.has(name);
    const tenantOwned = tenantNames.has(model.modelName);
    const legacy = exists && tenantOwned ? await collection.countDocuments(LEGACY_TENANT_FILTER) : 0;
    const indexes = exists ? await collection.indexes() : [];
    const obsolete = tenantOwned ? indexes.filter(index => index.unique && index.name !== "_id_" && !Object.hasOwn(index.key, "tenantId")) : [];
    console.log(`${name}: legacy=${legacy}, indexes=${model.schema.indexes().length}, replaceGlobalUnique=${obsolete.length}`);
    if (!apply) continue;
    if (!exists) await db.createCollection(name);
    if (legacy) await collection.updateMany(LEGACY_TENANT_FILTER, { $set: { tenantId: PLATFORM_TENANT_ID } });
    // Install scoped constraints before removing old global uniqueness. TTL indexes stay unchanged.
    for (const [keys, options] of model.schema.indexes()) {
      const { background: _background, unique, ...safeOptions } = options;
      await collection.createIndex(keys as IndexSpecification, {
        ...safeOptions,
        ...(unique === undefined ? {} : { unique: Array.isArray(unique) ? true : unique }),
      });
    }
    for (const index of obsolete) await collection.dropIndex(index.name!);
  }
  if (apply) {
    await assertTenantMigrationReady();
    console.log("Tenant migration complete and verified. Existing data belongs to platform.");
  }
}

main().catch((error: unknown) => {
  // Driver connection errors may contain credential-bearing URIs; never echo them.
  console.error(error instanceof Error && !error.name.startsWith("Mongo") ? error.message : "Tenant migration failed; inspect database connectivity and index constraints privately.");
  process.exitCode = 1;
}).finally(async () => { await mongoose.disconnect(); });
