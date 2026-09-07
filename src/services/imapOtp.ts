import { fileURLToPath } from "node:url";
import path from "node:path";
import { fork, ChildProcess } from "node:child_process";
import { Api } from "grammy";
import { getTenantId, PLATFORM_TENANT_ID } from "../tenant/context.js";
import { BotConfig } from "../models/BotConfig.js";

// ============================================================================
//  Types & Interfaces (Compatible with previous definitions)
// ============================================================================

export type OtpProviderType = "PAYPAL" | "NETFLIX" | "DISCORD" | "GENERIC";

export interface ParsedEmailOtp {
  uid: number;
  date: Date | null;
  subject: string;
  senderName: string;
  senderEmail: string;
  isRead: boolean;
  provider: OtpProviderType;
  recipientName?: string | undefined;
  recipientEmail?: string | undefined;
  otpCode?: string | undefined;
  expiresIn?: string | undefined;
  magicLink?: string | undefined;
  transactionId?: string | undefined;
  amount?: string | undefined;
  currency?: string | undefined;
  payerEmail?: string | undefined;
  previewText?: string | undefined;
  rawText: string;
}

export type ParsedPayPalTransaction = ParsedEmailOtp;

export interface ImapStatusSummary {
  connected: boolean;
  listening: boolean;
  configured: boolean;
  host: string;
  user: string;
  targetSender: string;
  mailbox: string;
  lastConnectedAt?: Date | undefined;
  lastReceivedAt?: Date | undefined;
  lastReceivedOtp?: string | undefined;
  lastRecipientName?: string | undefined;
  totalOtpForwarded: number;
  lastError?: string | undefined;
  pid?: number | undefined;
}

export function normalizeImapStatusDates(status: ImapStatusSummary): ImapStatusSummary {
  return {
    ...status,
    lastConnectedAt: normalizeOptionalDate(status.lastConnectedAt),
    lastReceivedAt: normalizeOptionalDate(status.lastReceivedAt),
  };
}

function normalizeOptionalDate(value: unknown): Date | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const date = value instanceof Date ? value : new Date(value as string | number);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

// ============================================================================
//  IMAP Process Supervisor (Main Thread)
// ============================================================================

export class ImapOtpService {
  private static instance: ImapOtpService | null = null;
  private child: ChildProcess | null = null;
  private isRunning: boolean = false;
  private cachedStatus: ImapStatusSummary | null = null;
  private pendingRequests: Map<string, { resolve: (val: any) => void; reject: (err: any) => void; timeout: NodeJS.Timeout }> = new Map();
  private respawnTimeout: NodeJS.Timeout | null = null;

  private constructor() {}

  public static getInstance(): ImapOtpService {
    if (!this.instance) {
      this.instance = new ImapOtpService();
    }
    return this.instance;
  }

  /**
   * Starts the dedicated IMAP child process worker.
   */
  public static async start(_api?: Api): Promise<void> {
    if (getTenantId() !== PLATFORM_TENANT_ID) throw new Error("IMAP is only available to the platform bot.");
    const supervisor = this.getInstance();
    await supervisor.startWorker();
  }

  /**
   * Stops the IMAP worker child process.
   */
  public static async stop(): Promise<void> {
    if (this.instance) {
      await this.instance.stopWorker();
    }
  }

  /**
   * Restarts the IMAP worker child process.
   */
  public static async restart(_api?: Api): Promise<void> {
    const supervisor = this.getInstance();
    await supervisor.restartWorker();
  }

  /**
   * Retrieves status summary from child process or fallback configuration.
   */
  public static async getStatus(): Promise<ImapStatusSummary> {
    const supervisor = this.getInstance();
    return supervisor.fetchStatus();
  }

  /**
   * Sends a test OTP dispatch (PayPal or Netflix) via the child process worker.
   */
  public static async sendTestOtp(api: Api, target: "paypal" | "netflix" | "discord" = "netflix"): Promise<{ success: boolean; channel?: string; error?: string }> {
    const supervisor = this.getInstance();
    return supervisor.sendTestOtp(api, target);
  }

  /**
   * Fetches latest emails (Netflix, PayPal, or all) via worker process.
   */
  public static async fetchLatestEmails(
    limit: number = 5,
    unreadOnly: boolean = false,
    filterSender?: string
  ): Promise<ParsedEmailOtp[]> {
    const supervisor = this.getInstance();
    return supervisor.fetchLatestEmails(limit, unreadOnly, filterSender);
  }

  // ── Child Process Lifecycle ─────────────────────────────────────────────────

  private getWorkerPath(): string {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const isTypeScript = import.meta.url.endsWith(".ts");
    const workerFilename = isTypeScript ? "imapWorker.ts" : "imapWorker.js";
    return path.resolve(currentDir, "..", "workers", workerFilename);
  }

