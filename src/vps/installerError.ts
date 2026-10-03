export type SshConnectionFailure = "network_unreachable" | "connection_refused" | "connection_timeout" | "handshake_timeout" | "connection_reset";
export type SshReadinessFailure = SshConnectionFailure | "authentication" | "cloud_init" | "permission" | "ssh";
export type InstallerErrorReason = "unsupported_virtualization" | "boot_detection" | "image_unreachable" | SshConnectionFailure;

/** Only these fixed messages may reach order evidence; never include raw SSH output/errors. */
export const SSH_READINESS_DETAILS: Readonly<Record<SshReadinessFailure, string>> = Object.freeze({
  network_unreachable: "Jalur jaringan dari server bot ke VPS tidak tersedia; periksa routing/firewall server bot.",
  connection_refused: "Port SSH 22 menolak koneksi; layanan SSH VPS belum menerima koneksi.",
  connection_timeout: "Koneksi ke port SSH 22 timeout; periksa akses jaringan dan Cloud Firewall DO.",
  handshake_timeout: "Port SSH terhubung tetapi handshake/login SSH melewati batas waktu.",
  connection_reset: "Koneksi SSH ditutup atau direset sebelum pemeriksaan selesai.",
  authentication: "Server SSH merespons, tetapi login ditolak; password/root login dari cloud-init belum dapat diverifikasi.",
  cloud_init: "Login SSH berhasil, tetapi cloud-init belum selesai atau memerlukan pemeriksaan.",
  permission: "Login SSH belum membuktikan akses root/sudo yang diperlukan installer.",
  ssh: "Pemeriksaan SSH belum dapat dipastikan.",
});

export class InstallerError extends Error {
  constructor(
    public readonly kind: "timeout" | "cancelled" | "authentication" | "ssh" | "validation",
    public readonly uncertain = false,
    public readonly reason?: InstallerErrorReason,
  ) {
    super(kind === "authentication" ? "Login SSH belum berhasil." : kind === "timeout" ? "Pemeriksaan SSH melewati batas waktu."
      : kind === "cancelled" ? "Pemeriksaan installer dihentikan." : kind === "validation" ? "Konfigurasi installer tidak valid."
      : "Koneksi SSH installer belum dapat dipastikan.");
    this.name = "InstallerError";
  }
}

/** Preserve diagnostic codes, never provider messages, credentials, causes, or stack data. */
export function classifySshError(error: unknown, uncertain = false, tcpConnected = true): InstallerError {
  const value = error && typeof error === "object" ? error as { code?: unknown; level?: unknown } : {};
  if (value.level === "client-authentication") return new InstallerError("authentication", uncertain);
  if (["ENETUNREACH", "EHOSTUNREACH", "EADDRNOTAVAIL"].includes(String(value.code))) return new InstallerError("ssh", uncertain, "network_unreachable");
  if (value.code === "ECONNREFUSED") return new InstallerError("ssh", uncertain, "connection_refused");
  if (value.code === "ETIMEDOUT") return new InstallerError("timeout", uncertain, "connection_timeout");
  if (value.level === "client-timeout") return new InstallerError("timeout", uncertain, tcpConnected ? "handshake_timeout" : "connection_timeout");
  if (["ECONNRESET", "EPIPE"].includes(String(value.code))) return new InstallerError("ssh", uncertain, "connection_reset");
  return new InstallerError("ssh", uncertain);
}
