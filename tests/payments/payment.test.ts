import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { encryptSecret, decryptSecret, validateEncryptionKey } from "../services/crypto.js";
import { matchesSettlement, claimSettlement, reservePaymentAmount } from "./paymentLedger.service.js";
import { validateTenantQrisImage, validateTenantQrisPayload } from "./paymentConfigValidation.js";
import { getTenantPaymentClients, invalidateTenantPaymentConfig, saveTenantPaymentConfig } from "./tenantPayment.service.js";
import { getPlatformPaymentClients } from "./platformPayment.service.js";
import { TenantPaymentConfig } from "../models/TenantPaymentConfig.js";
import { TopupSession } from "../models/TopupSession.js";
import { PaymentAmountReservation } from "../models/PaymentLedger.js";
import { getTenantId, runWithTenant, type TenantContext } from "../tenant/context.js";
import { QrisGenerator } from "../services/payment/qris.js";

const context = (tenantId: string): TenantContext => ({ tenantId, rentalId: tenantId, ownerTelegramId: "100", adminTelegramIds: ["101"] });
const rawQris = (name: string) => `00020101021126190015ID.CO.GOPAY.WWW53033605802ID59${String(name.length).padStart(2, "0")}${name}6007JAKARTA`;
const qris = (name: string) => new QrisGenerator({ qrisStaticPayload: rawQris(name) }).getDynamicPayload(1);

test("AES-GCM encrypts with fresh IVs and rejects tampering, wrong key, wrong tenant purpose and malformed envelopes", (t) => {
  const previous = process.env["CREDENTIAL_ENCRYPTION_KEY"];
  t.after(() => { if (previous === undefined) delete process.env["CREDENTIAL_ENCRYPTION_KEY"]; else process.env["CREDENTIAL_ENCRYPTION_KEY"] = previous; });
  process.env["CREDENTIAL_ENCRYPTION_KEY"] = randomBytes(32).toString("hex");
  const first = encryptSecret("private-password", "a:payment:password");
  const second = encryptSecret("private-password", "a:payment:password");
  assert.notEqual(first, second);
  assert.equal(first.includes("private-password"), false);
  assert.equal(decryptSecret(first, "a:payment:password"), "private-password");
  assert.throws(() => decryptSecret(first, "b:payment:password"), /decryption failed/);
  const parts = first.split(".");
  const tag = Buffer.from(parts[2]!, "base64url");
  tag[0] = tag[0]! ^ 1;
  parts[2] = tag.toString("base64url");
  assert.throws(() => decryptSecret(parts.join("."), "a:payment:password"), /decryption failed/);
  for (const invalid of ["plaintext", "v1.a.b.c", `${first}.extra`, first.replace("v1", "v2")]) {
    assert.throws(() => decryptSecret(invalid), /Invalid encrypted credential/);
  }
  process.env["CREDENTIAL_ENCRYPTION_KEY"] = randomBytes(32).toString("base64");
  validateEncryptionKey();
  assert.throws(() => decryptSecret(first, "a:payment:password"), /decryption failed/);
  process.env["CREDENTIAL_ENCRYPTION_KEY"] = randomBytes(32).toString("base64url");
  validateEncryptionKey();
  delete process.env["CREDENTIAL_ENCRYPTION_KEY"];
  assert.throws(validateEncryptionKey, /Detected 0 characters/);
  process.env["CREDENTIAL_ENCRYPTION_KEY"] = "x".repeat(32);
  assert.throws(validateEncryptionKey, /Detected 32 characters/);
});

test("payment matching rejects another merchant, amount, method, status and outside invoice time", async () => {
  const invoice = { merchantId: "merchant-a", amount: 10001, createdAt: new Date(1000), expiresAt: new Date(5000) };
  const tx = { merchantId: "merchant-a", amount: 10001, paidAt: 3000, paymentType: "QRIS", status: "SETTLEMENT", transactionId: "transaction-a" };
  assert.equal(matchesSettlement(tx, invoice), true);
  for (const mutation of [{ merchantId: "merchant-b" }, { amount: 10002 }, { paymentType: "CARD" }, { status: "PENDING" }, { paidAt: 999 }, { paidAt: 5001 }]) {
    assert.equal(matchesSettlement({ ...tx, ...mutation }, invoice), false);
  }
  assert.deepEqual(await claimSettlement({ merchantId: "merchant-b", tenantId: "b", invoiceReference: "invoice-b", kind: "rental", transaction: tx }), { owned: false, created: false });
  assert.deepEqual(await claimSettlement({ merchantId: "merchant-a", tenantId: "a", invoiceReference: "invoice-a", kind: "rental", transaction: { ...tx, status: "PENDING" } }), { owned: false, created: false });
  for (const amount of [0, -1, 1.5, NaN, Infinity, 1_000_000_001]) await assert.rejects(reservePaymentAmount("merchant-a", "a", amount), /Nominal/);
  await assert.rejects(reservePaymentAmount("", "a", 100), /Identitas/);
});

