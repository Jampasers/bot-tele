import mongoose from "mongoose";
import dotenv from "dotenv";
import { AntiFraudService } from "../src/services/antiFraudService.js";
import { FraudLog } from "../src/models/FraudLog.js";
import { User } from "../src/models/User.js";
import { WarrantyClaim } from "../src/models/WarrantyClaim.js";
import { PromoCode } from "../src/models/PromoCode.js";
import { validatePromo } from "../src/services/promo.js";
import { clearUserBanCache } from "../src/middlewares/antiFraud.js";

dotenv.config();

async function runTests() {
  console.log("==================================================");
  console.log("🧪 STARTING ANTI-FRAUD & SECURITY INTEGRATION TEST");
  console.log("==================================================");

  const mongoUri = process.env.MONGODB_URI || "mongodb://localhost:27017/grammy-bot";
  await mongoose.connect(mongoUri, { dbName: process.env.DATABASE_NAME || "telegram-danka" });
  console.log("✅ Connected to MongoDB");

  const TEST_USER_ID = "9998887771";
  const TEST_USER_HANDLE = "security_tester";

  try {
    // Cleanup prior test artifacts
    await User.deleteMany({ telegramId: TEST_USER_ID });
    await FraudLog.deleteMany({ userId: TEST_USER_ID });
    await WarrantyClaim.deleteMany({ userId: TEST_USER_ID });
    await PromoCode.deleteMany({ code: "TESTFRAUDPROMO" });

    // ── Test 1: Payment Idempotency & Replay Guard ────────────────────────────
    console.log("\n[TEST 1] Payment Idempotency & Replay Guard...");
    const txId = `GOPAY-TX-${Date.now()}`;
    const amount = 50000;
    const paidAt = new Date();

    const signature = AntiFraudService.computePaymentSignature("GOPAY", amount, paidAt, txId);
    console.log("   Signature:", signature);

    // 1st check: should not be replay
    const firstCheck = await AntiFraudService.checkPaymentReplay(signature, {
      userId: TEST_USER_ID,
      amount,
      txId,
      issuer: "GOPAY",
    });
    if (firstCheck.isReplay) throw new Error("First payment check should not be flagged as replay!");
    console.log("   ✅ First payment transaction verified (Allowed)");

    // Record signature
    await AntiFraudService.recordPaymentSignature(signature);

    // 2nd check with same signature: MUST be caught as replay attack
    const secondCheck = await AntiFraudService.checkPaymentReplay(signature, {
      userId: TEST_USER_ID,
      amount,
      txId,
      issuer: "GOPAY",
    });
    if (!secondCheck.isReplay) throw new Error("Duplicate payment mutation must be blocked by Replay Guard!");
    console.log("   ✅ Duplicate transaction correctly blocked by Replay Guard:", secondCheck.reason);

    // Check MongoDB FraudLog
    const replayLog = await FraudLog.findOne({ userId: TEST_USER_ID, fraudType: "PAYMENT_REPLAY" });
    if (!replayLog) throw new Error("FraudLog for PAYMENT_REPLAY was not created in MongoDB!");
    console.log("   ✅ FraudLog record confirmed in MongoDB:", replayLog._id);

    // ── Test 2: User Creation & Warranty Abuse Guard ──────────────────────────
    console.log("\n[TEST 2] Warranty Abuse Detection & Auto-Flagging...");
    const user = await User.create({
      telegramId: TEST_USER_ID,
      firstName: "Security Tester",
      username: TEST_USER_HANDLE,
      balance: 100000,
      totalOrders: 2,
    });

    // Create 3 fake claims in last 24h to trigger daily threshold abuse
    for (let i = 1; i <= 3; i++) {
      await WarrantyClaim.create({
        claimId: `CLM-TEST-${Date.now()}-${i}`,
        orderId: `ORD-TEST-${i}`,
        userId: TEST_USER_ID,
        userHandle: TEST_USER_HANDLE,
        productId: new mongoose.Types.ObjectId(),
        productName: "Test Account",
        itemContentSnapshot: "user:pass",
        reason: "Akun login gagal",
        status: "PENDING",
        createdAt: new Date(),
      });
    }

    const abuseCheck = await AntiFraudService.checkWarrantyAbuse(TEST_USER_ID);
    if (abuseCheck.allowed) throw new Error("Warranty abuse should have been flagged for 3 claims in 24h!");
    console.log("   ✅ Warranty abuse caught:", abuseCheck.reason);

    // Verify User account status updated to UNDER_REVIEW
    const updatedUser = await User.findOne({ telegramId: TEST_USER_ID });
    if (updatedUser?.accountStatus !== "UNDER_REVIEW") {
      throw new Error(`User accountStatus should be UNDER_REVIEW, got: ${updatedUser?.accountStatus}`);
    }
    console.log(`   ✅ User status successfully transitioned to: ${updatedUser.accountStatus} (Risk Score: ${updatedUser.fraudScore})`);

    // ── Test 3: Promo Code Brute-Force Protection ─────────────────────────────
    console.log("\n[TEST 3] Promo Brute-Force Rate Limiter...");
    await PromoCode.create({
      code: "TESTFRAUDPROMO",
      discountType: "FIXED",
      discountValue: 10000,
      quota: 100,
      minSpend: 20000,
      expiresAt: new Date(Date.now() + 86400000),
      isActive: true,
    });

    // Simulate 4 failed invalid promo codes
    for (let i = 1; i <= 4; i++) {
      const res = await validatePromo(`INVALID_CODE_${i}`, TEST_USER_ID, 50000);
      if (res.valid) throw new Error("Invalid promo code was accepted!");
    }
    console.log("   ✅ 4 failed attempts tracked without locking.");

    // 5th failed attempt: should lock the user
    const fifthFail = await validatePromo("INVALID_CODE_5", TEST_USER_ID, 50000);
    console.log("   5th failure message:", fifthFail.message);

    // Subsequent attempt: should be blocked by lock
    const lockedCheck = await validatePromo("TESTFRAUDPROMO", TEST_USER_ID, 50000);
    if (!lockedCheck.message.includes("Diblokir Sementara")) {
      throw new Error(`User was not blocked after 5 failed promo attempts! Msg: ${lockedCheck.message}`);
    }
    console.log("   ✅ Promo brute-force lock engaged (1 hour temporary ban on promo inputs)");

    // Reset lock
    await AntiFraudService.resetPromoFailure(TEST_USER_ID);
    const validAfterReset = await validatePromo("TESTFRAUDPROMO", TEST_USER_ID, 50000);
    if (!validAfterReset.valid) throw new Error("Valid promo should succeed after lock reset!");
    console.log("   ✅ Promo input unlocked successfully after reset.");

    // ── Test 4: Velocity Burst Limiter ────────────────────────────────────────
    console.log("\n[TEST 4] Velocity Rate Limiter...");
    let burstBlocked = false;
    for (let i = 0; i < 7; i++) {
      const velo = await AntiFraudService.checkVelocity(TEST_USER_ID, 5);
      if (!velo.allowed) {
        burstBlocked = true;
        console.log(`   ✅ Velocity exceeded at action #${i + 1} (Rate: ${velo.rate} req/s)`);
        break;
      }
    }
    if (!burstBlocked) throw new Error("Velocity limiter failed to block rapid burst > 5 req/s!");

    // ── Test 5: Admin User Ban, Unban & Security Review ───────────────────────
    console.log("\n[TEST 5] Admin User Ban, Unban & Investigation Review...");
    const banRes = await AntiFraudService.banUser(TEST_USER_ID, "Testing ban functionality", "admin_123");
    if (!banRes.success) throw new Error("Failed to ban user!");
    clearUserBanCache(TEST_USER_ID);

    const bannedUser = await User.findOne({ telegramId: TEST_USER_ID });
    if (!bannedUser?.isBanned || bannedUser.accountStatus !== "BANNED") {
      throw new Error("User model isBanned / accountStatus not set properly!");
    }
    console.log("   ✅ User banned successfully:", banRes.message);

    // Security Review summary check
    const review = await AntiFraudService.getUserSecurityReview(TEST_USER_ID);
    if (!review) throw new Error("getUserSecurityReview returned null!");
    console.log(`   ✅ Security Review Summary: ${review.fraudLogsCount} fraud logs, ${review.totalClaims} claims, Claim Ratio: ${review.claimRatioPercent}%`);

    // Unban
    const unbanRes = await AntiFraudService.unbanUser(TEST_USER_ID, "admin_123");
    if (!unbanRes.success) throw new Error("Failed to unban user!");
    clearUserBanCache(TEST_USER_ID);

    const activeUser = await User.findOne({ telegramId: TEST_USER_ID });
    if (activeUser?.isBanned || activeUser?.accountStatus !== "ACTIVE") {
      throw new Error("User was not unbanned!");
    }
    console.log("   ✅ User unbanned successfully:", unbanRes.message);

    console.log("\n==================================================");
    console.log("🎉 ALL ANTI-FRAUD & SECURITY TESTS PASSED 100%!");
    console.log("==================================================");
  } finally {
    // Cleanup
    await User.deleteMany({ telegramId: TEST_USER_ID });
    await FraudLog.deleteMany({ userId: TEST_USER_ID });
    await WarrantyClaim.deleteMany({ userId: TEST_USER_ID });
    await PromoCode.deleteMany({ code: "TESTFRAUDPROMO" });
    await mongoose.disconnect();
    console.log("🔌 Disconnected from MongoDB");
  }
}

runTests().catch((err) => {
  console.error("❌ Test failed with error:", err);
  process.exit(1);
});
