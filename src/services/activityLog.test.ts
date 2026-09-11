import assert from "node:assert/strict";
import test from "node:test";
import { Api } from "grammy";
import { ActivityLogService } from "./activityLog.js";
import { IBotConfig } from "../models/BotConfig.js";
import { platformContext, runWithTenant } from "../tenant/context.js";

// Mock BotConfig for testing
const mockConfig: Partial<IBotConfig> = {
  logChannelEnabled: true,
  logChannel: "@test_log_channel",
  logChannelLink: "https://t.me/test_log_channel",
};

interface SentMessage {
  chatId: string | number;
  text: string;
  options?: any;
}

function createMockApi(shouldThrow = false) {
  const sentMessages: SentMessage[] = [];

  const mockApi = {
    async sendMessage(chatId: string | number, text: string, options?: any) {
      if (shouldThrow) {
        throw new Error("Telegram API Network Error");
      }
      sentMessages.push({ chatId, text, options });
      return { message_id: 12345 };
    },
  } as unknown as Api;

  return { mockApi, sentMessages };
}

test.beforeEach(() => runWithTenant(platformContext(), () => {
  ActivityLogService.setCachedConfig(mockConfig as IBotConfig);
}));

test.afterEach(() => runWithTenant(platformContext(), () => {
  ActivityLogService.setCachedConfig(null);
  ActivityLogService.setDefaultApi(null as any);
}));

test("ActivityLogService defaultApi setter and getter", () => runWithTenant(platformContext(), () => {
  const { mockApi } = createMockApi();
  ActivityLogService.setDefaultApi(mockApi);
  assert.equal(ActivityLogService.getDefaultApi(), mockApi);
}));

test("returns false when logChannelEnabled is false", () => runWithTenant(platformContext(), async () => {
  ActivityLogService.setCachedConfig({
    logChannelEnabled: false,
    logChannel: "@test_channel",
  } as IBotConfig);

  const { mockApi, sentMessages } = createMockApi();
  const res = await ActivityLogService.logBalanceAdjusted(mockApi, {
    user: { telegramId: 111, firstName: "User1" },
    type: "CREDIT",
    amount: 10000,
    balanceAfter: 20000,
  });

  assert.equal(res, false);
  assert.equal(sentMessages.length, 0);
}));

test("returns false when logChannel is empty string", () => runWithTenant(platformContext(), async () => {
  ActivityLogService.setCachedConfig({
    logChannelEnabled: true,
    logChannel: "   ",
  } as IBotConfig);

  const { mockApi, sentMessages } = createMockApi();
  const res = await ActivityLogService.logBalanceAdjusted(mockApi, {
    user: { telegramId: 111, firstName: "User1" },
    type: "CREDIT",
    amount: 10000,
    balanceAfter: 20000,
  });

  assert.equal(res, false);
  assert.equal(sentMessages.length, 0);
}));

test("logUserRegistration formats standard and referral info", () => runWithTenant(platformContext(), async () => {
  const { mockApi, sentMessages } = createMockApi();

  // Without referrer
  await ActivityLogService.logUserRegistration(mockApi, {
    user: {
      telegramId: 123456,
      firstName: "Budi",
      username: "budi123",
    },
  });
  assert.equal(sentMessages.length, 1);
  assert.ok(sentMessages[0]?.text.includes("[AUDIT: USER REGISTER]"));
  assert.ok(sentMessages[0]?.text.includes("123456"));
  assert.ok(sentMessages[0]?.text.includes("budi123"));

  // With referrer
  await ActivityLogService.logUserRegistration(mockApi, {
    user: {
      telegramId: 789012,
      firstName: "Andi",
    },
    referredBy: "123456",
    referrerUser: { telegramId: 123456, firstName: "Budi", username: "budi123" },
  });
  assert.equal(sentMessages.length, 2);
  assert.ok(sentMessages[1]?.text.includes("Referral Dari:"));
  assert.ok(sentMessages[1]?.text.includes("Budi"));
}));

