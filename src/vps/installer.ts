import { randomInt } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createConnection, isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { Client } from "ssh2";
import { InstallerError } from "./installerError.js";
import { validateWindowsImageUrl, type WindowsBootMode } from "./windowsImages.js";

export { InstallerError } from "./installerError.js";

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
const runtimeOs = new Map<string, VpsOs>();
export function registerOs(os: VpsOs): void { if (/^[a-z0-9][a-z0-9_-]{1,31}$/.test(os.key)) runtimeOs.set(os.key, os); }
export function getOs(key: string): VpsOs | undefined { return runtimeOs.get(key) ?? (Object.hasOwn(OS_CATALOG, key) ? OS_CATALOG[key] : undefined); }
export const INSTALLER_COMMIT = "6a0a2c9b3c678728fe63bc8bbb0ab82c86717830";

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
const jpegLib = ((jpeg as unknown as { default?: typeof jpeg }).default || jpeg);
let cachedWallpaperBase64: string | null = null;
let cachedWallpaperMtime = 0;

export function getWallpaperJpegBase64(customPath?: string): string | null {
    try {
        const candidates = customPath
            ? [customPath]
            : [
                fileURLToPath(new URL("../../Wallpaper.png", import.meta.url)),
                path.resolve(process.cwd(), "Wallpaper.png"),
            ];
        let filePath: string | null = null;
        for (const c of candidates) {
            if (existsSync(c)) {
                filePath = c;
                break;
            }
        }
        if (!filePath) return null;
        const stat = statSync(filePath);
        if (cachedWallpaperBase64 && stat.mtimeMs === cachedWallpaperMtime && !customPath) {
            return cachedWallpaperBase64;
        }
        const pngBuffer = readFileSync(filePath);
        const png = PNG.sync.read(pngBuffer);
        const encoded = jpegLib.encode({ data: png.data, width: png.width, height: png.height }, 95);
        const b64 = encoded.data.toString("base64");
        if (!customPath) {
            cachedWallpaperBase64 = b64;
            cachedWallpaperMtime = stat.mtimeMs;
        }
        return b64;
    } catch (error) {
        console.error("[VPS:Installer] Failed to load/encode Wallpaper.png:", error);
        return null;
    }
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

export async function testSsh(input: { ip: string; password: string; username?: string }, signal?: AbortSignal, deps: InstallerDependencies = {}): Promise<boolean> {
    try {
        const command = !input.username || input.username === "root"
            ? "test \"$(id -u)\" = 0 && printf '__VPS_SSH_READY__'"
            : "sudo -n true && printf '__VPS_SSH_READY__'";
        const result = await (deps.ssh ?? executeSsh)({ ...input, username: input.username ?? "root", command, timeoutMs: 20_000 }, signal);
        return result.code === 0 && result.output.includes("__VPS_SSH_READY__");
    } catch (error) { if (signal?.aborted) throw new InstallerError("cancelled"); if (error instanceof InstallerError && error.kind === "validation") throw error; return false; }
}

export function parseWindowsBootMode(output: string): WindowsBootMode {
    const virtualization = output.match(/^\*\*VPS_VIRTUALIZATION\*\*:(lxc|openvz)\r?$/m)?.[1];
    if (virtualization) throw new InstallerError("validation", false, "unsupported_virtualization");
    const bootMode = output.match(/^\*\*VPS_BOOT_MODE\*\*:(efi|bios)\r?$/m)?.[1];
    if (bootMode !== "bios" && bootMode !== "efi") throw new InstallerError("validation", false, "boot_detection");
    return bootMode;
}

export async function selectWindowsImage(
    input: { ip: string; password: string; username?: string; candidates: readonly string[] },
    signal?: AbortSignal,
    deps: InstallerDependencies = {},
): Promise<string> {
    validIp(input.ip);
    const candidates = [...new Set(input.candidates.map(validateWindowsImageUrl))];
    if (!candidates.length) throw new InstallerError("validation", false, "image_unreachable");
    const script = `set -u
i=0
${candidates.map(url => `i=$((i+1))
set +e
curl --silent --show-error --location --fail --connect-timeout 5 --max-time 12 --range 0-0 --max-filesize 1048576 ${quote(url)} --output /dev/null
rc=$?
set -e
if [ "$rc" -eq 0 ] || [ "$rc" -eq 63 ]; then
  printf '__VPS_IMAGE_OK__:%s\\n' "$i"
  exit 0
fi`).join("\n")}
exit 1
`;
    const result = await (deps.ssh ?? executeSsh)({
        ip: input.ip,
        password: input.password,
        username: input.username ?? "root",
        command: input.username && input.username !== "root" ? "sudo -n bash -s" : "bash -s",
        stdin: script,
        timeoutMs: Math.min(60_000, Math.max(15_000, candidates.length * 15_000)),
    }, signal);
    const index = Number(result.output.match(/__VPS_IMAGE_OK__:(\d+)/)?.[1] ?? 0) - 1;
    if (result.code !== 0 || index < 0 || index >= candidates.length) throw new InstallerError("validation", false, "image_unreachable");
    return candidates[index]!;
}

/** Read-only Linux probe. It must run and be persisted before reinstall preparation. */
export async function detectWindowsBootMode(
    input: { ip: string; password: string; username?: string },
    signal?: AbortSignal,
    deps: InstallerDependencies = {},
): Promise<WindowsBootMode> {
    const command = `set -eu
if [ -d /sys/firmware/efi ]; then boot_mode=efi; else boot_mode=bios; fi
virtualization=unknown
if command -v systemd-detect-virt >/dev/null 2>&1; then
  virtualization=$(systemd-detect-virt 2>/dev/null || true)
  virtualization=$(printf '%s' "$virtualization" | head -n 1 | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_.-')
  [ -n "$virtualization" ] || virtualization=unknown
fi
if [ "$virtualization" = unknown ] && [ -d /proc/vz ]; then
  virtualization=openvz
elif [ "$virtualization" = unknown ] && [ -r /proc/1/environ ] && grep -aq 'container=lxc' /proc/1/environ; then
  virtualization=lxc
fi
printf '**VPS_BOOT_MODE**:%s\n' "$boot_mode"
printf '**VPS_VIRTUALIZATION**:%s\n' "$virtualization"
`;
    const result = await (deps.ssh ?? executeSsh)({ ip: input.ip, password: input.password, username: input.username ?? "root",
        command: input.username && input.username !== "root" ? "sudo -n bash -s" : "bash -s", stdin: command, timeoutMs: 20_000 }, signal);
    if (result.code !== 0) throw new InstallerError("ssh");
    return parseWindowsBootMode(result.output);
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

export interface WindowsInstallInput { ip: string; password: string; username?: string; windowsPassword: string; os: string; orderId: string; bootMode: WindowsBootMode; imageUrl: string; installChrome?: boolean; wallpaperPath?: string; }
export interface WindowsInstallResult { state: "prepared" | "running" | "failed"; logUrl?: string; errorDetail?: string; bootMode: WindowsBootMode; imageUrl: string; }
export async function launchWindows(input: WindowsInstallInput, signal?: AbortSignal, deps: InstallerDependencies = {}): Promise<WindowsInstallResult> {
    const os = getOs(input.os); validatePassword(input.windowsPassword); validIp(input.ip);
    if (os?.family !== "windows" || (input.bootMode !== "bios" && input.bootMode !== "efi")) throw new InstallerError("validation");
    const imageUrl = validateWindowsImageUrl(input.imageUrl);
    const passwordBase64 = Buffer.from(input.windowsPassword, "utf8").toString("base64");
    const directory = stateDirectory(input.orderId);
    const chromeBatPatch = input.installChrome === true ? `
chrome_bat_code = r'''    _bot_assets=${BOT_TELE_CONFIG_ROOT:-/configs/bot-tele}
    _chrome_src="$_bot_assets/google-chrome-enterprise.msi"
    _chrome_dst=$(get_path_in_correct_case "$os_dir/Windows/Temp/google-chrome-enterprise.msi")
    if [ ! -f "$_chrome_src" ]; then
        error_and_exit "Requested Chrome package is missing from installer initrd."
    fi
    mkdir -p "$(dirname "$_chrome_dst")"
    cp -f "$_chrome_src" "$_chrome_dst"

    cat << 'EOF_CHROME_PS1' > "$os_dir/windows-install-chrome.ps1"
$ErrorActionPreference = 'Stop'
$outMsi = Join-Path $env:WINDIR 'Temp\\google-chrome-enterprise.msi'
if (-not (Test-Path $outMsi)) { throw 'Preloaded Chrome MSI is missing' }
if ((Get-Item $outMsi).Length -lt 10485760) { throw 'Preloaded Chrome MSI is incomplete' }

Start-Service msiserver -ErrorAction SilentlyContinue
$log = Join-Path $env:TEMP 'chrome-msi-install.log'
$proc = Start-Process msiexec.exe -ArgumentList "/i \`"$outMsi\`" /qn /norestart /log \`"$log\`"" -Wait -PassThru
if ($proc.ExitCode -ne 0 -and $proc.ExitCode -ne 3010) {
    throw "Chrome MSI failed with exit code $($proc.ExitCode)"
}

$pf = [Environment]::GetFolderPath('ProgramFiles')
$pfx = [Environment]::GetFolderPath('ProgramFilesX86')
$chromePaths = @(
    (Join-Path $pf 'Google\\Chrome\\Application\\chrome.exe'),
    (Join-Path $pfx 'Google\\Chrome\\Application\\chrome.exe')
)
$chromeExe = $chromePaths | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chromeExe) { throw 'Chrome executable was not found after MSI install' }

$desktop = [Environment]::GetFolderPath('CommonDesktopDirectory')
$link = Join-Path $desktop 'Google Chrome.lnk'
if (-not (Test-Path $link)) {
    try {
        $wsh = New-Object -ComObject WScript.Shell
        $sc = $wsh.CreateShortcut($link)
        $sc.TargetPath = $chromeExe
        $sc.Save()
    } catch {}
}
Set-Content -Path (Join-Path $env:SystemRoot 'bot-tele-chrome-ready') -Value 'ready' -Encoding Ascii
Remove-Item -Force $outMsi -ErrorAction SilentlyContinue
EOF_CHROME_PS1
    cat << 'EOF_CHROME_INSTALL' > "$os_dir/windows-install-chrome.bat"
@echo off
del "%SystemRoot%\\bot-tele-chrome-ready" >nul 2>&1
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%SystemDrive%\\windows-install-chrome.ps1" >> "%SystemDrive%\\windows-setup.log" 2>&1
if errorlevel 1 exit /b 1
if not exist "%SystemRoot%\\bot-tele-chrome-ready" exit /b 1
del "%SystemDrive%\\windows-install-chrome.ps1" >nul 2>&1
del "%~f0" >nul 2>&1
exit /b 0
EOF_CHROME_INSTALL
    printf 'ready' > "$os_dir/Windows/bot-tele-chrome-required"
    unix2dos "$os_dir/windows-install-chrome.ps1" 2>/dev/null || true
    unix2dos "$os_dir/windows-install-chrome.bat" 2>/dev/null || true
    bats="$bats windows-install-chrome.bat"'''
` : "";
    const wallpaperB64 = getWallpaperJpegBase64(input.wallpaperPath);
    const wallpaperScript = wallpaperB64 ? `
cat << 'EOF_WALLPAPER_B64' | base64 -d > /root/wallpaper.jpg
${wallpaperB64}
EOF_WALLPAPER_B64
chmod 644 /root/wallpaper.jpg
` : "";
    // mkdir is the durable remote claim. An uncertain attempt is inspected, never executed a second time.
    // Caller must persist INSTALLING before calling and must never return here after scheduling reboot.
    const script = `set -eu
umask 077
state=${quote(directory)}
mkdir -p /root/.bot-tele-vps
if ! mkdir "$state" 2>/dev/null; then
  if [ -f "$state/prepared" ]; then echo __VPS_PREPARED__; exit 0;
  elif [ -f "$state/failed" ]; then rm -f "$state/failed";
  else echo __VPS_RUNNING__; exit 0; fi
fi
trap 'touch "$state/failed"' EXIT
if command -v cloud-init >/dev/null 2>&1; then
  if command -v timeout >/dev/null 2>&1; then timeout 20s cloud-init status --wait || true;
  else cloud-init status --wait || true; fi
fi
for i in $(seq 1 30); do
  if fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 || fuser /var/lib/apt/lists/lock >/dev/null 2>&1; then
    sleep 2
  else
    break
  fi
done
set +e
curl --silent --show-error --location --fail --connect-timeout 15 --max-time 30 --range 0-0 --max-filesize 1048576 ${quote(imageUrl)} --output /dev/null
image_check_rc=$?
set -e
if [ "$image_check_rc" -ne 0 ] && [ "$image_check_rc" -ne 63 ]; then
  echo __VPS_IMAGE_UNREACHABLE__
  exit 1
fi
${input.installChrome === true ? `
CHROME_MSI_URL='https://dl.google.com/dl/chrome/install/googlechromestandaloneenterprise64.msi'
rm -f /root/google-chrome-enterprise.msi
if ! curl --silent --show-error --location --fail --retry 4 --retry-delay 2 --connect-timeout 15 --max-time 180 \\
  -o /root/google-chrome-enterprise.msi "$CHROME_MSI_URL"; then
  echo __VPS_CHROME_PACKAGE_UNREACHABLE__
  exit 1
fi
chrome_size=$(wc -c < /root/google-chrome-enterprise.msi)
if [ "$chrome_size" -lt 10485760 ]; then
  echo __VPS_CHROME_PACKAGE_INVALID__
  exit 1
fi
echo "[PATCH] Chrome MSI preloaded: $chrome_size bytes"
` : ""}
COMMIT=${quote(INSTALLER_COMMIT)}
curl --connect-timeout 20 --max-time 180 -fLo /root/reinstall.sh "https://raw.githubusercontent.com/bin456789/reinstall/$COMMIT/reinstall.sh"
sed -i "/^confhome=/s|/main$|/$COMMIT|" /root/reinstall.sh
sed -i "/^confhome_cn=/s|/main$|/$COMMIT|" /root/reinstall.sh
sed -i 's/command curl --insecure /command curl /' /root/reinstall.sh
chmod 700 /root/reinstall.sh
${wallpaperScript}
cat << 'EOF_PATCH_PY' > /root/patch_trans.py
import os
import shutil
import sys

trans_path = sys.argv[1]
initrd_dir = os.path.dirname(trans_path)
assets_dir = os.path.join(initrd_dir, 'configs', 'bot-tele')
os.makedirs(assets_dir, exist_ok=True)
if ${wallpaperB64 ? "True" : "False"} and os.path.exists('/root/wallpaper.jpg'):
    shutil.copyfile('/root/wallpaper.jpg', os.path.join(assets_dir, 'wallpaper.jpg'))
if ${input.installChrome === true ? "True" : "False"}:
    chrome_source = '/root/google-chrome-enterprise.msi'
    if not os.path.exists(chrome_source):
        raise SystemExit('Requested Chrome package is missing before initrd packing')
    shutil.copyfile(chrome_source, os.path.join(assets_dir, 'google-chrome-enterprise.msi'))

with open(trans_path, 'r', encoding='utf-8') as f:
    lines = f.read().splitlines()

new_lines = []
bats_found = False
gpo_found = False
wallpaper_copy_code = r'''    _bot_assets=${BOT_TELE_CONFIG_ROOT:-/configs/bot-tele}
    _wp_src="$_bot_assets/wallpaper.jpg"
    if [ -f "$_wp_src" ]; then
        wallpaper_win_dir=$(get_path_in_correct_case "$os_dir/Windows")
        if [ -d "$wallpaper_win_dir" ]; then
            cp -f "$_wp_src" "$wallpaper_win_dir/wallpaper.jpg" 2>/dev/null || true
        fi
    fi'''
password_bat_code = r'''    cat << 'EOF_PASSWORD_PS1' > "$os_dir/windows-set-admin-password.ps1"
$ErrorActionPreference = 'Stop'
$passwordBytes = [Convert]::FromBase64String('${passwordBase64}')
try {
    $password = [Text.Encoding]::UTF8.GetString($passwordBytes)
    $lastError = $null
    for ($attempt = 1; $attempt -le 30; $attempt++) {
        try {
            $administrator = $null
            if (Get-Command Get-LocalUser -ErrorAction SilentlyContinue) {
                $administrator = Get-LocalUser | Where-Object { $_.SID.Value -like '*-500' } | Select-Object -First 1
            }
            if (-not $administrator) {
                $administrator = Get-WmiObject Win32_UserAccount -Filter "LocalAccount=True" | Where-Object { $_.SID -like '*-500' } | Select-Object -First 1
            }
            if (-not $administrator) { throw 'Built-in administrator account was not found' }
            if (Get-Command Set-LocalUser -ErrorAction SilentlyContinue) {
                $secure = ConvertTo-SecureString $password -AsPlainText -Force
                Set-LocalUser -Name $administrator.Name -Password $secure -PasswordNeverExpires $true
                Enable-LocalUser -Name $administrator.Name -ErrorAction SilentlyContinue
            } else {
                $account = [ADSI]("WinNT://" + $env:COMPUTERNAME + "/" + $administrator.Name + ",user")
                $account.SetPassword($password)
                $flags = [int]$account.Get('UserFlags')
                $account.Put('UserFlags', (($flags -band (-bnot 2)) -bor 65536))
                $account.SetInfo()
            }
            exit 0
        } catch {
            $lastError = $_
            Start-Sleep -Seconds 2
        }
    }
    throw $lastError
} finally {
    if ($passwordBytes) { [Array]::Clear($passwordBytes, 0, $passwordBytes.Length) }
    $password = $null
}
EOF_PASSWORD_PS1
    cat << 'EOF_PASSWORD_BAT' > "$os_dir/windows-set-admin-password.bat"
@echo off
del "%SystemRoot%\\bot-tele-password-ready" >nul 2>&1
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%SystemDrive%\\windows-set-admin-password.ps1" >> "%SystemDrive%\\windows-setup.log" 2>&1
if errorlevel 1 exit /b 1
echo ready>"%SystemRoot%\\bot-tele-password-ready"
del "%SystemDrive%\\windows-set-admin-password.ps1" >nul 2>&1
del "%~f0" >nul 2>&1
EOF_PASSWORD_BAT
    unix2dos "$os_dir/windows-set-admin-password.ps1" 2>/dev/null || true
    unix2dos "$os_dir/windows-set-admin-password.bat" 2>/dev/null || true
    bats="$bats windows-set-admin-password.bat"'''
fix_bat_code = r'''    cat << 'EOF_RDP_FIX' > "$os_dir/windows-fix-rdp.bat"
@echo off
setlocal EnableExtensions
set /a BOT_TELE_ATTEMPT=0
:BOT_TELE_WAIT_SETUP
if not exist "%SystemRoot%\\bot-tele-password-ready" (
    if exist "%SystemDrive%\\windows-set-admin-password.bat" call "%SystemDrive%\\windows-set-admin-password.bat"
)
${input.installChrome === true ? 'if exist "%SystemRoot%\\\\bot-tele-chrome-required" if not exist "%SystemRoot%\\\\bot-tele-chrome-ready" (\\n    if exist "%SystemDrive%\\\\windows-install-chrome.bat" call "%SystemDrive%\\\\windows-install-chrome.bat"\\n)\\n' : ""}if exist "%SystemRoot%\\bot-tele-password-ready" (
    if not exist "%SystemRoot%\\bot-tele-chrome-required" goto BOT_TELE_SETUP_READY
    if exist "%SystemRoot%\\bot-tele-chrome-ready" goto BOT_TELE_SETUP_READY
)
set /a BOT_TELE_ATTEMPT+=1
if %BOT_TELE_ATTEMPT% GEQ 30 exit /b 1
timeout /t 10 /nobreak >nul 2>&1
goto BOT_TELE_WAIT_SETUP
:BOT_TELE_SETUP_READY
rem Nonaktifkan keharusan tekan Ctrl+Alt+Del saat login
reg add "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System" /v DisableCAD /t REG_DWORD /d 1 /f
reg add "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon" /v DisableCAD /t REG_DWORD /d 1 /f

rem Aktifkan Remote Desktop dan matikan NLA (Network Level Authentication)
reg add "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server" /v fDenyTSConnections /t REG_DWORD /d 0 /f
reg add "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server\\WinStations\\RDP-Tcp" /v UserAuthentication /t REG_DWORD /d 0 /f
reg add "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server\\WinStations\\RDP-Tcp" /v SecurityLayer /t REG_DWORD /d 0 /f

rem Izinkan CredSSP encryption oracle di server
reg add "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System\\CredSSP\\Parameters" /v AllowEncryptionOracle /t REG_DWORD /d 2 /f

rem Izinkan port RDP di Windows Firewall
netsh advfirewall firewall set rule group="remote desktop" new enable=Yes
netsh advfirewall firewall add rule name="Allow-RDP-TCP" dir=in action=allow protocol=TCP localport=3389
netsh advfirewall firewall add rule name="Allow-RDP-UDP" dir=in action=allow protocol=UDP localport=3389

rem Pastikan service TermService berjalan otomatis
sc config TermService start= auto
net start TermService

rem ========================================================
rem OPTIMASI & DEBLOAT WINDOWS VPS (HEMAT RAM & RESOURCE)
rem ========================================================

rem 1. Nonaktifkan Windows Defender / Antivirus & SmartScreen
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Set-MpPreference -DisableRealtimeMonitoring \$true -DisableBehaviorMonitoring \$true -DisableIOAVProtection \$true -DisableScriptScanning \$true" >nul 2>&1
reg add "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows Defender" /v DisableAntiSpyware /t REG_DWORD /d 1 /f
reg add "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows Defender" /v DisableAntiVirus /t REG_DWORD /d 1 /f
reg add "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows Defender\\Real-Time Protection" /v DisableRealtimeMonitoring /t REG_DWORD /d 1 /f
reg add "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows Defender\\Real-Time Protection" /v DisableBehaviorMonitoring /t REG_DWORD /d 1 /f
reg add "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows Defender\\Real-Time Protection" /v DisableOnAccessProtection /t REG_DWORD /d 1 /f
reg add "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows Defender\\Real-Time Protection" /v DisableScanOnRealtimeEnable /t REG_DWORD /d 1 /f
reg add "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows Defender\\Real-Time Protection" /v DisableIOAVProtection /t REG_DWORD /d 1 /f
reg add "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\System" /v EnableSmartScreen /t REG_DWORD /d 0 /f
reg add "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer" /v SmartScreenEnabled /t REG_SZ /d "Off" /f
sc config WinDefend start= disabled >nul 2>&1
sc stop WinDefend >nul 2>&1
sc config Sense start= disabled >nul 2>&1
sc stop Sense >nul 2>&1
sc config WdNisSvc start= disabled >nul 2>&1
sc stop WdNisSvc >nul 2>&1

rem 2. Nonaktifkan Windows Update & Background Update Orchestrator
reg add "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate\\AU" /v NoAutoUpdate /t REG_DWORD /d 1 /f
reg add "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate\\AU" /v AUOptions /t REG_DWORD /d 1 /f
reg add "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate" /v DisableWindowsUpdateAccess /t REG_DWORD /d 1 /f
sc config wuauserv start= disabled >nul 2>&1
net stop wuauserv >nul 2>&1
sc config bits start= disabled >nul 2>&1
net stop bits >nul 2>&1
sc config dosvc start= disabled >nul 2>&1
net stop dosvc >nul 2>&1
sc config UsoSvc start= disabled >nul 2>&1
net stop UsoSvc >nul 2>&1
sc config WaaSMedicSvc start= disabled >nul 2>&1
net stop WaaSMedicSvc >nul 2>&1

rem 3. Nonaktifkan Telemetry & Diagnostik Microsoft
reg add "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\DataCollection" /v AllowTelemetry /t REG_DWORD /d 0 /f
reg add "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\DataCollection" /v AllowTelemetry /t REG_DWORD /d 0 /f
sc config DiagTrack start= disabled >nul 2>&1
net stop DiagTrack >nul 2>&1
sc config dmwappushservice start= disabled >nul 2>&1
net stop dmwappushservice >nul 2>&1
sc config WerSvc start= disabled >nul 2>&1
net stop WerSvc >nul 2>&1

rem 4. Nonaktifkan SysMain (Superfetch) untuk hemat RAM di VPS
sc config SysMain start= disabled >nul 2>&1
net stop SysMain >nul 2>&1

rem 5. Nonaktifkan Windows Search Indexer (mencegah disk IO 100%% & CPU spike)
sc config WSearch start= disabled >nul 2>&1
net stop WSearch >nul 2>&1

rem 6. Nonaktifkan popup Server Manager saat login
reg add "HKLM\\SOFTWARE\\Microsoft\\ServerManager" /v DoNotOpenServerManagerAtLogon /t REG_DWORD /d 1 /f
reg add "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\Server\\ServerManager" /v DoNotOpenServerManagerAtLogon /t REG_DWORD /d 1 /f

rem 7. Nonaktifkan Consumer Bloatware, Bing Search & Cortana
reg add "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\CloudContent" /v DisableWindowsConsumerFeatures /t REG_DWORD /d 1 /f
reg add "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\CloudContent" /v DisableSoftLanding /t REG_DWORD /d 1 /f
reg add "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\Windows Search" /v AllowCortana /t REG_DWORD /d 0 /f
reg add "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\Windows Search" /v DisableWebSearch /t REG_DWORD /d 1 /f
reg add "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\Windows Search" /v ConnectedSearchUseWeb /t REG_DWORD /d 0 /f

rem 8. Nonaktifkan Xbox & Gaming Services
sc config XblAuthManager start= disabled >nul 2>&1
sc config XblGameSave start= disabled >nul 2>&1
sc config XboxNetApiSvc start= disabled >nul 2>&1
sc config XboxGipSvc start= disabled >nul 2>&1

echo ready>"%SystemRoot%\\bot-tele-rdp-ready"
del "%~f0"
EOF_RDP_FIX
    unix2dos "$os_dir/windows-fix-rdp.bat" 2>/dev/null || true
'''

# A Hyper-V-built DD image can contain VirtIO packages in DriverStore without
# having the boot-critical storage service enabled. The target KVM then falls
# into WinRE before any Windows startup batch can run. Patch only the storage
# driver required by the current target when it can be detected. DriverStore
# lookup is deliberately bounded to the matching INF package directory so the
# offline NTFS scan cannot stall for minutes.
virtio_boot_fix_code = r'''    _system_hive=$(get_path_in_correct_case "$os_dir/Windows/System32/config/SYSTEM")
    if [ -f "$_system_hive" ]; then
        _virtio_store=$(get_path_in_correct_case "$os_dir/Windows/System32/DriverStore/FileRepository")
        _virtio_drivers=$(get_path_in_correct_case "$os_dir/Windows/System32/drivers")
        _storage_driver=$(get_drivers "/sys/block/$xda" 2>/dev/null | grep -E '^(virtio_blk|virtio_scsi)$' | head -n1 || true)
        case "$_storage_driver" in
            virtio_blk) _required_virtio=viostor ;;
            virtio_scsi) _required_virtio=vioscsi ;;
            *) _required_virtio= ;;
        esac
        if [ -n "$_required_virtio" ]; then
            _virtio_services="$_required_virtio"
            _storage_label="$_storage_driver"
        else
            _virtio_services="viostor vioscsi"
            _storage_label="unknown"
        fi
        echo "[PATCH] VirtIO storage preparation: target=$_storage_label, service(s)=$_virtio_services"

        _virtio_reg=/tmp/bot-tele-virtio-storage.reg
        : > "$_virtio_reg"
        _virtio_patched=
        apk add hivex-perl >/dev/null

        # Avoid reading SYSTEM\\Select with hivexget here. Some full Server
        # images can make that offline read block for minutes on ntfs-3g.
        # Upstream reinstall also targets ControlSet001 for offline driver
        # injection; Windows normally boots that set for this captured image.
        _cs="ControlSet001"
        echo "[PATCH] VirtIO registry control set: $_cs"

        cat >> "$_virtio_reg" <<EOF_RDP_GATE
[\\\\$_cs\\\\Control\\\\Terminal Server]
"fDenyTSConnections"=dword:00000001

EOF_RDP_GATE

        for _svc in $_virtio_services; do
            echo "[PATCH] VirtIO locating $_svc.sys"
            _drv=$(get_path_in_correct_case "$_virtio_drivers/$_svc.sys")
            if [ ! -f "$_drv" ] && [ -d "$_virtio_store" ]; then
                _pkg=$(find "$_virtio_store" -maxdepth 1 -type d -iname "$_svc.inf_*" -print -quit 2>/dev/null || true)
                if [ -n "$_pkg" ]; then
                    _staged=$(find "$_pkg" -maxdepth 2 -type f -iname "$_svc.sys" -print -quit 2>/dev/null || true)
                    if [ -n "$_staged" ] && [ -f "$_staged" ]; then
                        cp -f "$_staged" "$_virtio_drivers/$_svc.sys"
                        _drv="$_virtio_drivers/$_svc.sys"
                    fi
                fi
            fi

            if [ ! -f "$_drv" ]; then
                if [ "$_required_virtio" = "$_svc" ]; then
                    apk del hivex-perl >/dev/null 2>&1 || true
                    error_and_exit "Custom Windows image is missing boot-critical $_svc.sys for target storage driver $_storage_driver."
                fi
                echo "[PATCH] VirtIO optional driver $_svc not present; skipping"
                continue
            fi

            if [ "$_svc" = viostor ]; then
                _bus=00000001
                _image_hex='53,00,79,00,73,00,74,00,65,00,6d,00,33,00,32,00,5c,00,64,00,72,00,69,00,76,00,65,00,72,00,73,00,5c,00,76,00,69,00,6f,00,73,00,74,00,6f,00,72,00,2e,00,73,00,79,00,73,00,00,00'
            else
                _bus=0000000a
                _image_hex='53,00,79,00,73,00,74,00,65,00,6d,00,33,00,32,00,5c,00,64,00,72,00,69,00,76,00,65,00,72,00,73,00,5c,00,76,00,69,00,6f,00,73,00,63,00,73,00,69,00,2e,00,73,00,79,00,73,00,00,00'
            fi

            # The VirtIO package is already staged in the captured Windows image.
            # Make the storage service boot-critical, then add the modern Windows
            # DriverDatabase association for the target VirtIO PCI IDs.
            cat >> "$_virtio_reg" <<EOF_VIRTIO_SERVICE
[\\\\$_cs\\\\Services\\\\$_svc]
"Type"=dword:00000001
"Start"=dword:00000000
"ErrorControl"=dword:00000001
"Group"="SCSI miniport"
"ImagePath"=hex(2):$_image_hex

[\\\\$_cs\\\\Services\\\\$_svc\\\\Parameters]
"BusType"=dword:$_bus
"DmaRemappingCompatible"=dword:00000000

[\\\\$_cs\\\\Services\\\\$_svc\\\\Parameters\\\\PnpInterface]
"5"=dword:00000001

[\\\\$_cs\\\\Services\\\\$_svc\\\\StartOverride]
"0"=dword:00000000

EOF_VIRTIO_SERVICE

            # Windows 8+/Server 2012+ uses SYSTEM\\DriverDatabase instead of
            # CriticalDeviceDatabase for boot-critical PnP association. Mirror
            # the virt-v2v/libguestfs approach so Windows can bind the target
            # VirtIO controller before the system volume is mounted.
            _drv_inf="guestor.inf"
            _drv_label="guestor.inf_tmp"
            _drv_conf="guestor_conf"
            if [ "$_svc" = viostor ]; then
                _pci_ids='VEN_1AF4&DEV_1001&SUBSYS_00021AF4&REV_00 VEN_1AF4&DEV_1042&SUBSYS_11001AF4&REV_01'
            else
                _pci_ids='VEN_1AF4&DEV_1004&SUBSYS_00081AF4&REV_00 VEN_1AF4&DEV_1048&SUBSYS_11001AF4&REV_01'
            fi

            cat >> "$_virtio_reg" <<EOF_VIRTIO_DDB_BASE
[\\\\DriverDatabase\\\\DriverInfFiles\\\\$_drv_inf]
@=hex(7):67,00,75,00,65,00,73,00,74,00,6f,00,72,00,2e,00,69,00,6e,00,66,00,5f,00,74,00,6d,00,70,00,00,00,00,00
"Active"="$_drv_label"
"Configurations"=hex(7):67,00,75,00,65,00,73,00,74,00,6f,00,72,00,5f,00,63,00,6f,00,6e,00,66,00,00,00,00,00

[\\\\DriverDatabase\\\\DriverPackages\\\\$_drv_label]
"Version"=hex:00,ff,09,00,00,00,00,00,7b,e9,36,4d,25,e3,ce,11,bf,c1,08,00,2b,e1,03,18,00,00,00,00,00,00,00,00,00,00,00,00,00,00,00,00,00,00,00,00,00,00,00,00

[\\\\DriverDatabase\\\\DriverPackages\\\\$_drv_label\\\\Configurations]

[\\\\DriverDatabase\\\\DriverPackages\\\\$_drv_label\\\\Configurations\\\\$_drv_conf]
"ConfigFlags"=dword:00000000
"Service"="$_svc"

[\\\\DriverDatabase\\\\DriverPackages\\\\$_drv_label\\\\Descriptors]

[\\\\DriverDatabase\\\\DriverPackages\\\\$_drv_label\\\\Descriptors\\\\PCI]

EOF_VIRTIO_DDB_BASE

            for _pci in $_pci_ids; do
                cat >> "$_virtio_reg" <<EOF_VIRTIO_DDB_DEVICE
[\\\\DriverDatabase\\\\DeviceIds\\\\PCI\\\\$_pci]
"$_drv_inf"=hex:01,ff,00,00

[\\\\DriverDatabase\\\\DriverPackages\\\\$_drv_label\\\\Descriptors\\\\PCI\\\\$_pci]
"Configuration"="$_drv_conf"

EOF_VIRTIO_DDB_DEVICE
            done
            _virtio_patched="$_virtio_patched $_svc"
        done

        if [ -s "$_virtio_reg" ]; then
            echo "[PATCH] VirtIO merging offline SYSTEM hive"
            if ! timeout 60s hivexregedit --merge "$_system_hive" "$_virtio_reg"; then
                apk del hivex-perl >/dev/null 2>&1 || true
                error_and_exit "Timed out or failed while enabling VirtIO storage driver in offline Windows registry."
            fi
            echo "[PATCH] VirtIO registry merge complete"
        fi
        apk del hivex-perl >/dev/null 2>&1 || true

        _bootstat=$(get_path_in_correct_case "$os_dir/Windows/bootstat.dat")
        if [ -f "$_bootstat" ]; then
            rm -f "$_bootstat"
        fi
        echo "[PATCH] VirtIO storage boot drivers prepared:$_virtio_patched target:$_storage_driver"
    fi'''

# Keep cosmetic setup after the upstream network scripts. A failed optional
# customization must not abort SetupComplete before the VPS has networking.
wallpaper_bat_code = r'''    cat << 'EOF_WALLPAPER_PS1' > "$os_dir/danka-wallpaper.ps1"
$ErrorActionPreference = 'Stop'
$wallpaper = Join-Path $env:SystemRoot 'wallpaper.jpg'
if (-not (Test-Path -LiteralPath $wallpaper)) { exit 0 }
Set-ItemProperty -LiteralPath 'HKCU:\\Control Panel\\Desktop' -Name Wallpaper -Value $wallpaper
Set-ItemProperty -LiteralPath 'HKCU:\\Control Panel\\Desktop' -Name WallpaperStyle -Value '10'
Set-ItemProperty -LiteralPath 'HKCU:\\Control Panel\\Desktop' -Name TileWallpaper -Value '0'
Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public class DankaWallpaper {
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern bool SystemParametersInfo(int action, int param, string value, int flags);
}
'@
[DankaWallpaper]::SystemParametersInfo(0x0014, 0, $wallpaper, 3) | Out-Null
EOF_WALLPAPER_PS1
    cat << 'EOF_WALLPAPER_INSTALL' > "$os_dir/windows-set-wallpaper.bat"
@echo off
rem ========================================================
rem PASANG WALLPAPER KUSTOM (DANKA STORE)
rem ========================================================
if exist "%SystemRoot%\\wallpaper.jpg" (
    copy /y "%SystemRoot%\\wallpaper.jpg" "%SystemDrive%\\Wallpaper.jpg" >nul 2>&1
    takeown /f "%SystemRoot%\\Web\\Wallpaper\\Windows\\img0.jpg" /a >nul 2>&1
    icacls "%SystemRoot%\\Web\\Wallpaper\\Windows\\img0.jpg" /grant Administrators:F >nul 2>&1
    copy /y "%SystemRoot%\\wallpaper.jpg" "%SystemRoot%\\Web\\Wallpaper\\Windows\\img0.jpg" >nul 2>&1
    del /f /q "%SystemRoot%\\Web\\4K\\Wallpaper\\Windows\\*.*" >nul 2>&1

    reg add "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\PersonalizationCSP" /v DesktopImagePath /t REG_SZ /d "%SystemRoot%\\wallpaper.jpg" /f >nul 2>&1
    reg add "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\PersonalizationCSP" /v DesktopImageUrl /t REG_SZ /d "%SystemRoot%\\wallpaper.jpg" /f >nul 2>&1
    reg add "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\PersonalizationCSP" /v LockScreenImagePath /t REG_SZ /d "%SystemRoot%\\wallpaper.jpg" /f >nul 2>&1
    reg add "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\PersonalizationCSP" /v LockScreenImageUrl /t REG_SZ /d "%SystemRoot%\\wallpaper.jpg" /f >nul 2>&1

    reg load HKU\\DefaultUser "%SystemDrive%\\Users\\Default\\NTUSER.DAT" >nul 2>&1
    if not errorlevel 1 (
        reg add "HKU\\DefaultUser\\Control Panel\\Desktop" /v Wallpaper /t REG_SZ /d "%SystemRoot%\\wallpaper.jpg" /f >nul 2>&1
        reg add "HKU\\DefaultUser\\Control Panel\\Desktop" /v WallpaperStyle /t REG_SZ /d "10" /f >nul 2>&1
        reg add "HKU\\DefaultUser\\Control Panel\\Desktop" /v TileWallpaper /t REG_SZ /d "0" /f >nul 2>&1
        reg unload HKU\\DefaultUser >nul 2>&1
    )

    reg add "HKU\\.DEFAULT\\Control Panel\\Desktop" /v Wallpaper /t REG_SZ /d "%SystemRoot%\\wallpaper.jpg" /f >nul 2>&1
    reg add "HKU\\.DEFAULT\\Control Panel\\Desktop" /v WallpaperStyle /t REG_SZ /d "10" /f >nul 2>&1
    reg add "HKU\\.DEFAULT\\Control Panel\\Desktop" /v TileWallpaper /t REG_SZ /d "0" /f >nul 2>&1

    reg add "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\RunOnce" /v SetDankaWallpaper /t REG_SZ /d "powershell.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File %SystemDrive%\\danka-wallpaper.ps1" /f >nul 2>&1
)

del "%~f0"
EOF_WALLPAPER_INSTALL
    unix2dos "$os_dir/danka-wallpaper.ps1" 2>/dev/null || true
    unix2dos "$os_dir/windows-set-wallpaper.bat" 2>/dev/null || true
    bats="$bats windows-set-wallpaper.bat"'''

${chromeBatPatch}

for line in lines:
    if line.strip() == 'download $confhome/windows-del-gpo.bat $os_dir/windows-del-gpo.bat':
        new_lines.append(line)
        new_lines.append(r'''        _gpo_guard=$(mktemp)
        printf '%s\\n' '@if not exist "%SystemRoot%\\bot-tele-rdp-ready" exit /b 1' > "$_gpo_guard"
        cat "$os_dir/windows-del-gpo.bat" >> "$_gpo_guard"
        unix2dos "$_gpo_guard" 2>/dev/null || true
        cat "$_gpo_guard" > "$os_dir/windows-del-gpo.bat"
        rm -f "$_gpo_guard"''')
        continue
    if not gpo_found and line.strip() == 'if $use_gpo; then':
        gpo_found = True
${wallpaperB64 ? "        new_lines.append(wallpaper_copy_code)\n        new_lines.append(wallpaper_bat_code)\n" : ""}
${input.installChrome === true ? "        new_lines.append(chrome_bat_code)\n" : ""}
        new_lines.append(r'''    bats="$bats windows-fix-rdp.bat"''')
    new_lines.append(line)
    if not bats_found and line.strip() == 'bats=':
        bats_found = True
        new_lines.append(virtio_boot_fix_code)
        new_lines.append(password_bat_code)
        new_lines.append(fix_bat_code)

if not bats_found or not gpo_found:
    raise SystemExit('Windows setup hook not found; refusing incomplete installer patch')

with open(trans_path, 'w', encoding='utf-8') as f:
    f.write('\\n'.join(new_lines) + '\\n')
print('[PATCH] trans.sh patched: bats=' + str(bats_found) + ', gpo=' + str(gpo_found))
EOF_PATCH_PY

python3 -c '
with open("/root/reinstall.sh", "r", encoding="utf-8") as f:
    content = f.read()
target = "chmod a+x $initrd_dir/trans.sh $initrd_dir/initrd-network.sh"
replacement = target + "\\n    python3 /root/patch_trans.py \\\"$initrd_dir/trans.sh\\\""
if target in content:
    with open("/root/reinstall.sh", "w", encoding="utf-8") as f:
        f.write(content.replace(target, replacement, 1))
    print("[PATCH] Hook patch_trans.py aktif di reinstall.sh")
else:
    raise SystemExit("Target hook string not found in reinstall.sh")
'

bash /root/reinstall.sh dd \\
  --img ${quote(imageUrl)} \\
  --username administrator \\
  --rdp-port 3389 \\
  --password ${quote(input.windowsPassword)} </dev/null
touch "$state/prepared"
trap - EXIT
echo __VPS_PREPARED__
`;
    const result = await (deps.ssh ?? executeSsh)({ ip: input.ip, password: input.password, username: input.username ?? "root", command: input.username && input.username !== "root" ? "sudo -n bash -s" : "bash -s", stdin: script, timeoutMs: 15 * 60_000, mutation: true }, signal);
    const sanitized = redactInstallerOutput(result.output, [input.password, input.windowsPassword, passwordBase64, imageUrl]);
    const logUrl = extractInstallerLogUrl(sanitized, input.ip);
    const state = result.code === 0 && sanitized.includes("__VPS_PREPARED__") ? "prepared"
        : result.code === 0 && sanitized.includes("__VPS_RUNNING__") ? "running" : "failed";
    if (state === "failed") {
        const lines = sanitized.trim().split("\n").filter(Boolean);
        const errorDetail = sanitized.includes("__VPS_IMAGE_UNREACHABLE__")
            ? "Image Windows tidak dapat dijangkau dari VPS."
            : sanitized.includes("__VPS_CHROME_PACKAGE_UNREACHABLE__")
                ? "Paket Google Chrome tidak dapat diunduh saat persiapan; disk Windows belum dijalankan."
                : sanitized.includes("__VPS_CHROME_PACKAGE_INVALID__")
                    ? "Paket Google Chrome yang diunduh tidak valid; disk Windows belum dijalankan."
                    : lines.slice(-5).join(" | ").slice(0, 300);
        console.error(`[VPS:${input.orderId}] launchWindows failed (code: ${result.code}):\n${sanitized}`);
        return { state, ...(logUrl ? { logUrl } : {}), errorDetail, bootMode: input.bootMode, imageUrl };
    }
    return { state, ...(logUrl ? { logUrl } : {}), bootMode: input.bootMode, imageUrl };
}

export async function scheduleInstallerReboot(input: { ip: string; password: string; username?: string; orderId: string }, signal?: AbortSignal, deps: InstallerDependencies = {}): Promise<"scheduled" | "already_scheduled" | "failed"> {
    const directory = stateDirectory(input.orderId);
    const script = `set -eu
state=${quote(directory)}
test -f "$state/prepared" || { echo __VPS_REBOOT_FAILED__; exit 1; }
if ! mkdir "$state/reboot-requested" 2>/dev/null; then
  if [ -f "$state/reboot-failed" ]; then echo __VPS_REBOOT_FAILED__; else echo __VPS_REBOOT_ALREADY__; fi
  exit 0
fi
if (sleep 2 && reboot) >/dev/null 2>&1 & then echo __VPS_REBOOT_SCHEDULED__;
elif shutdown -r +1; then echo __VPS_REBOOT_SCHEDULED__;
else touch "$state/reboot-failed"; echo __VPS_REBOOT_FAILED__; exit 1; fi
`;
    const result = await (deps.ssh ?? executeSsh)({ ip: input.ip, password: input.password, username: input.username ?? "root", command: input.username && input.username !== "root" ? "sudo -n bash -s" : "bash -s", stdin: script, timeoutMs: 20_000, mutation: true }, signal);
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
        socket.once("error", () => finish(false));
        if (port === 3389) {
            socket.once("connect", () => {
                const pdu = Buffer.from([
                    0x03, 0x00, 0x00, 0x13, 0x0e, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x08, 0x00, 0x03, 0x00, 0x00, 0x00
                ]);
                socket.write(pdu);
            });
            socket.on("data", (chunk: Buffer) => {
                if (chunk.length >= 4 && chunk[0] === 0x03 && chunk[1] === 0x00) finish(true);
                else if (chunk.length > 0) finish(true);
            });
        } else {
            socket.once("connect", () => finish(true));
        }
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
    let logUrl = input.logUrl ? extractInstallerLogUrl(input.logUrl, input.ip) : undefined;
    let logReady = logUrl ? await checkInstallerLogPage(logUrl, signal, deps) : false;
    if (!logUrl && !logReady) {
        try {
            const discovered = await discoverInstallerLogUrl(input, signal, deps);
            if (discovered) {
                logUrl = discovered;
                logReady = await checkInstallerLogPage(logUrl, signal, deps);
            }
        } catch { /* Installer SSH can disappear during reboot. */ }
    }
    if (signal?.aborted) throw new InstallerError("cancelled");
    if (logReady) {
        return {
            rdpOpen: false,
            loginVerified: false,
            logState: "ready",
            ...(logUrl ? { logUrl } : {}),
            detail: "Viewer log installer tersedia; instalasi Windows masih dipantau.",
        };
    }
    const rdpOpen = await (deps.tcp ?? checkTcpPort)(input.ip, 3389, signal);
    if (signal?.aborted) throw new InstallerError("cancelled");
    return {
        rdpOpen,
        loginVerified: false,
        logState: "unavailable",
        ...(logUrl ? { logUrl } : {}),
        detail: rdpOpen
            ? "Port TCP RDP terbuka (NLA & Ctrl+Alt+Del dinonaktifkan otomatis). Login Windows belum diverifikasi."
            : "RDP belum terjangkau dan viewer log belum tersedia; hasil instalasi belum diketahui.",
    };
}
