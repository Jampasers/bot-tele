import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import mongoose from "mongoose";
import { defaultVpsCatalog } from "../vps/catalog.js";
import { catalogPlans } from "../vps/catalogPlans.js";
import { VpsPlan } from "../models/VpsPlan.js";

export async function replacementVpsPlans() {
  return Promise.all(catalogPlans(defaultVpsCatalog()).map(async plan => {
    const document = new VpsPlan({ _id: plan.id, tenantId: "platform", name: plan.name, serviceType: plan.serviceType,
      sizeSlug: plan.sizeSlug, regions: plan.regions, osPrices: plan.osPrices, priceMatrix: [], enabled: true, catalogManaged: true });
    await document.validate();
    return document.toObject();
  }));
}

/** Explicit operator reset only. No imports/startup path execute this reset. */
async function main(): Promise<void> {
  await import("dotenv/config");
  const apply = process.argv.includes("--apply");
  const expected = process.argv[process.argv.indexOf("--expect") + 1];
  await mongoose.connect(process.env.MONGODB_URI ?? "", {
    dbName: process.env.DATABASE_NAME || "danka-telegram", autoIndex: false, autoCreate: false,
    serverSelectionTimeoutMS: 7000, socketTimeoutMS: 15000,
  });
  const db = mongoose.connection.db!;
  const plans = db.collection<{ _id: string; tenantId: string }>("vpsplans");
  const catalogs = db.collection<{ _id: string }>("vpscatalogs");
  const before = await plans.find({ tenantId: "platform" }).sort({ _id: 1 }).toArray();
  const beforeCatalog = await catalogs.findOne({ _id: "platform" });
  const fingerprint = createHash("sha256").update(JSON.stringify({ before, beforeCatalog })).digest("hex");
  const replacements = await replacementVpsPlans();
  if (!apply) {
    console.log(JSON.stringify({ mode: "dry-run", database: db.databaseName, oldPlans: before.length,
      replacements: replacements.length, specsPerService: 7, regions: 16, linuxOs: 14, windowsOs: 4, fingerprint }));
    return;
  }
  if (!process.argv.includes("--expect") || expected !== fingerprint) throw new Error("VPS configuration changed; repeat the dry run.");
  const backupId = `vps-catalog-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
  // Save only catalog/plan configuration. Orders, wallets, credentials and provider resources are never selected for mutation.
  await db.collection("vpscatalogresetbackups").insertOne({ backupId, createdAt: new Date(), fingerprint, plans: before, catalog: beforeCatalog });
  const hello = await db.admin().command({ hello: 1 });
  const session = await mongoose.startSession();
  const replace = async (transactional: boolean) => {
    const options = transactional ? { session } : {};
    await catalogs.replaceOne({ _id: "platform" }, defaultVpsCatalog(), { ...options, upsert: true });
    for (const replacement of replacements) await plans.replaceOne({ _id: replacement._id }, replacement, { ...options, upsert: true });
    const currentIds = new Set(replacements.map(plan => plan._id));
    const oldIds = before.map(plan => plan._id).filter(id => !currentIds.has(id));
    if (oldIds.length) await plans.deleteMany({ tenantId: "platform", _id: { $in: oldIds } }, options);
  };
  try {
    if (hello.setName || hello.msg === "isdbgrid") await session.withTransaction(() => replace(true));
    else await replace(false);
  } finally { await session.endSession(); }
  const after = await plans.find({ tenantId: "platform" }).toArray();
  if (after.length !== replacements.length || replacements.some(plan => !after.some(row => row._id === plan._id))) {
    throw new Error("VPS catalog verification failed; retain backup for recovery.");
  }
  console.log(JSON.stringify({ mode: "applied", database: db.databaseName, removedOldPlans: before.filter(old => !replacements.some(plan => plan._id === old._id)).length,
    plans: after.length, pricesConfigured: 0, backupCollection: "vpscatalogresetbackups", backupId, verified: true }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error("VPS reset did not finish. Inspect catalog/backup counts privately; connection details suppressed."); process.exitCode = 1; })
    .finally(() => mongoose.disconnect());
}
