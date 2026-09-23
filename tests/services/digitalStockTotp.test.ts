import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";
import { DigitalStock } from "../../src/models/DigitalStock.js";
import {
  DigitalStockInputError,
  prepareDigitalStockDocuments,
} from "../../src/services/digitalProduct.js";
import { decryptSecret } from "../../src/services/crypto.js";
import {
  TotpService,
  classifyTotpStockAccess,
  digitalStockTotpPurpose,
  isValidAccountCode,
  normalizeAccountCode,
  ownedStockByAccountCodeFilter,
  ownedStockByIdFilter,
} from "../../src/services/totp.js";
import { OtpRequestRateLimiter } from "../../src/plugins/totp/index.js";
import { runWithTenant } from "../../src/tenant/context.js";
import { BACKUP_COLLECTIONS } from "../../src/services/backup.js";

const TEST_KEY = "11".repeat(32);
const TEST_SECRET = "JBSWY3DPEHPK3PXP";

test("account codes normalize to uppercase and enforce the documented format", () => {
  assert.equal(normalizeAccountCode("  nf-a01  "), "NF-A01");
  for (const valid of ["NF-A01", "DISCORD_001", "GOOGLE-A07"]) {
    assert.equal(isValidAccountCode(valid), true, valid);
  }
  for (const invalid of ["AB", "HAS SPACE", "INVALID!", "A".repeat(41)]) {
    assert.equal(isValidAccountCode(invalid), false, invalid);
  }
});

test("new stock format encrypts the TOTP secret with the stock ID purpose", () => {
  const previousKey = process.env["CREDENTIAL_ENCRYPTION_KEY"];
  process.env["CREDENTIAL_ENCRYPTION_KEY"] = TEST_KEY;
  try {
    const productId = new Types.ObjectId();
    const [stock] = prepareDigitalStockDocuments(
      productId,
      `buyer@example.com|password123|nf-a01|${TEST_SECRET}`
    );

    assert.ok(stock);
    assert.equal(stock.content, "buyer@example.com|password123");
    assert.equal(stock.accountCode, "NF-A01");
    assert.ok(stock.totpSecretEncrypted);
    assert.doesNotMatch(JSON.stringify(stock), new RegExp(TEST_SECRET));
    assert.equal(
      decryptSecret(stock.totpSecretEncrypted, digitalStockTotpPurpose(stock._id)),
      TEST_SECRET
    );
    assert.throws(
      () => decryptSecret(stock.totpSecretEncrypted!, digitalStockTotpPurpose(new Types.ObjectId())),
      /decryption failed/
    );
  } finally {
    if (previousKey === undefined) delete process.env["CREDENTIAL_ENCRYPTION_KEY"];
    else process.env["CREDENTIAL_ENCRYPTION_KEY"] = previousKey;
  }
});

test("legacy stock remains opaque and duplicate/new invalid rows are rejected", () => {
  const legacy = prepareDigitalStockDocuments(
    new Types.ObjectId(),
    "username|password\nlegacy:payload:with:colons"
  );
  assert.equal(legacy.length, 2);
  assert.equal(legacy[0]!.content, "username|password");
  assert.equal(legacy[0]!.accountCode, undefined);
  assert.equal(legacy[0]!.totpSecretEncrypted, undefined);

  assert.throws(
    () => prepareDigitalStockDocuments(
      new Types.ObjectId(),
      `a@b.test|pass|NF-A01|${TEST_SECRET}\nc@d.test|pass|nf-a01|${TEST_SECRET}`
    ),
    (error: unknown) => error instanceof DigitalStockInputError && /duplikat/.test(error.message)
  );
  assert.throws(
    () => prepareDigitalStockDocuments(new Types.ObjectId(), "a@b.test|pass|NF-A01|NOT-A-SECRET"),
    /Baris 1: TOTP secret tidak valid/
  );
});

test("DigitalStock hides ciphertext and defines tenant-scoped account code uniqueness", () => {
  assert.equal(DigitalStock.schema.path("totpSecretEncrypted").options.select, false);
  const uniqueIndex = DigitalStock.schema.indexes().find(([, options]) => options.unique);
  assert.ok(uniqueIndex);
  assert.deepEqual(uniqueIndex[0], { tenantId: 1, accountCode: 1 });
  assert.deepEqual(uniqueIndex[1].partialFilterExpression, {
    $or: [{ accountCode: { $exists: true } }],
  });
});

