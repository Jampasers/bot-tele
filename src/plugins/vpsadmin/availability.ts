import { randomUUID } from "node:crypto";
import { Context, InlineKeyboard } from "grammy";
import type { VpsUiCatalog, VpsUiDependencies } from "../vps/contracts.js";
import { vpsReply } from "../vps/ui.js";
import { DEFAULT_DISABLED_MESSAGE, type VpsAvailabilityRule } from "../../vps/availability.js";

type Catalog = VpsUiCatalog;
type Field = "target" | "size" | "os";
interface Draft {
  token: string;
  expiresAt: number;
  catalog: Catalog;
  kind: VpsAvailabilityRule["kind"];
  target: string;
  size: string | null;
  os: string | null;
  scope?: "all" | "size" | "os" | "both";
  step: Field | "scope" | "message";
}
const back = (): InlineKeyboard => new InlineKeyboard().text("🔙 Disable Spek / OS / Region", "vpa_availability");
const actorOf = (ctx: Context): string => String(ctx.from!.id);

export function availabilityRuleLabel(rule: Pick<VpsAvailabilityRule, "kind" | "target" | "size" | "os">, catalog: Catalog): string {
  const size = (slug: string): string => catalog.sizes.find(item => item.slug === slug)?.label ?? slug;
  const os = (id: string): string => catalog.os.find(item => item.id === id)?.label ?? id;
  const target = rule.kind === "size" ? `Spek: ${size(rule.target)}` : rule.kind === "os" ? `OS: ${os(rule.target)}`
    : `Region: ${catalog.regions.find(item => item.slug === rule.target)?.name ?? rule.target} (${rule.target})`;
  const scope = rule.kind === "size" ? "semua OS & region" : rule.kind === "os"
    ? `${rule.size ? size(rule.size) : "semua spek"} · semua region`
    : `${rule.size ? size(rule.size) : "semua spek"} · ${rule.os ? os(rule.os) : "semua OS"}`;
  return `${target}\nCakupan: ${scope}`;
}

