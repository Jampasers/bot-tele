import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import mongoose, { Schema } from "mongoose";
import { runWithTenant, platformContext } from "./context.js";
import { tenantPlugin } from "./tenantPlugin.js";
import { assertTenantMigrationReady } from "./migration.js";
import { User } from "../models/User.js";
import { BotConfig } from "../models/BotConfig.js";
import { SmsConfig } from "../models/SmsConfig.js";

const uri = process.env.TEST_MONGODB_URI;
const execute = promisify(execFile);

test("tenant isolation against disposable MongoDB", { skip: !uri }, async t => {
  assert.match(uri!, /^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\//, "Only a loopback test MongoDB is allowed");
  const databaseName = `tenant_isolation_test_${randomUUID().replaceAll("-", "")}`;
  await mongoose.connect(uri!, { dbName: databaseName, autoIndex: false, autoCreate: false });
  const db = mongoose.connection.db!;
  const tenantA = { tenantId: "tenant_a" };
  const tenantB = { tenantId: "tenant_b" };
  const schema = new Schema({ label: String, amount: Number, optionalReference: { type: String, unique: true, sparse: true } }, { autoCreate: false });
  schema.plugin(tenantPlugin);
  const Probe = mongoose.model("TenantIsolationProbe", schema);

  try {
    await t.test("migration dry-run does not change legacy records or indexes; apply is repeatable", async () => {
      await db.collection("users").insertOne({ telegramId: "legacy-owner", firstName: "Legacy", balance: 1 });
      await db.collection("users").createIndex({ telegramId: 1 }, { unique: true });
      await db.collection("botconfigs").insertOne({ isMaintenance: false });
      const beforeCollections = (await db.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name).sort();
      const beforeIndexes = await db.collection("users").indexes();
      const env = { ...process.env, MONGODB_URI: uri!, DATABASE_NAME: databaseName };
      const dry = await execute(process.execPath, ["--import", "tsx", "src/scripts/migrateTenantData.ts"], { env });
      assert.match(dry.stdout, /DRY RUN/);
      assert.equal((await db.collection("users").findOne({ telegramId: "legacy-owner" }))?.tenantId, undefined);
      assert.deepEqual(await db.collection("users").indexes(), beforeIndexes);
      assert.deepEqual((await db.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name).sort(), beforeCollections);
      await assert.rejects(assertTenantMigrationReady(), /Tenant migration required/);
      await execute(process.execPath, ["--import", "tsx", "src/scripts/migrateTenantData.ts", "--apply"], { env });
      assert.equal((await db.collection("users").findOne({ telegramId: "legacy-owner" }))?.tenantId, "platform");
      assert.equal(await runWithTenant(platformContext(), () => User.countDocuments({ telegramId: "legacy-owner" })), 1);
      assert.equal(await runWithTenant(tenantA, () => User.countDocuments({ telegramId: "legacy-owner" })), 0);
      await assertTenantMigrationReady();
      await execute(process.execPath, ["--import", "tsx", "src/scripts/migrateTenantData.ts", "--apply"], { env });
      await assertTenantMigrationReady();
    });

    await Probe.createCollection();
    await Probe.createIndexes();
    await t.test("same Telegram ID can belong to separate tenants with separate balances", async () => {
      await Promise.all([
        runWithTenant(tenantA, () => User.create({ telegramId: "123456", firstName: "Buyer", balance: 100 })),
        runWithTenant(tenantB, () => User.create({ telegramId: "123456", firstName: "Buyer", balance: 900 })),
      ]);
      await runWithTenant(tenantA, () => User.updateOne({ telegramId: "123456" }, { $inc: { balance: -10 } }));
      assert.equal((await runWithTenant(tenantA, () => User.findOne({ telegramId: "123456" }).lean()))?.balance, 90);
      assert.equal((await runWithTenant(tenantB, () => User.findOne({ telegramId: "123456" }).lean()))?.balance, 900);
      await assert.rejects(runWithTenant(tenantA, () => User.create({ telegramId: "123456", firstName: "Duplicate" })), /E11000/);
    });

    await t.test("find/count/distinct/aggregate/update/delete and replacement stay scoped", async () => {
      await runWithTenant(tenantA, () => Probe.insertMany([{ label: "a1", amount: 1 }, { label: "a2", amount: 2 }]));
      await runWithTenant(tenantB, () => Probe.insertMany([{ label: "b1", amount: 10 }, { label: "b2", amount: 20 }]));
      await runWithTenant(tenantA, async () => {
        assert.deepEqual(await Probe.distinct("label"), ["a1", "a2"]);
        assert.equal(await Probe.countDocuments({}), 2);
        assert.deepEqual(await Probe.aggregate([{ $group: { _id: null, amount: { $sum: "$amount" } } }]), [{ _id: null, amount: 3 }]);
        assert.equal((await Probe.find({ $or: [{ tenantId: "tenant_b" }, { label: "b1" }] })).length, 0);
        await Probe.updateMany({}, { $inc: { amount: 10 } });
        const doc = await Probe.findOne({ label: "a1" });
        assert.ok(doc);
        doc.amount = 12;
        await doc.save();
        await Probe.replaceOne({ label: "a2" }, { label: "a2-replaced", amount: 33 });
        await Probe.findOneAndUpdate({ label: "upsert" }, { $set: { amount: 7 } }, { upsert: true, returnDocument: "after" });
        assert.equal(await Probe.countDocuments({}), 3);
      });
      assert.deepEqual(await runWithTenant(tenantB, () => Probe.distinct("amount")), [10, 20]);
      const captured = await runWithTenant(tenantA, () => Probe.findOne({ label: "a1" }));
      assert.ok(captured);
      await assert.rejects(runWithTenant(tenantB, () => captured.save()), /Cross-tenant/);
      assert.equal((await runWithTenant(tenantB, () => Probe.findByIdAndUpdate(captured._id, { $set: { amount: 999 } }))), null);
      await runWithTenant(tenantA, () => Probe.deleteMany({}));
      assert.equal(await runWithTenant(tenantA, () => Probe.countDocuments({})), 0);
      assert.equal(await runWithTenant(tenantB, () => Probe.countDocuments({})), 2);
    });

    await t.test("optional unique references and lean insertMany preserve isolation", async () => {
      await runWithTenant(tenantA, () => Probe.insertMany([{ label: "optional1" }, { label: "optional2" }], { lean: true }));
      await runWithTenant(tenantA, () => Probe.create({ label: "ref-a", optionalReference: "shared-ref" }));
      await runWithTenant(tenantB, () => Probe.create({ label: "ref-b", optionalReference: "shared-ref" }));
      await assert.rejects(runWithTenant(tenantA, () => Probe.create({ optionalReference: "shared-ref" })), /E11000/);
      await assert.rejects(runWithTenant(tenantA, () => Probe.insertMany([{ tenantId: "tenant_b", label: "foreign" }], { lean: true })), /Cross-tenant/);
      const raw = await db.collection(Probe.collection.name).findOne({ label: "optional1" });
      assert.equal(raw?.tenantId, "tenant_a");
    });

    await t.test("concurrent config initialization creates one isolated singleton per tenant", async () => {
      await Promise.all([tenantA, tenantB].flatMap(context => Array.from({ length: 12 }, () => runWithTenant(context, async () => {
        const [botConfig, smsConfig] = await Promise.all([BotConfig.getOrCreate(), SmsConfig.getOrCreate()]);
        assert.equal(botConfig.tenantId, context.tenantId);
        assert.equal(botConfig.imapPass, "");
        assert.equal(smsConfig.enabled, false);
      }))));
      for (const context of [tenantA, tenantB]) {
        assert.equal(await runWithTenant(context, () => BotConfig.countDocuments({})), 1);
        assert.equal(await runWithTenant(context, () => SmsConfig.countDocuments({})), 1);
      }
    });

    await t.test("missing context, forged document saves and legacy data remain inaccessible", async () => {
      await assert.rejects(User.find({}).exec(), /Tenant context is required/);
      const ownedA = await runWithTenant(tenantA, () => User.findOne({ telegramId: "123456" }));
      assert.ok(ownedA);
      await runWithTenant(tenantB, async () => {
        const forged = User.hydrate({ ...ownedA.toObject(), tenantId: "tenant_b", balance: 1 });
        forged.balance = 0;
        await assert.rejects(forged.save(), /No document found|DocumentNotFound/);
      });
      await db.collection("users").insertOne({ telegramId: "unmigrated", firstName: "Legacy" });
      assert.equal(await runWithTenant(platformContext(), () => User.findOne({ telegramId: "unmigrated" })), null);
      assert.equal(await runWithTenant(tenantA, () => User.findOne({ telegramId: "unmigrated" })), null);
      await assert.rejects(assertTenantMigrationReady(), /legacy documents/);
      assert.equal((await runWithTenant(tenantA, () => User.findOne({ telegramId: "123456" }).lean()))?.balance, 90);
    });
  } finally {
    assert.equal(db.databaseName, databaseName);
    assert.ok(databaseName.startsWith("tenant_isolation_test_"));
    await db.dropDatabase();
    await mongoose.disconnect();
  }
});
