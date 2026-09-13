import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import mongoose from "mongoose";
import { PaymentAmountReservation, PaymentSettlementClaim } from "../models/PaymentLedger.js";
import { TenantPaymentConfig } from "../models/TenantPaymentConfig.js";
import { TopupSession } from "../models/TopupSession.js";
import { reservePaymentAmount, claimSettlement } from "./paymentLedger.service.js";
import { getTenantPaymentClients, getTenantPaymentSummary, invalidateTenantPaymentConfig, saveTenantPaymentConfig } from "./tenantPayment.service.js";
import { decryptSecret } from "../services/crypto.js";
import { runWithTenant, type TenantContext } from "../tenant/context.js";
import { QrisGenerator } from "../services/payment/qris.js";

const testUri = process.env["PAYMENT_TEST_MONGODB_URI"];
const context = (tenantId: string): TenantContext => ({ tenantId, rentalId: tenantId, ownerTelegramId: "100", adminTelegramIds: ["101"] });

test("isolated Mongo: concurrent merchant reservations, durable payment replay claims and tenant credential isolation", { skip: !testUri }, async (t) => {
  // Destructive cleanup is limited to this randomly named local test database.
  if (!testUri || !/^mongodb:\/\/(127\.0\.0\.1|localhost):\d+(\/|$)/.test(testUri)) throw new Error("PAYMENT_TEST_MONGODB_URI must target an isolated local MongoDB.");
  const dbName = `payment_test_${process.pid}_${randomBytes(6).toString("hex")}`;
  const previousKey = process.env["CREDENTIAL_ENCRYPTION_KEY"];
  process.env["CREDENTIAL_ENCRYPTION_KEY"] = randomBytes(32).toString("hex");
  await mongoose.connect(testUri, { dbName, serverSelectionTimeoutMS: 5000 });
  t.after(async () => {
    if (mongoose.connection.name !== dbName || !dbName.startsWith("payment_test_")) throw new Error("Refusing cleanup outside payment test database.");
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
    if (previousKey === undefined) delete process.env["CREDENTIAL_ENCRYPTION_KEY"]; else process.env["CREDENTIAL_ENCRYPTION_KEY"] = previousKey;
    invalidateTenantPaymentConfig("config-a"); invalidateTenantPaymentConfig("config-b");
  });
  for (const model of [PaymentAmountReservation, PaymentSettlementClaim, TenantPaymentConfig, TopupSession]) await model.createIndexes();

  const reservations = await Promise.all(Array.from({ length: 12 }, (_, index) => reservePaymentAmount("shared-merchant", `tenant-${index}`, 10000)));
  assert.equal(new Set(reservations.map((item) => item.totalAmount)).size, 12);
  assert.deepEqual(reservations.map((item) => item.totalAmount).sort((a, b) => a - b), Array.from({ length: 12 }, (_, index) => 10001 + index));
  const differentBase = await reservePaymentAmount("shared-merchant", "another-tenant", 10001);
  assert.equal(differentBase.totalAmount, 10013);
  const otherMerchant = await reservePaymentAmount("other-merchant", "tenant-0", 10000);
  assert.equal(otherMerchant.totalAmount, 10001);

  const transaction = { merchantId: "shared-merchant", amount: 10001, transactionId: "settlement-1", paymentType: "QRIS", status: "SETTLEMENT", paidAt: Date.now() };
  const claimA = { merchantId: "shared-merchant", tenantId: "tenant-a", invoiceReference: "invoice-a", kind: "rental" as const, transaction };
  const claimB = { ...claimA, tenantId: "tenant-b", invoiceReference: "invoice-b", kind: "store" as const };
  const outcomes = await Promise.all([claimSettlement(claimA), claimSettlement(claimB)]);
  assert.equal(outcomes.filter((item) => item.created).length, 1);
  assert.equal(outcomes.filter((item) => item.owned).length, 1);
  const winner = outcomes[0]!.owned ? claimA : claimB;
  assert.deepEqual(await claimSettlement(winner), { owned: true, created: false });
  assert.equal(await PaymentSettlementClaim.countDocuments({}), 1);
  assert.deepEqual(await claimSettlement({ ...winner, kind: winner.kind === "store" ? "rental" : "store" }), { owned: false, created: false });

  const payload = await new QrisGenerator({ qrisStaticPayload: "00020101021126190015ID.CO.GOPAY.WWW53033605802ID5904TEST6007JAKARTA" }).getDynamicPayload(1);
  const config = (merchantId: string) => ({ qris: { enabled: true, payload }, gopayMerchant: { enabled: true, merchantId, email: `${merchantId}@example.com`, password: `${merchantId}-secret`, clientSecret: `${merchantId}-client-secret`, accessToken: `${merchantId}-token` } });
  await runWithTenant(context("config-a"), () => saveTenantPaymentConfig("100", config("merchant-a")));
  await runWithTenant(context("config-b"), () => saveTenantPaymentConfig("101", config("merchant-b")));
  const storedA = await runWithTenant(context("config-a"), () => TenantPaymentConfig.findOne().select("+gopayMerchant.passwordEncrypted +qris.payloadEncrypted").lean());
  assert.equal(storedA?.tenantId, "config-a");
  assert.equal(storedA?.version, 1);
  assert.equal(decryptSecret(storedA!.gopayMerchant.passwordEncrypted, "config-a:payment:password"), "merchant-a-secret");
  assert.throws(() => decryptSecret(storedA!.gopayMerchant.passwordEncrypted, "config-b:payment:password"), /decryption failed/);
  await assert.rejects(runWithTenant(context("config-a"), () => TenantPaymentConfig.findOne({ tenantId: "config-b" })), /Cross-tenant/);
  const summary = await runWithTenant(context("config-a"), getTenantPaymentSummary);
  assert.deepEqual(Object.keys(summary).sort(), ["configured", "gopayEnabled", "merchantId", "qrisEnabled", "version"].sort());
  assert.equal(summary.merchantId, "merchant-a");
  const [clientA, clientB] = await Promise.all([runWithTenant(context("config-a"), getTenantPaymentClients), runWithTenant(context("config-b"), getTenantPaymentClients)]);
  assert.equal(clientA.merchantId, "merchant-a"); assert.equal(clientB.merchantId, "merchant-b");
  await reservePaymentAmount("merchant-a", "config-a", 1000);
  await assert.rejects(runWithTenant(context("config-a"), () => saveTenantPaymentConfig("100", config("replacement-a"))), /Tunggu invoice/);
  await runWithTenant(context("config-b"), () => saveTenantPaymentConfig("100", config("replacement-b")));
  const changedB = await runWithTenant(context("config-b"), getTenantPaymentClients);
  assert.equal(changedB.merchantId, "replacement-b"); assert.equal(changedB.version, 2);
  assert.equal((await runWithTenant(context("config-a"), getTenantPaymentClients)).merchantId, "merchant-a");
});
