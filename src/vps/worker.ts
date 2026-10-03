import { randomUUID } from "node:crypto";
import type { Api } from "grammy";
import { VpsOrder, type IVpsOrder } from "../models/VpsOrder.js";
import { VpsCredential } from "../models/VpsCredential.js";
import { User } from "../models/User.js";
import { ActivityLogService } from "../services/activityLog.js";
import { decryptSecret } from "../services/crypto.js";
import { platformContext, runWithTenant } from "../tenant/context.js";
import { ThrottledWarningLogger } from "../runtime/retryLogger.js";
import { DigitalOceanClient, DigitalOceanError } from "./digitalOcean.js";
import { buildUserData, detectWindowsBootMode, getOs, inspectSsh, inspectWindows, InstallerError, launchWindows, scheduleInstallerReboot, selectWindowsImage } from "./installer.js";
import { SSH_READINESS_DETAILS } from "./installerError.js";
import { resolveWindowsDdImageCandidates } from "./windowsImages.js";
import { assertVpsPlatform, boundedEnv, buyerTokens } from "./security.js";
import { providerForCredential, releaseCapacityTicket, reserveStoreCapacity } from "./credentials.js";
import { reconcileVpsPayments, refundVpsOrder, type VpsRefundReason } from "./payment.js";
import { resolveVpsWallpaperBase64 } from "./wallpaper.js";

export interface VpsStepDependencies {
  save(patch: Partial<IVpsOrder>): Promise<void>;
  client(): Promise<DigitalOceanClient | undefined>;
  reserve(): Promise<{ credentialId: string; accountId: string } | null>;
  releaseCapacity(): Promise<void>;
  refund(reason: VpsRefundReason): Promise<void>;
  password(): string;
  sourcePassword?(): string;
  sourceUsername?(): string;
  inspectSsh: typeof inspectSsh;
  detectWindowsBootMode: typeof detectWindowsBootMode;
  resolveWindowsDdImageCandidates: typeof resolveWindowsDdImageCandidates;
  selectWindowsImage: typeof selectWindowsImage;
  launchWindows: typeof launchWindows;
  scheduleInstallerReboot: typeof scheduleInstallerReboot;
  inspectWindows: typeof inspectWindows;
  wallpaperBase64?(): Promise<string | null>;
  clearToken(): void;
  now(): number;
  signal: AbortSignal;
}

