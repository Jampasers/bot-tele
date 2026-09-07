import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import mongoose, { Types } from "mongoose";
import { Bot } from "grammy";
import { BotRental } from "../models/BotRental.js";
import { RentalPlan } from "../models/RentalPlan.js";
import { platformContext, runWithTenant } from "../tenant/context.js";
import { saveTenantPaymentConfig } from "../payments/tenantPayment.service.js";
import { parseRentalFeatures, provisionRental, saveRentalPlan, validateProvisionIdentity } from "../rental/rentalProvisioning.service.js";
import { validateEncryptionKey } from "../services/crypto.js";

export { parseRentalFeatures, validateProvisionIdentity } from "../rental/rentalProvisioning.service.js";

function argumentList(args: string[]): { positional: string[]; options: Map<string, string | boolean> } {
  const positional: string[] = [];
  const options = new Map<string, string | boolean>();
  for (let index = 0; index < args.length; index++) {
    const item = args[index]!;
    if (["--apply", "--active", "--disabled"].includes(item)) options.set(item, true);
    else if (["--features", "--admins"].includes(item)) {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`Nilai ${item} wajib diisi.`);
      options.set(item, value);
    } else if (item.startsWith("--")) throw new Error("Opsi tidak dikenal.");
    else positional.push(item);
  }
  return { positional, options };
}

