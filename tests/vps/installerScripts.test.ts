import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { PNG } from "pngjs";
import { launchWindows } from "../../src/vps/installer.js";

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
        os: "windows2019", orderId: "script-regression-test", installChrome, wallpaperPath,
    }, undefined, { ssh: async input => { script = input.stdin ?? ""; return { code: 0, output: "__VPS_PREPARED__" }; } });
    assert.equal(result.state, "prepared");
    const patch = script.match(/cat << 'EOF_PATCH_PY' > \/root\/patch_trans\.py\r?\n([\s\S]*?)\r?\nEOF_PATCH_PY/)?.[1];
    assert.ok(patch, "launchWindows must emit an executable Python patch");
    const encodedImage = script.match(/cat << 'EOF_WALLPAPER_B64'[^\n]*\n([^\n]+)\nEOF_WALLPAPER_B64/);
    assert.equal(Boolean(encodedImage), wallpaper);
    if (encodedImage) writeFileSync(path.join(directory, "source-wallpaper.jpg"), Buffer.from(encodedImage[1]!, "base64"));
    // Remap only absolute fixture file locations; preserve all generated code
    // and quoting through Python -> Bash -> Windows batch/PowerShell.
    return patch.replaceAll("'/root/wallpaper.jpg'", JSON.stringify(path.join(directory, "source-wallpaper.jpg")))
        .replaceAll(/(?<=\s)\/wallpaper\.jpg(?=\s)/g, '"$PWD/source-wallpaper.jpg"');
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
    const emitted = spawnSync(bash!, ["--noprofile", "--norc", "trans.sh"], { cwd: directory, encoding: "utf8", timeout: 10_000, windowsHide: true });
    assert.equal(emitted.status, 0, `${emitted.stdout}\n${emitted.stderr}`);
    return { directory, batches: emitted.stdout.trim().split(/\s+/) };
}

for (const installChrome of [false, true]) {
    test(`generated setup runs network before wallpaper${installChrome ? " and Chrome" : ""}`, { skip: scriptSkip }, async t => {
        const { directory, batches } = await emitWindowsFiles(t, installChrome, true);
        assert.deepEqual(batches, ["windows-fix-rdp.bat", "windows-set-netconf-eth0.bat", "windows-set-wallpaper.bat",
            ...(installChrome ? ["windows-install-chrome.bat"] : [])]);
        const batch = readFileSync(path.join(directory, "os", "windows-fix-rdp.bat"), "utf8");
        assert.match(batch, /fDenyTSConnections/);
        assert.doesNotMatch(batch, /SetDankaWallpaper|Add-Type/);
        assert.equal(readFileSync(path.join(directory, "win-dir.txt"), "utf8").trim(), "Windows", "wallpaper copy must preserve the upstream relative Windows directory");
        assert.ok(existsSync(path.join(directory, "os", "Windows", "wallpaper.jpg")));
        assert.equal(existsSync(path.join(directory, "os", "windows-install-chrome.bat")), installChrome);
    });

    test(`missing wallpaper preserves network setup and Chrome=${installChrome}`, { skip: scriptSkip }, async t => {
        const { directory, batches } = await emitWindowsFiles(t, installChrome, false);
        assert.deepEqual(batches, ["windows-fix-rdp.bat", "windows-set-netconf-eth0.bat", ...(installChrome ? ["windows-install-chrome.bat"] : [])]);
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
