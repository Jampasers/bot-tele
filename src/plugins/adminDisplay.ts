export function formatAdminValue(value: string | null | undefined, fallback = "(Belum diatur)"): string {
  return value && value.length > 0 ? value : fallback;
}

export function formatSecretStatus(value: string | null | undefined): string {
  return value && value.length > 0 ? "✅ Tersimpan" : "⚪ Belum diatur";
}

export function isPrivateAdminChat(chatType: string | undefined): boolean {
  return chatType === "private";
}
