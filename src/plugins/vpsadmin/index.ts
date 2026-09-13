import { Bot, Context, InlineKeyboard } from "grammy";
import type { Plugin } from "../../types/Plugin.js";
import { isAdmin } from "../../core/admin.js";
import { vpsService } from "../../vps/service.js";
import { planPrice } from "../../vps/catalogPlans.js";
import type { VpsCredentialFilter, VpsUiCredential, VpsUiDependencies } from "../vps/contracts.js";
import { clearVpsInput, setVpsInput } from "../vps/input.js";
import { isVpsPlatform, vpsDate, vpsPrice, vpsReply } from "../vps/ui.js";

const homeKeyboard = (): InlineKeyboard => new InlineKeyboard().text("🔑 Token & akun DO", "vpa_tokens_all_0").row()
  .text("➕ Tambah token", "vpa_addtoken").text("🔎 Cek semua token", "vpa_checkall").row()
  .text("💰 Harga per spek / region / OS", "vpa_plans_0").row()
  .text("🧩 Katalog OS/region/spek", "vpa_catalog").row()
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
  async function getPlan(id: string) {
    const plan = (await deps.listPlans(undefined, true)).find(item => item.id === id);
    if (!plan) throw new Error("Spec unavailable");
    return plan;
  }
  async function planDetail(ctx: Context, id: string): Promise<void> {
    const plan = await getPlan(id);
    const keyboard = new InlineKeyboard();
    plan.regions.forEach((region, index) => keyboard.text(plan.regionLabels?.[region] ?? region, `vpa_os_${id}_${index}_0`).row());
    keyboard.text(plan.enabled ? "Nonaktifkan spek" : "Aktifkan spek", `vpa_planenable_${id}_${plan.enabled ? "0" : "1"}`).row().text("🔙 Spek & layanan", "vpa_plans_0");
    await vpsReply(ctx, `💰 ${plan.serviceType === "install" ? "Jasa install" : "VPS DO"}\n${plan.sizeLabel ?? plan.name}\n\nPilih region untuk mengatur harga setiap OS. Harga belum diatur berarti kombinasi belum dapat dibayar.`, keyboard);
  }
  async function osPrices(ctx: Context, id: string, regionIndex: number, offset: number): Promise<void> {
    const plan = await getPlan(id), region = plan.regions[regionIndex];
    if (!region) throw new Error("Region unavailable");
    const keyboard = new InlineKeyboard();
    plan.osPrices.slice(offset, offset + 10).forEach((os, index) => {
      const price = planPrice(plan, region, os.os);
      keyboard.text(`${os.label} · ${price ? vpsPrice(price) : "Belum diatur"}`, `vpa_set_${id}_${regionIndex}_${offset + index}`).row();
    });
    if (offset) keyboard.text("← Sebelumnya", `vpa_os_${id}_${regionIndex}_${Math.max(0, offset - 10)}`);
    if (offset + 10 < plan.osPrices.length) keyboard.text("Berikutnya →", `vpa_os_${id}_${regionIndex}_${offset + 10}`);
    keyboard.row().text("🔙 Region", `vpa_plan_${id}`);
    await vpsReply(ctx, `💰 ${plan.serviceType === "install" ? "Jasa install" : "VPS DO"} · ${plan.sizeLabel ?? plan.name}\nRegion: ${plan.regionLabels?.[region] ?? region}\n\nPilih OS untuk mengisi harga Rupiah. Perubahan berlaku pada checkout baru.`, keyboard);
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

  async function catalogHome(ctx: Context): Promise<void> {
    const catalog = await deps.listCatalog?.();
    if (!catalog) throw new Error("Katalog belum tersedia");
    await vpsReply(ctx, `🧩 Katalog VPS\n\nRegion: ${catalog.regions.length}\nSpek: ${catalog.sizes.length}\nOS: ${catalog.os.length}\n\nEntri baru langsung tersedia di menu pembeli. Atur harga kombinasinya melalui menu harga.`, new InlineKeyboard()
      .text("➕ Region", "vpa_addregion").text("➕ Spek", "vpa_addsize").row().text("➕ OS", "vpa_addos").row().text("🔙 Admin VPS", "vpa_home"));
  }
  async function addCatalog(ctx: Context, kind: "region" | "size" | "os"): Promise<void> {
    if (!deps.addCatalogEntry) throw new Error("Catalog unavailable");
    const actor = actorOf(ctx), values: string[] = [];
    const fields = kind === "region" ? ["slug region, contoh sgp1", "nama region, contoh Singapore", "negara, contoh Singapore"]
      : kind === "size" ? ["slug DigitalOcean, contoh s-2vcpu-4gb", "jumlah CPU, contoh 2", "RAM, contoh 4 GB", "disk, contoh 80 GB", "transfer, contoh 4 TB", "label biaya DigitalOcean, contoh $24/month"]
      : ["key OS, contoh ubuntu24", "nama OS", "slug image DigitalOcean (Windows: ubuntu-24-04-x64)", "family OS: linux atau windows", "nama image Windows installer, contoh Windows Server 2022 ServerStandard"];
    async function prompt(target: Context, index: number): Promise<void> {
      input(actor, async (replyCtx, value) => {
        values.push(shortText(value, 100));
        if (index + 1 < fields.length && !(kind === "os" && index === 3 && value.trim() === "linux")) {
          await prompt(replyCtx, index + 1); return;
        }
        await deps.addCatalogEntry!(actor, { kind, value: values });
        await replyCtx.reply("Entri katalog tersimpan. Atur harga kombinasinya melalui menu harga.");
        await catalogHome(replyCtx);
      });
      await vpsReply(target, `➕ Tambah ${kind}\n\nKirim ${fields[index]}.\nKetik /batal untuk membatalkan.`, new InlineKeyboard().text("Batal", "vpa_catalog"));
    }
    await prompt(ctx, 0);
  }

  return {
    name: "vpsadmin", version: "1.0.0", internalOnly: true,
    commands: [{ command: "vpsadmin", description: "[Admin] Token DigitalOcean dan harga VPS" }],
    register(bot: Bot<Context>): void {
      bot.command("vpsadmin", authorized(home));
      bot.callbackQuery(/^vpa_/, authorized(async ctx => {
        const data = ctx.callbackQuery!.data!;
        const actor = actorOf(ctx);
        clearVpsInput(actor);
        if (data === "vpa_home") { await home(ctx); return; }
        if (data === "vpa_catalog") { await catalogHome(ctx); return; }
        if (data === "vpa_addregion" || data === "vpa_addsize" || data === "vpa_addos") { await addCatalog(ctx, data === "vpa_addregion" ? "region" : data === "vpa_addsize" ? "size" : "os"); return; }
        if (data === "vpa_addtoken") { await addToken(ctx); return; }
        if (data === "vpa_checkall") {
          await ctx.reply("Pemeriksaan seluruh token dimulai dengan concurrency terbatas. Buka daftar token untuk melihat waktu dan hasil pemeriksaan.");
          await deps.checkAllCredentials(actor);
          await ctx.reply("Pemeriksaan seluruh token selesai.", { reply_markup: homeKeyboard() });
          return;
        }
        if (data === "vpa_addplan" || data.startsWith("vpa_new")) { await catalogHome(ctx); return; }
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
          page.forEach(plan => keyboard.text(`${plan.enabled ? "🟢" : "⚪"} ${plan.serviceType === "install" ? "Install" : "VPS DO"} · ${plan.sizeLabel ?? plan.name}`, `vpa_plan_${plan.id}`).row());
          if (offset) keyboard.text("← Sebelumnya", `vpa_plans_${Math.max(0, offset - 10)}`);
          if (offset + 10 < allPlans.length) keyboard.text("Berikutnya →", `vpa_plans_${offset + 10}`);
          keyboard.row().text("🧩 Katalog", "vpa_catalog").text("🔙 Admin VPS", "vpa_home");
          await vpsReply(ctx, "💰 Paket & harga VPS\n\nSemua spek katalog sudah tersedia. Pilih layanan/spek, lalu region dan OS untuk mengisi harga.", keyboard);
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
        const pricePage = /^vpa_os_([A-Za-z0-9-]{1,40})_(\d{1,3})_(\d{1,3})$/.exec(data);
        if (pricePage) { await osPrices(ctx, pricePage[1]!, Number(pricePage[2]), Number(pricePage[3])); return; }
        const price = /^vpa_set_([A-Za-z0-9-]{1,40})_(\d{1,3})_(\d{1,3})$/.exec(data);
        if (price) {
          const plan = await getPlan(price[1]!), region = plan.regions[Number(price[2])], os = plan.osPrices[Number(price[3])];
          if (!region || !os) throw new Error("Combination unavailable");
          input(actor, async (priceCtx, value) => {
            await deps.updatePlan(actor, plan.id, { region, os: os.os, price: numeric(value, 1, 100_000_000) });
            await priceCtx.reply("Harga kombinasi tersimpan.");
            await osPrices(priceCtx, plan.id, Number(price[2]), Math.floor(Number(price[3]) / 10) * 10);
          });
          await vpsReply(ctx, `Kirim harga Rupiah untuk ${plan.serviceType === "install" ? "Jasa install" : "VPS DO"}\n${plan.sizeLabel ?? plan.name}\nRegion: ${region}\nOS: ${os.label}\n\nAngka bulat 1–100000000. Order sebelumnya tetap memakai harga checkout.`, new InlineKeyboard().text("Batal", `vpa_plan_${plan.id}`));
          return;
        }
        await home(ctx);
      }));
    },
  };
}
export default createVpsAdminPlugin();
