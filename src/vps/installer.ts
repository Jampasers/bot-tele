import { randomInt } from "node:crypto";
import { createConnection, isIP } from "node:net";
import { Client } from "ssh2";

export interface VpsOs { key: string; name: string; family: "linux" | "windows"; image: string; windowsImageName?: string; }
const linux = (key: string, name: string, image: string): VpsOs => ({ key, name, image, family: "linux" });
const windows = (key: string, version: string): VpsOs => ({ key, name: `Windows Server ${version}`, family: "windows", image: "ubuntu-24-04-x64", windowsImageName: `Windows Server ${version} ServerStandard` });
/** Local reference choices; actual availability is checked with DO before checkout/create. */
export const OS_CATALOG: Readonly<Record<string, VpsOs>> = Object.freeze({
    ubuntu22: linux("ubuntu22", "Ubuntu 22.04 LTS", "ubuntu-22-04-x64"),
    ubuntu24: linux("ubuntu24", "Ubuntu 24.04 LTS", "ubuntu-24-04-x64"),
    ubuntu26: linux("ubuntu26", "Ubuntu 26.04 LTS", "ubuntu-26-04-x64"),
    debian13: linux("debian13", "Debian 13", "debian-13-x64"),
    almalinux8: linux("almalinux8", "AlmaLinux 8", "almalinux-8-x64"),
    almalinux9: linux("almalinux9", "AlmaLinux 9", "almalinux-9-x64"),
    almalinux10: linux("almalinux10", "AlmaLinux 10", "almalinux-10-x64"),
    rocky8: linux("rocky8", "Rocky Linux 8", "rockylinux-8-x64"),
    rocky9: linux("rocky9", "Rocky Linux 9", "rockylinux-9-x64"),
    rocky10: linux("rocky10", "Rocky Linux 10", "rockylinux-10-x64"),
    centos9: linux("centos9", "CentOS Stream 9", "centos-stream-9-x64"),
    centos10: linux("centos10", "CentOS Stream 10", "centos-stream-10-x64"),
    fedora43: linux("fedora43", "Fedora 43", "fedora-43-x64"),
    fedora44: linux("fedora44", "Fedora 44", "fedora-44-x64"),
    windows2012r2: windows("windows2012r2", "2012 R2"), windows2016: windows("windows2016", "2016"),
    windows2019: windows("windows2019", "2019"), windows2022: windows("windows2022", "2022"),
});
export function getOs(key: string): VpsOs | undefined { return Object.hasOwn(OS_CATALOG, key) ? OS_CATALOG[key] : undefined; }
export const INSTALLER_COMMIT = "6a0a2c9b3c678728fe63bc8bbb0ab82c86717830";

export class InstallerError extends Error {
    constructor(public readonly kind: "timeout" | "cancelled" | "authentication" | "ssh" | "validation", public readonly uncertain = false) {
        super(kind === "authentication" ? "Login SSH belum berhasil." : kind === "timeout" ? "Pemeriksaan SSH melewati batas waktu."
            : kind === "cancelled" ? "Pemeriksaan installer dihentikan." : kind === "validation" ? "Konfigurasi installer tidak valid."
            : "Koneksi SSH installer belum dapat dipastikan.");
        this.name = "InstallerError";
    }
}
export function generatePassword(): string {
    const sets = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnpqrstuvwxyz", "23456789", "!@#%+_-="];
    const alphabet = sets.join(""); const chars = sets.map((set) => set[randomInt(set.length)]!);
    while (chars.length < 24) chars.push(alphabet[randomInt(alphabet.length)]!);
    for (let i = chars.length - 1; i > 0; i--) { const j = randomInt(i + 1); [chars[i], chars[j]] = [chars[j]!, chars[i]!]; }
    return chars.join("");
}
function validatePassword(password: string): void {
    if (password.length < 16 || password.length > 128 || /[\r\n\0]/.test(password) || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/\d/.test(password) || !/[^A-Za-z0-9]/.test(password)) throw new InstallerError("validation");
}
function quote(value: string): string { return `'${value.replace(/'/g, "'\\''")}'`; }
function validIp(ip: string): void { if (!isIP(ip)) throw new InstallerError("validation"); }
function stateDirectory(orderId: string): string {
    if (!/^[A-Za-z0-9_-]{6,100}$/.test(orderId)) throw new InstallerError("validation");
    return `/root/.bot-tele-vps/${orderId}`;
}
export function buildUserData(password: string): string {
    validatePassword(password);
    return `#!/bin/bash
set -eu
printf '%s\\n' ${quote(`root:${password}`)} | chpasswd
passwd -u root || true
mkdir -p /etc/ssh/sshd_config.d
cat > /etc/ssh/sshd_config.d/00-password-login.conf <<'SSHCONFIG'
PasswordAuthentication yes
PermitRootLogin yes
SSHCONFIG
if [ -f /etc/ssh/sshd_config ]; then
  if grep -qE '^[# ]*PasswordAuthentication' /etc/ssh/sshd_config; then
    sed -i 's/^[# ]*PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config
  else echo 'PasswordAuthentication yes' >> /etc/ssh/sshd_config; fi
  if grep -qE '^[# ]*PermitRootLogin' /etc/ssh/sshd_config; then
    sed -i 's/^[# ]*PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config
  else echo 'PermitRootLogin yes' >> /etc/ssh/sshd_config; fi
fi
/usr/sbin/sshd -t
systemctl restart ssh || systemctl restart sshd
`;
}

