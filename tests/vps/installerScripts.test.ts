import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { PNG } from "pngjs";
import { InstallerError, launchWindows, selectWindowsImage } from "../../src/vps/installer.js";
import { resolveWindowsDdImage } from "../../src/vps/windowsImages.js";

function interpreter(candidates: string[], args: string[], expected: RegExp): string | undefined {
    return candidates.find(command => {
        const result = spawnSync(command, args, { encoding: "utf8", timeout: 5_000, windowsHide: true });
        return result.status === 0 && expected.test(`${result.stdout}${result.stderr}`);
    });
}
const python = interpreter(["python", "python3"], ["--version"], /Python 3\./);
const bash = interpreter(process.platform === "win32"
    ? [path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe"), "bash"]
    : ["bash"], ["--version"], /GNU bash/);
const powershell = process.platform === "win32" ? interpreter([
    path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
], ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Write-Output PS_PARSER_READY"], /PS_PARSER_READY/) : undefined;
const scriptSkip = !python ? "Python 3 is required to execute the generated installer patch" : !bash ? "Bash is required to emit the Windows setup files" : false;

// These are the upstream setup hooks and batch registration sequence. Nothing
// from the real installer (downloads, disks, network or registry) is executed.
const transFixture = `#!/bin/bash
set -eu
os_dir="$PWD/os"
win_dir=Windows
use_gpo=false
unix2dos() { :; }
get_path_in_correct_case() { printf '%s\\n' "$1"; }
bats=
cat << 'EOF_NETWORK' > "$os_dir/windows-set-netconf-eth0.bat"
@echo off
rem upstream network configuration
EOF_NETWORK
bats="$bats windows-set-netconf-eth0.bat"
if $use_gpo; then
    bats="$bats windows-del-gpo.bat"
fi
printf '%s\\n' "$bats"
printf '%s\\n' "$win_dir" > "$PWD/win-dir.txt"
`;

function temporaryDirectory(t: TestContext): string {
    const directory = mkdtempSync(path.join(tmpdir(), "vps-installer-test-"));
    t.after(() => {
        assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
        assert.ok(path.basename(directory).startsWith("vps-installer-test-"));
        rmSync(directory, { recursive: true, force: true });
    });
    mkdirSync(path.join(directory, "os", "Windows"), { recursive: true });
    return directory;
}

async function installerPatch(directory: string, installChrome: boolean, wallpaper: boolean): Promise<string> {
    const wallpaperPath = path.join(directory, "source.png");
    if (wallpaper) {
        const png = new PNG({ width: 1, height: 1 });
        png.data.set([30, 60, 90, 255]);
        writeFileSync(wallpaperPath, PNG.sync.write(png));
    }
    let script = "";
    const result = await launchWindows({
        ip: "192.0.2.10", password: "SyntheticSource123!", windowsPassword: "SyntheticWindows123!",
        os: "windows2019", orderId: "script-regression-test", bootMode: "efi",
        imageUrl: resolveWindowsDdImage("windows2019", "efi", {}), installChrome, wallpaperPath,
    }, undefined, { ssh: async input => { script = input.stdin ?? ""; return { code: 0, output: "__VPS_PREPARED__" }; } });
    assert.equal(result.state, "prepared");
    const patch = script.match(/cat << 'EOF_PATCH_PY' > \/root\/patch_trans\.py\r?\n([\s\S]*?)\r?\nEOF_PATCH_PY/)?.[1];
    assert.ok(patch, "launchWindows must emit an executable Python patch");
    const encodedImage = script.match(/cat << 'EOF_WALLPAPER_B64'[^\n]*\n([^\n]+)\nEOF_WALLPAPER_B64/);
    assert.equal(Boolean(encodedImage), wallpaper);
    if (encodedImage) writeFileSync(path.join(directory, "source-wallpaper.jpg"), Buffer.from(encodedImage[1]!, "base64"));
    if (installChrome) writeFileSync(path.join(directory, "source-chrome.msi"), "synthetic-msi");
    // Remap host-side preload sources only. The generated trans.sh still uses
    // the production /configs/bot-tele path after switch_root.
    return patch
        .replaceAll("'/root/wallpaper.jpg'", JSON.stringify(path.join(directory, "source-wallpaper.jpg")))
        .replaceAll("'/root/google-chrome-enterprise.msi'", JSON.stringify(path.join(directory, "source-chrome.msi")));
}

function patchFixture(directory: string, patch: string, fixture = transFixture) {
    writeFileSync(path.join(directory, "patch_trans.py"), patch);
    writeFileSync(path.join(directory, "trans.sh"), fixture);
    return spawnSync(python!, ["patch_trans.py", "trans.sh"], { cwd: directory, encoding: "utf8", timeout: 10_000, windowsHide: true });
}

async function emitWindowsFiles(t: TestContext, installChrome: boolean, wallpaper: boolean): Promise<{ directory: string; batches: string[] }> {
    const directory = temporaryDirectory(t);
    const patched = patchFixture(directory, await installerPatch(directory, installChrome, wallpaper));
    assert.equal(patched.status, 0, `${patched.stdout}\n${patched.stderr}`);
    const emitted = spawnSync(bash!, ["--noprofile", "--norc", "trans.sh"], {
        cwd: directory, encoding: "utf8", timeout: 10_000, windowsHide: true,
        env: { ...process.env, BOT_TELE_CONFIG_ROOT: path.join(directory, "configs", "bot-tele") },
    });
    assert.equal(emitted.status, 0, `${emitted.stdout}\n${emitted.stderr}`);
    return { directory, batches: emitted.stdout.trim().split(/\s+/) };
}

for (const installChrome of [false, true]) {
    test(`generated setup puts critical RDP bootstrap before cosmetic tasks${installChrome ? " with Chrome" : ""}`, { skip: scriptSkip }, async t => {
        const { directory, batches } = await emitWindowsFiles(t, installChrome, true);
        assert.deepEqual(batches, ["windows-fix-rdp.bat", "windows-set-wallpaper.bat"]);
        const batch = readFileSync(path.join(directory, "os", "windows-fix-rdp.bat"), "utf8");
        assert.match(batch, /fDenyTSConnections/);
        assert.match(batch, /if not exist "%SystemRoot%\\bot-tele-password-ready"/);
        assert.match(batch, /bot-tele-rdp-ready/);
        assert.match(batch, /bot-tele-chrome-required/);
        assert.match(batch, /BOT_TELE_WAIT_SETUP/);
        assert.match(batch, /windows-set-netconf-\*\.bat/);
        assert.match(batch, /Get-NetAdapter/);
        assert.match(batch, /netsh interface ipv4 set address/);
        assert.match(batch, /bot-tele fast netconf/);
        assert.doesNotMatch(batch, /call "%%~fF"/);
        assert.doesNotMatch(batch, /Get-WmiObject|Get-CimInstance|wmic/i);
        assert.match(batch, /windows-set-admin-password\.bat/);
        if (installChrome) assert.match(batch, /windows-install-chrome\.bat/);
        else assert.doesNotMatch(batch, /windows-install-chrome\.bat/);
        assert.match(batch, /BOT_TELE_ATTEMPT% GEQ 2/);
        assert.match(batch, /timeout \/t 5/);
        assert.doesNotMatch(batch, /SetDankaWallpaper|Add-Type/);
        const passwordBatch = readFileSync(path.join(directory, "os", "windows-set-admin-password.bat"), "utf8");
        assert.match(passwordBatch, /echo ready>"%SystemRoot%\\bot-tele-password-ready"/);
        assert.doesNotMatch(passwordBatch, /fDenyTSConnections/);
        const passwordScript = readFileSync(path.join(directory, "os", "windows-set-admin-password.ps1"), "utf8");
        assert.match(passwordScript, /for \(\$attempt = 1; \$attempt -le 10; \$attempt\+\+\)/);
        assert.match(passwordScript, /Get-LocalUser/);
        assert.equal(readFileSync(path.join(directory, "win-dir.txt"), "utf8").trim(), "Windows", "wallpaper copy must preserve the upstream relative Windows directory");
        assert.ok(existsSync(path.join(directory, "os", "Windows", "wallpaper.jpg")));
        assert.equal(existsSync(path.join(directory, "os", "windows-install-chrome.bat")), installChrome);
    });

    test(`missing wallpaper preserves network setup and Chrome=${installChrome}`, { skip: scriptSkip }, async t => {
        const { directory, batches } = await emitWindowsFiles(t, installChrome, false);
        assert.deepEqual(batches, ["windows-fix-rdp.bat"]);
        assert.equal(existsSync(path.join(directory, "os", "windows-set-wallpaper.bat")), false);
        assert.equal(existsSync(path.join(directory, "os", "danka-wallpaper.ps1")), false);
    });
}

for (const anchor of ["bats=\n", "if $use_gpo; then\n"]) {
    test(`installer refuses an upstream script missing ${anchor.trim()}`, { skip: !python && "Python 3 is required to execute the generated installer patch" }, async t => {
        const directory = temporaryDirectory(t);
        const original = transFixture.replace(anchor, "");
        const result = patchFixture(directory, await installerPatch(directory, true, true), original);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /hook not found/i);
        assert.equal(readFileSync(path.join(directory, "trans.sh"), "utf8"), original, "failed patch must leave the upstream script intact");
    });
}

test("fast image selector uses the reachable candidate index without exposing URL output", async () => {
    const candidates = [
        "https://fast.example.test/windows2022.zst",
        "https://fallback.example.test/windows2022.xz",
    ];
    let probe = "";
    const selected = await selectWindowsImage({
        ip: "192.0.2.10", password: "SyntheticSource123!", username: "root", candidates,
    }, undefined, { ssh: async input => {
        probe = input.stdin ?? "";
        return { code: 0, output: "__VPS_IMAGE_OK__:2\n" };
    } });
    assert.equal(selected, candidates[1]);
    assert.match(probe, /fast\.example\.test\/windows2022\.zst/);
    assert.match(probe, /fallback\.example\.test\/windows2022\.xz/);
    assert.match(probe, /--range 0-0/);
    assert.match(probe, /--max-time 12/);
});

test("fast image selector fails before disk preparation when every candidate is unreachable", async () => {
    await assert.rejects(() => selectWindowsImage({
        ip: "192.0.2.10", password: "SyntheticSource123!", candidates: ["https://dead.example.test/windows.xz"],
    }, undefined, { ssh: async () => ({ code: 1, output: "" }) }), InstallerError);
});

test("installer preparation caps cloud-init wait and gates readiness on Chrome completion", async t => {
    const directory = temporaryDirectory(t);
    let script = "";
    await launchWindows({
        ip: "192.0.2.10", password: "SyntheticSource123!", windowsPassword: "SyntheticWindows123!",
        os: "windows2019", orderId: "fast-installer-test", bootMode: "efi",
        imageUrl: resolveWindowsDdImage("windows2019", "efi", {}), installChrome: true,
    }, undefined, { ssh: async input => { script = input.stdin ?? ""; return { code: 0, output: "__VPS_PREPARED__" }; } });
    assert.match(script, /timeout 20s cloud-init status --wait/);
    const patch = script.match(/cat << 'EOF_PATCH_PY' > \/root\/patch_trans\.py\r?\n([\s\S]*?)\r?\nEOF_PATCH_PY/)?.[1];
    assert.ok(patch);
    const remappedPatch = patch.replaceAll("'/root/google-chrome-enterprise.msi'", JSON.stringify(path.join(directory, "source-chrome.msi")));
    writeFileSync(path.join(directory, "source-chrome.msi"), "synthetic-msi");
    const patched = patchFixture(directory, remappedPatch);
    assert.equal(patched.status, 0, `${patched.stdout}\n${patched.stderr}`);
    const emitted = spawnSync(bash!, ["--noprofile", "--norc", "trans.sh"], {
        cwd: directory, encoding: "utf8", timeout: 10_000, windowsHide: true,
        env: { ...process.env, BOT_TELE_CONFIG_ROOT: path.join(directory, "configs", "bot-tele") },
    });
    assert.equal(emitted.status, 0, `${emitted.stdout}\n${emitted.stderr}`);
    const chromeBatch = readFileSync(path.join(directory, "os", "windows-install-chrome.bat"), "utf8");
    assert.doesNotMatch(chromeBatch, /start "" \/min powershell\.exe/i);
    assert.match(chromeBatch, /windows-install-chrome\.ps1/);
    assert.match(chromeBatch, /bot-tele-chrome-ready/);
    assert.ok(existsSync(path.join(directory, "os", "Windows", "Temp", "google-chrome-enterprise.msi")));
    const chromePs = readFileSync(path.join(directory, "os", "windows-install-chrome.ps1"), "utf8");
    assert.match(chromePs, /Preloaded Chrome MSI/);
    assert.match(chromePs, /msiexec\.exe/);
    assert.match(chromePs, /WaitForExit\(90000\)/);
    assert.match(chromePs, /Chrome MSI timed out after 90 seconds/);
    assert.match(chromePs, /bot-tele-chrome-ready/);
    assert.doesNotMatch(chromePs, /DownloadFile|dl\.google\.com/);
    assert.match(script, /googlechromestandaloneenterprise64\.msi/);
    assert.match(script, /__VPS_CHROME_PACKAGE_UNREACHABLE__/);
    assert.match(script, /configs.*bot-tele/);
    assert.doesNotMatch(readFileSync(path.join(directory, "trans.sh"), "utf8"), /BASH_SOURCE/);
    assert.match(script, /Group Policy\\\\Scripts\\\\Startup\\\\0\\\\0/);
    assert.match(script, /Group Policy\\\\State\\\\Machine\\\\Scripts\\\\Startup\\\\0\\\\0/);
    assert.match(script, /Policies\\\\Microsoft\\\\Windows\\\\System\\\\Scripts\\\\Startup\\\\0\\\\0/);
    assert.match(script, /GpNetworkStartTimeoutPolicyValue/);
    assert.match(script, /Registering LocalGPO startup bootstrap/);
});

test("DD patch primes staged VirtIO storage drivers for first KVM boot", { skip: scriptSkip }, async t => {
    const { directory } = await emitWindowsFiles(t, false, false);
    const patchedScript = readFileSync(path.join(directory, "trans.sh"), "utf8");
    assert.match(patchedScript, /bot-tele-virtio-storage\.reg/);
    assert.match(patchedScript, /virtio_blk\) _required_virtio=viostor/);
    assert.match(patchedScript, /virtio_scsi\) _required_virtio=vioscsi/);
    assert.match(patchedScript, /\\\\\$_cs\\\\Services\\\\\$_svc/);
    assert.doesNotMatch(patchedScript, /\[\\\$_cs\\Services\\\$_svc\]/);
    assert.match(patchedScript, /"Start"=dword:00000000/);
    assert.match(patchedScript, /fDenyTSConnections/);
    assert.match(patchedScript, /dword:00000001/);
    assert.match(patchedScript, /StartOverride/);
    assert.doesNotMatch(patchedScript, /\\\\CriticalDeviceDatabase\\\\/);
    assert.match(patchedScript, /DriverDatabase/);
    assert.match(patchedScript, /DriverInfFiles/);
    assert.match(patchedScript, /DeviceIds/);
    assert.match(patchedScript, /DriverPackages/);
    assert.match(patchedScript, /VEN_1AF4&DEV_1001&SUBSYS_00021AF4&REV_00/);
    assert.match(patchedScript, /VEN_1AF4&DEV_1042&SUBSYS_11001AF4&REV_01/);
    assert.match(patchedScript, /VEN_1AF4&DEV_1004&SUBSYS_00081AF4&REV_00/);
    assert.match(patchedScript, /VEN_1AF4&DEV_1048&SUBSYS_11001AF4&REV_01/);
    assert.match(patchedScript, /"Configuration"="\$_drv_conf"/);
    assert.match(patchedScript, /\\\\DriverDatabase\\\\DriverPackages\\\\\$_drv_label\\\\Descriptors\\\\PCI/);
    assert.match(patchedScript, /\\\\DriverDatabase\\\\DriverPackages\\\\\$_drv_label\\\\Configurations/);
    assert.match(patchedScript, /\\\\DriverDatabase\\\\DeviceIds\\\\PCI\\\\\$_pci/);
    assert.doesNotMatch(patchedScript, /\[\\DriverDatabase\\DriverPackages\\\$_drv_label/);
    assert.match(patchedScript, /bootstat\.dat/);
    assert.match(patchedScript, /missing boot-critical \$_svc\.sys/);
    assert.match(patchedScript, /-maxdepth 1 -type d -iname "\$_svc\.inf_\*"/);
    assert.doesNotMatch(patchedScript, /hivexget .*Select.*Current/);
    assert.match(patchedScript, /_cs="ControlSet001"/);
    assert.match(patchedScript, /timeout 60s hivexregedit --merge/);
    assert.match(patchedScript, /VirtIO registry merge complete/);
    assert.match(patchedScript, /bot-tele-rdp-ready/);
    assert.match(patchedScript, /Windows startup order:/);
    assert.match(patchedScript, /bats="windows-fix-rdp\.bat\$_bot_tele_after"/);
});

