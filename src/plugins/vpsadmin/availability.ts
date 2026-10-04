import { randomUUID } from "node:crypto";
import { Context, InlineKeyboard } from "grammy";
import type { VpsDisableRule } from "../../vps/availability.js";
import type { VpsUiDependencies } from "../vps/contracts.js";
import { vpsReply } from "../vps/ui.js";

type Dimension = "size" | "os" | "region";
const labels = { size: "Spek", os: "OS", region: "Region" };
export function ruleSummary(rule: VpsDisableRule): string {
  return `${labels[rule.kind]}: ${rule[rule.kind]} · ${rule.kind !== "size" ? `Spek: ${rule.size ?? "semua"}` : "semua OS/region"}${rule.kind === "region" ? ` · OS: ${rule.os ?? "semua"}` : ""}`;
}

export function createAvailabilityMenu(deps: VpsUiDependencies, input: (actor: string, receive: (ctx: Context, value: string) => Promise<void>) => void) {
  const sessions = new Map<string, { id: string; expires: number; rule: VpsDisableRule; steps: Dimension[]; step: number; options: { value: string; label: string }[] }>();
  const back = () => new InlineKeyboard().text("Kembali", "vpa_availability_0");
  async function show(ctx: Context, offset = 0): Promise<void> {
    sessions.delete(String(ctx.from!.id));
    const rules = await deps.listDisableRules(String(ctx.from!.id));
    const keyboard = new InlineKeyboard().text("Disable Spek", "vpa_disable_size").text("Disable OS", "vpa_disable_os").row()
      .text("Disable Region", "vpa_disable_region").row();
    rules.slice(offset, offset + 4).forEach(rule => keyboard.text(`Aktifkan: ${ruleSummary(rule)}`, `vpa_enable_rule_${rule.id}`).row());
    if (offset) keyboard.text("←", `vpa_availability_${Math.max(0, offset - 4)}`);
    if (offset + 4 < rules.length) keyboard.text("→", `vpa_availability_${offset + 4}`);
    keyboard.row().text("Admin VPS", "vpa_home");
    await vpsReply(ctx, `Ketersediaan VPS\n\nAturan berlaku untuk VPS DO dan jasa install, termasuk VPS buyer sesuai spek/OS (tanpa region DO).\nPilihan tetap terlihat. User menerima pesan saat memilih opsi nonaktif.\n\nAturan aktif: ${rules.length}\n${rules.slice(offset, offset + 4).map(rule => `${ruleSummary(rule)}\nPesan: ${rule.message}`).join("\n\n")}\n\nAktifkan menghapus satu aturan. Aturan lain yang cocok tetap berlaku. Pembayaran yang sudah berjalan tetap diselesaikan.`, keyboard);
  }
  async function step(ctx: Context): Promise<void> {
    const actor = String(ctx.from!.id), session = sessions.get(actor)!;
    const dimension = session.steps[session.step];
    if (!dimension) {
      input(actor, async (target, value) => {
        if (sessions.get(actor) !== session || session.expires <= Date.now()) throw new Error("Sesi berakhir");
        const message = value.trim();
        if (!message || message.length > 500) { await target.reply("Pesan wajib diisi, maksimal 500 karakter."); await step(target); return; }
        await deps.setDisableRule(actor, { ...session.rule, message });
        await target.reply("Aturan disable tersimpan.");
        await show(target);
      });
      await vpsReply(ctx, `${ruleSummary(session.rule)}\n\nKirim pesan yang muncul saat user memilih opsi ini (maksimal 500 karakter).\nAturan dengan cakupan sama akan diperbarui. /batal untuk membatalkan.`, back());
      return;
    }
    const catalog = await deps.listCatalog!();
    const options = dimension === "size" ? catalog.sizes.map(item => ({ value: item.slug, label: item.label }))
      : dimension === "os" ? catalog.os.map(item => ({ value: item.id, label: item.label }))
      : catalog.regions.map(item => ({ value: item.slug, label: `${item.name} (${item.slug})` }));
    session.options = session.step ? [{ value: "", label: `Semua ${labels[dimension]}` }, ...options] : options;
    const keyboard = new InlineKeyboard();
    session.options.forEach((option, i) => keyboard.text(option.label, `vpa_disable_pick_${session.id}_${session.step}_${i}`).row());
    keyboard.text("Batal", "vpa_availability_0");
    await vpsReply(ctx, `Disable ${labels[session.rule.kind]}\n\nPilih ${labels[dimension]}${session.step ? " untuk cakupan aturan" : " yang dinonaktifkan"}:`, keyboard);
  }
  return async (ctx: Context, data: string): Promise<boolean> => {
    const actor = String(ctx.from!.id);
    for (const [key, value] of sessions) if (value.expires <= Date.now()) sessions.delete(key);
    const list = /^vpa_availability_(\d{1,6})$/.exec(data);
    if (list) { await show(ctx, Number(list[1])); return true; }
    const enable = /^vpa_enable_rule_([a-f0-9]{24})$/.exec(data);
    if (enable) { await deps.removeDisableRule(actor, enable[1]!); await show(ctx); return true; }
    const start = /^vpa_disable_(size|os|region)$/.exec(data);
    if (start) {
      const kind = start[1] as Dimension;
      sessions.set(actor, { id: randomUUID().slice(0, 8), expires: Date.now() + 10 * 60_000, rule: { kind, message: "" },
        steps: kind === "size" ? ["size"] : kind === "os" ? ["os", "size"] : ["region", "os", "size"], step: 0, options: [] });
      await step(ctx); return true;
    }
    const pick = /^vpa_disable_pick_([a-f0-9]{8})_(\d)_(\d{1,3})$/.exec(data);
    if (pick) {
      const session = sessions.get(actor);
      if (!session || session.id !== pick[1] || session.step !== Number(pick[2])) { await ctx.reply("Pilihan kedaluwarsa. Buka ulang Ketersediaan VPS."); return true; }
      const option = session.options[Number(pick[3])], dimension = session.steps[session.step];
      if (!option || !dimension) throw new Error("Pilihan tidak valid");
      if (option.value) session.rule[dimension] = option.value;
      session.step++;
      await step(ctx); return true;
    }
    // Navigating away invalidates the wizard, including its old buttons.
    sessions.delete(actor);
    return false;
  };
}