export interface SshRunInput { ip: string; password: string; username: string; command: string; stdin?: string; timeoutMs: number; mutation?: boolean; }
export interface SshRunResult { code: number | null; output: string; }
export type SshExecutor = (input: SshRunInput, signal?: AbortSignal) => Promise<SshRunResult>;
export interface InstallerDependencies {
    ssh?: SshExecutor;
    tcp?: (ip: string, port: number, signal?: AbortSignal) => Promise<boolean>;
    fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

/** Password stays in ssh2 memory; no local child process/CLI argument, debug logger, or raw error escapes. */
const executeSsh: SshExecutor = (input, signal) => new Promise((resolve, reject) => {
    validIp(input.ip);
    if (signal?.aborted) { reject(new InstallerError("cancelled")); return; }
    const client = new Client(); let finished = false; let output = "";
    const finish = (error?: InstallerError, result?: SshRunResult): void => {
        if (finished) return; finished = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); client.destroy();
        if (error) reject(error); else resolve(result!);
    };
    const abort = () => finish(new InstallerError("cancelled", input.mutation === true));
    const timer = setTimeout(() => finish(new InstallerError("timeout", input.mutation === true)), input.timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    client.on("ready", () => {
        client.exec(input.command, (error, stream) => {
            if (error) { finish(new InstallerError("ssh", input.mutation === true)); return; }
            const collect = (data: Buffer): void => { output = (output + data.toString("utf8")).slice(-65536); };
            stream.on("data", collect); stream.stderr.on("data", collect);
            stream.on("error", () => finish(new InstallerError("ssh", input.mutation === true)));
            stream.stderr.on("error", () => finish(new InstallerError("ssh", input.mutation === true)));
            stream.on("close", (code: number | null) => finish(undefined, { code, output }));
            if (input.stdin !== undefined) stream.end(input.stdin); else stream.end();
        });
    });
    client.on("error", (error: Error & { level?: string }) => finish(new InstallerError(error.level === "client-authentication" ? "authentication" : "ssh", input.mutation === true)));
    client.on("close", () => finish(new InstallerError("ssh", input.mutation === true)));
    try { client.connect({ host: input.ip, port: 22, username: input.username, password: input.password,
        readyTimeout: Math.min(input.timeoutMs, 20_000), keepaliveInterval: 10_000, keepaliveCountMax: 3 });
    } catch { finish(new InstallerError("ssh", input.mutation === true)); }
});

export async function testSsh(input: { ip: string; password: string }, signal?: AbortSignal, deps: InstallerDependencies = {}): Promise<boolean> {
    try {
        const result = await (deps.ssh ?? executeSsh)({ ...input, username: "root", command: "test \"$(id -u)\" = 0 && printf '__VPS_SSH_READY__'", timeoutMs: 20_000 }, signal);
        return result.code === 0 && result.output.includes("__VPS_SSH_READY__");
    } catch (error) { if (signal?.aborted) throw new InstallerError("cancelled"); if (error instanceof InstallerError && error.kind === "validation") throw error; return false; }
}

/** Only fixed machine markers/validated URLs are returned; installer text may contain passwords. */
export function redactInstallerOutput(value: string, secrets: readonly string[]): string {
    let result = value;
    for (const secret of secrets) if (secret) result = result.split(secret).join("[REDACTED]");
    return result.replace(/dop_v1_[A-Za-z0-9_-]+/g, "[REDACTED]");
}
export function extractInstallerLogUrl(text: string, ip: string): string | undefined {
    if (!isIP(ip)) return undefined;
    const host = isIP(ip) === 6 ? `[${ip}]` : ip;
    for (const match of text.matchAll(/http:\/\/(?:IP|\[[\da-fA-F:]+\]|[\d.]+)(?::\d+)?\/[A-Za-z0-9]{8}(?=$|[\s\x1b])/g)) {
        try {
            const url = new URL(match[0].replace(/^http:\/\/IP(?=[:/])/, `http://${host}`));
            if (url.hostname === host && (!url.port || Number(url.port) > 0)) return url.href;
        } catch { /* Ignore malformed installer output. */ }
    }
    return undefined;
}

export interface WindowsInstallInput { ip: string; password: string; windowsPassword: string; os: string; orderId: string; }
export interface WindowsInstallResult { state: "prepared" | "running" | "failed"; logUrl?: string; }
export async function launchWindows(input: WindowsInstallInput, signal?: AbortSignal, deps: InstallerDependencies = {}): Promise<WindowsInstallResult> {
    const os = getOs(input.os); validatePassword(input.windowsPassword); validIp(input.ip);
    if (os?.family !== "windows" || !os.windowsImageName) throw new InstallerError("validation");
    const directory = stateDirectory(input.orderId);
    // mkdir is the durable remote claim. An uncertain attempt is inspected, never executed a second time.
    // Caller must persist INSTALLING before calling and must never return here after scheduling reboot.
    const script = `set -eu
umask 077
state=${quote(directory)}
mkdir -p /root/.bot-tele-vps
if ! mkdir "$state" 2>/dev/null; then
  if [ -f "$state/prepared" ]; then echo __VPS_PREPARED__;
  elif [ -f "$state/failed" ]; then echo __VPS_FAILED__;
  else echo __VPS_RUNNING__; fi
  exit 0
fi
trap 'touch "$state/failed"' EXIT
COMMIT=${quote(INSTALLER_COMMIT)}
curl --connect-timeout 20 --max-time 180 -fLo /root/reinstall.sh "https://raw.githubusercontent.com/bin456789/reinstall/$COMMIT/reinstall.sh"
sed -i "/^confhome=/s|/main$|/$COMMIT|" /root/reinstall.sh
sed -i "/^confhome_cn=/s|/main$|/$COMMIT|" /root/reinstall.sh
sed -i 's/command curl --insecure /command curl /' /root/reinstall.sh
chmod 700 /root/reinstall.sh
bash /root/reinstall.sh windows \\
  --image-name ${quote(os.windowsImageName)} \\
  --lang en-us \\
  --username administrator \\
  --rdp-port 3389 \\
  --password ${quote(input.windowsPassword)} \\
  --force-boot-mode bios </dev/null
touch "$state/prepared"
trap - EXIT
echo __VPS_PREPARED__
`;
    const result = await (deps.ssh ?? executeSsh)({ ip: input.ip, password: input.password, username: "root", command: "bash -s", stdin: script, timeoutMs: 15 * 60_000, mutation: true }, signal);
    const sanitized = redactInstallerOutput(result.output, [input.password, input.windowsPassword]);
    const logUrl = extractInstallerLogUrl(sanitized, input.ip);
    const state = result.code === 0 && sanitized.includes("__VPS_PREPARED__") ? "prepared"
        : result.code === 0 && sanitized.includes("__VPS_RUNNING__") ? "running" : "failed";
    return { state, ...(logUrl ? { logUrl } : {}) };
}

export async function scheduleInstallerReboot(input: { ip: string; password: string; orderId: string }, signal?: AbortSignal, deps: InstallerDependencies = {}): Promise<"scheduled" | "already_scheduled" | "failed"> {
    const directory = stateDirectory(input.orderId);
    const script = `set -eu
state=${quote(directory)}
test -f "$state/prepared" || { echo __VPS_REBOOT_FAILED__; exit 1; }
if ! mkdir "$state/reboot-requested" 2>/dev/null; then
  if [ -f "$state/reboot-failed" ]; then echo __VPS_REBOOT_FAILED__; else echo __VPS_REBOOT_ALREADY__; fi
  exit 0
fi
if shutdown -r +1; then echo __VPS_REBOOT_SCHEDULED__;
else touch "$state/reboot-failed"; echo __VPS_REBOOT_FAILED__; exit 1; fi
`;
    const result = await (deps.ssh ?? executeSsh)({ ip: input.ip, password: input.password, username: "root", command: "bash -s", stdin: script, timeoutMs: 20_000, mutation: true }, signal);
    if (result.code === 0 && result.output.includes("__VPS_REBOOT_SCHEDULED__")) return "scheduled";
    if (result.code === 0 && result.output.includes("__VPS_REBOOT_ALREADY__")) return "already_scheduled";
    return "failed";
}

export async function checkTcpPort(ip: string, port: number, signal?: AbortSignal): Promise<boolean> {
    validIp(ip);
    return new Promise((resolve) => {
        if (signal?.aborted) { resolve(false); return; }
        let finished = false;
        const socket = createConnection({ host: ip, port });
        const finish = (open: boolean): void => { if (finished) return; finished = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); socket.destroy(); resolve(open); };
        const abort = () => finish(false), timer = setTimeout(() => finish(false), 5000);
        signal?.addEventListener("abort", abort, { once: true });
        socket.once("connect", () => finish(true)); socket.once("error", () => finish(false));
    });
}
async function discoverInstallerLogUrl(input: { ip: string; windowsPassword: string }, signal: AbortSignal | undefined, deps: InstallerDependencies): Promise<string | undefined> {
    const result = await (deps.ssh ?? executeSsh)({ ip: input.ip, password: input.windowsPassword, username: "administrator",
        command: "tr ' ' '\\n' < /proc/cmdline | grep -E '^extra_web_(path|port)='", timeoutMs: 5000 }, signal);
    const path = result.output.match(/^extra_web_path=['"]?(\/[A-Za-z0-9]{8})['"]?\s*$/m)?.[1];
    const port = result.output.match(/^extra_web_port=['"]?(\d+)['"]?\s*$/m)?.[1] ?? "80";
    return result.code === 0 && path ? extractInstallerLogUrl(`http://IP:${port}${path}`, input.ip) : undefined;
}
async function checkInstallerLogPage(url: string, signal: AbortSignal | undefined, deps: InstallerDependencies): Promise<boolean> {
    const controller = new AbortController(), abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 5000);
    try {
        if (signal?.aborted) return false;
        const response = await (deps.fetch ?? fetch)(url, { redirect: "error", signal: controller.signal });
        if (!response.ok || !response.body) { void response.body?.cancel().catch(() => {}); return false; }
        const reader = response.body.getReader(); let body = "";
        try {
            for (;;) {
                const part = await reader.read(); if (part.done) return false;
                body += Buffer.from(part.value).toString("utf8");
                if (body.includes("<title>Reinstall Logs</title>")) return true;
                if (body.length > 65536) return false;
            }
        } finally { await reader.cancel().catch(() => {}); }
    } catch { return false; }
    finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}
export interface WindowsInspection { rdpOpen: boolean; loginVerified: false; logState: "ready" | "unavailable"; logUrl?: string; detail: string; }
/** One bounded poll; the persistent worker owns intervals, consecutive successes, and timeout/recovery policy. */
export async function inspectWindows(input: { ip: string; windowsPassword: string; logUrl?: string }, signal?: AbortSignal, deps: InstallerDependencies = {}): Promise<WindowsInspection> {
    validIp(input.ip);
    if (signal?.aborted) throw new InstallerError("cancelled");
    const rdpOpen = await (deps.tcp ?? checkTcpPort)(input.ip, 3389, signal);
    let logUrl = input.logUrl ? extractInstallerLogUrl(input.logUrl, input.ip) : undefined;
    if (!logUrl && !rdpOpen) {
        try { logUrl = await discoverInstallerLogUrl(input, signal, deps); } catch { /* Installer SSH can disappear during reboot. */ }
    }
    const logReady = logUrl ? await checkInstallerLogPage(logUrl, signal, deps) : false;
    if (signal?.aborted) throw new InstallerError("cancelled");
    return { rdpOpen, loginVerified: false, logState: logReady ? "ready" : "unavailable", ...(logUrl ? { logUrl } : {}),
        detail: rdpOpen ? "Port TCP RDP terbuka. Login Windows belum diverifikasi."
            : logReady ? "Viewer log installer tersedia; instalasi Windows masih dipantau."
                : "RDP belum terjangkau dan viewer log belum tersedia; hasil instalasi belum diketahui." };
}
