import { Api, InputFile } from "grammy";
import { createWriteStream, mkdirSync, rmSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ZipArchive } from "archiver";
import AdmZip from "adm-zip";
import { Model } from "mongoose";

import { User } from "../models/User.js";
import { DigitalProduct } from "../models/DigitalProduct.js";
import { DigitalStock } from "../models/DigitalStock.js";
import { DigitalOrder } from "../models/DigitalOrder.js";
import { Order } from "../models/Order.js";
import { BotConfig } from "../models/BotConfig.js";
import { SmsConfig } from "../models/SmsConfig.js";
import { PromoCode } from "../models/PromoCode.js";
import { TopupSession } from "../models/TopupSession.js";
import { BalanceLog } from "../models/BalanceLog.js";
import { AffiliateLog } from "../models/AffiliateLog.js";
import { RestockAlert } from "../models/RestockAlert.js";
import { WarrantyClaim } from "../models/WarrantyClaim.js";
import { FraudLog } from "../models/FraudLog.js";
import { Cart } from "../models/Cart.js";
import { ActivityLogService } from "./activityLog.js";
import { SMSBowerService } from "./smsbower.js";
import { clearMaintenanceCache } from "../middlewares/maintenance.js";
import { getAdminIds } from "../core/admin.js";

// ============================================================================
//  Database Backup & Rollback Service
// ============================================================================

export interface BackupCollectionInfo {
  name: string;
  model: Model<any>;
}

export const BACKUP_COLLECTIONS: readonly BackupCollectionInfo[] = [
  { name: "users",           model: User },
  { name: "digitalproducts", model: DigitalProduct },
  { name: "digitalstocks",   model: DigitalStock },
  { name: "digitalorders",   model: DigitalOrder },
  { name: "carts",           model: Cart },
  { name: "orders",          model: Order },
  { name: "botconfigs",      model: BotConfig },
  { name: "smsconfigs",      model: SmsConfig },
  { name: "promocodes",      model: PromoCode },
  { name: "topupsessions",   model: TopupSession },
  { name: "balancelogs",     model: BalanceLog },
  { name: "affiliatelogs",   model: AffiliateLog },
  { name: "restockalerts",   model: RestockAlert },
  { name: "warrantyclaims",  model: WarrantyClaim },
  { name: "fraudlogs",       model: FraudLog },
] as const;

export const COLLECTION_MODEL_MAP = new Map<string, Model<any>>(
  BACKUP_COLLECTIONS.map((c) => [c.name, c.model])
);

export interface InspectedCollection {
  name: string;
  count: number;
  docs: any[];
}

export interface InspectBackupResult {
  success: boolean;
  collections: InspectedCollection[];
  totalDocs: number;
  skippedFiles?: string[];
  error?: string;
}

export interface RollbackResult {
  success: boolean;
  results: { name: string; restored: number; error?: string }[];
  totalRestored: number;
  message: string;
}

/**
 * Exports all registered MongoDB collections to JSON and packages them in a .zip file.
 * Returns the absolute path to the generated zip (caller must delete after use).
 */
export async function createBackupZip(): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const tmpDir = join(tmpdir(), `bot-backup-${timestamp}`);
  const zipPath = join(tmpdir(), `backup-${timestamp}.zip`);

  // Create temp directory
  mkdirSync(tmpDir, { recursive: true });

  // Export each collection to a JSON file
  for (const col of BACKUP_COLLECTIONS) {
    const docs = await col.model.find({}).lean();
    const filePath = join(tmpDir, `${col.name}.json`);
    writeFileSync(filePath, JSON.stringify(docs, null, 2), "utf-8");
  }

  // Package into a zip
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(zipPath);
    const archive = new (ZipArchive as any)({ zlib: { level: 9 } });

    output.on("close", resolve);
    archive.on("error", reject);

    archive.pipe(output);
    archive.directory(tmpDir, false);
    archive.finalize();
  });

  // Clean up temp dir
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }

  return zipPath;
}

/**
 * Creates a backup and sends it to all configured ADMIN_IDs via Telegram.
 */
