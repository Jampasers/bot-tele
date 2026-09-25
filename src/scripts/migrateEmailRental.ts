import "dotenv/config";
import mongoose from "mongoose";
import type { IndexSpecification } from "mongodb";
import { EMAIL_RENTAL_MODELS } from "../tenant/models.js";
import { INVALID_TENANT_FILTER, LEGACY_TENANT_FILTER } from "../tenant/migration.js";

type ExistingIndex = {
  key: Record<string, unknown>;
  name?: string;
  unique?: boolean;
  sparse?: boolean;
  expireAfterSeconds?: number;
  partialFilterExpression?: unknown;
};

function stableStringify(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
    .join(",")}}`;
}

function indexMatches(
  index: ExistingIndex,
  keys: Record<string, unknown>,
  options: {
    unique?: unknown;
    sparse?: boolean;
    expireAfterSeconds?: number;
    partialFilterExpression?: unknown;
  },
): boolean {
  return stableStringify(index.key) === stableStringify(keys)
    && Boolean(index.unique) === Boolean(options.unique)
    && Boolean(index.sparse) === Boolean(options.sparse)
    && index.expireAfterSeconds === options.expireAfterSeconds
    && stableStringify(index.partialFilterExpression) === stableStringify(options.partialFilterExpression);
}

function makeIndexName(
  keys: Record<string, unknown>,
  options: {
    name?: string;
    unique?: unknown;
    sparse?: boolean;
    expireAfterSeconds?: number;
    partialFilterExpression?: unknown;
  },
  usedNames: Set<string>,
): string {
  const requestedName = typeof options.name === "string" && options.name.trim() ? options.name.trim() : undefined;
  const keyName = Object.entries(keys)
    .map(([field, direction]) => `${field}_${String(direction)}`)
    .join("_")
    .replace(/[^A-Za-z0-9_.-]/g, "_");
  const qualifiers = [
    options.unique ? "uniq" : "",
    options.partialFilterExpression ? "partial" : "",
    options.sparse ? "sparse" : "",
    options.expireAfterSeconds !== undefined ? `ttl_${options.expireAfterSeconds}` : "",
  ].filter(Boolean);

  const base = requestedName ?? (qualifiers.length ? `${keyName}__${qualifiers.join("_")}` : keyName);
  let candidate = base;
  let suffix = 2;
  while (usedNames.has(candidate)) candidate = `${base}__${suffix++}`;
  return candidate;
}

function formatMigrationError(error: unknown): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return raw.replace(/mongodb(\+srv)?:\/\/[^@\s]+@/gi, "mongodb$1://***@");
}

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
      const currentIndexes = await collection.indexes();
      if (currentIndexes.some((index) => indexMatches(index as ExistingIndex, keys, options))) continue;

      const usedNames = new Set(currentIndexes.map((index) => index.name).filter((indexName): indexName is string => Boolean(indexName)));
      const { background: _background, name: declaredName, unique, ...safeOptions } = options;
      const indexName = makeIndexName(keys, { ...options, name: declaredName }, usedNames);
      await collection.createIndex(keys as IndexSpecification, {
        ...safeOptions,
        ...(unique === undefined ? {} : { unique: Array.isArray(unique) ? true : unique }),
        name: indexName,
      });
      console.log(`${name}: created index ${indexName}`);
    }

    // Retire unscoped unique indexes only after tenant-scoped indexes are ready.
    for (const index of obsoleteGlobalUnique) await collection.dropIndex(index.name!);
  }

  if (apply) {
    for (const model of EMAIL_RENTAL_MODELS) {
      const indexes = await db.collection(model.collection.name).indexes();
      for (const [keys, options] of model.schema.indexes()) {
        if (!indexes.some((index) => indexMatches(index as ExistingIndex, keys, options))) {
          throw new Error(`${model.collection.name}: index verification failed after apply.`);
        }
      }
    }
    console.log("Email Rental indexes installed and verified. Configure providers/services, then set EMAIL_RENTAL_ENABLED=true.");
  }
}

main().catch((error: unknown) => {
  console.error(`Email Rental migration failed: ${formatMigrationError(error)}`);
  process.exitCode = 1;
}).finally(async () => { await mongoose.disconnect(); });