test("tenant QRIS requires a valid CRC and IDR merchant payload; image paths and oversized images are rejected", async () => {
  const payload = await qris("TEST");
  validateTenantQrisPayload(payload);
  assert.throws(() => validateTenantQrisPayload(payload.slice(0, -1) + (payload.endsWith("0") ? "1" : "0")), /CRC/);
  assert.throws(() => validateTenantQrisPayload(payload.replace("5303360", "5303840")), /mata uang/);
  assert.throws(() => validateTenantQrisPayload(payload + "5802ID"), /struktur/);
  assert.throws(() => validateTenantQrisImage(Buffer.from("not an image")), /PNG\/JPEG/);
  const png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.writeUInt32BE(512, 16); png.writeUInt32BE(512, 20);
  validateTenantQrisImage(png);
  png.writeUInt32BE(100000, 16);
  assert.throws(() => validateTenantQrisImage(png), /melebihi batas/);
});

test("renter payment clients isolate QRIS, merchant login token and cache; missing config never falls back to platform", async (t) => {
  const previousKey = process.env["CREDENTIAL_ENCRYPTION_KEY"];
  const previousMerchant = process.env["GOPAY_MERCHANT_ID"];
  const previousPayload = process.env["QRIS_STATIC_PAYLOAD"];
  const previousEmail = process.env["GOBIZ_EMAIL"];
  const previousPassword = process.env["GOBIZ_PASSWORD"];
  t.after(() => {
    for (const [name, value] of [["CREDENTIAL_ENCRYPTION_KEY", previousKey], ["GOPAY_MERCHANT_ID", previousMerchant], ["QRIS_STATIC_PAYLOAD", previousPayload], ["GOBIZ_EMAIL", previousEmail], ["GOBIZ_PASSWORD", previousPassword]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    for (const tenantId of ["tenant-a", "tenant-b", "missing"]) invalidateTenantPaymentConfig(tenantId);
  });
  process.env["CREDENTIAL_ENCRYPTION_KEY"] = randomBytes(32).toString("hex");
  process.env["GOPAY_MERCHANT_ID"] = "platform-merchant";
  process.env["GOBIZ_EMAIL"] = "platform@example.com";
  process.env["GOBIZ_PASSWORD"] = "platform-fake-password";
  process.env["QRIS_STATIC_PAYLOAD"] = await qris("PLATFORM");
  const payloads = new Map([["tenant-a", await qris("STORE A")], ["tenant-b", await qris("STORE B")]]);
  const reads: string[] = [];
  t.mock.method(TenantPaymentConfig, "findOne", () => {
    const id = getTenantId(); reads.push(id);
    const seal = (value: string, field: string) => encryptSecret(value, `${id}:payment:${field}`);
    const value = payloads.has(id) ? {
      tenantId: id, version: 1, qris: { enabled: true, payloadEncrypted: seal(payloads.get(id)!, "qris") },
      gopayMerchant: { enabled: true, merchantId: `${id}-merchant`, clientId: "go-biz-web-new", storeId: "",
        emailEncrypted: seal(`${id}@example.com`, "email"), passwordEncrypted: seal(`${id}-password`, "password"), clientSecretEncrypted: "", accessTokenEncrypted: "" },
    } : null;
    return { select: () => ({ lean: async () => value }) } as unknown as ReturnType<typeof TenantPaymentConfig.findOne>;
  });
  const tokens: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, options?: RequestInit) => {
    const url = String(input);
    if (url.includes("/goid/token")) {
      const data = JSON.parse(String(options?.body)) as { data: { email: string; password: string } };
      assert.equal(data.data.password, data.data.email.replace("@example.com", "-password"));
      return new Response(JSON.stringify({ access_token: `${data.data.email}-token` }), { status: 200 });
    }
    tokens.push(new Headers(options?.headers).get("Authorization") ?? "");
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  });
  const a = await runWithTenant(context("tenant-a"), getTenantPaymentClients);
  const b = await runWithTenant(context("tenant-b"), getTenantPaymentClients);
  const cachedA = await runWithTenant(context("tenant-a"), getTenantPaymentClients);
  assert.equal(a, cachedA); assert.notEqual(a, b);
  assert.deepEqual(reads, ["tenant-a", "tenant-b"]);
  assert.match(await a.generator.getDynamicPayload(123), /STORE A/);
  assert.match(await b.generator.getDynamicPayload(123), /STORE B/);
  await Promise.all([a.merchant.getQrisSettlements({ startTime: new Date(0), endTime: new Date() }), b.merchant.getQrisSettlements({ startTime: new Date(0), endTime: new Date() })]);
  assert.deepEqual(tokens.sort(), ["Bearer tenant-a@example.com-token", "Bearer tenant-b@example.com-token"]);
  const platform = runWithTenant(context("tenant-a"), getPlatformPaymentClients);
  assert.equal(platform.merchantId, "platform-merchant");
  assert.match(await platform.generator.getDynamicPayload(123), /PLATFORM/);
  await assert.rejects(runWithTenant(context("missing"), getTenantPaymentClients), /belum dikonfigurasi/);
  invalidateTenantPaymentConfig("tenant-a");
  await runWithTenant(context("tenant-a"), getTenantPaymentClients);
  assert.equal(reads.filter((id) => id === "tenant-a").length, 2);
});

