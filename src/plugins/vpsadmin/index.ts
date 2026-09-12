import { Bot, Context, InlineKeyboard } from "grammy";
import type { Plugin } from "../../types/Plugin.js";
import { isAdmin } from "../../core/admin.js";
import { vpsService } from "../../vps/service.js";
import type { VpsCredentialFilter, VpsServiceType, VpsUiCredential, VpsUiDependencies } from "../vps/contracts.js";
import { clearVpsInput, setVpsInput } from "../vps/input.js";
import { isVpsPlatform, vpsDate, vpsPrice, vpsReply } from "../vps/ui.js";

const homeKeyboard = (): InlineKeyboard => new InlineKeyboard().text("🔑 Token & akun DO", "vpa_tokens_all_0").row()
  .text("➕ Tambah token", "vpa_addtoken").text("🔎 Cek semua token", "vpa_checkall").row()
  .text("💰 Paket & harga", "vpa_plans_0").text("➕ Tambah paket", "vpa_addplan").row()
  .text("🔙 Admin", "adm_home");
const known = (value: string | number | null | undefined): string => value === null || value === undefined || value === "" ? "belum diketahui" : String(value).slice(0, 400);
export function vpsCredentialText(credential: VpsUiCredential): string {
  const readiness = credential.enabled && credential.accountStatus === "active" && credential.tokenStatus === "ok" && (credential.available ?? 0) > 0 ? "Siap dicoba" : "Periksa status dan kapasitas akun";
  return `🔑 ${credential.label}\n\nToken: ${credential.enabled ? "aktif" : "nonaktif"}\nPrioritas: ${credential.priority}\nAkun/team: ${known(credential.accountId)}\nStatus akun: ${known(credential.accountStatus)}\nKeterangan akun: ${known(credential.statusMessage)}\nPemeriksaan token: ${known(credential.tokenStatus)}\nLimit droplet: ${known(credential.dropletLimit)}\nTerpakai di seluruh akun: ${known(credential.used)}\nReservasi order: ${known(credential.reserved)}\nKapasitas setelah reservasi: ${known(credential.available)}\nDiperiksa: ${vpsDate(credential.checkedAt)}\nKesiapan: ${readiness}\nCreate terakhir: ${known(credential.lastCreateResult)}\nWaktu create: ${vpsDate(credential.lastCreateAt)}\n\nToken satu akun/team berbagi kapasitas. “Siap dicoba” berarti akun aktif dan slot terpantau tersedia; keberhasilan create baru diketahui dari hasil DigitalOcean.`;
}
function numeric(value: string, min: number, max: number): number {
  if (!/^\d+$/.test(value.trim())) throw new Error("Invalid number");
  const result = Number(value.trim());
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new Error("Invalid number");
  return result;
}
function shortText(value: string, max = 80): string {
  const result = value.trim();
  if (!result || result.length > max || /[\r\n\x00-\x1f]/.test(result)) throw new Error("Invalid label");
  return result;
}

