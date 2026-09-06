import { WaUserSession, WaSessionStep } from "./types.js";

const SESSION_TTL_MS = 15 * 60 * 1000; // 15 minutes
const sessions = new Map<string, WaUserSession>();

export class WaSessionManager {
  static getSession(jid: string): WaUserSession {
    const existing = sessions.get(jid);
    const now = Date.now();

    if (!existing || now - existing.lastActive > SESSION_TTL_MS) {
      const fresh: WaUserSession = {
        jid,
        step: "MAIN_MENU",
        lastActive: now,
        data: {},
      };
      sessions.set(jid, fresh);
      return fresh;
    }

    existing.lastActive = now;
    return existing;
  }

  static setStep(jid: string, step: WaSessionStep, data?: Record<string, any>): WaUserSession {
    const current = this.getSession(jid);
    current.step = step;
    current.lastActive = Date.now();
    if (data) {
      current.data = { ...(current.data || {}), ...data };
    }
    sessions.set(jid, current);
    return current;
  }

  static updateData(jid: string, data: Record<string, any>): WaUserSession {
    const current = this.getSession(jid);
    current.data = { ...(current.data || {}), ...data };
    current.lastActive = Date.now();
    sessions.set(jid, current);
    return current;
  }

  static resetSession(jid: string): void {
    sessions.set(jid, {
      jid,
      step: "MAIN_MENU",
      lastActive: Date.now(),
      data: {},
    });
  }
}