/** One durable step. Every external mutation follows a persisted intent. */
export async function advanceVpsOrder(order: IVpsOrder, deps: VpsStepDependencies): Promise<void> {
  const save = async (patch: Partial<IVpsOrder>) => { await deps.save(patch); Object.assign(order, patch); };
  const stage = async (value: IVpsOrder["stage"], patch: Partial<IVpsOrder> = {}) => save({ stage: value, stageStartedAt: new Date(deps.now()), ...patch });
  const api = async () => {
    const client = await deps.client();
    if (!client) await save({ resumeStage: order.stage === "review" ? order.resumeStage ?? "review" : order.stage,
      stage: "needs_token", evidence: "Kirim ulang token akun/team yang sama untuk melanjutkan VPS ini." });
    return client;
  };
  const monitorWindows = async (enforceTimeout: boolean, knownPassword?: string) => {
    if (!order.publicIp) return;
    const windowsPassword = knownPassword ?? deps.password();
    const inspection = await deps.inspectWindows({ ip: order.publicIp, windowsPassword, ...(order.installerLogUrl ? { logUrl: order.installerLogUrl } : {}) }, deps.signal);
    const successes = inspection.rdpOpen ? order.rdpSuccesses + 1 : 0;
    await save({ rdpSuccesses: successes, ...(inspection.logUrl ? { installerLogUrl: inspection.logUrl } : {}), evidence: inspection.detail });
    if (successes >= 2) {
      await stage("ready", { resumeStage: null, reservationActive: false, evidence: "Instalasi Windows selesai. Port RDP aktif & siap digunakan (NLA & Ctrl+Alt+Del dinonaktifkan otomatis)." });
      deps.clearToken();
    } else if (enforceTimeout && deps.now() - order.stageStartedAt.getTime() > 90 * 60_000) {
      await save({ stage: "review", resumeStage: "monitoring", evidence: "Batas pemantauan Windows tercapai. Status instalasi belum pasti; VPS yang sama tetap diperiksa, tanpa create/refund otomatis." });
    }
  };
  if (deps.signal.aborted || order.paymentStatus !== "paid") return;
  const directInstall = order.service === "install" && !!order.sourceUsername;
  const provisionAttempt = order.provisionAttempt ?? 1;
  const sshBootGraceMs = () => boundedEnv("VPS_SSH_BOOT_GRACE_SECONDS", 300, 60, 1800) * 1000;
  const sshStartedAt = () => order.sshStartedAt ?? order.stageStartedAt;
  const sshDiagnostic = () => order.sshLastFailure ? ` Terakhir: ${SSH_READINESS_DETAILS[order.sshLastFailure]}` : "";
  const refundTerminal = async () => {
    const reason: VpsRefundReason = order.stage === "cancelled" ? "cancelled_before_create"
      : order.lastError === "ssh_retry_exhausted" ? "ssh_retry_exhausted"
      : order.lastError === "create_rejected" ? "create_rejected" : "validation_failed";
    await deps.releaseCapacity();
    await deps.refund(reason);
    await save({ paymentStatus: "refunded", refundReason: reason,
      evidence: `${order.evidence}\nPembayaran telah dikembalikan ke saldo buyer.` });
    deps.clearToken();
  };
  if (["failed", "cancelled"].includes(order.stage) && !order.dropletId && !order.createAttemptedAt) {
    await refundTerminal();
    return;
  }

  if (order.stage === "replacing") {
    if (directInstall || !order.dropletId) {
      await stage("review", { lastError: "replacement_target_invalid", evidence: "VPS pengganti tidak dapat diproses: identitas droplet DO belum valid." });
      return;
    }
    // Also protect orders upgraded from the old three-immediate-failures policy.
    // Once DELETE intent is durable, finish observing deletion instead of resuming SSH.
    if (!order.replacementDeleteRequestedAt && deps.now() - sshStartedAt().getTime() < sshBootGraceMs()) {
      await stage("ssh", { sshStartedAt: sshStartedAt(), sshAttempts: 0,
        evidence: "VPS masih dalam masa boot/cloud-init. Penghapusan ditunda; menunggu kesiapan SSH pada VPS yang sama." });
      return;
    }
    const client = await api(); if (!client) return;
    const dropletId = order.dropletId;
    const missing = (error: unknown) => error instanceof DigitalOceanError && error.httpStatus === 404;
    let deleted = false;
    try {
      let droplet;
      try { droplet = await client.getDroplet(dropletId, deps.signal); }
      catch (error) { if (!missing(error)) throw error; deleted = true; }
      if (droplet) {
        if (droplet.id !== dropletId || droplet.name !== order.createName
          || (droplet.region && droplet.region !== order.snapshot.region) || (droplet.size && droplet.size !== order.snapshot.size)) {
          await stage("review", { lastError: "droplet_identity_mismatch", evidence: "Identitas droplet berbeda dari pesanan; penghapusan dan create ulang dihentikan." });
          return;
        }
        // Persist the exact target before DELETE. Recovery observes this same ID;
        // an interrupted request never authorizes another create or a refund.
        await save({ replacementDeleteRequestedAt: new Date(deps.now()) });
        try { await client.deleteDroplet(dropletId, deps.signal); }
        catch (error) { if (!missing(error)) throw error; }
        try { await client.getDroplet(dropletId, deps.signal); }
        catch (error) { if (!missing(error)) throw error; deleted = true; }
      }
    } catch (error) {
      if (deps.signal.aborted) throw error;
      const reason = error instanceof DigitalOceanError && error.kind === "permission" ? "Token DO tidak memiliki izin menghapus VPS. " : "";
      await save({ lastError: "replacement_delete_pending", evidence: `${reason}SSH gagal 3 kali setelah masa boot.${sshDiagnostic()} Penghapusan VPS belum terkonfirmasi; create ulang dan refund menunggu penghapusan selesai.` });
      return;
    }
    if (!deleted) {
      await save({ evidence: "Menunggu konfirmasi penghapusan VPS sebelum melanjutkan percobaan berikutnya." });
      return;
    }
    await deps.releaseCapacity();
    const deletedDropletIds = [...new Set([...(order.deletedDropletIds ?? []), dropletId])];
    const reset: Partial<IVpsOrder> = { deletedDropletIds, dropletId: null, publicIp: null, createAttemptedAt: null,
      reservationActive: false, replacementDeleteRequestedAt: null, sshStartedAt: null, sshNextAttemptAt: null,
      installerBootMode: null, installerImageUrl: null, installerLogUrl: null, rdpSuccesses: 0, resumeStage: null };
    if (provisionAttempt >= 3) {
      await stage("failed", { ...reset, provisionAttempt: 3, sshAttempts: 3, lastError: "ssh_retry_exhausted",
        evidence: `Failed: SSH belum siap pada 3 VPS setelah masa boot (3 percobaan per VPS, total 9 percobaan).${sshDiagnostic()} Semua VPS telah dihapus. Refund ke saldo buyer diproses.` });
      await refundTerminal();
    } else {
      await stage("queued", { ...reset, provisionAttempt: provisionAttempt + 1, sshAttempts: 0, sshLastFailure: null, lastError: null,
        createName: `bt-vps-${order._id}-try${provisionAttempt + 1}`,
        ...(order.service === "purchase" ? { credentialId: null, accountId: null } : {}),
        evidence: `SSH gagal 3 kali pada VPS ${provisionAttempt}/3. VPS telah dihapus; menyiapkan VPS baru ${provisionAttempt + 1}/3 dengan spek dan region yang sama.` });
    }
    return;
  }

  if (["requested", "submitting", "running"].includes(order.rebootState)) {
    if (order.service !== "purchase" || !order.dropletId) return;
    const client = await api(); if (!client) return;
    if (order.rebootState === "submitting") {
      // Missing action ID after a crash is ambiguous. Do not submit another reboot.
      await save({ rebootState: "review", evidence: "Hasil request reboot belum pasti; perlu pemeriksaan action DigitalOcean." }); return;
    }
    if (order.rebootState === "requested") {
      await save({ rebootState: "submitting" });
      try {
        const action = await client.reboot(order.dropletId, deps.signal);
        await save({ rebootActionId: action.id, rebootState: action.status === "completed" ? "completed" : action.status === "errored" ? "errored" : "running", evidence: `Reboot DigitalOcean: ${action.status}.` });
      } catch (error) {
        await save({ rebootState: error instanceof DigitalOceanError && !error.uncertain ? "errored" : "review", evidence: "Request reboot belum berhasil dikonfirmasi." });
      }
      return;
    }
    if (order.rebootActionId) {
      const action = await client.action(order.dropletId, order.rebootActionId, deps.signal);
      await save({ rebootState: action.status === "completed" ? "completed" : action.status === "errored" ? "errored" : "running", evidence: `Reboot DigitalOcean: ${action.status}.` });
    }
    return;
  }
  if (["failed", "cancelled", "ready", "needs_token"].includes(order.stage)) return;
  if (order.stage === "review") {
    // Retry observation only. Neither create nor install can be repeated from this branch.
    if (order.resumeStage === "creating") {
      const client = await api(); if (!client) return;
      const found = (await client.listDroplets(deps.signal)).filter(d => d.name === order.createName);
      if (found.length === 1) await stage("droplet", { dropletId: found[0]!.id, publicIp: found[0]!.publicIp ?? null, resumeStage: null, evidence: "Droplet existing ditemukan; melanjutkan pesanan yang sama." });
      return;
    }
    if (order.resumeStage === "monitoring") {
      // Keep recovery observation in review so ordinary polling does not emit a
      // review -> monitoring notification on every retry cycle.
      await monitorWindows(false);
      return;
    }
    if (order.resumeStage !== "ssh" && order.resumeStage !== "droplet") return;
    // These steps only observe the existing VPS and cannot allocate another droplet.
    const resumeStage = order.resumeStage as IVpsOrder["stage"];
    await save({ stage: resumeStage });
  }
  if (order.stage === "queued") {
    if (order.service === "install" && order.publicIp && order.sourceUsername && order.sourcePasswordEncrypted) {
      // Direct-install fast path: persist the SSH intent, then continue in the
      // same leased worker execution instead of waiting for another poll.
      await stage("ssh", { evidence: "VPS pelanggan diterima. Menunggu koneksi SSH untuk instalasi Windows." });
    } else {
      if (order.createAttemptedAt) { await stage("creating"); return; }
      if (order.service === "purchase" && !order.credentialId) {
        const capacity = await deps.reserve();
        if (!capacity) { await save({ lastError: "capacity_unavailable", evidence: "Menunggu kapasitas akun toko. Pesanan belum membuat droplet." }); return; }
        Object.assign(order, capacity, { reservationActive: true });
      }
      const client = await api(); if (!client) return;
      try {
        const selected = await client.validateSelection({ region: order.snapshot.region, size: order.snapshot.size, os: order.snapshot.os }, deps.signal);
        if (selected.size.memory !== order.snapshot.memory || selected.size.vcpus !== order.snapshot.vcpus || selected.size.disk !== order.snapshot.disk || selected.os.image !== order.snapshot.image) throw new DigitalOceanError("validation");
      } catch (error) {
        if (error instanceof DigitalOceanError && error.kind === "validation") {
          await stage("failed", { lastError: "validation_failed", reservationActive: false, evidence: "Spek/region/image tidak tersedia sebelum create. Refund dijadwalkan." }); deps.clearToken(); return;
        }
        throw error;
      }
      // Name is persisted at checkout. Even a process crash after this write forbids
      // blindly replaying POST, whether or not the request reached DigitalOcean.
      await stage("creating", { provisionAttempt, createAttemptedAt: new Date(deps.now()), evidence: `Request pembuatan droplet ${provisionAttempt}/3 sedang diproses.` });
      try {
        const created = await client.createDroplet({ name: order.createName, region: order.snapshot.region, size: order.snapshot.size,
          image: order.snapshot.image, userData: buildUserData(deps.password()) }, deps.signal);
        await stage("droplet", { dropletId: created.id, publicIp: created.publicIp ?? null, reservationActive: false, evidence: "Droplet tercatat. Menunggu status aktif dan IP publik." });
      } catch (error) {
        if (error instanceof DigitalOceanError && !error.uncertain) {
          await stage("failed", { createAttemptedAt: null, reservationActive: false, lastError: "create_rejected", evidence: "DigitalOcean menolak create secara definitif. Refund dijadwalkan." }); deps.clearToken();
        } else await stage("review", { resumeStage: "creating", lastError: "create_uncertain", evidence: "Hasil create belum pasti. Rekonsiliasi droplet berjalan; tidak ada create ulang/refund otomatis." });
      }
      return;
    }
  }
  if (order.stage === "creating") {
    const client = await api(); if (!client) return;
    const found = (await client.listDroplets(deps.signal)).filter(d => d.name === order.createName);
    if (found.length === 1) await stage("droplet", { dropletId: found[0]!.id, publicIp: found[0]!.publicIp ?? null, reservationActive: false, evidence: "Droplet existing ditemukan." });
    else await stage("review", { resumeStage: "creating", lastError: "create_uncertain", evidence: "Create belum dapat dipastikan. Perlu pemeriksaan; tidak membuat droplet tambahan." });
    return;
  }
  if (order.stage === "droplet") {
    if (!order.dropletId) { await stage("review", { evidence: "Identitas droplet belum tersedia; perlu pemeriksaan." }); return; }
    const client = await api(); if (!client) return;
    const droplet = await client.getDroplet(order.dropletId, deps.signal);
    if (droplet.name !== order.createName) { await stage("review", { evidence: "Identitas droplet tidak sesuai pesanan; operasi dihentikan." }); return; }
    if (droplet.status === "active" && !droplet.locked && droplet.publicIp) await stage("ssh", { publicIp: droplet.publicIp,
      sshStartedAt: new Date(deps.now()), sshNextAttemptAt: null, sshAttempts: 0, sshLastFailure: null,
      evidence: "Droplet aktif. Menunggu kesiapan SSH dan penyelesaian cloud-init Linux." });
    else if (deps.now() - order.stageStartedAt.getTime() > 30 * 60_000) await save({ stage: "review", resumeStage: "droplet", evidence: "Penantian droplet melewati batas pemantauan. Droplet yang sama tetap diperiksa." });
    return;
  }
  if (!order.publicIp) return;
  const password = deps.password();
  const sourcePassword = order.service === "install" && order.sourcePasswordEncrypted ? (deps.sourcePassword?.() ?? password) : password;
  const sourceUsername = order.service === "install" && order.sourceUsername ? (deps.sourceUsername?.() ?? order.sourceUsername) : "root";
  if (order.stage === "ssh") {
    if (order.sshNextAttemptAt && deps.now() < order.sshNextAttemptAt.getTime()) return;
    if (!directInstall && (order.sshAttempts ?? 0) >= 3 && deps.now() - sshStartedAt().getTime() >= sshBootGraceMs()) {
      await stage("replacing", { evidence: `SSH gagal 3 kali setelah masa boot pada VPS ${provisionAttempt}/3.${sshDiagnostic()} Menghapus VPS sebelum ${provisionAttempt >= 3 ? "refund ke saldo buyer" : "membuat VPS pengganti"}.` });
      return;
    }
    const inspection = await deps.inspectSsh({ ip: order.publicIp, password: sourcePassword, username: sourceUsername,
      ...(!directInstall ? { waitForCloudInit: true } : {}) }, deps.signal);
    if (deps.signal.aborted) return;
    if (inspection.ready) {
      if (getOs(order.snapshot.os)?.family === "linux") {
        await stage("ready", { reservationActive: false, sshLastFailure: null, lastError: null, evidence: "Login SSH root berhasil diverifikasi." });
        deps.clearToken();
        return;
      }
      // Persist before mutation, but do not burn another worker interval.
      await stage("installing", { sshLastFailure: null, lastError: null, evidence: "SSH Linux berhasil; menyiapkan installer Windows." });
    } else {
      const detail = SSH_READINESS_DETAILS[inspection.reason];
      const observation: Partial<IVpsOrder> = { sshStartedAt: sshStartedAt(), sshLastFailure: inspection.reason,
        sshNextAttemptAt: new Date(deps.now() + 30_000) };
      if (inspection.reason === "network_unreachable") {
        // Recreating a paid VPS cannot repair the bot host's route. Keep observing
        // this exact droplet; do not spend attempts, delete, or refund it.
        await stage("review", { ...observation, resumeStage: "ssh", lastError: "ssh_network_unreachable",
          evidence: `${detail} VPS tetap dipertahankan dan dipantau; penggantian otomatis ditunda.` });
        return;
      }
      if (inspection.reason === "cloud_init") {
        // Authenticated root access is already working. Waiting for the boot
        // scripts is not a failed SSH login and must not trigger replacement.
        await save({ ...observation, ...(deps.now() - sshStartedAt().getTime() > 30 * 60_000 ? { stage: "review", resumeStage: "ssh" } : {}),
          evidence: `${detail} Menunggu cloud-init pada VPS yang sama; jatah retry SSH tidak berkurang.` });
        return;
      }
      if (!directInstall && order.dropletId) {
        if (deps.now() - sshStartedAt().getTime() < sshBootGraceMs()) {
          await save({ ...observation, sshAttempts: 0, lastError: null,
            evidence: `Menunggu boot/cloud-init VPS ${provisionAttempt}/3 (masa tunggu ${sshBootGraceMs() / 1000} detik). ${detail} Pemeriksaan selama boot belum mengurangi 3 retry SSH.` });
          return;
        }
        const sshAttempts = (order.sshAttempts ?? 0) + 1;
        if (sshAttempts >= 3) await stage("replacing", { ...observation, sshAttempts: 3, replacementDeleteRequestedAt: null,
          evidence: `SSH gagal 3 kali setelah masa boot pada VPS ${provisionAttempt}/3. ${detail} Menghapus VPS sebelum ${provisionAttempt >= 3 ? "refund ke saldo buyer" : "membuat VPS pengganti"}.` });
        else await save({ ...observation, sshAttempts, lastError: `ssh_${inspection.reason}`,
          evidence: `SSH belum siap setelah masa boot. ${detail} Percobaan ${sshAttempts}/3 pada VPS ${provisionAttempt}/3; mencoba SSH kembali.` });
      } else await save({ ...observation, ...(deps.now() - order.stageStartedAt.getTime() > 30 * 60_000 ? { stage: "review", resumeStage: "ssh" } : {}),
        evidence: `${detail} VPS pelanggan yang sama tetap dipantau.` });
      return;
    }
  }
  if (order.stage === "installing") {
    let bootMode = order.installerBootMode;
    let imageUrl = order.installerImageUrl;
    if ((bootMode && !imageUrl) || (!bootMode && imageUrl)) {
      await stage("review", { resumeStage: "ssh", evidence: "Pilihan image installer tidak lengkap; instalasi dihentikan sebelum perubahan disk." });
      return;
    }
    if (!bootMode || !imageUrl) {
      try {
        bootMode = await deps.detectWindowsBootMode({ ip: order.publicIp, password: sourcePassword, username: sourceUsername }, deps.signal);
      } catch (error) {
        if (error instanceof InstallerError && error.reason === "unsupported_virtualization") {
          await stage("failed", { lastError: "validation_failed", evidence: "Virtualisasi LXC/OpenVZ tidak mendukung instalasi Windows DD. Disk tidak diubah." });
        } else {
          await stage("review", { resumeStage: "ssh", evidence: "Boot mode VPS tidak dapat dideteksi dengan aman; instalasi belum dijalankan." });
        }
        return;
      }
      try {
        const candidates = deps.resolveWindowsDdImageCandidates(order.snapshot.os, bootMode);
        imageUrl = await deps.selectWindowsImage({
          ip: order.publicIp,
          password: sourcePassword,
          username: sourceUsername,
          candidates,
        }, deps.signal);
      } catch {
        await stage("failed", { lastError: "validation_failed", evidence: "Image Windows tidak dapat dijangkau dari VPS; instalasi belum menyentuh disk." });
        return;
      }
      const bootLabel = bootMode === "efi" ? "UEFI" : "BIOS/Legacy";
      const imageFormat = new URL(imageUrl).pathname.toLowerCase().endsWith(".zst") ? "Zstandard fast image" : "XZ image";
      await save({ installerBootMode: bootMode, installerImageUrl: imageUrl,
        evidence: `SSH Linux berhasil. Boot mode: ${bootLabel}. ${imageFormat} terpilih dan dapat dijangkau; menyiapkan ${getOs(order.snapshot.os)?.name ?? "Windows"}.` });
    }
    const wallpaperBase64 = await deps.wallpaperBase64?.();
    const result = await deps.launchWindows({ ip: order.publicIp, password: sourcePassword, username: sourceUsername, windowsPassword: password,
      os: order.snapshot.os, orderId: order._id, bootMode, imageUrl, installChrome: order.snapshot.installChrome === true,
      ...(wallpaperBase64 ? { wallpaperBase64 } : {}) }, deps.signal);
    if (result.logUrl) await save({ installerLogUrl: result.logUrl });
    if (result.state === "prepared") {
      // The reboot call is guarded by a durable remote marker, so it is safe
      // to schedule it immediately after persisting the rebooting stage.
      await stage("rebooting", { evidence: `Installer Windows ${bootMode === "efi" ? "UEFI" : "BIOS/Legacy"} disiapkan. Menjadwalkan reboot instalasi.` });
    } else {
      if (result.state === "failed" || deps.now() - order.stageStartedAt.getTime() > 30 * 60_000) {
        const err = result.errorDetail ? ` (${result.errorDetail})` : "";
        await stage("review", { resumeStage: "installing", evidence: `Persiapan installer memerlukan pemeriksaan${err}. Droplet tetap sama dan tidak diinstal ulang otomatis.` });
      }
      return;
    }
  }
  if (order.stage === "rebooting") {
    // Keep the persisted rebooting intent until the guarded remote call is attempted.
    // A crash before this call must not skip reboot. After a crash during/after it,
    // the remote order marker prevents another shutdown; after the disk is replaced,
    // the missing prepared marker prevents any reboot command on the installed OS.
    let result: Awaited<ReturnType<typeof scheduleInstallerReboot>>;
    try {
      result = await deps.scheduleInstallerReboot({ ip: order.publicIp, password: sourcePassword, username: sourceUsername, orderId: order._id }, deps.signal);
    } catch {
      await stage("monitoring", { evidence: "Hasil reboot instalasi belum terkonfirmasi; memantau VPS yang sama tanpa mengulang persiapan installer." });
      return;
    }
    if (result === "failed") await stage("review", { resumeStage: "monitoring", evidence: "Penjadwalan reboot belum terkonfirmasi. Periksa console; pemantauan tetap dapat dilanjutkan." });
    else await stage("monitoring", { evidence: "Reboot instalasi dijadwalkan; memantau Windows pada VPS yang sama." });
    return;
  }
  if (order.stage === "monitoring") {
    await monitorWindows(true, password);
  }
}