test("RFC 6238 SHA1 vector is generated as a six-digit Google Authenticator code", () => {
  const result = TotpService.generateToken("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 59);
  assert.equal(result.token, "287082");
  assert.equal(result.period, 30);
  assert.equal(result.digits, 6);
  assert.equal(result.remainingSeconds, 1);
});

test("OTP view contains only the stock ID/account code and never the TOTP secret", () => {
  const stockId = new Types.ObjectId().toString();
  const view = TotpService.buildTotpView({
    success: true,
    stockId,
    accountCode: "NF-A01",
    token: "482193",
    remainingSeconds: 17,
    period: 30,
    digits: 6,
  });
  const serialized = JSON.stringify(view);
  assert.match(serialized, /482 193/);
  assert.match(serialized, new RegExp(`totp_refresh_${stockId}`));
  assert.doesNotMatch(serialized, new RegExp(TEST_SECRET));
  assert.doesNotMatch(serialized, /totp_ref_/);
});

test("owner authorization rejects another buyer, unsold stock, and missing TOTP", () => {
  const base = {
    _id: new Types.ObjectId(),
    accountCode: "NF-A01",
    isSold: true,
    soldTo: "1001",
    totpSecretEncrypted: "ciphertext",
  };
  assert.equal(classifyTotpStockAccess(base, "1001"), "AUTHORIZED");
  assert.equal(classifyTotpStockAccess(base, "2002"), "NOT_FOUND");
  assert.equal(classifyTotpStockAccess({ ...base, isSold: false }, "1001"), "NOT_FOUND");
  assert.equal(
    classifyTotpStockAccess({ ...base, totpSecretEncrypted: undefined }, "1001"),
    "NO_TOTP"
  );
});

test("command and refresh query filters always include current ownership and sold state", () => {
  assert.deepEqual(ownedStockByAccountCodeFilter(" nf-a01 ", "1001"), {
    accountCode: "NF-A01",
    isSold: true,
    soldTo: "1001",
  });
  const stockId = new Types.ObjectId().toString();
  assert.deepEqual(ownedStockByIdFilter(stockId, "1001"), {
    _id: stockId,
    isSold: true,
    soldTo: "1001",
  });
});

test("owner can generate a code while another buyer cannot access the same stock", async () => {
  const previousKey = process.env["CREDENTIAL_ENCRYPTION_KEY"];
  process.env["CREDENTIAL_ENCRYPTION_KEY"] = TEST_KEY;
  const stockId = new Types.ObjectId();
  const { encryptSecret } = await import("../../src/services/crypto.js");
  let soldStock = {
    _id: stockId,
    accountCode: "NF-A01",
    isSold: true,
    soldTo: "1001",
    totpSecretEncrypted: encryptSecret(TEST_SECRET, digitalStockTotpPurpose(stockId)) as string | undefined,
  };

  const originalFindOne = DigitalStock.findOne;
  (DigitalStock as unknown as { findOne: (filter: Record<string, unknown>) => unknown }).findOne =
    ((filter: Record<string, unknown>) => ({
      select: () => ({
        exec: async () =>
          filter["isSold"] === true &&
          filter["soldTo"] === soldStock.soldTo &&
          (filter["accountCode"] === undefined || filter["accountCode"] === soldStock.accountCode) &&
          (filter["_id"] === undefined || filter["_id"] === soldStock._id.toString())
            ? soldStock
            : null,
      }),
    })) as never;

  try {
    const owner = await TotpService.getOwnedByAccountCode("NF-A01", "1001");
    assert.equal(owner.success, true);
    if (owner.success) assert.match(owner.token, /^\d{6}$/);

    const otherBuyer = await TotpService.getOwnedByAccountCode("NF-A01", "2002");
    assert.deepEqual(otherBuyer, { success: false, reason: "NOT_FOUND" });

    const refreshed = await TotpService.getOwnedByStockId(stockId.toString(), "1001");
    assert.equal(refreshed.success, true);
    const forgedRefresh = await TotpService.getOwnedByStockId(stockId.toString(), "2002");
    assert.deepEqual(forgedRefresh, { success: false, reason: "NOT_FOUND" });

    soldStock = { ...soldStock, totpSecretEncrypted: undefined };
    const missingTotp = await TotpService.getOwnedByAccountCode("NF-A01", "1001");
    assert.deepEqual(missingTotp, { success: false, reason: "NO_TOTP" });
  } finally {
    DigitalStock.findOne = originalFindOne;
    if (previousKey === undefined) delete process.env["CREDENTIAL_ENCRYPTION_KEY"];
    else process.env["CREDENTIAL_ENCRYPTION_KEY"] = previousKey;
  }
});

test("OTP limiter allows ten combined requests per tenant/user per minute", () => {
  runWithTenant({ tenantId: "totp_test" }, () => {
    const requestLimiter = new OtpRequestRateLimiter(10, 60_000);
    for (let index = 0; index < 10; index++) {
      assert.equal(requestLimiter.tryConsume("1001", 1_000 + index), true);
    }
    assert.equal(requestLimiter.tryConsume("1001", 2_000), false);
    assert.equal(requestLimiter.tryConsume("1002", 2_000), true);
    assert.equal(requestLimiter.tryConsume("1001", 61_010), true);
  });
});

test("database backup explicitly includes only the encrypted TOTP field", () => {
  const digitalStocks = BACKUP_COLLECTIONS.find((collection) => collection.name === "digitalstocks");
  assert.equal(digitalStocks?.select, "+totpSecretEncrypted");
});
