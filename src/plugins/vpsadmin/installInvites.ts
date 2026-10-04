import { randomBytes } from "node:crypto";
import { Context, InlineKeyboard } from "grammy";
import type { VpsUiDependencies, VpsUiInstallInvite } from "../vps/contracts.js";
import { vpsDate, vpsReply } from "../vps/ui.js";
import { VpsInstallInviteError } from "../../vps/installInvites.js";

const sourceLabel = (source: VpsUiInstallInvite["sourceMode"]): string => source === "direct" ? "VPS Buyer (SSH)" : source === "digitalocean" ? "DigitalOcean Buyer" : "DO / VPS Buyer";
const statusLabel = (invite: VpsUiInstallInvite): string => invite.redeemedAt ? "Sudah digunakan" : invite.revokedAt ? "Dicabut" : invite.expiresAt.getTime() <= Date.now() ? "Kedaluwarsa" : invite.claimedBy ? "Diklaim, belum install" : "Belum diklaim";

export function createInstallInviteAdmin(deps: VpsUiDependencies, input: (actor: string, receive: (ctx: Context, value: string) => Promise<void>) => void) {
  const drafts = new Map<string, { token: string; sourceMode: VpsUiInstallInvite["sourceMode"]; expiresAt: number }>();
  const back = (): InlineKeyboard => new InlineKeyboard().text("Kembali", "vpa_invites_0");
  async function detail(ctx: Context, invite: VpsUiInstallInvite): Promise<void> {
    const link = `https://t.me/${ctx.me.username}?start=install_${invite.id}`;
    const keyboard = new InlineKeyboard();
    if (!invite.redeemedAt && !invite.revokedAt && invite.expiresAt.getTime() > Date.now()) keyboard.url("Buka undangan", link).row().text("Cabut undangan", `vpa_invrevoke_${invite.id}`).row();
    keyboard.text("Daftar undangan", "vpa_invites_0").text("Admin VPS", "vpa_home");
    await vpsReply(ctx, `Undangan Jasa Install Gratis\n\nSumber: ${sourceLabel(invite.sourceMode)}\nPenerima: ${invite.recipientId ?? "Siapa pun pemegang link (1 orang)"}\nStatus: ${statusLabel(invite)}\nDiklaim oleh: ${invite.claimedBy ?? "belum ada"}\nBerlaku sampai: ${vpsDate(invite.expiresAt)}\n\nLink untuk dibagikan:\n${link}\n\nSatu undangan untuk satu order. Biaya DO/VPS tetap ditanggung penerima. Order masuk log dan testimoni biasa dengan metode Undangan Gratis.`, keyboard);
  }
  return async (ctx: Context, data: string): Promise<void> => {
    const actor = String(ctx.from!.id);
    for (const [owner, draft] of drafts) if (draft.expiresAt <= Date.now()) drafts.delete(owner);
    const list = /^vpa_invites_(\d{1,5})$/.exec(data);
    if (list) {
      drafts.delete(actor);
      const offset = Number(list[1]), invites = await deps.listInstallInvites(actor, offset);
      const keyboard = new InlineKeyboard().text("Buat undangan gratis", "vpa_invnew").row();
      invites.forEach(invite => keyboard.text(`${invite.recipientId ?? "Link bebas"} · ${statusLabel(invite)}`, `vpa_invdetail_${invite.id}`).row());
      if (offset) keyboard.text("Sebelumnya", `vpa_invites_${Math.max(0, offset - 10)}`);
      if (invites.length === 10) keyboard.text("Berikutnya", `vpa_invites_${offset + 10}`);
      keyboard.row().text("Admin VPS", "vpa_home");
      await vpsReply(ctx, "Undangan Jasa Install Gratis\n\nBuat link sekali pakai untuk mengajak user mencoba jasa install. User memakai VPS atau akun DO sendiri; saldo tidak dipotong.", keyboard);
      return;
    }
    if (data === "vpa_invnew") {
      drafts.delete(actor);
      await vpsReply(ctx, "Pilih sumber VPS untuk undangan gratis:", new InlineKeyboard()
        .text("DO atau VPS Buyer", "vpa_invsource_any").row().text("DigitalOcean Buyer", "vpa_invsource_digitalocean").row()
        .text("VPS Buyer (SSH)", "vpa_invsource_direct").row().text("Batal", "vpa_invites_0"));
      return;
    }
    const source = /^vpa_invsource_(any|digitalocean|direct)$/.exec(data);
    if (source) {
      const token = randomBytes(4).toString("hex");
      drafts.set(actor, { token, sourceMode: source[1] as VpsUiInstallInvite["sourceMode"], expiresAt: Date.now() + 10 * 60_000 });
      await vpsReply(ctx, "Pilih masa berlaku undangan:", new InlineKeyboard().text("1 hari", `vpa_invdays_${token}_1`).text("7 hari", `vpa_invdays_${token}_7`).text("30 hari", `vpa_invdays_${token}_30`).row().text("Batal", "vpa_invites_0"));
      return;
    }
    const days = /^vpa_invdays_([a-f0-9]{8})_(1|7|30)$/.exec(data);
    if (days) {
      const draft = drafts.get(actor);
      if (!draft || draft.token !== days[1]) throw new VpsInstallInviteError("Sesi undangan habis. Buat undangan kembali.");
      const receive = async (inputCtx: Context, value: string): Promise<void> => {
        if (drafts.get(actor) !== draft || draft.expiresAt <= Date.now()) throw new VpsInstallInviteError("Sesi undangan habis. Buat undangan kembali.");
        const recipientId = value.trim();
        if (recipientId !== "-" && !/^[1-9]\d{0,19}$/.test(recipientId)) {
          input(actor, receive);
          await inputCtx.reply("Kirim Telegram ID berupa angka positif, atau - untuk link sekali pakai tanpa penerima khusus.");
          return;
        }
        const invite = await deps.createInstallInvite(actor, { sourceMode: draft.sourceMode, days: Number(days[2]), ...(recipientId === "-" ? {} : { recipientId }) });
        drafts.delete(actor);
        await detail(inputCtx, invite);
      };
      input(actor, receive);
      await vpsReply(ctx, "Kirim Telegram ID penerima undangan. Hanya ID ini yang bisa memakainya.\n\nKirim - untuk link sekali pakai yang bisa diklaim satu orang. Ketik /batal untuk membatalkan.", back());
      return;
    }
    const action = /^vpa_inv(detail|revoke)_([a-f0-9]{32})$/.exec(data);
    if (action) {
      if (action[1] === "revoke") await deps.revokeInstallInvite(actor, action[2]!);
      const invite = await deps.getInstallInvite(actor, action[2]!);
      if (!invite) throw new VpsInstallInviteError("Undangan tidak ditemukan.");
      await detail(ctx, invite);
    }
  };
}