test("payment settings enforce actor authorization, encrypt all secrets and block merchant changes while invoices are pending", async (t) => {
  const previous = process.env["CREDENTIAL_ENCRYPTION_KEY"];
  t.after(() => { if (previous === undefined) delete process.env["CREDENTIAL_ENCRYPTION_KEY"]; else process.env["CREDENTIAL_ENCRYPTION_KEY"] = previous; });
  process.env["CREDENTIAL_ENCRYPTION_KEY"] = randomBytes(32).toString("hex");
  let pending = false;
  const writes: unknown[] = [];
  t.mock.method(TopupSession, "exists", () => Promise.resolve(pending ? { _id: "pending" } : null) as unknown as ReturnType<typeof TopupSession.exists>);
  t.mock.method(PaymentAmountReservation, "exists", () => Promise.resolve(null) as unknown as ReturnType<typeof PaymentAmountReservation.exists>);
  t.mock.method(TenantPaymentConfig, "findOneAndUpdate", (...args: unknown[]) => {
    writes.push(args[1]); return Promise.resolve(null) as unknown as ReturnType<typeof TenantPaymentConfig.findOneAndUpdate>;
  });
  const input = { qris: { enabled: true, payload: await qris("STORE A") }, gopayMerchant: { enabled: true, merchantId: "merchant-a", email: "a@example.com", password: "private-password", clientSecret: "private-client-secret", accessToken: "private-access-token" } };
  await assert.rejects(runWithTenant(context("a"), () => saveTenantPaymentConfig("999", input)), /Hanya owner/);
  await assert.rejects(runWithTenant(context("a"), () => saveTenantPaymentConfig("100", { ...input, tenantId: "b" })), /tidak dikenali/);
  await assert.rejects(runWithTenant(context("a"), () => saveTenantPaymentConfig("100", { ...input, qris: { enabled: true, image: "C:/private.png" } })), /bukan path/);
  await runWithTenant(context("a"), () => saveTenantPaymentConfig("100", input));
  assert.equal(writes.length, 1);
  const encoded = JSON.stringify(writes[0]);
  for (const secret of [input.qris.payload, input.gopayMerchant.email, input.gopayMerchant.password, input.gopayMerchant.clientSecret, input.gopayMerchant.accessToken]) assert.equal(encoded.includes(secret), false);
  const stored = writes[0] as { $set: { gopayMerchant: { passwordEncrypted: string } } };
  assert.equal(decryptSecret(stored.$set.gopayMerchant.passwordEncrypted, "a:payment:password"), "private-password");
  assert.throws(() => decryptSecret(stored.$set.gopayMerchant.passwordEncrypted, "b:payment:password"), /decryption failed/);
  pending = true;
  await assert.rejects(runWithTenant(context("a"), () => saveTenantPaymentConfig("101", input)), /Tunggu invoice/);
  assert.equal(writes.length, 1);
});
