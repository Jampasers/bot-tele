/**
 * WhatsApp Text Formatting Helpers
 */

export function formatIDR(amount: number): string {
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  }).format(amount);
}

export function cleanJid(jid: string): string {
  return jid.replace(/:\d+@/, "@").split("@")[0] || "";
}

export function extractPhone(jid: string): string {
  return cleanJid(jid);
}

export function bold(text: string | number): string {
  return `*${text}*`;
}

export function italic(text: string | number): string {
  return `_${text}_`;
}

export function mono(text: string | number): string {
  return `\`\`\`${text}\`\`\``;
}

export function strike(text: string | number): string {
  return `~${text}~`;
}

export function formatDateWIB(date: Date): string {
  return new Intl.DateTimeFormat("id-ID", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Jakarta",
  }).format(date) + " WIB";
}