export async function createAndSendBackup(api: Api): Promise<{ success: boolean; message: string }> {
  const adminIds = getAdminIds();
  if (adminIds.length === 0) {
    return { success: false, message: "ADMIN_ID tidak dikonfigurasi di environment." };
  }

  let zipPath: string | null = null;
  try {
    console.log("[backup] Starting database backup…");
    zipPath = await createBackupZip();

    const now = new Date();
    const label = now.toLocaleString("id-ID", {
      timeZone: "Asia/Jakarta",
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

    const collectionNames = BACKUP_COLLECTIONS.map((c) => c.name).join(", ");

    const sendPromises = adminIds.map((adminId) =>
      api.sendDocument(
        adminId,
        new InputFile(zipPath!, `backup-${now.toISOString().slice(0, 10)}.zip`),
        {
          caption:
            `🗄 <b>Backup Database Otomatis</b>\n` +
            `────────────────────────────────\n\n` +
            `📅 <b>Waktu:</b> ${label} WIB\n` +
            `📦 <b>Koleksi (${BACKUP_COLLECTIONS.length}):</b> <code>${collectionNames}</code>\n\n` +
            `<i>Simpan file ini di tempat yang aman untuk keperluan rollback/restore.</i>`,
          parse_mode: "HTML",
        }
      ).catch((sendErr) => {
        console.error(`[backup] Failed to send backup to admin ${adminId}:`, sendErr);
      })
    );

    await Promise.all(sendPromises);

    console.log(`[backup] Backup sent to ${adminIds.length} admin(s) successfully.`);
    return { success: true, message: `Backup berhasil dibuat dan dikirim ke ${adminIds.length} admin.` };
  } catch (err: any) {
    console.error("[backup] Error:", err);
    return { success: false, message: err?.message ?? "Terjadi kesalahan saat membuat backup." };
  } finally {
    if (zipPath && existsSync(zipPath)) {
      try { rmSync(zipPath, { force: true }); } catch { /* ignore */ }
    }
  }
}

/**
 * Inspects a backup zip buffer and parses its JSON collections.
 */
export function inspectBackupZip(zipBuffer: Buffer): InspectBackupResult {
  try {
    const zip = new AdmZip(zipBuffer);
    const zipEntries = zip.getEntries();

    if (!zipEntries || zipEntries.length === 0) {
      return {
        success: false,
        collections: [],
        totalDocs: 0,
        error: "File zip kosong atau tidak dapat dibaca.",
      };
    }

    const collections: InspectedCollection[] = [];
    const skippedFiles: string[] = [];
    let totalDocs = 0;

    for (const entry of zipEntries) {
      if (entry.isDirectory) continue;
      const fileName = entry.entryName.split("/").pop() || "";
      if (!fileName.endsWith(".json")) {
        skippedFiles.push(fileName);
        continue;
      }

      const colName = fileName.replace(/\.json$/i, "").toLowerCase();
      const model = COLLECTION_MODEL_MAP.get(colName);
      if (!model) {
        skippedFiles.push(fileName);
        continue;
      }

      const contentStr = entry.getData().toString("utf-8");
      let parsed: any;
      try {
        parsed = JSON.parse(contentStr);
      } catch (parseErr: any) {
        return {
          success: false,
          collections: [],
          totalDocs: 0,
          error: `Format JSON tidak valid pada file ${fileName}: ${parseErr?.message || "Syntax error"}`,
        };
      }

      if (!Array.isArray(parsed)) {
        return {
          success: false,
          collections: [],
          totalDocs: 0,
          error: `Isi file ${fileName} harus berupa array JSON ([...]).`,
        };
      }

      collections.push({
        name: colName,
        count: parsed.length,
        docs: parsed,
      });
      totalDocs += parsed.length;
    }

    if (collections.length === 0) {
      return {
        success: false,
        collections: [],
        totalDocs: 0,
        error: "Tidak ditemukan file koleksi database yang dikenali (.json) di dalam zip.",
      };
    }

    // Sort collections according to standard BACKUP_COLLECTIONS order
    collections.sort((a, b) => {
      const idxA = BACKUP_COLLECTIONS.findIndex((c) => c.name === a.name);
      const idxB = BACKUP_COLLECTIONS.findIndex((c) => c.name === b.name);
      return (idxA >= 0 ? idxA : 999) - (idxB >= 0 ? idxB : 999);
    });

    return {
      success: true,
      collections,
      totalDocs,
      skippedFiles,
    };
  } catch (err: any) {
    console.error("[backup] inspectBackupZip error:", err);
    return {
      success: false,
      collections: [],
      totalDocs: 0,
      error: err?.message || "Terjadi kesalahan saat mengekstrak file zip.",
    };
  }
}

/**
 * Executes a database rollback from parsed collection data.
 * Automatically takes a safety backup before restoring collections.
 */
export async function executeRollback(
  collectionsData: InspectedCollection[],
  api?: Api,
  adminUser?: { telegramId: string | number; firstName?: string | undefined; username?: string | undefined }
): Promise<RollbackResult> {
  // 1. Safety Backup
  if (api) {
    try {
      console.log("[rollback] Creating safety backup before rollback...");
      await createAndSendBackup(api);
    } catch (safetyErr) {
      console.error("[rollback] Warning: Failed to create safety backup:", safetyErr);
    }
  }

  const results: { name: string; restored: number; error?: string }[] = [];
  let totalRestored = 0;

  for (const item of collectionsData) {
    const model = COLLECTION_MODEL_MAP.get(item.name);
    if (!model) {
      results.push({ name: item.name, restored: 0, error: "Model tidak dikenali" });
      continue;
    }

    try {
      // Clear existing records in the collection
      await model.deleteMany({});

      if (item.docs.length > 0) {
        // Insert docs using insertMany
        await model.insertMany(item.docs, { ordered: false });
      }

      results.push({ name: item.name, restored: item.docs.length });
      totalRestored += item.docs.length;
      console.log(`[rollback] Restored ${item.docs.length} docs into ${item.name}`);
    } catch (err: any) {
      console.error(`[rollback] Error restoring ${item.name}:`, err);
      try {
        const count = await model.countDocuments();
        results.push({ name: item.name, restored: count, error: err?.message });
        totalRestored += count;
      } catch {
        results.push({ name: item.name, restored: 0, error: err?.message });
      }
    }
  }

  // 2. Invalidate / sync caches
  try {
    clearMaintenanceCache();
  } catch { /* ignore */ }

  try {
    await SMSBowerService.loadData();
  } catch { /* ignore */ }

  // 3. Audit log to channel
  if (api && adminUser) {
    try {
      await ActivityLogService.logDatabaseRollback(api, {
        admin: adminUser,
        collectionsRestored: results.map((r) => ({ name: r.name, count: r.restored })),
        totalRestored,
        date: new Date(),
      });
    } catch (logErr) {
      console.error("[rollback] Failed to send activity log:", logErr);
    }
  }

  return {
    success: true,
    results,
    totalRestored,
    message: "Rollback database berhasil diselesaikan.",
  };
}

/**
 * Schedules a daily backup at 00:00 WIB (UTC+7 = UTC-17:00 = 17:00 UTC previous day).
 * Uses a recursive setTimeout that recalculates the next midnight on every tick.
 */
export function scheduleDailyBackup(api: Api): void {
  function getMsUntilMidnightWIB(): number {
    const now = new Date();
    // WIB = UTC+7
    const utcOffset = 7 * 60 * 60 * 1000;
    const nowWIB = new Date(now.getTime() + utcOffset);
    const midnightWIB = new Date(nowWIB);
    midnightWIB.setUTCHours(0, 0, 0, 0);
    midnightWIB.setUTCDate(midnightWIB.getUTCDate() + 1); // next midnight
    return midnightWIB.getTime() - nowWIB.getTime();
  }

  function scheduleNext() {
    const msUntilMidnight = getMsUntilMidnightWIB();
    console.log(`[backup] Daily backup scheduled in ${Math.round(msUntilMidnight / 3_600_000)}h.`);

    setTimeout(async () => {
      try {
        await createAndSendBackup(api);
      } catch (err) {
        console.error("[backup] Scheduled backup error:", err);
      }
      scheduleNext(); // reschedule for the next midnight
    }, msUntilMidnight);
  }

  scheduleNext();
}