export function createVpsAdminPlugin(overrides: Partial<VpsUiDependencies> = {}): Plugin {
  const deps: VpsUiDependencies = { ...vpsService, ...overrides };
  const actorOf = (ctx: Context): string => String(ctx.from!.id);
  function authorized(handler: (ctx: Context) => Promise<void>): (ctx: Context) => Promise<void> {
    return async ctx => {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => {});
      if (!ctx.from || !isVpsPlatform() || !isAdmin(ctx) || ctx.chat?.type !== "private") {
        if (ctx.chat) await ctx.reply("Hanya admin melalui chat pribadi bot utama.");
        return;
      }
      try { await handler(ctx); }
      catch { await ctx.reply("Pengaturan VPS belum dapat diproses. Periksa input atau status akun dan coba kembali.", { reply_markup: homeKeyboard() }).catch(() => {}); }
    };
  }
  function input(actor: string, receive: (ctx: Context, value: string) => Promise<void>, secret = false): void {
    setVpsInput(actor, { secret, receive: async (ctx, value) => {
      if (!isVpsPlatform() || !isAdmin(ctx) || ctx.chat?.type !== "private") throw new Error("Unauthorized admin");
      await receive(ctx, value);
    } });
  }
  async function home(ctx: Context): Promise<void> {
    clearVpsInput(actorOf(ctx));
    await vpsReply(ctx, `🖥️ Admin VPS DigitalOcean\n\nPemesanan baru: ${deps.enabled() ? "aktif" : "nonaktif (VPS_ENABLED)"}\n\nAtur token toko dan harga dari database. Token buyer hanya berada sementara di memori dan tidak ditampilkan pada admin.\n\nPemeriksaan akun menggunakan GET tanpa membuat droplet percobaan.`, homeKeyboard());
  }
  async function credentialDetail(ctx: Context, id: string): Promise<void> {
    const credential = await deps.getCredential(actorOf(ctx), id);
    if (!credential) throw new Error("Credential unavailable");
    await vpsReply(ctx, vpsCredentialText(credential), new InlineKeyboard().text("🔎 Cek token", `vpa_check_${id}`).row()
      .text(credential.enabled ? "Nonaktifkan" : "Aktifkan", `vpa_enable_${id}_${credential.enabled ? "0" : "1"}`).text("Prioritas", `vpa_priority_${id}`).row()
      .text("🔙 Token & akun", "vpa_tokens_all_0"));
  }
  async function planDetail(ctx: Context, id: string): Promise<void> {
    const plan = (await deps.listPlans(undefined, true)).find(item => item.id === id);
    if (!plan) throw new Error("Plan unavailable");
    const keyboard = new InlineKeyboard();
    plan.osPrices.forEach((os, index) => keyboard.text(`Ubah harga ${os.label}`, `vpa_price_${id}_${index}`).row());
    keyboard.text(plan.enabled ? "Nonaktifkan paket" : "Aktifkan paket", `vpa_planenable_${id}_${plan.enabled ? "0" : "1"}`).row().text("🔙 Paket", "vpa_plans_0");
    await vpsReply(ctx, `💰 ${plan.name}\n\nLayanan: ${plan.serviceType === "install" ? "Jasa setup/install" : "Beli VPS"}\nSpek: ${plan.sizeSlug}\nRegion: ${plan.regions.join(", ")}\nStatus: ${plan.enabled ? "aktif" : "nonaktif"}\n\n${plan.osPrices.map(os => `${os.label}: ${vpsPrice(os.price)}`).join("\n")}\n\nPerubahan harga hanya berlaku pada checkout baru.`, keyboard);
  }
  async function addToken(ctx: Context): Promise<void> {
    const actor = actorOf(ctx);
    clearVpsInput(actor);
    input(actor, async (labelCtx, value) => {
      const label = shortText(value);
      input(actor, async (priorityCtx, priorityValue) => {
        const priority = numeric(priorityValue, 0, 10_000);
        input(actor, async (tokenCtx, tokenValue) => {
          const credential = await deps.addCredential(actor, { label, priority, token: tokenValue.trim() });
          await tokenCtx.reply("Token telah divalidasi dan disimpan terenkripsi.");
          await credentialDetail(tokenCtx, credential.id);
        }, true);
        await priorityCtx.reply("(3/3) Kirim token DigitalOcean. Pesan harus berhasil dihapus sebelum token diproses. Ketik /batal untuk membatalkan.");
      });
      await labelCtx.reply("(2/3) Kirim angka prioritas 0–10000. Angka lebih kecil dipilih lebih dahulu.");
    });
    await vpsReply(ctx, "➕ Tambah token toko\n\n(1/3) Kirim label akun/token (maksimal 80 karakter). Ketik /batal untuk membatalkan.", new InlineKeyboard().text("Batal", "vpa_home"));
  }
  async function addPlan(ctx: Context, serviceType: VpsServiceType): Promise<void> {
    const actor = actorOf(ctx);
    clearVpsInput(actor);
    input(actor, async (nameCtx, value) => {
      const name = shortText(value);
      input(actor, async (sizeCtx, sizeValue) => {
        const sizeSlug = shortText(sizeValue, 64);
        if (!/^[a-z0-9-]+$/.test(sizeSlug)) throw new Error("Invalid size");
        input(actor, async (regionCtx, regionValue) => {
          const regions = [...new Set(regionValue.trim().split(/[,\s]+/))];
          if (!regions.length || regions.length > 30 || regions.some(region => !/^[a-z]{2,10}\d{1,2}$/.test(region))) throw new Error("Invalid regions");
          const osList = deps.listOs();
          const keyboard = new InlineKeyboard();
          osList.forEach((os, index) => keyboard.text(os.label, `vpa_newos_${index}`).row());
          pendingPlans.set(actor, { name, serviceType, sizeSlug, regions, expiresAt: Date.now() + 10 * 60_000 });
          await regionCtx.reply("(4/5) Pilih OS. Buat paket terpisah untuk OS dengan harga berbeda.", { reply_markup: keyboard.text("Batal", "vpa_home") });
        });
        await sizeCtx.reply("(3/5) Kirim slug region yang ditawarkan, pisahkan dengan koma. Contoh: sgp1,fra1. Ketersediaan aktual divalidasi melalui DO saat checkout.");
      });
      await nameCtx.reply("(2/5) Kirim slug size DigitalOcean. Contoh: s-1vcpu-2gb.");
    });
    await vpsReply(ctx, `➕ Paket ${serviceType === "install" ? "jasa setup/install" : "VPS toko"}\n\n(1/5) Kirim nama paket. Ketik /batal untuk membatalkan.`, new InlineKeyboard().text("Batal", "vpa_home"));
  }
  const pendingPlans = new Map<string, { name: string; serviceType: VpsServiceType; sizeSlug: string; regions: string[]; expiresAt: number }>();

  return {
    name: "vpsadmin", version: "1.0.0", internalOnly: true,
    commands: [{ command: "vpsadmin", description: "[Admin] Token DigitalOcean dan harga VPS" }],
    register(bot: Bot<Context>): void {
      bot.command("vpsadmin", authorized(home));
      bot.callbackQuery(/^vpa_/, authorized(async ctx => {
        const data = ctx.callbackQuery!.data!;
        const actor = actorOf(ctx);
        clearVpsInput(actor);
        if (data === "vpa_home") { pendingPlans.delete(actor); await home(ctx); return; }
        if (data === "vpa_addtoken") { await addToken(ctx); return; }
        if (data === "vpa_checkall") {
          await ctx.reply("Pemeriksaan seluruh token dimulai dengan concurrency terbatas. Buka daftar token untuk melihat waktu dan hasil pemeriksaan.");
          await deps.checkAllCredentials(actor);
          await ctx.reply("Pemeriksaan seluruh token selesai.", { reply_markup: homeKeyboard() });
          return;
        }
        if (data === "vpa_addplan") {
          await vpsReply(ctx, "Pilih jenis layanan untuk harga paket:", new InlineKeyboard().text("Beli VPS", "vpa_new_purchase").text("Jasa install", "vpa_new_install").row().text("Batal", "vpa_home"));
          return;
        }
        if (data === "vpa_new_purchase" || data === "vpa_new_install") { await addPlan(ctx, data === "vpa_new_install" ? "install" : "purchase"); return; }
        const newOs = /^vpa_newos_(\d{1,3})$/.exec(data);
        if (newOs) {
          const pending = pendingPlans.get(actor);
          const os = deps.listOs()[Number(newOs[1])];
          if (!pending || !os || pending.expiresAt <= Date.now()) throw new Error("Expired wizard");
          pendingPlans.delete(actor);
          input(actor, async (priceCtx, value) => {
            const price = numeric(value, 1, 100_000_000);
            const plan = await deps.savePlan(actor, { name: pending.name, serviceType: pending.serviceType, sizeSlug: pending.sizeSlug, regions: pending.regions, osPrices: [{ os: os.id, label: os.label, price }], enabled: true });
            await priceCtx.reply("Paket dan harga tersimpan di database.");
            await planDetail(priceCtx, plan.id);
          });
          await vpsReply(ctx, `(5/5) ${pending.name}\nOS: ${os.label}\n\nKirim ${pending.serviceType === "install" ? "biaya jasa" : "harga jual"} dalam Rupiah (angka bulat).`, new InlineKeyboard().text("Batal", "vpa_home"));
          return;
        }
        const list = /^vpa_tokens_(all|active|warning|locked|available|problem)_(\d{1,6})$/.exec(data);
        if (list) {
          const filter = list[1] as VpsCredentialFilter;
          const offset = Number(list[2]);
          const credentials = await deps.listCredentials(actor, filter, offset, 8);
          const keyboard = new InlineKeyboard().text("Semua", "vpa_tokens_all_0").text("Active", "vpa_tokens_active_0").text("Warning", "vpa_tokens_warning_0").row()
            .text("Locked", "vpa_tokens_locked_0").text("Slot tersedia", "vpa_tokens_available_0").text("Token bermasalah", "vpa_tokens_problem_0").row();
          credentials.forEach(credential => keyboard.text(`${credential.enabled ? "🟢" : "⚪"} ${credential.label} · ${known(credential.tokenStatus)}`, `vpa_credential_${credential.id}`).row());
          if (offset) keyboard.text("← Sebelumnya", `vpa_tokens_${filter}_${Math.max(0, offset - 8)}`);
          if (credentials.length === 8) keyboard.text("Berikutnya →", `vpa_tokens_${filter}_${offset + 8}`);
          keyboard.row().text("🔙 Admin VPS", "vpa_home");
          await vpsReply(ctx, `🔑 Token & akun DO · ${filter}\n\n${credentials.length ? credentials.map(c => `${c.label}: ${known(c.accountStatus)} · slot ${known(c.available)}\nDiperiksa: ${vpsDate(c.checkedAt)}`).join("\n\n") : "Belum ada token pada filter/halaman ini."}`, keyboard);
          return;
        }
        const plans = /^vpa_plans_(\d{1,6})$/.exec(data);
        if (plans) {
          const offset = Number(plans[1]);
          const allPlans = await deps.listPlans(undefined, true);
          const page = allPlans.slice(offset, offset + 10);
          const keyboard = new InlineKeyboard();
          page.forEach(plan => keyboard.text(`${plan.enabled ? "🟢" : "⚪"} ${plan.name} · ${plan.serviceType}`, `vpa_plan_${plan.id}`).row());
          if (offset) keyboard.text("← Sebelumnya", `vpa_plans_${Math.max(0, offset - 10)}`);
          if (offset + 10 < allPlans.length) keyboard.text("Berikutnya →", `vpa_plans_${offset + 10}`);
          keyboard.row().text("➕ Tambah paket", "vpa_addplan").text("🔙 Admin VPS", "vpa_home");
          await vpsReply(ctx, "💰 Paket & harga VPS\n\nHarga jual VPS dan biaya jasa install disimpan terpisah. Pilih paket untuk mengubah harga atau status.", keyboard);
          return;
        }
        const item = /^vpa_(credential|check|priority|plan)_([A-Za-z0-9-]{1,40})$/.exec(data);
        if (item) {
          const id = item[2]!;
          if (item[1] === "plan") await planDetail(ctx, id);
          else if (item[1] === "credential") await credentialDetail(ctx, id);
          else if (item[1] === "check") { await deps.checkCredential(actor, id); await credentialDetail(ctx, id); }
          else {
            if (!await deps.getCredential(actor, id)) throw new Error("Credential unavailable");
            input(actor, async (priorityCtx, value) => { await deps.updateCredential(actor, id, { priority: numeric(value, 0, 10_000) }); await credentialDetail(priorityCtx, id); });
            await vpsReply(ctx, "Kirim prioritas baru (0–10000). Angka lebih kecil dipilih lebih dahulu.", new InlineKeyboard().text("Batal", "vpa_home"));
          }
          return;
        }
        const toggle = /^vpa_(enable|planenable)_([A-Za-z0-9-]{1,40})_([01])$/.exec(data);
        if (toggle) {
          const id = toggle[2]!;
          const enabled = toggle[3] === "1";
          if (toggle[1] === "enable") { await deps.updateCredential(actor, id, { enabled }); await credentialDetail(ctx, id); }
          else { await deps.updatePlan(actor, id, { enabled }); await planDetail(ctx, id); }
          return;
        }
        const price = /^vpa_price_([A-Za-z0-9-]{1,40})_(\d{1,3})$/.exec(data);
        if (price) {
          const id = price[1]!;
          const plan = (await deps.listPlans(undefined, true)).find(item => item.id === id);
          const os = plan?.osPrices[Number(price[2])];
          if (!plan || !os) throw new Error("Plan unavailable");
          input(actor, async (priceCtx, value) => { await deps.updatePlan(actor, id, { price: numeric(value, 1, 100_000_000), os: os.os }); await planDetail(priceCtx, id); });
          await vpsReply(ctx, `Kirim harga baru untuk ${plan.name} / ${os.label} dalam Rupiah. Pesanan existing tetap memakai snapshot checkout.`, new InlineKeyboard().text("Batal", "vpa_home"));
          return;
        }
        await home(ctx);
      }));
    },
  };
}
export default createVpsAdminPlugin();
