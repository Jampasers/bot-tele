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
import { buildUserData, detectWindowsBootMode, getOs, inspectWindows, InstallerError, launchWindows, scheduleInstallerReboot, testSsh } from "./installer.js";
import { resolveWindowsDdImage } from "./windowsImages.js";
import { assertVpsPlatform, boundedEnv, buyerTokens } from "./security.js";
import { providerForCredential, releaseCapacityTicket, reserveStoreCapacity } from "./credentials.js";
import { reconcileVpsPayments, refundVpsOrder } from "./payment.js";

export interface VpsStepDependencies {
  save(patch: Partial<IVpsOrder>): Promise<void>;
  client(): Promise<DigitalOceanClient | undefined>;
  reserve(): Promise<{ credentialId: string; accountId: string } | null>;
  password(): string;
  sourcePassword?(): string;
  sourceUsername?(): string;
  testSsh: typeof testSsh;
  detectWindowsBootMode: typeof detectWindowsBootMode;
  resolveWindowsDdImage: typeof resolveWindowsDdImage;
  launchWindows: typeof launchWindows;
  scheduleInstallerReboot: typeof scheduleInstallerReboot;
  inspectWindows: typeof inspectWindows;
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
    const successes = (inspection.rdpOpen && inspection.logState !== "ready") ? order.rdpSuccesses + 1 : 0;
    await save({ rdpSuccesses: successes, ...(inspection.logUrl ? { installerLogUrl: inspection.logUrl } : {}), evidence: inspection.detail });
    if (successes >= 3) {
      await stage("ready", { resumeStage: null, evidence: "Instalasi Windows selesai. Port RDP aktif & siap digunakan (NLA & Ctrl+Alt+Del dinonaktifkan otomatis)." });
      deps.clearToken();
    } else if (enforceTimeout && deps.now() - order.stageStartedAt.getTime() > 90 * 60_000) {
      await save({ stage: "review", resumeStage: "monitoring", evidence: "Batas pemantauan Windows tercapai. Status instalasi belum pasti; VPS yang sama tetap diperiksa, tanpa create/refund otomatis." });
    }
  };
  if (deps.signal.aborted || order.paymentStatus !== "paid") return;

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
      await stage("ssh", { evidence: "VPS pelanggan diterima. Menunggu koneksi SSH untuk instalasi Windows." });
      return;
    }
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
    await stage("creating", { createAttemptedAt: new Date(deps.now()), evidence: "Request pembuatan droplet sedang diproses." });
    try {
      const created = await client.createDroplet({ name: order.createName, region: order.snapshot.region, size: order.snapshot.size,
        image: order.snapshot.image, userData: buildUserData(deps.password()) }, deps.signal);
      await stage("droplet", { dropletId: created.id, publicIp: created.publicIp ?? null, evidence: "Droplet tercatat. Menunggu status aktif dan IP publik." });
    } catch (error) {
      if (error instanceof DigitalOceanError && !error.uncertain) {
        await stage("failed", { createAttemptedAt: null, reservationActive: false, lastError: "create_rejected", evidence: "DigitalOcean menolak create secara definitif. Refund dijadwalkan." }); deps.clearToken();
      } else await stage("review", { resumeStage: "creating", lastError: "create_uncertain", evidence: "Hasil create belum pasti. Rekonsiliasi droplet berjalan; tidak ada create ulang/refund otomatis." });
    }
    return;
  }
  if (order.stage === "creating") {
    const client = await api(); if (!client) return;
    const found = (await client.listDroplets(deps.signal)).filter(d => d.name === order.createName);
    if (found.length === 1) await stage("droplet", { dropletId: found[0]!.id, publicIp: found[0]!.publicIp ?? null, evidence: "Droplet existing ditemukan." });
    else await stage("review", { resumeStage: "creating", lastError: "create_uncertain", evidence: "Create belum dapat dipastikan. Perlu pemeriksaan; tidak membuat droplet tambahan." });
    return;
  }
  if (order.stage === "droplet") {
    if (!order.dropletId) { await stage("review", { evidence: "Identitas droplet belum tersedia; perlu pemeriksaan." }); return; }
    const client = await api(); if (!client) return;
    const droplet = await client.getDroplet(order.dropletId, deps.signal);
    if (droplet.name !== order.createName) { await stage("review", { evidence: "Identitas droplet tidak sesuai pesanan; operasi dihentikan." }); return; }
    if (droplet.status === "active" && droplet.publicIp) await stage("ssh", { publicIp: droplet.publicIp, evidence: "Droplet aktif. Menunggu login SSH Linux." });
    else if (deps.now() - order.stageStartedAt.getTime() > 30 * 60_000) await save({ stage: "review", resumeStage: "droplet", evidence: "Penantian droplet melewati batas pemantauan. Droplet yang sama tetap diperiksa." });
    return;
  }
  if (!order.publicIp) return;
  const password = deps.password();
  const sourcePassword = order.service === "install" && order.sourcePasswordEncrypted ? (deps.sourcePassword?.() ?? password) : password;
  const sourceUsername = order.service === "install" && order.sourceUsername ? (deps.sourceUsername?.() ?? order.sourceUsername) : "root";
  if (order.stage === "ssh") {
    if (await deps.testSsh({ ip: order.publicIp, password: sourcePassword, username: sourceUsername }, deps.signal)) {
      if (getOs(order.snapshot.os)?.family === "linux") { await stage("ready", { evidence: "Login SSH root berhasil diverifikasi." }); deps.clearToken(); }
      else await stage("installing", { evidence: "SSH Linux berhasil; menyiapkan installer Windows." });
    } else if (deps.now() - order.stageStartedAt.getTime() > 30 * 60_000) await save({ stage: "review", resumeStage: "ssh", evidence: "SSH belum dapat dikonfirmasi. VPS yang sama tetap dipantau." });
    return;
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
        imageUrl = deps.resolveWindowsDdImage(order.snapshot.os, bootMode);
      } catch {
        await stage("failed", { lastError: "validation_failed", evidence: "Konfigurasi image Windows tidak valid; instalasi belum dijalankan." });
        return;
      }
      const bootLabel = bootMode === "efi" ? "UEFI" : "BIOS/Legacy";
      await save({ installerBootMode: bootMode, installerImageUrl: imageUrl,
        evidence: `SSH Linux berhasil. Boot mode terdeteksi: ${bootLabel}. Menyiapkan ${getOs(order.snapshot.os)?.name ?? "Windows"}.` });
    }
    const result = await deps.launchWindows({ ip: order.publicIp, password: sourcePassword, username: sourceUsername, windowsPassword: password,
      os: order.snapshot.os, orderId: order._id, bootMode, imageUrl, installChrome: order.snapshot.installChrome === true }, deps.signal);
    if (result.logUrl) await save({ installerLogUrl: result.logUrl });
    if (result.state === "prepared") await stage("rebooting", { evidence: `Installer Windows ${bootMode === "efi" ? "UEFI" : "BIOS/Legacy"} disiapkan. Menjadwalkan reboot instalasi.` });
    else if (result.state === "failed" || deps.now() - order.stageStartedAt.getTime() > 30 * 60_000) {
      const err = result.errorDetail ? ` (${result.errorDetail})` : "";
      await stage("review", { resumeStage: "installing", evidence: `Persiapan installer memerlukan pemeriksaan${err}. Droplet tetap sama dan tidak diinstal ulang otomatis.` });
    }
    return;
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
  private readonly concurrency = boundedEnv("VPS_CONCURRENCY", 2, 1, 5);
  constructor(private readonly api: Pick<Api, "sendMessage">) {}
  start(): void {
    assertVpsPlatform();
    this.timer = setInterval(() => void runWithTenant(platformContext(), () => this.tick()), 15_000);
    this.timer.unref();
    void this.tick();
  }
  async tick(): Promise<void> {
    assertVpsPlatform();
    if (this.ticking || this.abort.signal.aborted) return;
    this.ticking = true;
    try {
      buyerTokens.sweep();
      await reconcileVpsPayments({ signal: this.abort.signal });
      while (this.tasks.size < this.concurrency && !this.abort.signal.aborted) {
        const leaseId = randomUUID();
        const order = await VpsOrder.findOneAndUpdate({ tenantId: "platform", paymentStatus: "paid", nextRunAt: { $lte: new Date() },
          $and: [ { $or: [{ lockUntil: null }, { lockUntil: { $lt: new Date() } }] }, { $or: [
            { stage: { $in: ["queued", "creating", "droplet", "ssh", "installing", "rebooting", "monitoring", "review", "failed", "cancelled"] } },
            { rebootState: { $in: ["requested", "submitting", "running"] } },
          ] } ],
        }, { $set: { lockOwner: leaseId, lockUntil: new Date(Date.now() + 120_000) } }, { sort: { nextRunAt: 1 }, returnDocument: "after" }).select("+passwordEncrypted +sourcePasswordEncrypted").lean();
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
      if (["failed", "cancelled"].includes(order.stage) && !order.dropletId && !order.createAttemptedAt) {
        await releaseCapacityTicket(order._id);
        await refundVpsOrder(order._id, order.stage === "cancelled" ? "cancelled_before_create" : order.lastError === "create_rejected" ? "create_rejected" : "validation_failed");
        buyerTokens.delete(order.buyerId, order._id);
        return;
      }
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
        password: () => decryptSecret(order.passwordEncrypted, `platform:vps:password:${order._id}`),
        sourcePassword: () => order.sourcePasswordEncrypted ? decryptSecret(order.sourcePasswordEncrypted, `platform:vps:source-password:${order._id}`) : decryptSecret(order.passwordEncrypted, `platform:vps:password:${order._id}`),
        sourceUsername: () => order.sourceUsername ?? "root",
        testSsh, detectWindowsBootMode, resolveWindowsDdImage, launchWindows, scheduleInstallerReboot, inspectWindows,
        clearToken: () => buyerTokens.delete(order.buyerId, order._id), now: Date.now, signal: stopStep.signal,
      });
      if (order.dropletId) await releaseCapacityTicket(order._id);
      if (order.credentialId && ["queued", "creating", "review"].includes(initialStage) && (order.dropletId || order.lastError === "create_rejected" || order.lastError === "create_uncertain")) {
        await VpsCredential.updateOne({ _id: order.credentialId }, { $set: { lastCreateResult: order.dropletId ? "created" : order.lastError, lastCreateAt: order.createAttemptedAt ?? new Date() } }).catch(() => {});
      }
      if (initialStage !== order.stage || initialReboot !== order.rebootState) {
        // Notification failure cannot alter provisioning, payment or refund state.
        const isReady = order.stage === "ready";
        const message = isReady
          ? `✅ VPS Selesai & Siap Digunakan!\n\n🖥️ Order: ${order._id}\n${order.evidence}\n\n👉 Buka /vps lalu klik "🔐 Lihat akses VPS" untuk mengambil IP, Username, dan Password RDP.`
          : `🖥️ VPS ${order._id}\n${order.evidence}\nBuka /vps untuk detail.`;
        await this.api.sendMessage(order.chatId, message).catch(() => console.warn(`[VPS:${order._id}] Notification delivery deferred.`));

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
      await save({ lastError: "step_deferred" }).catch(() => {});
      this.warnings.warn(`vps:${order._id}`, `[VPS:${order._id}] Step interrupted; persistent stage retained.`, error);
    } finally {
      clearInterval(heartbeat); clearTimeout(deadline); this.abort.signal.removeEventListener("abort", stop);
      await VpsOrder.updateOne({ _id: order._id, lockOwner: leaseId }, { $set: { lockOwner: null, lockUntil: null, nextRunAt: new Date(Date.now() + (order.stage === "review" ? 60_000 : 15_000)) } });
    }
  }
  async stop(): Promise<void> {
    assertVpsPlatform();
    if (this.timer) clearInterval(this.timer);
    this.abort.abort(); buyerTokens.clear();
    while (this.ticking) await new Promise(resolve => setTimeout(resolve, 25));
    await Promise.allSettled(this.tasks); buyerTokens.clear();
  }
}
