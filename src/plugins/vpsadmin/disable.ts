import { randomUUID } from "node:crypto";
import { Context, InlineKeyboard } from "grammy";
import type { VpsUiDependencies } from "../vps/contracts.js";
import { vpsReply } from "../vps/ui.js";
import { DEFAULT_VPS_DISABLE_MESSAGE, type VpsDisableRuleInput, type VpsDisableService } from "../../vps/availability.js";

const services: { value: VpsDisableService; label: string }[] = [
  { value: "all", label: "Semua layanan" }, { value: "purchase", label: "VPS DO toko" },
  { value: "install-do", label: "Jasa install DO buyer" }, { value: "install-direct", label: "Jasa install VPS buyer" },
];
const targets = [{ value: "size", label: "Spek" }, { value: "os", label: "OS" }, { value: "region", label: "Region" }] as const;
type Field = "service" | "target" | "sizeSlug" | "os" | "region";
type Catalog = NonNullable<Awaited<ReturnType<NonNullable<VpsUiDependencies["listCatalog"]>>>>;
interface Draft {
  id: string;
  expiresAt: number;
  catalog: Catalog;
  rule: VpsDisableRuleInput;
  field: Field;
}

function summary(rule: VpsDisableRuleInput, catalog: Catalog): string {
  const size = rule.sizeSlug === "*" ? "semua spek" : catalog.sizes.find(size => size.slug === rule.sizeSlug)?.label ?? rule.sizeSlug;
  const os = rule.os === "*" ? "semua OS" : catalog.os.find(os => os.id === rule.os)?.label ?? rule.os;
  const region = rule.region === "*" ? "semua region" : catalog.regions.find(region => region.slug === rule.region)?.name ?? rule.region;
  const service = services.find(service => service.value === rule.service)?.label ?? rule.service;
  return `${service}\nSpek: ${size}\nOS: ${os}\nRegion: ${region}`;
}

