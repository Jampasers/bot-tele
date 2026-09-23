export type InstallerErrorReason = "unsupported_virtualization" | "boot_detection";

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