export function createAvailabilityAdmin(
  deps: VpsUiDependencies,
  input: (actor: string, receive: (ctx: Context, value: string) => Promise<void>) => void,
): (ctx: Context, data: string) => Promise<void> {
  const drafts = new Map<string, Draft>();
  async function catalog(): Promise<Catalog> {
    const result = await deps.listCatalog?.();
    if (!result) throw new Error("Katalog belum tersedia.");
    return result;
  }
  function current(ctx: Context, token: string): Draft {
    const draft = drafts.get(actorOf(ctx));
    if (!draft || draft.token !== token || draft.expiresAt <= Date.now()) throw new Error("Sesi disable sudah berakhir. Buka ulang menu.");
    return draft;
  }
  async function home(ctx: Context, offset = 0): Promise<void> {
    drafts.delete(actorOf(ctx));
    const rules = await deps.listAvailabilityRules();
    const data = await catalog();
    const kb = new InlineKeyboard().text("Disable Spek", "vpa_avnew_size").text("Disable OS", "vpa_avnew_os").row()
      .text("Disable Region", "vpa_avnew_region").row();
    rules.slice(offset, offset + 8).forEach(rule => kb.text(`${rule.enabled ? "🔴" : "🟢"} ${availabilityRuleLabel(rule, data).replace(/\n/g, " · ")}`.slice(0, 100), `vpa_avrule_${rule.id}`).row());
    if (offset) kb.text("← Sebelumnya", `vpa_avlist_${Math.max(0, offset - 8)}`);
    if (offset + 8 < rules.length) kb.text("Berikutnya →", `vpa_avlist_${offset + 8}`);
    kb.row().text("🔙 Admin VPS", "vpa_home");
    await vpsReply(ctx, `🚫 Disable Spek / OS / Region\n\nAturan aktif: ${rules.filter(rule => rule.enabled).length}\n\nSpek: semua OS dan region.\nOS: semua spek atau satu spek.\nRegion: semua OS & spek, satu OS di semua spek, satu spek di semua OS, atau satu OS + satu spek.\n\nBerlaku untuk VPS DO dan jasa install. Region hanya berlaku pada DigitalOcean. Opsi nonaktif tetap terlihat; pesan ditampilkan saat dipilih. Pembayaran yang sudah dimulai tetap diselesaikan.\n\nPilih jenis aturan baru, atau buka aturan untuk mengaktifkan kembali pilihan dan mengubah pesan.`, kb);
  }
  async function detail(ctx: Context, id: string): Promise<void> {
    const rule = (await deps.listAvailabilityRules()).find(item => item.id === id);
    if (!rule) throw new Error("Aturan tidak ditemukan.");
    await vpsReply(ctx, `🚫 ${availabilityRuleLabel(rule, await catalog())}\n\nStatus: ${rule.enabled ? "Disable aktif" : "Aturan dimatikan"}\n\nPesan ke user:\n${rule.message}\n\nPilihan tetap diblokir jika ada aturan lain yang cocok atau spek layanan masih nonaktif di menu harga.`, new InlineKeyboard()
      .text(rule.enabled ? "Aktifkan kembali pilihan" : "Disable lagi", `vpa_avtoggle_${id}_${rule.enabled ? "0" : "1"}`).row()
      .text("Ubah pesan disable", `vpa_avmessage_${id}`).row().text("🔙 Daftar aturan", "vpa_availability"));
  }
  function options(draft: Draft, field: Field): { value: string; label: string }[] {
    const kind = field === "target" ? draft.kind : field;
    return kind === "size" ? draft.catalog.sizes.map(item => ({ value: item.slug, label: item.label }))
      : kind === "os" ? draft.catalog.os.map(item => ({ value: item.id, label: item.label }))
      : draft.catalog.regions.map(item => ({ value: item.slug, label: `${item.name} (${item.slug})` }));
  }
  async function pick(ctx: Context, draft: Draft, field: Field, offset = 0): Promise<void> {
    draft.step = field;
    const choices = options(draft, field), kb = new InlineKeyboard();
    choices.slice(offset, offset + 10).forEach((item, index) => kb.text(item.label, `vpa_avpick_${draft.token}_${field}_${offset + index}`).row());
    if (offset) kb.text("← Sebelumnya", `vpa_avpage_${draft.token}_${field}_${Math.max(0, offset - 10)}`);
    if (offset + 10 < choices.length) kb.text("Berikutnya →", `vpa_avpage_${draft.token}_${field}_${offset + 10}`);
    kb.row().text("Batal", "vpa_availability");
    await vpsReply(ctx, field === "target" ? `Pilih ${draft.kind === "size" ? "spek" : draft.kind === "os" ? "OS" : "region"} yang mau di-disable.`
      : `Pilih ${field === "size" ? "spek" : "OS"} untuk cakupan aturan ini.`, kb);
  }
  async function message(ctx: Context, draft: Draft): Promise<void> {
    draft.step = "message";
    input(actorOf(ctx), async (replyCtx, value) => {
      const latest = current(replyCtx, draft.token);
      if (latest.step !== "message") throw new Error("Langkah input berubah.");
      const rule = await deps.saveAvailabilityRule(actorOf(replyCtx), { kind: latest.kind, target: latest.target, size: latest.size, os: latest.os,
        message: value.trim() === "-" ? DEFAULT_DISABLED_MESSAGE : value });
      drafts.delete(actorOf(replyCtx));
      await replyCtx.reply("Aturan disable tersimpan.");
      await detail(replyCtx, rule.id);
    });
    await vpsReply(ctx, `${availabilityRuleLabel(draft, draft.catalog)}\n\nKirim pesan yang muncul saat user memilih opsi ini (maksimal 500 karakter). Kirim - untuk pesan bawaan.\n\nAturan disimpan setelah pesan dikirim. Ketik /batal untuk membatalkan.`, back());
  }
  return async (ctx, data) => {
    for (const [actor, draft] of drafts) if (draft.expiresAt <= Date.now()) drafts.delete(actor);
    if (data === "vpa_availability") { await home(ctx); return; }
    const list = /^vpa_avlist_(\d{1,3})$/.exec(data);
    if (list) { await home(ctx, Number(list[1])); return; }
    const ruleAction = /^vpa_av(rule|toggle|message)_([a-f0-9]{24})(?:_([01]))?$/.exec(data);
    if (ruleAction) {
      const id = ruleAction[2]!;
      if (ruleAction[1] === "message") {
        const rule = (await deps.listAvailabilityRules()).find(item => item.id === id);
        if (!rule) throw new Error("Aturan tidak ditemukan.");
        input(actorOf(ctx), async (replyCtx, value) => {
          await deps.updateAvailabilityRule(actorOf(replyCtx), id, { message: value.trim() === "-" ? DEFAULT_DISABLED_MESSAGE : value });
          await detail(replyCtx, id);
        });
        await vpsReply(ctx, `Pesan saat ini:\n${rule.message}\n\nKirim pesan baru, maksimal 500 karakter. Kirim - untuk pesan bawaan.`, back());
      } else {
        if (ruleAction[1] === "toggle") {
          if (!ruleAction[3]) throw new Error("Status belum dipilih.");
          await deps.updateAvailabilityRule(actorOf(ctx), id, { enabled: ruleAction[3] === "1" });
        }
        await detail(ctx, id);
      }
      return;
    }
    const begin = /^vpa_avnew_(size|os|region)$/.exec(data);
    if (begin) {
      const draft: Draft = { token: randomUUID().slice(0, 8), expiresAt: Date.now() + 10 * 60_000, catalog: await catalog(), kind: begin[1] as Draft["kind"], target: "", size: null, os: null, step: "target" };
      drafts.set(actorOf(ctx), draft);
      await pick(ctx, draft, "target"); return;
    }
    const choice = /^vpa_av(pick|page)_([a-f0-9]{8})_(target|size|os)_(\d{1,3})$/.exec(data);
    if (choice) {
      const draft = current(ctx, choice[2]!), field = choice[3] as Field;
      if (draft.step !== field) throw new Error("Langkah input berubah.");
      if (choice[1] === "page") { await pick(ctx, draft, field, Number(choice[4])); return; }
      const item = options(draft, field)[Number(choice[4])];
      if (!item) throw new Error("Pilihan tidak ditemukan.");
      draft[field] = item.value;
      if (field === "target" && draft.kind !== "size") {
        draft.step = "scope";
        const kb = new InlineKeyboard().text(draft.kind === "os" ? "Semua spek" : "Semua OS & spek", `vpa_avscope_${draft.token}_all`).row()
          .text(draft.kind === "os" ? "Satu spek" : "Satu spek · semua OS", `vpa_avscope_${draft.token}_size`).row();
        if (draft.kind === "region") kb.text("Satu OS · semua spek", `vpa_avscope_${draft.token}_os`).row()
          .text("Satu OS + satu spek", `vpa_avscope_${draft.token}_both`).row();
        kb.text("Batal", "vpa_availability");
        await vpsReply(ctx, "Pilih cakupan disable. Semua berarti berlaku pada seluruh pilihan saat ini dan entri baru.", kb);
      } else if (field === "os" && draft.scope === "both") await pick(ctx, draft, "size");
      else await message(ctx, draft);
      return;
    }
    const scope = /^vpa_avscope_([a-f0-9]{8})_(all|size|os|both)$/.exec(data);
    if (scope) {
      const draft = current(ctx, scope[1]!);
      if (draft.step !== "scope" || (draft.kind !== "region" && scope[2] !== "all" && scope[2] !== "size")) throw new Error("Cakupan tidak valid.");
      draft.scope = scope[2] as NonNullable<Draft["scope"]>;
      if (draft.scope === "all") await message(ctx, draft);
      else await pick(ctx, draft, draft.scope === "size" ? "size" : "os");
      return;
    }
    await home(ctx);
  };
}