export function createVpsDisableAdmin(deps: VpsUiDependencies,
  input: (actor: string, receive: (ctx: Context, value: string) => Promise<void>) => void,
) {
  const drafts = new Map<string, Draft>();
  const actorOf = (ctx: Context): string => String(ctx.from!.id);
  const back = () => new InlineKeyboard().text("Kembali", "vpa_disable_0");
  async function catalog(): Promise<Catalog> {
    const value = await deps.listCatalog?.();
    if (!value) throw new Error("Katalog belum tersedia.");
    return value;
  }
  async function list(ctx: Context, offset = 0): Promise<void> {
    drafts.delete(actorOf(ctx));
    const rules = await deps.listDisableRules!(actorOf(ctx));
    const choices = await catalog();
    const keyboard = new InlineKeyboard().text("Tambah aturan disable", "vpa_dnew").row();
    rules.slice(offset, offset + 8).forEach(rule => {
      const label = rule.target === "size" ? choices.sizes.find(size => size.slug === rule.sizeSlug)?.label ?? rule.sizeSlug
        : rule.target === "os" ? choices.os.find(os => os.id === rule.os)?.label ?? rule.os
        : choices.regions.find(region => region.slug === rule.region)?.name ?? rule.region;
      keyboard.text(`${targets.find(target => target.value === rule.target)?.label}: ${label}`.slice(0, 100), `vpa_drule_${rule.id}`).row();
    });
    if (offset) keyboard.text("← Sebelumnya", `vpa_disable_${Math.max(0, offset - 8)}`);
    if (offset + 8 < rules.length) keyboard.text("Berikutnya →", `vpa_disable_${offset + 8}`);
    keyboard.row().text("Admin VPS", "vpa_home");
    await vpsReply(ctx, `Disable Spek / OS / Region\n\nAturan aktif: ${rules.length}\n\nSpek: semua OS dan region pada spek tersebut.\nOS: semua spek atau satu spek.\nRegion: semua spek/OS, satu spek, satu OS, atau kombinasi spek + OS.\n\nSetiap aturan punya pesan untuk user. Pilihan tetap tampil dan ditolak saat dipilih. Toggle spek di menu harga juga tetap berlaku.`, keyboard);
  }
  async function detail(ctx: Context, id: string): Promise<void> {
    const rule = (await deps.listDisableRules!(actorOf(ctx))).find(rule => rule.id === id);
    if (!rule) { await list(ctx); return; }
    await vpsReply(ctx, `Aturan disable\n\n${summary(rule, await catalog())}\n\nPesan user:\n${rule.message}\n\nAktifkan kembali menghapus aturan ini. Pilihan tetap diblokir jika ada aturan lain atau toggle spek yang masih nonaktif.`, new InlineKeyboard()
      .text("Aktifkan kembali", `vpa_dremove_${rule.id}`).row()
      .text("Ubah pesan", `vpa_dmessage_${rule.id}`).row().text("Kembali", "vpa_disable_0"));
  }
  function options(draft: Draft): { value: string; label: string }[] {
    switch (draft.field) {
      case "service": return services;
      case "target": return targets.filter(target => draft.rule.service !== "install-direct" || target.value !== "region").map(target => ({ ...target }));
      case "sizeSlug": return [
        ...(draft.rule.target === "size" ? [] : [{ value: "*", label: "Semua spek (global)" }]),
        ...draft.catalog.sizes.map(size => ({ value: size.slug, label: size.label })),
      ];
      case "os": return [
        ...(draft.rule.target === "os" ? [] : [{ value: "*", label: "Semua OS (global)" }]),
        ...draft.catalog.os.map(os => ({ value: os.id, label: os.label })),
      ];
      case "region": return draft.catalog.regions.map(region => ({ value: region.slug, label: `${region.name} (${region.slug})` }));
    }
  }
  async function choose(ctx: Context, draft: Draft, offset = 0): Promise<void> {
    const choices = options(draft);
    const keyboard = new InlineKeyboard();
    choices.slice(offset, offset + 8).forEach((choice, index) => keyboard.text(choice.label, `vpa_dpick_${draft.id}_${draft.field}_${offset + index}`).row());
    if (offset) keyboard.text("← Sebelumnya", `vpa_dpage_${draft.id}_${Math.max(0, offset - 8)}`);
    if (offset + 8 < choices.length) keyboard.text("Berikutnya →", `vpa_dpage_${draft.id}_${offset + 8}`);
    keyboard.row().text("Batal", "vpa_disable_0");
    const prompt = draft.field === "service" ? "Berlaku untuk layanan mana?"
      : draft.field === "target" ? "Apa yang mau dinonaktifkan?"
      : draft.field === "sizeSlug" ? draft.rule.target === "size" ? "Pilih spek yang dinonaktifkan." : "Berlaku untuk semua spek atau satu spek?"
      : draft.field === "os" ? draft.rule.target === "os" ? "Pilih OS yang dinonaktifkan." : "Berlaku untuk semua OS atau satu OS?"
      : "Pilih region yang dinonaktifkan.";
    await vpsReply(ctx, `Tambah aturan disable\n\n${prompt}${draft.field === "service" || draft.field === "target" ? "" : `\n\n${summary(draft.rule, draft.catalog)}`}`, keyboard);
  }
  async function message(ctx: Context, rule: VpsDisableRuleInput, after: (ctx: Context) => Promise<void>): Promise<void> {
    const actor = actorOf(ctx);
    async function receive(replyCtx: Context, value: string): Promise<void> {
      const text = value.trim() === "-" ? DEFAULT_VPS_DISABLE_MESSAGE : value.trim();
      if (!text || text.length > 200 || /[\x00-\x1f\x7f]/.test(text)) {
        input(actor, receive);
        await replyCtx.reply("Kirim pesan 1–200 karakter dalam satu baris, atau - untuk pesan default.");
        return;
      }
      await deps.saveDisableRule!(actor, { ...rule, message: text });
      drafts.delete(actor);
      await replyCtx.reply("Aturan disable dan pesan user tersimpan.");
      await after(replyCtx);
    }
    input(actor, receive);
    await vpsReply(ctx, `Pesan saat user memilih opsi yang dinonaktifkan\n\n${summary(rule, await catalog())}\n\nKirim pesan 1–200 karakter dalam satu baris. Kirim - untuk pesan default:\n${DEFAULT_VPS_DISABLE_MESSAGE}\n\nAturan disimpan setelah pesan dikirim.`, back());
  }
  function current(ctx: Context, id: string): Draft | null {
    const draft = drafts.get(actorOf(ctx));
    return draft?.id === id && draft.expiresAt > Date.now() ? draft : null;
  }
  return {
    clear(actor: string): void { drafts.delete(actor); },
    async handle(ctx: Context, data: string): Promise<boolean> {
      if (!/^vpa_(disable_|dnew$|dpick_|dpage_|drule_|dremove_|dmessage_)/.test(data)) return false;
      if (!deps.listDisableRules || !deps.saveDisableRule || !deps.removeDisableRule) throw new Error("Disable belum tersedia.");
      const page = /^vpa_disable_(\d{1,3})$/.exec(data);
      if (page) { await list(ctx, Number(page[1])); return true; }
      if (data === "vpa_dnew") {
        for (const [actor, draft] of drafts) if (draft.expiresAt <= Date.now()) drafts.delete(actor);
        const draft: Draft = { id: randomUUID(), expiresAt: Date.now() + 10 * 60_000, catalog: await catalog(), field: "service",
          rule: { service: "all", target: "size", sizeSlug: "*", os: "*", region: "*", message: DEFAULT_VPS_DISABLE_MESSAGE } };
        drafts.set(actorOf(ctx), draft);
        await choose(ctx, draft); return true;
      }
      const action = /^vpa_d(rule|remove|message)_([a-f0-9]{24})$/.exec(data);
      if (action) {
        const id = action[2]!;
        if (action[1] === "rule") await detail(ctx, id);
        else if (action[1] === "remove") { await deps.removeDisableRule(actorOf(ctx), id); await ctx.reply("Aturan disable dihapus."); await list(ctx); }
        else {
          const rule = (await deps.listDisableRules(actorOf(ctx))).find(rule => rule.id === id);
          if (rule) await message(ctx, rule, replyCtx => detail(replyCtx, id));
          else await list(ctx);
        }
        return true;
      }
      const pick = /^vpa_dpick_([a-f0-9-]{36})_(service|target|sizeSlug|os|region)_(\d{1,3})$/.exec(data);
      const nextPage = /^vpa_dpage_([a-f0-9-]{36})_(\d{1,3})$/.exec(data);
      const draft = current(ctx, (pick ?? nextPage)?.[1] ?? "");
      if (!draft) { await ctx.reply("Sesi pengaturan disable habis. Mulai kembali dari menu."); await list(ctx); return true; }
      if (nextPage) { await choose(ctx, draft, Number(nextPage[2])); return true; }
      if (!pick || draft.field !== pick[2]) { await choose(ctx, draft); return true; }
      const choice = options(draft)[Number(pick[3])];
      if (!choice) { await choose(ctx, draft); return true; }
      const field = draft.field;
      if (field === "service") { draft.rule.service = choice.value as VpsDisableService; draft.field = "target"; }
      else if (field === "target") { draft.rule.target = choice.value as VpsDisableRuleInput["target"]; draft.field = draft.rule.target === "size" ? "sizeSlug" : draft.rule.target; }
      else {
        draft.rule[field] = choice.value;
        if (field === "region") draft.field = "sizeSlug";
        else if (field === "os" && draft.rule.target === "os") draft.field = "sizeSlug";
        else if (field === "sizeSlug" && draft.rule.target === "region") draft.field = "os";
        else { await message(ctx, { ...draft.rule }, replyCtx => list(replyCtx)); return true; }
      }
      await choose(ctx, draft); return true;
    },
  };
}