test("wallpaper and Chrome asset lookup is POSIX-safe across initrd switch_root", { skip: !python && "Python 3 is required" }, async t => {
    const directory = temporaryDirectory(t);
    const patched = patchFixture(directory, await installerPatch(directory, false, true));
    assert.equal(patched.status, 0, `${patched.stdout}\n${patched.stderr}`);
    const patchedScript = readFileSync(path.join(directory, "trans.sh"), "utf8");
    assert.doesNotMatch(patchedScript, /BASH_SOURCE/, "Alpine ash must never receive Bash-only BASH_SOURCE expansion");
    assert.match(patchedScript, /BOT_TELE_CONFIG_ROOT:-\/configs\/bot-tele/);
    assert.match(patchedScript, /_wp_src="\$_bot_assets\/wallpaper\.jpg"/);
    assert.ok(existsSync(path.join(directory, "configs", "bot-tele", "wallpaper.jpg")));
});


function sanitizeBatch(batch: string): string {
    return batch.split(/\r?\n/).map(line => {
        if (/^\s*(?:@echo off|\)|)\s*$/i.test(line) || /^\s*rem\b/i.test(line)) return line;
        if (/^\s*if exist "%SystemRoot%\\wallpaper\.jpg" \(\s*$/i.test(line) || /^\s*if not errorlevel 1 \(\s*$/i.test(line)) return line;
        assert.match(line, /^\s*(?:copy|takeown|icacls|del|reg)\s/i, "refuse to execute an unexpected batch command");
        const noRedirection = line.replace(/>nul\s+2>&1/gi, "");
        assert.doesNotMatch(noRedirection, /[&|<>^]/, "sanitized commands must not chain or redirect commands");
        assert.doesNotMatch(noRedirection.replace(/%SystemRoot%|%SystemDrive%|%~f0/gi, ""), /%/, "only controlled fixture environment expansions may execute");
        return noRedirection.replace(/^(\s*)/, "$1echo ");
    }).join("\r\n");
}

test("Windows CMD reaches the end of the wallpaper batch with and without its image", {
    skip: scriptSkip || (process.platform !== "win32" && "Native CMD regression requires Windows"),
}, async t => {
    const { directory } = await emitWindowsFiles(t, true, true);
    const batch = readFileSync(path.join(directory, "os", "windows-set-wallpaper.bat"), "utf8");
    const runOnce = batch.split(/\r?\n/).find(line => line.includes("/v SetDankaWallpaper"));
    assert.ok(runOnce);
    const command = runOnce.match(/\/d "([^"]+)" \/f/)?.[1];
    assert.ok(command);
    assert.ok(command.length <= 260, "RunOnce must stay within its documented command length limit");
    assert.match(command, /-File %SystemDrive%\\danka-wallpaper\.ps1$/);
    assert.doesNotMatch(command, /Add-Type|-Command/);
    const safeBatch = sanitizeBatch(batch) + "\r\necho __WALLPAPER_BATCH_FINISHED__\r\n";
    writeFileSync(path.join(directory, "wallpaper-parse.bat"), safeBatch);
    const cmd = process.env.ComSpec ?? path.join(process.env.SystemRoot!, "System32", "cmd.exe");
    for (const present of [false, true]) {
        const systemRoot = path.join(directory, present ? "with-wallpaper" : "without-wallpaper");
        mkdirSync(systemRoot);
        if (present) writeFileSync(path.join(systemRoot, "wallpaper.jpg"), "fixture");
        const result = spawnSync(cmd, ["/d", "/c", "wallpaper-parse.bat"], {
            cwd: directory, encoding: "utf8", timeout: 10_000, windowsHide: true,
            env: { ...process.env, SystemRoot: systemRoot, SystemDrive: directory },
        });
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
        assert.match(result.stdout, /__WALLPAPER_BATCH_FINISHED__/);
        assert.equal(result.stderr, "");
        assert.equal(result.stdout.includes("/v SetDankaWallpaper"), present);
    }
});