  private async startWorker(): Promise<void> {
    if (this.child && this.child.connected) {
      return;
    }

    this.isRunning = true;
    const workerPath = this.getWorkerPath();

    try {
      // Spawn child process with inherited execArgv (for tsx loader support in dev)
      this.child = fork(workerPath, [], {
        execArgv: process.execArgv,
        env: { ...process.env },
        stdio: ["inherit", "inherit", "inherit", "ipc"],
      });

      console.log(`[IMAP Supervisor] 🚀 Dedicated IMAP Child Process spawned (PID: ${this.child.pid}).`);

      this.child.on("message", (msg: any) => {
        if (!msg || typeof msg !== "object") return;

        if (msg.type === "STATUS_UPDATE" && msg.payload) {
          this.cachedStatus = normalizeImapStatusDates(msg.payload);
        } else if (msg.reqId && this.pendingRequests.has(msg.reqId)) {
          const req = this.pendingRequests.get(msg.reqId)!;
          clearTimeout(req.timeout);
          this.pendingRequests.delete(msg.reqId);

          if (msg.type === "STATUS_RESP") {
            req.resolve(normalizeImapStatusDates(msg.payload));
          } else if (msg.type === "TEST_RESP") {
            req.resolve(msg.result);
          } else if (msg.type === "FETCH_RESP") {
            if (msg.success) {
              req.resolve(msg.emails || []);
            } else {
              req.reject(new Error(msg.error || "Gagal mengambil email dari worker"));
            }
          }
        }
      });

      this.child.on("error", (err) => {
        console.error(`[IMAP Supervisor] Child process error (PID: ${this.child?.pid}):`, err);
      });

      this.child.on("exit", (code, signal) => {
        console.warn(`[IMAP Supervisor] Worker process exited with code ${code}, signal ${signal}.`);
        this.cleanupPendingRequests("Worker process exited");
        this.child = null;

        // Auto-respawn if still supposed to be running
        if (this.isRunning && !this.respawnTimeout) {
          console.log("[IMAP Supervisor] Rescheduling child worker respawn in 5 seconds...");
          this.respawnTimeout = setTimeout(() => {
            this.respawnTimeout = null;
            if (this.isRunning) {
              this.startWorker().catch((e) => console.error("[IMAP Supervisor] Respawn error:", e));
            }
          }, 5000);
        }
      });
    } catch (spawnErr) {
      console.error("[IMAP Supervisor] Failed to spawn IMAP worker process:", spawnErr);
    }
  }

  private async stopWorker(): Promise<void> {
    this.isRunning = false;
    if (this.respawnTimeout) {
      clearTimeout(this.respawnTimeout);
      this.respawnTimeout = null;
    }

    if (this.child) {
      const childRef = this.child;
      if (childRef.exitCode === null && childRef.signalCode === null) {
        await new Promise<void>((resolve, reject) => {
          const force = setTimeout(() => { childRef.kill("SIGKILL"); }, 2000);
          const deadline = setTimeout(() => { clearTimeout(force); reject(new Error("IMAP worker did not exit.")); }, 7000);
          childRef.once("exit", () => { clearTimeout(force); clearTimeout(deadline); resolve(); });
          try { if (childRef.connected) childRef.send({ type: "STOP" }); else childRef.kill("SIGTERM"); }
          catch { childRef.kill("SIGKILL"); }
        });
      }
      this.child = null;
    }
    this.cachedStatus = null;
    this.cleanupPendingRequests("Supervisor stopped");
    console.log("[IMAP Supervisor] IMAP Child Process stopped.");
  }

  private async restartWorker(): Promise<void> {
    if (this.child && this.child.connected) {
      this.child.send({ type: "RESTART" });
    } else {
      await this.startWorker();
    }
  }

  private async fetchStatus(): Promise<ImapStatusSummary> {
    if (this.child && this.child.connected) {
      try {
        const status = await this.sendIpcRequest<ImapStatusSummary>("GET_STATUS", {}, 3000);
        this.cachedStatus = normalizeImapStatusDates(status);
        return this.cachedStatus;
      } catch {
        if (this.cachedStatus) return this.cachedStatus;
      }
    }

    const config = await BotConfig.getOrCreate().catch(() => null);
    const isConfigured = !!(config?.imapHost && config?.imapUser && config?.imapPass);

    return {
      connected: false,
      listening: false,
      configured: isConfigured,
      host: config?.imapHost || "-",
      user: config?.imapUser ? `${config.imapUser.slice(0, 3)}***` : "-",
      targetSender: config?.imapTargetSender || "service@intl.paypal.com",
      mailbox: config?.imapMailbox || "INBOX",
      totalOtpForwarded: this.cachedStatus?.totalOtpForwarded || 0,
      lastError: this.cachedStatus?.lastError || "Worker offline / initializing",
      pid: this.child?.pid,
    };
  }

  private async sendTestOtp(_api: Api, target: "paypal" | "netflix" | "discord" = "netflix"): Promise<{ success: boolean; channel?: string; error?: string }> {
    if (this.child && this.child.connected) {
      try {
        return await this.sendIpcRequest<{ success: boolean; channel?: string; error?: string }>("SEND_TEST", { target }, 10000);
      } catch (err: any) {
        return { success: false, error: err?.message || "Worker timeout" };
      }
    }
    return { success: false, error: "IMAP worker process is not running." };
  }

  private async fetchLatestEmails(limit: number, unreadOnly: boolean, filterSender?: string): Promise<ParsedEmailOtp[]> {
    if (this.child && this.child.connected) {
      return await this.sendIpcRequest<ParsedEmailOtp[]>("FETCH_EMAILS", { limit, unreadOnly, filterSender }, 15000);
    }
    throw new Error("IMAP Worker process is offline.");
  }

  // ── IPC Helpers ─────────────────────────────────────────────────────────────

  private sendIpcRequest<T>(type: string, data: Record<string, any> = {}, timeoutMs: number = 5000): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.child || !this.child.connected) {
        return reject(new Error("Worker process is not connected"));
      }

      const reqId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(reqId);
        reject(new Error(`IPC request ${type} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(reqId, { resolve, reject, timeout });

      try {
        this.child.send({ type, reqId, ...data });
      } catch (err) {
        clearTimeout(timeout);
        this.pendingRequests.delete(reqId);
        reject(err);
      }
    });
  }

  private cleanupPendingRequests(reason: string): void {
    for (const [reqId, req] of this.pendingRequests.entries()) {
      clearTimeout(req.timeout);
      req.reject(new Error(`Cancelled: ${reason}`));
    }
    this.pendingRequests.clear();
  }
}