async function main(args = process.argv.slice(2)): Promise<void> {
  const { positional, options } = argumentList(args);
  const [command, ...values] = positional;
  if (!command || command === "help") {
    console.log("Rental admin (dry-run default, tambah --apply untuk menyimpan):\n  plan <code> <durationDays> <priceIDR> <name> [--features digital,affiliate] [--disabled]\n  create <ownerTelegramId> <planCode> [--admins id1,id2] [--active]\n  list\n  payment <rentalId> <config.json>\n\ncreate membaca RENTAL_BOT_TOKEN dari environment; token tidak diterima sebagai argumen CLI.\nDefault rental pending dan dapat /renew; --active memberikan masa aktif sesuai paket tanpa invoice.");
    return;
  }
  if (!["plan", "create", "list", "payment"].includes(command)) throw new Error("Perintah tidak dikenal; jalankan help.");
  const apply = options.has("--apply");
  const uri = process.env["MONGODB_URI"];
  if (!uri) throw new Error("MONGODB_URI wajib diisi.");
  await mongoose.connect(uri, { dbName: process.env["DATABASE_NAME"] || "danka-telegram", autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 5000 });
  await runWithTenant(platformContext(), async () => {
    if (command === "plan") {
      const [code, daysRaw, priceRaw, ...nameParts] = values;
      const durationDays = Number(daysRaw);
      const price = Number(priceRaw);
      const name = nameParts.join(" ").trim();
      if (!code || !/^[a-z0-9_-]{1,40}$/.test(code) || !name || name.length > 80 || !Number.isSafeInteger(durationDays) || durationDays < 1 || durationDays > 3650 || !Number.isSafeInteger(price) || price < 1 || price > 1_000_000_000) throw new Error("Gunakan plan <code> <durasi 1-3650 hari> <harga IDR integer> <nama maksimal 80 karakter>.");
      const existing = await RentalPlan.findOne({ code }).lean();
      const featureOption = options.get("--features");
      const enabledFeatures = featureOption === undefined ? existing?.enabledFeatures ?? ["digital", "affiliate"] : parseRentalFeatures(String(featureOption));
      if (apply) await saveRentalPlan({ code, name, durationDays, price, enabledFeatures, enabled: !options.has("--disabled") });
      console.log(`${apply ? "SAVED" : "DRY RUN"}: plan ${code}, ${durationDays} hari, Rp${price}, fitur=${enabledFeatures.join(",")}, enabled=${!options.has("--disabled")}`);
      return;
    }
    if (command === "list") {
      const rentals = BotRental.find().select("tenantId botUsername status expiresAt").lean().cursor();
      for await (const rental of rentals) console.log(`${rental._id} tenant=${rental.tenantId} @${rental.botUsername} status=${rental.status} expiresAt=${rental.expiresAt.toISOString()}`);
      return;
    }
    if (command === "create") {
      const [ownerId, planCode] = values;
      if (!ownerId || !planCode || values.length !== 2) throw new Error("Gunakan create <ownerTelegramId> <planCode>.");
      const token = process.env["RENTAL_BOT_TOKEN"]?.trim() ?? "";
      validateProvisionIdentity(ownerId, token, process.env["BOT_TOKEN"] ?? "");
      const admins = String(options.get("--admins") ?? "").split(",").map(value => value.trim()).filter(Boolean);
      const plan = await RentalPlan.findOne({ code: planCode, enabled: true }).lean();
      if (!plan) throw new Error("Paket aktif tidak ditemukan. Simpan paket dengan perintah plan terlebih dahulu.");
      const active = options.has("--active");
      if (!apply) {
        validateProvisionIdentity(ownerId, token, process.env["BOT_TOKEN"] ?? "");
        validateEncryptionKey();
        if (admins.length > 20 || admins.some(id => !/^[1-9]\d{0,18}$/.test(id))) throw new Error("Admin IDs harus numerik, maksimal 20 admin.");
        let me;
        try { me = await new Bot(token).api.getMe(); }
        catch { throw new Error("Token rental belum berhasil diverifikasi ke Telegram."); }
        if (String(me.id) === process.env["BOT_TOKEN"]?.split(":")[0]) throw new Error("Bot platform tidak dapat dijadikan rental.");
        if (await BotRental.exists({ botId: String(me.id) })) throw new Error("Bot sudah terdaftar sebagai rental.");
        console.log(`DRY RUN: @${me.username}, owner=${ownerId}, plan=${planCode}, status=${active ? "active" : "pending"}`);
        return;
      }
      const created = await provisionRental({ ownerTelegramId: ownerId, planCode, botToken: token, adminTelegramIds: admins, active });
      console.log(`CREATED: @${created.botUsername}, status=${created.status}, rentalId=${created.rentalId}, tenantId=${created.tenantId}`);
      if (apply) console.log("Scheduler platform akan menyalakan bot. Owner membuka /start lalu /renew di bot rental untuk aktivasi/perpanjangan.");
      return;
    }
    const [rentalId, file] = values;
    if (!rentalId || !Types.ObjectId.isValid(rentalId) || !file || values.length !== 2) throw new Error("Gunakan payment <rentalId> <config.json>.");
    const rental = await BotRental.findById(rentalId).lean();
    if (!rental || rental.status === "terminated") throw new Error("Rental tidak tersedia.");
    const source = await readFile(resolve(file), "utf8");
    if (source.length > 2_100_000) throw new Error("Konfigurasi terlalu besar.");
    let input: unknown;
    try { input = JSON.parse(source) as unknown; }
    catch { throw new Error("File konfigurasi harus JSON yang valid."); }
    if (apply) await runWithTenant({ tenantId: rental.tenantId, rentalId, ownerTelegramId: rental.ownerTelegramId, adminTelegramIds: rental.adminTelegramIds }, () => saveTenantPaymentConfig(rental.ownerTelegramId, input));
    console.log(`${apply ? "SAVED" : "DRY RUN: JSON parsed; validation and encryption require --apply"}: payment tenant=${rental.tenantId}`);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  import("dotenv/config").then(() => main()).catch(() => {
    // CLI errors can include a driver URI, a Telegram token, or malformed credential JSON.
    console.error("Rental administration failed. Check command arguments, database connectivity, bot identity, plan and credential configuration privately; no credentials are printed.");
    process.exitCode = 1;
  }).finally(async () => { await mongoose.disconnect(); });
}