test("generated wallpaper PowerShell parses without executing registry or desktop changes", {
    skip: scriptSkip || (!powershell && "Windows PowerShell is required for the native parser check"),
}, async t => {
    const { directory } = await emitWindowsFiles(t, false, true);
    const parser = `$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PWD 'os/danka-wallpaper.ps1'), [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { $parseErrors | ForEach-Object { Write-Error $_.Message }; exit 1 }
Write-Output '__POWERSHELL_PARSE_OK__'
`;
    writeFileSync(path.join(directory, "parse-only.ps1"), parser);
    const result = spawnSync(powershell!, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "parse-only.ps1"], {
        cwd: directory, encoding: "utf8", timeout: 10_000, windowsHide: true,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /__POWERSHELL_PARSE_OK__/);
});

test("generated administrator password hook is encoded and parses without execution", {
    skip: scriptSkip || (!powershell && "Windows PowerShell is required for the native parser check"),
}, async t => {
    const { directory } = await emitWindowsFiles(t, false, false);
    const passwordScript = readFileSync(path.join(directory, "os", "windows-set-admin-password.ps1"), "utf8");
    assert.doesNotMatch(passwordScript, /SyntheticWindows123!/);
    assert.match(passwordScript, /FromBase64String/);
    assert.match(passwordScript, /SID -like '\*-500'/);
    const parser = `$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PWD 'os/windows-set-admin-password.ps1'), [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { $parseErrors | ForEach-Object { Write-Error $_.Message }; exit 1 }
Write-Output '__PASSWORD_POWERSHELL_PARSE_OK__'
`;
    writeFileSync(path.join(directory, "parse-password-only.ps1"), parser);
    const result = spawnSync(powershell!, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "parse-password-only.ps1"], {
        cwd: directory, encoding: "utf8", timeout: 10_000, windowsHide: true,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /__PASSWORD_POWERSHELL_PARSE_OK__/);
});