export class VpsWorker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly tasks = new Set<Promise<void>>();
  private readonly abort = new AbortController();
  private ticking = false;
  private readonly warnings = new ThrottledWarningLogger();
  private readonly concurrency = boundedEnv("VPS_CONCURRENCY", 4, 1, 8);
  private paymentReconciliation: Promise<void> | null = null;
  constructor(private readonly api: Pick<Api, "sendMessage" | "editMessageText">) {}

  private kickPaymentReconciliation(): void {
    if (this.paymentReconciliation || this.abort.signal.aborted) return;
    const job = reconcileVpsPayments({ signal: this.abort.signal })
      .catch(error => this.warnings.warn("vps-payments", "[VPS] Payment reconciliation deferred; provisioning continues.", error));
    this.paymentReconciliation = job;
    void job.finally(() => {
      if (this.paymentReconciliation === job) this.paymentReconciliation = null;
    });
  }

  private async leaseOrder(leaseId: string, priorityOnly: boolean): Promise<IVpsOrder | null> {
    const now = new Date();
    const update = { $set: { lockOwner: leaseId, lockUntil: new Date(Date.now() + 120_000) } };
    const options = { sort: { nextRunAt: 1, createdAt: 1 }, returnDocument: "after" as const };

    if (priorityOnly) {
      return VpsOrder.findOneAndUpdate({
        tenantId: "platform",
        paymentStatus: "paid",
        nextRunAt: { $lte: now },
        stage: { $in: ["queued", "ssh", "replacing", "installing", "rebooting"] },
        $or: [{ lockUntil: null }, { lockUntil: { $lt: now } }],
      }, update, options).select("+passwordEncrypted +sourcePasswordEncrypted").lean();
    }

    return VpsOrder.findOneAndUpdate({
      tenantId: "platform",
      paymentStatus: "paid",
      nextRunAt: { $lte: now },
      $and: [
        { $or: [{ lockUntil: null }, { lockUntil: { $lt: now } }] },
        { $or: [
          { stage: { $in: ["queued", "creating", "droplet", "ssh", "replacing", "installing", "rebooting", "monitoring", "review", "failed", "cancelled"] } },
          { rebootState: { $in: ["requested", "submitting", "running"] } },
        ] },
      ],
    }, update, options).select("+passwordEncrypted +sourcePasswordEncrypted").lean();
  }

  start(): void {
    assertVpsPlatform();
    this.timer = setInterval(() => void runWithTenant(platformContext(), () => this.tick()), 5_000);
    this.timer.unref();
    void this.tick();
  }
  async tick(): Promise<void> {
    assertVpsPlatform();
    if (this.ticking || this.abort.signal.aborted) return;
    this.ticking = true;
    try {
      buyerTokens.sweep();
      // Payment polling can involve slow external merchant APIs. Never block
      // already-paid provisioning behind reconciliation of unrelated invoices.
      this.kickPaymentReconciliation();

      while (this.tasks.size < this.concurrency && !this.abort.signal.aborted) {
        const leaseId = randomUUID();
        // First reserve capacity for user-visible provisioning stages so a new
        // paid order cannot be starved by frequent monitoring/review polling.
        const order = await this.leaseOrder(leaseId, true) ?? await this.leaseOrder(leaseId, false);
        if (!order) break;
        const task = this.process(order).catch(error => { this.warnings.warn(`vps:${order._id}`, `[VPS:${order._id}] Worker step deferred`, error); });
        this.tasks.add(task); void task.finally(() => this.tasks.delete(task));
      }
    } catch (error) { this.warnings.warn("vps-polling", "[VPS] Worker polling deferred; durable orders retained.", error); }
    finally { this.ticking = false; }
  }
  private async process(order: IVpsOrder): Promise<void> {
    const leaseId = order.lockOwner;
    if (!leaseId) throw new Error("Missing VPS lease.");
    const initialStage = order.stage; const initialReboot = order.rebootState;
    const initialEvidence = order.evidence;
    const stopStep = new AbortController();
    const stop = () => stopStep.abort();
    this.abort.signal.addEventListener("abort", stop, { once: true });
    if (this.abort.signal.aborted) stop();
    const deadline = setTimeout(stop, 20 * 60_000);
    const heartbeat = setInterval(() => {
      void VpsOrder.updateOne({ _id: order._id, lockOwner: leaseId, lockUntil: { $gt: new Date() } }, { $set: { lockUntil: new Date(Date.now() + 120_000) } })
        .then(result => { if (!result.matchedCount) stop(); }).catch(stop);
    }, 30_000);
    const save = async (patch: Partial<IVpsOrder>) => {
      const result = await VpsOrder.updateOne({ _id: order._id, tenantId: "platform", lockOwner: leaseId, lockUntil: { $gt: new Date() } }, { $set: patch });
      if (!result.matchedCount) throw new Error("VPS order lease lost.");
    };
    try {
      await advanceVpsOrder(order, {
        save,
        client: async () => {
          let client: DigitalOceanClient;
          if (order.service === "install") {
            const secret = buyerTokens.get(order.buyerId, order._id);
            if (!secret) return undefined;
            if (secret.accountId !== order.accountId) { buyerTokens.delete(order.buyerId, order._id); return undefined; }
            client = new DigitalOceanClient(secret.token);
          } else {
            if (!order.credentialId || !order.accountId) throw new Error("VPS credential unavailable.");
            client = await providerForCredential(order.credentialId, order.accountId);
          }
          try {
            const account = await client.account(stopStep.signal);
            if (account.identity !== order.accountId) throw new Error("VPS account mismatch.");
          } catch (error) {
            if (order.service === "install" && error instanceof DigitalOceanError && ["invalid_token", "permission"].includes(error.kind)) {
              buyerTokens.delete(order.buyerId, order._id); return undefined;
            }
            throw error;
          }
          return client;
        },
        reserve: () => reserveStoreCapacity(order, leaseId),
        releaseCapacity: () => releaseCapacityTicket(order._id),
        refund: async reason => { await refundVpsOrder(order._id, reason); },
        password: () => decryptSecret(order.passwordEncrypted, `platform:vps:password:${order._id}`),
        sourcePassword: () => order.sourcePasswordEncrypted ? decryptSecret(order.sourcePasswordEncrypted, `platform:vps:source-password:${order._id}`) : decryptSecret(order.passwordEncrypted, `platform:vps:password:${order._id}`),
        sourceUsername: () => order.sourceUsername ?? "root",
        inspectSsh, detectWindowsBootMode, resolveWindowsDdImageCandidates, selectWindowsImage, launchWindows, scheduleInstallerReboot, inspectWindows,
        wallpaperBase64: resolveVpsWallpaperBase64,
        clearToken: () => buyerTokens.delete(order.buyerId, order._id), now: Date.now, signal: stopStep.signal,
      });
      if (order.dropletId) await releaseCapacityTicket(order._id);
      if (order.credentialId && ["queued", "creating", "review"].includes(initialStage) && (order.dropletId || order.lastError === "create_rejected" || order.lastError === "create_uncertain")) {
        await VpsCredential.updateOne({ _id: order.credentialId }, { $set: { lastCreateResult: order.dropletId ? "created" : order.lastError, lastCreateAt: order.createAttemptedAt ?? new Date() } }).catch(() => {});
      }
      if (initialStage !== order.stage || initialReboot !== order.rebootState || initialEvidence !== order.evidence) {
        // Notification failure cannot alter provisioning, payment or refund state.
        const isReady = order.stage === "ready";
        const message = isReady
          ? `✅ VPS Selesai & Siap Digunakan!\n\n🖥️ Order: ${order._id}\n${order.evidence}\n\n👉 Buka /vps lalu klik "🔐 Lihat akses VPS" untuk mengambil IP, Username, dan Password RDP.`
          : `🖥️ VPS ${order._id}\n${order.evidence}\nBuka /vps untuk detail.`;
        if (order.statusMessageId) {
          await this.api.editMessageText(order.chatId, order.statusMessageId, message).catch(() => console.warn(`[VPS:${order._id}] Status message edit deferred.`));
        } else {
          const sent = await this.api.sendMessage(order.chatId, message).catch(() => null);
          if (sent) {
            order.statusMessageId = sent.message_id;
            await VpsOrder.updateOne({ _id: order._id, tenantId: "platform" }, { $set: { statusMessageId: sent.message_id } }).catch(() => {});
          } else {
            console.warn(`[VPS:${order._id}] Notification delivery deferred.`);
          }
        }

        if (isReady) {
          void User.findOne({ telegramId: order.buyerId, tenantId: "platform" })
            .select("telegramId firstName username")
            .lean()
            .then(buyer => {
              return ActivityLogService.logVpsSuccess(undefined, {
                orderId: order._id,
                service: order.service,
                planName: order.snapshot.planName,
                sizeSlug: order.snapshot.size,
                region: order.snapshot.region,
                os: order.snapshot.os,
                publicIp: order.publicIp ?? undefined,
                evidence: order.evidence,
                buyer: {
                  telegramId: order.buyerId,
                  firstName: buyer?.firstName,
                  username: buyer?.username,
                },
                date: new Date(),
              });
            })
            .catch(err => console.warn(`[VPS:${order._id}] Failed to dispatch ready audit log:`, err));
        }
      }
    } catch (error) {
      if (order.lastError !== "ssh_retry_exhausted") await save({ lastError: "step_deferred" }).catch(() => {});
      this.warnings.warn(`vps:${order._id}`, `[VPS:${order._id}] Step interrupted; persistent stage retained.`, error);
    } finally {
      clearInterval(heartbeat); clearTimeout(deadline); this.abort.signal.removeEventListener("abort", stop);
      const nextDelay = order.stage === "review" ? 60_000 : order.stage === "ssh" ? Math.max(10_000, (order.sshNextAttemptAt?.getTime() ?? 0) - Date.now())
        : order.stage === "replacing" ? 10_000 : order.stage === "monitoring" ? 5_000 : 2_000;
      await VpsOrder.updateOne({ _id: order._id, lockOwner: leaseId }, { $set: { lockOwner: null, lockUntil: null, nextRunAt: new Date(Date.now() + nextDelay) } });
    }
  }
  async stop(): Promise<void> {
    assertVpsPlatform();
    if (this.timer) clearInterval(this.timer);
    this.abort.abort(); buyerTokens.clear();
    while (this.ticking) await new Promise(resolve => setTimeout(resolve, 25));
    await Promise.allSettled(this.tasks);
    if (this.paymentReconciliation) await Promise.allSettled([this.paymentReconciliation]);
    buyerTokens.clear();
  }
}
