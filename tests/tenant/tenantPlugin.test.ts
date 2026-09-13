import assert from "node:assert/strict";
import test from "node:test";
import { Schema, model, type PipelineStage } from "mongoose";
import { getTenantContext, getTenantId, platformContext, runWithTenant, tenantEnvironment } from "./context.js";
import { scopeTenantFilter, scopeTenantPipeline, scopeTenantUpdate, tenantPlugin } from "./tenantPlugin.js";
import { TENANT_MODELS } from "./models.js";
import { BotConfig } from "../models/BotConfig.js";
import { SmsConfig } from "../models/SmsConfig.js";

test("tenant context fails closed and stays isolated across overlapping promises and timers", async () => {
  assert.throws(getTenantContext, /Tenant context is required/);
  const results = await Promise.all(["tenant_a", "tenant_b"].map((tenantId, index) => runWithTenant({ tenantId }, async () => {
    await new Promise(resolve => setTimeout(resolve, index === 0 ? 15 : 1));
    const nested = runWithTenant(platformContext(), getTenantId);
    assert.equal(nested, "platform");
    assert.equal(getTenantId(), tenantId);
    assert.throws(() => { (getTenantContext() as { tenantId: string }).tenantId = "attacker"; }, TypeError);
    return tenantId;
  })));
  assert.deepEqual(results, ["tenant_a", "tenant_b"]);
  assert.throws(getTenantId, /Tenant context is required/);
});

test("tenant filters intersect arbitrary filters and forbid explicit foreign identities", () => runWithTenant({ tenantId: "a" }, () => {
  assert.deepEqual(scopeTenantFilter({ $or: [{ tenantId: "b" }, { balance: 1 }] }), {
    $and: [{ $or: [{ tenantId: "b" }, { balance: 1 }] }, { tenantId: "a" }],
  });
  assert.throws(() => scopeTenantFilter({ tenantId: "b" }), /Cross-tenant/);
  assert.deepEqual(scopeTenantUpdate({ $inc: { balance: 1 } }), { $inc: { balance: 1 }, $setOnInsert: { tenantId: "a" } });
  for (const value of [{ $set: { tenantId: "b" } }, { $unset: { tenantId: 1 } }, { $rename: { balance: "tenantId" } }, [{ $set: { tenantId: "b" } }]]) {
    assert.throws(() => scopeTenantUpdate(value), /Tenant|pipelines/);
  }
  assert.throws(() => scopeTenantUpdate({ tenantId: "b" }, true), /Cross-tenant/);
  assert.deepEqual(scopeTenantUpdate({ balance: 1 }, true), { balance: 1, tenantId: "a" });
}));

test("aggregation scopes the collection and rejects joins, writes and nested facet bypasses", () => runWithTenant({ tenantId: "a" }, () => {
  const pipeline: PipelineStage[] = [{ $group: { _id: null, total: { $sum: "$balance" } } }];
  scopeTenantPipeline(pipeline);
  assert.deepEqual(pipeline[0], { $match: { tenantId: "a" } });
  for (const forbidden of ["$lookup", "$unionWith", "$graphLookup", "$out", "$merge", "$search", "$documents"]) {
    assert.throws(() => scopeTenantPipeline([{ [forbidden]: {} }] as unknown as PipelineStage[]), /Unsafe tenant aggregate/);
    assert.throws(() => scopeTenantPipeline([{ $facet: { unsafe: [{ [forbidden]: {} }] } }] as unknown as PipelineStage[]), /Unsafe tenant aggregate/);
  }
}));

test("every registered model enforces a required immutable tenant and tenant-prefixed indexes", () => {
  for (const Model of TENANT_MODELS) {
    const path = (Model.schema as Schema).path("tenantId");
    assert.equal(path.options.required, true, Model.modelName);
    assert.equal(path.options.immutable, true, Model.modelName);
    for (const [keys, options] of Model.schema.indexes()) {
      if (options.expireAfterSeconds !== undefined) assert.equal(Object.keys(keys).length, 1, "TTL stays a single-field index");
      else assert.equal(Object.keys(keys)[0], "tenantId", Model.modelName);
    }
  }
});

test("optional sparse unique fields stay optional after tenant prefixing", () => {
  const schema = new Schema({ optionalReference: { type: String, unique: true, sparse: true } });
  schema.plugin(tenantPlugin);
  const index = schema.indexes().find(([, options]) => options.unique)!;
  assert.deepEqual(index[0], { tenantId: 1, optionalReference: 1 });
  assert.equal(index[1].sparse, undefined);
  assert.deepEqual(index[1].partialFilterExpression, { $or: [{ optionalReference: { $exists: true } }] });
});

test("rental config defaults never inherit platform credentials, channels or internal feature flags", async () => {
  const original = process.env.IMAP_PASS;
  process.env.IMAP_PASS = "test-only-platform-secret";
  try {
    await runWithTenant({ tenantId: "rental_defaults", rentalId: "rental_defaults" }, async () => {
      const botConfig = new BotConfig();
      const smsConfig = new SmsConfig();
      await botConfig.validate();
      await smsConfig.validate();
      assert.equal(botConfig.imapPass, "");
      assert.equal(botConfig.cfApiKey, "");
      assert.equal(botConfig.logChannel, "");
      assert.equal(botConfig.testimonialChannel, "");
      assert.equal(botConfig.imapEnabled, false);
      assert.equal(botConfig.otpChannelEnabled, false);
      assert.equal(smsConfig.enabled, false);
      assert.deepEqual(tenantEnvironment(), {});
    });
  } finally {
    if (original === undefined) delete process.env.IMAP_PASS;
    else process.env.IMAP_PASS = original;
  }
});

test("real Mongoose middleware rejects unsafe operations before any database call", async () => {
  const schema = new Schema({ name: String }, { bufferCommands: false });
  schema.plugin(tenantPlugin);
  const Model = model("TenantMiddlewareOffline", schema);
  await assert.rejects(Model.find({}).exec(), /Tenant context is required/);
  await assert.rejects(Model.insertMany([{ name: "missing-context" }]), /Tenant context is required/);
  await runWithTenant({ tenantId: "a" }, async () => {
    await assert.rejects(Model.updateOne({}, { $set: { tenantId: "b" } }).exec(), /Tenant identity/);
    await assert.rejects(Model.findOne({ tenantId: "b" }).exec(), /Cross-tenant/);
    await assert.rejects(Model.insertMany([{ tenantId: "b" }]), /Cross-tenant/);
    await assert.rejects(Model.aggregate([{ $lookup: { from: "users", as: "users", pipeline: [] } }]).exec(), /Unsafe tenant aggregate/);
    await assert.rejects(Model.bulkWrite([{ deleteMany: { filter: {} } }]), /bulkWrite is not enabled/);
    await assert.rejects(Model.estimatedDocumentCount().exec(), /Use countDocuments/);
    const wrong = new Model({ tenantId: "b", name: "wrong-owner" });
    await assert.rejects(wrong.validate(), /Cross-tenant/);
  });
});
