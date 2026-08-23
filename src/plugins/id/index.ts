import { Bot, Context } from "grammy";
import { Plugin } from "../../types/Plugin.js";

/**
 * 📌 ID & Info Inspector Plugin
 *
 * Provides utilities to inspect Telegram IDs for:
 *  - Current user & chat (Private, Group, Supergroup, Channel)
 *  - Replied messages (Sender, Sender Chat, Forward Source, Media File ID)
 *  - Forwarded messages (Channel ID, User ID, Message ID)
 *
 * Commands:
 *  - /id, /getid, /myid
 *
 * Also auto-inspects forwarded messages sent directly to the bot in private chats.
 */

function escapeHtml(text: string): string {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

interface ForwardInfo {
  type: string;
  id?: string | number | undefined;
  title?: string | undefined;
  name?: string | undefined;
  username?: string | undefined;
  messageId?: number | undefined;
}

function extractForwardOrigin(msg: any): ForwardInfo | null {
  if (!msg) return null;

  // Bot API 7.0+ forward_origin
  if (msg.forward_origin) {
    const origin = msg.forward_origin;
    if (origin.type === "user") {
      const u = origin.sender_user;
      const fullName = [u?.first_name, u?.last_name].filter(Boolean).join(" ");
      return {
        type: "User",
        id: u?.id,
        name: fullName || "Tanpa Nama",
        username: u?.username,
      };
    }
    if (origin.type === "hidden_user") {
      return {
        type: "Hidden User (Privasi Aktif)",
        name: origin.sender_user_name || "Pengguna Tersembunyi",
      };
    }
    if (origin.type === "chat") {
      const c = origin.sender_chat;
      return {
        type: c?.type === "channel" ? "Channel" : "Group",
        id: c?.id,
        title: c?.title,
        username: c?.username,
      };
    }
    if (origin.type === "channel") {
      const c = origin.chat;
      return {
        type: "Channel",
        id: c?.id,
        title: c?.title,
        username: c?.username,
        messageId: origin.message_id,
      };
    }
  }

  // Legacy forward fields fallback
  if (msg.forward_from) {
    const u = msg.forward_from;
    const fullName = [u.first_name, u.last_name].filter(Boolean).join(" ");
    return {
      type: "User",
      id: u.id,
      name: fullName || "Tanpa Nama",
      username: u.username,
    };
  }

  if (msg.forward_from_chat) {
    const c = msg.forward_from_chat;
    return {
      type: c.type === "channel" ? "Channel" : "Group / Chat",
      id: c.id,
      title: c.title,
      username: c.username,
      messageId: msg.forward_from_message_id,
    };
  }

  if (msg.forward_sender_name) {
    return {
      type: "Hidden User (Privasi Aktif)",
      name: msg.forward_sender_name,
    };
  }

  return null;
}

interface MediaInfo {
  type: string;
  fileId: string;
  fileUniqueId: string;
  fileName?: string | undefined;
  fileSize?: number | undefined;
  mimeType?: string | undefined;
  width?: number | undefined;
  height?: number | undefined;
  duration?: number | undefined;
}

function extractMediaInfo(msg: any): MediaInfo | null {
  if (!msg) return null;

  if (msg.photo && Array.isArray(msg.photo) && msg.photo.length > 0) {
    const largest = msg.photo[msg.photo.length - 1];
    return {
      type: "Foto (Photo)",
      fileId: largest.file_id,
      fileUniqueId: largest.file_unique_id,
      width: largest.width,
      height: largest.height,
      fileSize: largest.file_size,
    };
  }

  if (msg.document) {
    return {
      type: "Dokumen (Document)",
      fileId: msg.document.file_id,
      fileUniqueId: msg.document.file_unique_id,
      fileName: msg.document.file_name,
      mimeType: msg.document.mime_type,
      fileSize: msg.document.file_size,
    };
  }

  if (msg.video) {
    return {
      type: "Video",
      fileId: msg.video.file_id,
      fileUniqueId: msg.video.file_unique_id,
      fileName: msg.video.file_name,
      fileSize: msg.video.file_size,
      mimeType: msg.video.mime_type,
      width: msg.video.width,
      height: msg.video.height,
      duration: msg.video.duration,
    };
  }

  if (msg.audio) {
    return {
      type: "Audio / Musik",
      fileId: msg.audio.file_id,
      fileUniqueId: msg.audio.file_unique_id,
      fileName: msg.audio.file_name || msg.audio.title,
      fileSize: msg.audio.file_size,
      mimeType: msg.audio.mime_type,
      duration: msg.audio.duration,
    };
  }

  if (msg.voice) {
    return {
      type: "Pesan Suara (Voice Note)",
      fileId: msg.voice.file_id,
      fileUniqueId: msg.voice.file_unique_id,
      fileSize: msg.voice.file_size,
      mimeType: msg.voice.mime_type,
      duration: msg.voice.duration,
    };
  }

  if (msg.video_note) {
    return {
      type: "Video Bulat (Video Note)",
      fileId: msg.video_note.file_id,
      fileUniqueId: msg.video_note.file_unique_id,
      fileSize: msg.video_note.file_size,
      duration: msg.video_note.duration,
    };
  }

  if (msg.sticker) {
    return {
      type: `Stiker (${msg.sticker.is_animated ? "Animasi" : msg.sticker.is_video ? "Video" : "Statis"})`,
      fileId: msg.sticker.file_id,
      fileUniqueId: msg.sticker.file_unique_id,
      fileName: msg.sticker.set_name ? `Set: ${msg.sticker.set_name}` : undefined,
      fileSize: msg.sticker.file_size,
    };
  }

  if (msg.animation) {
    return {
      type: "GIF / Animasi",
      fileId: msg.animation.file_id,
      fileUniqueId: msg.animation.file_unique_id,
      fileName: msg.animation.file_name,
      fileSize: msg.animation.file_size,
      mimeType: msg.animation.mime_type,
    };
  }

  return null;
}

function buildIdReport(ctx: Context): string {
  const msg = ctx.message || ctx.channelPost;
  const from = ctx.from;
  const chat = ctx.chat;
  const reply = msg?.reply_to_message;

  const lines: string[] = [];
  lines.push(`🔍 <b>TELEGRAM ID INSPECTOR</b>\n`);

  // 1. User info
  if (from) {
    const fullName = [from.first_name, from.last_name].filter(Boolean).join(" ");
    const userHandle = from.username ? `@${escapeHtml(from.username)}` : "—";
    lines.push(`👤 <b>Info Anda (Sender):</b>`);
    lines.push(`├ <b>ID:</b> <code>${from.id}</code>`);
    lines.push(`├ <b>Nama:</b> ${escapeHtml(fullName || "User")}`);
    lines.push(`├ <b>Username:</b> ${userHandle}`);
    if (from.is_premium) lines.push(`├ <b>Premium:</b> Ya ⭐️`);
    if (from.language_code) lines.push(`└ <b>Bahasa:</b> <code>${escapeHtml(from.language_code)}</code>`);
    else lines.push(`└ <b>Tipe:</b> ${from.is_bot ? "Bot 🤖" : "User 🙋‍♂️"}`);
    lines.push("");
  }

  // 2. Chat / Group / Channel info
  if (chat && chat.type !== "private") {
    const chatTypeLabels: Record<string, string> = {
      group: "Grup",
      supergroup: "Supergrup",
      channel: "Channel",
    };
    const typeLabel = chatTypeLabels[chat.type] || chat.type;
    const chatHandle = (chat as any).username ? `@${escapeHtml((chat as any).username)}` : "—";
    const chatTitle = (chat as any).title ? escapeHtml((chat as any).title) : "Tanpa Judul";

    lines.push(`💬 <b>Info Obrolan (${typeLabel}):</b>`);
    lines.push(`├ <b>Chat ID:</b> <code>${chat.id}</code>`);
    lines.push(`├ <b>Judul:</b> ${chatTitle}`);
    lines.push(`├ <b>Username:</b> ${chatHandle}`);
    if (msg?.message_thread_id) {
      lines.push(`├ <b>Topic / Thread ID:</b> <code>${msg.message_thread_id}</code>`);
    }
    lines.push(`└ <b>Tipe:</b> <code>${chat.type}</code>`);
    lines.push("");
  } else if (chat && chat.type === "private" && (!from || from.id !== chat.id)) {
    lines.push(`💬 <b>Chat ID:</b> <code>${chat.id}</code>\n`);
  }

  // 3. Replied Message info
  if (reply) {
    lines.push(`↩️ <b>Pesan yang Dibalas (Replied Message):</b>`);
    lines.push(`├ <b>Message ID:</b> <code>${reply.message_id}</code>`);

    if (reply.from) {
      const rFullName = [reply.from.first_name, reply.from.last_name].filter(Boolean).join(" ");
      const rHandle = reply.from.username ? `@${escapeHtml(reply.from.username)}` : "—";
      lines.push(`├ <b>Pengirim (User):</b> ${escapeHtml(rFullName || "User")}`);
      lines.push(`├ <b>User ID:</b> <code>${reply.from.id}</code>`);
      lines.push(`├ <b>Username:</b> ${rHandle}`);
      if (reply.from.is_bot) lines.push(`├ <b>Status:</b> Bot 🤖`);
    }

    if (reply.sender_chat) {
      const sc = reply.sender_chat;
      const scTitle = sc.title ? escapeHtml(sc.title) : "Tanpa Judul";
      const scHandle = sc.username ? `@${escapeHtml(sc.username)}` : "—";
      lines.push(`├ <b>Pengirim (Channel/Chat):</b> ${scTitle}`);
      lines.push(`├ <b>Sender Chat ID:</b> <code>${sc.id}</code>`);
      lines.push(`├ <b>Username:</b> ${scHandle}`);
    }

    // Forward origin inside replied message
    const replyFwd = extractForwardOrigin(reply);
    if (replyFwd) {
      lines.push(`├ ──────────────`);
      lines.push(`├ <b>Asal Terusan (Forward Source):</b>`);
      lines.push(`├ <b>Tipe:</b> ${escapeHtml(replyFwd.type)}`);
      if (replyFwd.id !== undefined) lines.push(`├ <b>Source ID:</b> <code>${replyFwd.id}</code>`);
      if (replyFwd.title) lines.push(`├ <b>Judul:</b> ${escapeHtml(replyFwd.title)}`);
      if (replyFwd.name) lines.push(`├ <b>Nama:</b> ${escapeHtml(replyFwd.name)}`);
      if (replyFwd.username) lines.push(`├ <b>Username:</b> @${escapeHtml(replyFwd.username)}`);
      if (replyFwd.messageId !== undefined) lines.push(`├ <b>Post Message ID:</b> <code>${replyFwd.messageId}</code>`);
    }

    // Media info inside replied message
    const replyMedia = extractMediaInfo(reply);
    if (replyMedia) {
      lines.push(`├ ──────────────`);
      lines.push(`├ <b>File & Media Info:</b>`);
      lines.push(`├ <b>Tipe Media:</b> ${escapeHtml(replyMedia.type)}`);
      if (replyMedia.fileName) lines.push(`├ <b>Nama File:</b> ${escapeHtml(replyMedia.fileName)}`);
      if (replyMedia.fileSize !== undefined) lines.push(`├ <b>Ukuran:</b> ${formatBytes(replyMedia.fileSize)}`);
      if (replyMedia.width && replyMedia.height) lines.push(`├ <b>Dimensi:</b> ${replyMedia.width}x${replyMedia.height}`);
      if (replyMedia.duration !== undefined) lines.push(`├ <b>Durasi:</b> ${replyMedia.duration}s`);
      if (replyMedia.mimeType) lines.push(`├ <b>MIME:</b> <code>${escapeHtml(replyMedia.mimeType)}</code>`);
      lines.push(`├ <b>File ID:</b> <code>${escapeHtml(replyMedia.fileId)}</code>`);
      lines.push(`└ <b>Unique ID:</b> <code>${escapeHtml(replyMedia.fileUniqueId)}</code>`);
    } else {
      lines.push(`└ <i>(Tidak ada file media)</i>`);
    }
    lines.push("");
  }

  // 4. If current message itself is a Forwarded message
  const msgFwd = extractForwardOrigin(msg);
  if (msgFwd && !reply) {
    lines.push(`📢 <b>Asal Pesan Terusan (Forward Source):</b>`);
    lines.push(`├ <b>Tipe:</b> ${escapeHtml(msgFwd.type)}`);
    if (msgFwd.id !== undefined) lines.push(`├ <b>ID:</b> <code>${msgFwd.id}</code>`);
    if (msgFwd.title) lines.push(`├ <b>Judul Channel/Chat:</b> ${escapeHtml(msgFwd.title)}`);
    if (msgFwd.name) lines.push(`├ <b>Nama:</b> ${escapeHtml(msgFwd.name)}`);
    if (msgFwd.username) lines.push(`├ <b>Username:</b> @${escapeHtml(msgFwd.username)}`);
    if (msgFwd.messageId !== undefined) lines.push(`├ <b>Post Message ID:</b> <code>${msgFwd.messageId}</code>`);
    lines.push(`└ <i>Tip: Tap ID di atas untuk menyalin.</i>\n`);
  }

  // 5. Media info on current message
  const currentMedia = extractMediaInfo(msg);
  if (currentMedia && !reply) {
    lines.push(`📁 <b>File & Media Info:</b>`);
    lines.push(`├ <b>Tipe Media:</b> ${escapeHtml(currentMedia.type)}`);
    if (currentMedia.fileName) lines.push(`├ <b>Nama File:</b> ${escapeHtml(currentMedia.fileName)}`);
    if (currentMedia.fileSize !== undefined) lines.push(`├ <b>Ukuran:</b> ${formatBytes(currentMedia.fileSize)}`);
    if (currentMedia.width && currentMedia.height) lines.push(`├ <b>Dimensi:</b> ${currentMedia.width}x${currentMedia.height}`);
    if (currentMedia.duration !== undefined) lines.push(`├ <b>Durasi:</b> ${currentMedia.duration}s`);
    if (currentMedia.mimeType) lines.push(`├ <b>MIME:</b> <code>${escapeHtml(currentMedia.mimeType)}</code>`);
    lines.push(`├ <b>File ID:</b> <code>${escapeHtml(currentMedia.fileId)}</code>`);
    lines.push(`└ <b>Unique ID:</b> <code>${escapeHtml(currentMedia.fileUniqueId)}</code>\n`);
  }

  lines.push(`💡 <i>Salin ID dengan mengetuk teks berlatar abu-abu (kode).</i>`);

  return lines.join("\n");
}

const idPlugin: Plugin = {
  name: "id",
  version: "1.0.0",

  commands: [
    {
      command: "id",
      description: "Cek ID Telegram Anda, grup, channel, atau pesan yang dibalas",
    },
    {
      command: "getid",
      description: "Lihat detail ID dan info chat / pesan / channel",
    },
    {
      command: "myid",
      description: "Tampilkan User ID Telegram Anda",
    },
  ],

  register(bot: Bot<Context>): void {
    // 1. Commands: /id, /getid, /myid
    bot.command(["id", "getid", "myid"], async (ctx) => {
      try {
        const text = buildIdReport(ctx);
        const options: Parameters<typeof ctx.reply>[1] = {
          parse_mode: "HTML",
        };
        if (ctx.message?.message_id) {
          options.reply_parameters = { message_id: ctx.message.message_id };
        }
        await ctx.reply(text, options);
      } catch (err: any) {
        console.error("Error in /id command:", err);
        await ctx.reply("❌ Gagal mengambil info ID.").catch(() => {});
      }
    });

    // 2. Private Chat: Auto-inspect when user forwards ANY message or channel post to the bot
    bot.on("message", async (ctx, next) => {
      const msg = ctx.message as any;
      // Only process in private chat if message is forwarded and not a slash command
      if (ctx.chat?.type === "private" && msg) {
        const isFwd =
          Boolean(msg.forward_origin) ||
          Boolean(msg.forward_from) ||
          Boolean(msg.forward_from_chat) ||
          Boolean(msg.forward_sender_name);

        const isCommand = typeof msg.text === "string" && msg.text.startsWith("/");

        if (isFwd && !isCommand) {
          try {
            const text = buildIdReport(ctx);
            await ctx.reply(text, {
              parse_mode: "HTML",
              reply_parameters: { message_id: msg.message_id },
            });
            return;
          } catch (err: any) {
            console.error("Error inspecting forwarded message:", err);
          }
        }
      }

      await next();
    });

    console.log("   → /id, /getid, /myid commands & forward inspector registered");
  },
};

export default idPlugin;