test("logBalanceAdjusted logs manual and automatic balance adjustments", () => runWithTenant(platformContext(), async () => {
  const { mockApi, sentMessages } = createMockApi();

  await ActivityLogService.logBalanceAdjusted(mockApi, {
    admin: { telegramId: 999, firstName: "Admin Utama", username: "admin_boss" },
    user: { telegramId: 123456, firstName: "Budi" },
    type: "CREDIT",
    amount: 50000,
    balanceBefore: 10000,
    balanceAfter: 60000,
    reason: "Manual topup via transfer",
  });

  assert.equal(sentMessages.length, 1);
  assert.ok(sentMessages[0]?.text.includes("[AUDIT: MUTASI SALDO MANUAL]"));
  assert.ok(sentMessages[0]?.text.includes("Admin Utama"));
  assert.ok(sentMessages[0]?.text.includes("Manual topup via transfer"));
  assert.ok(sentMessages[0]?.text.includes("50.000"));
}));

test("logUserBanned, logUserUnbanned, and logUserUnflagged format correctly", () => runWithTenant(platformContext(), async () => {
  const { mockApi, sentMessages } = createMockApi();

  await ActivityLogService.logUserBanned(mockApi, {
    admin: { telegramId: 999, firstName: "Admin Utama" },
    user: { telegramId: 123, firstName: "Spammer" },
    reason: "Abusive behavior",
  });

  await ActivityLogService.logUserUnbanned(mockApi, {
    admin: { telegramId: 999, firstName: "Admin Utama" },
    user: { telegramId: 123, firstName: "Spammer" },
  });

  await ActivityLogService.logUserUnflagged(mockApi, {
    admin: { telegramId: 999, firstName: "Admin Utama" },
    user: { telegramId: 123, firstName: "Spammer" },
  });

  assert.equal(sentMessages.length, 3);
  assert.ok(sentMessages[0]?.text.includes("[AUDIT: USER DIBANNED / BLOKIR]"));
  assert.ok(sentMessages[0]?.text.includes("Abusive behavior"));
  assert.ok(sentMessages[1]?.text.includes("[AUDIT: USER DI-UNBAN / AKTIF KEMBALI]"));
  assert.ok(sentMessages[2]?.text.includes("[AUDIT: STATUS REVIEW PENGGUNA DIPULIHKAN]"));
}));

test("logProductCreated, logProductUpdated, and logProductDeleted format correctly", () => runWithTenant(platformContext(), async () => {
  const { mockApi, sentMessages } = createMockApi();

  await ActivityLogService.logProductCreated(mockApi, {
    admin: { telegramId: 999, firstName: "Admin" },
    productId: "prod_001",
    name: "Netflix 1 Bulan",
    category: "Streaming",
    price: 35000,
    warrantyHours: 720,
  });

  await ActivityLogService.logProductUpdated(mockApi, {
    admin: { telegramId: 999, firstName: "Admin" },
    productId: "prod_001",
    name: "Netflix 1 Bulan",
    changes: "Harga diubah menjadi: Rp 30.000",
  });

  await ActivityLogService.logProductDeleted(mockApi, {
    admin: { telegramId: 999, firstName: "Admin" },
    productId: "prod_001",
    name: "Netflix 1 Bulan",
    category: "Streaming",
  });

  assert.equal(sentMessages.length, 3);
  assert.ok(sentMessages[0]?.text.includes("[AUDIT: PRODUK DIGITAL BARU DIBUAT]"));
  assert.ok(sentMessages[0]?.text.includes("Netflix 1 Bulan"));
  assert.ok(sentMessages[1]?.text.includes("[AUDIT: PRODUK DIGITAL DIPERBARUI]"));
  assert.ok(sentMessages[1]?.text.includes("Harga diubah menjadi: Rp 30.000"));
  assert.ok(sentMessages[2]?.text.includes("[AUDIT: PRODUK DIGITAL DIHAPUS]"));
}));

test("logStockAdded and logStockRemoved format correctly", () => runWithTenant(platformContext(), async () => {
  const { mockApi, sentMessages } = createMockApi();

  await ActivityLogService.logStockAdded(mockApi, {
    admin: { telegramId: 999, firstName: "Admin" },
    productId: "prod_001",
    productName: "Netflix 1 Bulan",
    addedCount: 15,
    totalUnsoldStock: 20,
  });

  await ActivityLogService.logStockRemoved(mockApi, {
    admin: { telegramId: 999, firstName: "Admin" },
    productId: "prod_001",
    productName: "Netflix 1 Bulan",
    removedCount: 5,
    action: "TAKE_MANUAL",
  });

  assert.equal(sentMessages.length, 2);
  assert.ok(sentMessages[0]?.text.includes("[AUDIT: STOK DIGITAL DITAMBAHKAN]"));
  assert.ok(sentMessages[0]?.text.includes("+15 item"));
  assert.ok(sentMessages[1]?.text.includes("[AUDIT: STOK DIGITAL DIKURANGI / DIAMBIL]"));
  assert.ok(sentMessages[1]?.text.includes("5 item"));
}));

test("logPromoCreated and logPromoUsed format correctly", () => runWithTenant(platformContext(), async () => {
  const { mockApi, sentMessages } = createMockApi();

  await ActivityLogService.logPromoCreated(mockApi, {
    admin: { telegramId: 999, firstName: "Admin" },
    code: "HEMAT50",
    discountType: "PERCENTAGE",
    discountValue: 50,
    quota: 100,
    minSpend: 20000,
    expiresAt: new Date(Date.now() + 86400000),
  });

  await ActivityLogService.logPromoUsed(mockApi, {
    user: { telegramId: 123456, firstName: "Budi" },
    code: "HEMAT50",
    discountAmount: 10000,
    totalAfterDiscount: 10000,
    orderId: "ORD-9999",
  });

  assert.equal(sentMessages.length, 2);
  assert.ok(sentMessages[0]?.text.includes("[AUDIT: KODE PROMO BARU DIBUAT]"));
  assert.ok(sentMessages[0]?.text.includes("HEMAT50"));
  assert.ok(sentMessages[1]?.text.includes("[AUDIT: KODE PROMO DIGUNAKAN]"));
  assert.ok(sentMessages[1]?.text.includes("ORD-9999"));
}));

test("logBroadcastExecuted formats broadcast statistics", () => runWithTenant(platformContext(), async () => {
  const { mockApi, sentMessages } = createMockApi();

  await ActivityLogService.logBroadcastExecuted(mockApi, {
    admin: { telegramId: 999, firstName: "Admin" },
    filterLabel: "Semua User",
    totalTarget: 500,
    sent: 480,
    failed: 10,
    blocked: 10,
  });

  assert.equal(sentMessages.length, 1);
  assert.ok(sentMessages[0]?.text.includes("[AUDIT: BROADCAST MASSAL SELESAI]"));
  assert.ok(sentMessages[0]?.text.includes("480"));
}));

test("logDatabaseBackup formats admin vs cron triggered backups", () => runWithTenant(platformContext(), async () => {
  const { mockApi, sentMessages } = createMockApi();

  await ActivityLogService.logDatabaseBackup(mockApi, {
    triggeredBy: "ADMIN",
    admin: { telegramId: 999, firstName: "Admin" },
    fileName: "backup-2026-09-11.zip",
    totalCollections: 12,
    recipientsCount: 2,
  });

  await ActivityLogService.logDatabaseBackup(mockApi, {
    triggeredBy: "CRON_AUTO",
    fileName: "backup-auto-2026-09-11.zip",
    totalCollections: 12,
    recipientsCount: 1,
  });

  assert.equal(sentMessages.length, 2);
  assert.ok(sentMessages[0]?.text.includes("[AUDIT: BACKUP DATABASE SELESAI]"));
  assert.ok(sentMessages[0]?.text.includes("Admin"));
  assert.ok(sentMessages[1]?.text.includes("00:00 WIB"));
}));

test("logCloudflareRuleCreated and logCloudflareRuleDeleted format correctly", () => runWithTenant(platformContext(), async () => {
  const { mockApi, sentMessages } = createMockApi();

  await ActivityLogService.logCloudflareRuleCreated(mockApi, {
    admin: { telegramId: 999, firstName: "Admin" },
    email: "test@example.com",
    destinationEmail: "forward@example.com",
    domain: "example.com",
    ruleId: "cf_rule_123",
  });

  await ActivityLogService.logCloudflareRuleDeleted(mockApi, {
    admin: { telegramId: 999, firstName: "Admin" },
    ruleId: "cf_rule_123",
    zoneId: "cf_zone_456",
  });

  assert.equal(sentMessages.length, 2);
  assert.ok(sentMessages[0]?.text.includes("[AUDIT: CLOUDFLARE EMAIL ROUTING DIBUAT]"));
  assert.ok(sentMessages[0]?.text.includes("test@example.com"));
  assert.ok(sentMessages[1]?.text.includes("[AUDIT: CLOUDFLARE EMAIL ROUTING DIHAPUS]"));
  assert.ok(sentMessages[1]?.text.includes("cf_rule_123"));
}));

test("logConfigUpdated formats bot settings updates", () => runWithTenant(platformContext(), async () => {
  const { mockApi, sentMessages } = createMockApi();

  await ActivityLogService.logConfigUpdated(mockApi, {
    admin: { telegramId: 999, firstName: "Admin" },
    moduleName: "Channel Testimonial",
    changeDescription: "Status diubah menjadi AKTIF",
  });

  assert.equal(sentMessages.length, 1);
  assert.ok(sentMessages[0]?.text.includes("[AUDIT: PENGATURAN BOT DIUBAH]"));
  assert.ok(sentMessages[0]?.text.includes("Channel Testimonial"));
  assert.ok(sentMessages[0]?.text.includes("Status diubah menjadi AKTIF"));
}));

test("logAffiliateCommission and logAffiliateWithdrawal format correctly", () => runWithTenant(platformContext(), async () => {
  const { mockApi, sentMessages } = createMockApi();

  await ActivityLogService.logAffiliateCommission(mockApi, {
    referrer: { telegramId: 111, firstName: "Upline" },
    referredUser: { telegramId: 222, firstName: "Downline" },
    sourceType: "DIGITAL_ORDER",
    sourceOrderId: "ORD-555",
    purchaseAmount: 50000,
    commissionAmount: 5000,
    newAffiliateBalance: 15000,
  });

  await ActivityLogService.logAffiliateWithdrawal(mockApi, {
    user: { telegramId: 111, firstName: "Upline" },
    amount: 15000,
    newMainBalance: 25000,
  });

  assert.equal(sentMessages.length, 2);
  assert.ok(sentMessages[0]?.text.includes("[AUDIT: KOMISI AFILIASI DITERIMA]"));
  assert.ok(sentMessages[0]?.text.includes("ORD-555"));
  assert.ok(sentMessages[1]?.text.includes("[AUDIT: PENARIKAN SALDO AFILIASI]"));
  assert.ok(sentMessages[1]?.text.includes("15.000"));
}));

test("logEmailOtpForwarded formats email OTP details", () => runWithTenant(platformContext(), async () => {
  const { mockApi, sentMessages } = createMockApi();

  await ActivityLogService.logEmailOtpForwarded(mockApi, {
    provider: "PAYPAL",
    subject: "Your PayPal Security Code",
    senderEmail: "service@intl.paypal.com",
    recipientEmail: "user@example.com",
    recipientName: "Budi Santoso",
    otpCode: "492810",
    targetChannel: "@mypaypalchannel",
  });

  assert.equal(sentMessages.length, 1);
  assert.ok(sentMessages[0]?.text.includes("[AUDIT: EMAIL OTP DITERUSKAN]"));
  assert.ok(sentMessages[0]?.text.includes("PAYPAL"));
  assert.ok(sentMessages[0]?.text.includes("492810"));
  assert.ok(sentMessages[0]?.text.includes("@mypaypalchannel"));
}));

test("handles Telegram API errors without throwing exceptions", () => runWithTenant(platformContext(), async () => {
  const { mockApi } = createMockApi(true);

  const result = await ActivityLogService.logBalanceAdjusted(mockApi, {
    user: { telegramId: 111, firstName: "User1" },
    type: "CREDIT",
    amount: 10000,
    balanceAfter: 20000,
  });

  assert.equal(result, false);
}));
