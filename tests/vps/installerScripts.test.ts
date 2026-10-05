import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { inspectSsh, inspectInstallStorage, MIN_INSTALL_DISK_BYTES, InstallerError, launchWindows, selectWindowsImage } from "../../src/vps/installer.js";
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
// hivexregedit prints its help successfully with exit code 1.
const hivexProbe = spawnSync("hivexregedit", ["--help"], { encoding: "utf8", timeout: 5_000, windowsHide: true });
const hivexregedit = /Usage:[\s\S]*hivexregedit --merge/.test(`${hivexProbe.stdout}${hivexProbe.stderr}`) ? "hivexregedit" : undefined;

test("storage probe measures the root backing disk for partitions, NVMe and single-disk LVM without mutations", { skip: !bash && "Bash is required" }, async () => {
    for (const [source, disk, bytes] of [
        ["/dev/vda1", "/dev/vda", MIN_INSTALL_DISK_BYTES],
        ["/dev/nvme0n1p2[/root]", "/dev/nvme0n1", 49_999_999_999],
        ["/dev/mapper/vg-root", "/dev/sda", 80_000_000_000],
    ] as const) {
        const storage = await inspectInstallStorage({ ip: "192.0.2.10", password: "offline", username: "ubuntu" }, undefined, {
            ssh: async input => {
                assert.equal(input.command, "sudo -n bash -s");
                assert.notEqual(input.mutation, true);
                const script = `findmnt() { printf '%s\\n' '${source}'; }
lsblk() {
  if [ "$1" = '-srnpo' ]; then
    [ "$3" = '${source.split("[")[0]}' ] || return 1
    printf '%s\\n' '${source.split("[")[0]} part' '${disk} disk'
  elif [ "$1" = '-bdrn' ]; then
    [ "$4" = '${disk}' ] || return 1
    printf '%s\\n' '${bytes}'
  else return 1; fi
}
${input.stdin}`;
                const run = spawnSync(bash!, ["-c", script], { encoding: "utf8", timeout: 5_000 });
                assert.ifError(run.error); assert.equal(run.stderr, "");
                return { code: run.status, output: run.stdout };
            },
        });
        assert.deepEqual(storage, { targetDisk: disk, bytes });
    }
});

test("storage probe refuses ambiguous multi-disk roots and invalid or failed SSH output", { skip: !bash && "Bash is required" }, async () => {
    await assert.rejects(inspectInstallStorage({ ip: "192.0.2.10", password: "offline" }, undefined, {
        ssh: async input => {
            const run = spawnSync(bash!, ["-c", `findmnt() { echo /dev/md0; }
lsblk() { printf '%s\\n' '/dev/sda disk' '/dev/sdb disk'; }
${input.stdin}`], { encoding: "utf8", timeout: 5_000 });
            return { code: run.status, output: run.stdout };
        },
    }), (error: unknown) => error instanceof InstallerError && error.reason === "storage_detection");
    for (const result of [
        { code: 1, output: "__VPS_INSTALL_DISK__:/dev/vda:50000000000\n" },
        { code: 0, output: "__VPS_INSTALL_DISK__:/dev/vda:0\n" },
        { code: 0, output: "__VPS_INSTALL_DISK__:/dev/vda:9007199254740992\n" },
        { code: 0, output: "__VPS_INSTALL_DISK__:/dev/vda:50000000000\n__VPS_INSTALL_DISK__:/dev/vdb:80000000000\n" },
        { code: 0, output: "unexpected SSH output containing a secret" },
    ]) {
        await assert.rejects(inspectInstallStorage({ ip: "192.0.2.10", password: "offline" }, undefined, { ssh: async () => result }),
            (error: unknown) => error instanceof InstallerError && error.reason === "storage_detection" && !error.message.includes("secret"));
    }
});

test("Windows reinstall targets the disk verified by the storage probe", async () => {
    let script = "";
    await launchWindows({ ip: "192.0.2.10", password: "offline", windowsPassword: "MockPassword123!xyz",
        os: "windows2022", orderId: "storage-probe-test", bootMode: "efi", imageUrl: "https://images.example.test/windows-efi.xz", targetDisk: "/dev/nvme0n1" },
    undefined, { ssh: async input => { script = input.stdin!; return { code: 0, output: "__VPS_PREPARED__" }; } });
    assert.match(script, /--target-disk '\/dev\/nvme0n1'/);
    if (bash) {
        const run = spawnSync(bash, ["-n"], { input: script, encoding: "utf8", timeout: 5_000 });
        assert.equal(run.status, 0, run.stderr);
    }
});

test("SSH readiness shell observes cloud-init and waits until boot scripts have finished", { skip: !bash && "Bash is required to execute the SSH readiness command" }, async () => {
    for (const [status, ready] of [
        ["status: running", false], ["status: not run", false], ["status: error", false],
        ["status: disabled", false], ["status: done", true], ["status: degraded done", true],
    ] as const) {
        const result = await inspectSsh({ ip: "203.0.113.10", password: "MockPassword123!xyz", waitForCloudInit: true }, undefined, {
            ssh: async input => {
                assert.equal(input.timeoutMs, 20_000); assert.notEqual(input.mutation, true);
                const script = `id() { printf '0\\n'; }\ncloud-init() { printf '%s\\n' '${status}'; }\n${input.command}`;
                const run = spawnSync(bash!, ["-c", script], { encoding: "utf8", timeout: 5_000, windowsHide: true });
                assert.ifError(run.error); assert.equal(run.stderr, "");
                return { code: run.status, output: run.stdout };
            },
        });
        assert.equal(result.ready, ready, status);
        if (!result.ready) assert.equal(result.reason, "cloud_init");
    }
});

test("direct SSH readiness checks sudo without waiting on an existing VPS's cloud-init", { skip: !bash && "Bash is required to execute the SSH readiness command" }, async () => {
    const result = await inspectSsh({ ip: "203.0.113.10", password: "MockPassword123!xyz", username: "ubuntu" }, undefined, {
        ssh: async input => {
            const script = `sudo() { test "$1" = -n && test "$2" = true; }\ncloud-init() { echo unexpected >&2; return 1; }\n${input.command}`;
            const run = spawnSync(bash!, ["-c", script], { encoding: "utf8", timeout: 5_000, windowsHide: true });
            assert.ifError(run.error); assert.equal(run.stderr, "");
            return { code: run.status, output: run.stdout };
        },
    });
    assert.equal(result.ready, true);
});

// These are the upstream setup hooks and batch registration sequence. Nothing
// from the real installer (downloads, disks, network or registry) is executed.
const transFixture = `#!/bin/bash
set -eu
os_dir="$PWD/os"
confhome="$PWD/conf"
win_dir=Windows
use_gpo=false
distro=fixture
unix2dos() { :; }
sync() { :; }
reboot() { :; }
error_and_exit() { printf '%s\\n' "$*" >&2; exit 1; }
get_path_in_correct_case() { printf '%s\\n' "$1"; }
download() { printf '@echo off\\n' > "$2"; }
bats=
cat << 'EOF_NETWORK' > "$os_dir/windows-set-netconf-eth0.bat"
@echo off
rem upstream network configuration
EOF_NETWORK
bats="$bats windows-set-netconf-eth0.bat"
if $use_gpo; then
    bats="$bats windows-del-gpo.bat"
    download $confhome/windows-del-gpo.bat $os_dir/windows-del-gpo.bat
fi
printf '%s\\n' "$bats"
printf '%s\\n' "$win_dir" > "$PWD/win-dir.txt"
# swapoff -a
# umount ?
sync
reboot
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
        assert.deepEqual(batches, ["windows-fix-rdp.bat", "windows-set-wallpaper.bat", "windows-del-gpo.bat"]);
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
        if (installChrome) {
            assert.match(batch, /windows-install-chrome\.bat/);
            assert.match(batch, /^if exist "%SystemRoot%\\bot-tele-chrome-required" if not exist "%SystemRoot%\\bot-tele-chrome-ready" \(\r?\n    if exist "%SystemDrive%\\windows-install-chrome\.bat" call "%SystemDrive%\\windows-install-chrome\.bat"\r?\n\)\r?\nif exist "%SystemRoot%\\bot-tele-password-ready"/m,
                "Chrome and password prerequisite blocks must be separate physical CMD lines");
            assert.doesNotMatch(batch, /\\n\s*if exist/, "literal newline escapes must never reach CMD");
        }
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
        assert.deepEqual(batches, ["windows-fix-rdp.bat", "windows-del-gpo.bat"]);
        assert.equal(existsSync(path.join(directory, "os", "windows-set-wallpaper.bat")), false);
        assert.equal(existsSync(path.join(directory, "os", "danka-wallpaper.ps1")), false);
    });
}

test("generalized/OOBE images register LocalGPO and keep a SetupComplete fallback", { skip: scriptSkip }, async t => {
    const { directory, batches } = await emitWindowsFiles(t, false, false);
    assert.deepEqual(batches, ["windows-fix-rdp.bat", "windows-del-gpo.bat"]);
    const setupComplete = path.join(directory, "os", "Windows", "Setup", "Scripts", "SetupComplete.cmd");
    assert.ok(existsSync(setupComplete), "OOBE images must keep SetupComplete as a fallback");
    const setup = readFileSync(setupComplete, "utf8");
    assert.match(setup, /windows-fix-rdp\.bat/);
    assert.match(setup, /windows-del-gpo\.bat/);
    assert.ok(setup.indexOf("windows-fix-rdp.bat") < setup.indexOf("windows-del-gpo.bat"), "RDP bootstrap must run before GPO cleanup");
    const cleanup = readFileSync(path.join(directory, "os", "windows-del-gpo.bat"), "utf8");
    assert.match(cleanup, /^@if not exist "%SystemRoot%\\bot-tele-rdp-ready" exit \/b 1/m);
    const patchedScript = readFileSync(path.join(directory, "trans.sh"), "utf8");
    assert.match(patchedScript, /_bot_tele_setupcomplete_fallback=true/);
    assert.match(patchedScript, /OOBE\/generalized Windows: enabling LocalGPO bootstrap with SetupComplete fallback/);
});

test("complete Windows images keep the ordinary LocalGPO path without adding SetupComplete", { skip: scriptSkip }, async t => {
    const directory = temporaryDirectory(t);
    const fixture = transFixture.replace("use_gpo=false", "use_gpo=true");
    const patched = patchFixture(directory, await installerPatch(directory, false, false), fixture);
    assert.equal(patched.status, 0, `${patched.stdout}\n${patched.stderr}`);
    const emitted = spawnSync(bash!, ["--noprofile", "--norc", "trans.sh"], {
        cwd: directory, encoding: "utf8", timeout: 10_000, windowsHide: true,
        env: { ...process.env, BOT_TELE_CONFIG_ROOT: path.join(directory, "configs", "bot-tele") },
    });
    assert.equal(emitted.status, 0, `${emitted.stdout}\n${emitted.stderr}`);
    assert.equal(existsSync(path.join(directory, "os", "Windows", "Setup", "Scripts", "SetupComplete.cmd")), false);
});

test("Windows CMD adapter lookup selects the MAC match and active hardware fallback", {
    skip: scriptSkip || (process.platform !== "win32" && "Native CMD adapter regression requires Windows"),
}, async t => {
    const { directory } = await emitWindowsFiles(t, true, false);
    const batch = readFileSync(path.join(directory, "os", "windows-fix-rdp.bat"), "utf8");
    const commands = batch.split(/\r?\n/).filter(line => /^\s*for \/f %%I in \('powershell\.exe /.test(line));
    assert.equal(commands.length, 2);
    // Keep the generated CMD -> PowerShell boundary intact. Only the adapter
    // provider is replaced, so no real network interface is read or changed.
    const adapterStub = "function Get-NetAdapter { [CmdletBinding()] param([string[]]$Name,[switch]$IncludeHidden) " +
        "@([pscustomobject]@{MacAddress='AA-BB-CC-DD-EE-FF';HardwareInterface=$true;Status='Up';ifIndex=17}," +
        "[pscustomobject]@{MacAddress='00-11-22-33-44-01';HardwareInterface=$true;Status='Disabled';ifIndex=1}," +
        "[pscustomobject]@{MacAddress='00-11-22-33-44-02';HardwareInterface=$false;Status='Up';ifIndex=2}," +
        "[pscustomobject]@{MacAddress='00-11-22-33-44-05';HardwareInterface=$true;Status='Up';ifIndex=5}) }; ";
    const cmd = process.env.ComSpec ?? path.join(process.env.SystemRoot!, "System32", "cmd.exe");
    for (const [index, expected] of [17, 5].entries()) {
        const command = commands[index]!.replace('-Command "', `-Command "${adapterStub}`);
        assert.notEqual(command, commands[index]);
        const probe = ["@echo off", "setlocal EnableExtensions", 'set "mac_addr=aa:bb:cc:dd:ee:ff"',
            'set "BOT_TELE_IFINDEX="', command, "echo __IFINDEX=%BOT_TELE_IFINDEX%__", ""].join("\r\n");
        writeFileSync(path.join(directory, "adapter-probe.bat"), probe);
        const result = spawnSync(cmd, ["/d", "/c", "adapter-probe.bat"], {
            cwd: directory, encoding: "utf8", timeout: 10_000, windowsHide: true,
        });
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
        assert.equal(result.stderr, "");
        assert.equal(result.stdout.trim(), `__IFINDEX=${expected}__`);
    }
});

test("Windows CMD logs missing network prerequisites for each incomplete configuration", {
    skip: scriptSkip || (process.platform !== "win32" && "Native CMD netconf regression requires Windows"),
}, async t => {
    const { directory } = await emitWindowsFiles(t, false, false);
    const batch = readFileSync(path.join(directory, "os", "windows-fix-rdp.bat"), "utf8");
    const start = batch.indexOf('set "BOT_TELE_NETCONF_READY="');
    const end = batch.indexOf("set /a BOT_TELE_ATTEMPT=0", start);
    assert.ok(start >= 0 && end > start);
    const networkBlock = batch.slice(start, end);
    assert.equal((networkBlock.match(/\bnetsh interface ipv4\b/g) ?? []).length, 3);
    // Echo the generated netsh commands into the fixture log instead of
    // executing them. The real conditional logic and log redirection remain.
    const harmlessBlock = networkBlock.replace(/\bnetsh interface ipv4\b/g, "echo __NETSH__ interface ipv4");
    const config: Record<string, string> = { BOT_TELE_IFINDEX: "17", ipv4_addr: "192.0.2.10/24", ipv4_gateway: "192.0.2.1" };
    const cmd = process.env.ComSpec ?? path.join(process.env.SystemRoot!, "System32", "cmd.exe");
    for (const missing of [...Object.keys(config), null]) {
        const log = `netconf-${missing ?? "complete"}.log`;
        const probe = ["@echo off", "setlocal EnableExtensions", `set "BOT_TELE_LOG=${log}"`,
            ...Object.entries(config).map(([key, value]) => `set "${key}=${key === missing ? "" : value}"`),
            'set "ipv4_dns1="', 'set "ipv4_dns2="', harmlessBlock, ""].join("\r\n");
        writeFileSync(path.join(directory, "netconf-probe.bat"), probe);
        const result = spawnSync(cmd, ["/d", "/c", "netconf-probe.bat"], {
            cwd: directory, encoding: "utf8", timeout: 10_000, windowsHide: true,
        });
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
        assert.equal(result.stderr, "");
        const output = readFileSync(path.join(directory, log), "utf8");
        if (missing) {
            assert.match(output, /could not resolve target adapter\/config; continuing setup/);
            assert.doesNotMatch(output, /__NETSH__/);
        } else {
            assert.match(output, /fast netconf ifIndex=17 ip=192\.0\.2\.10\/24/);
            assert.match(output, /__NETSH__ interface ipv4 set address name=17 static 192\.0\.2\.10\/24/);
            assert.doesNotMatch(output, /could not resolve/);
        }
    }
});

for (const anchor of ["bats=\n", "if $use_gpo; then\n", "# swapoff -a\n# umount ?\nsync\nreboot\n"]) {
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
    assert.match(script, /Group Policy[\\\\/]+Scripts[\\\\/]+Startup[\\\\/]+0[\\\\/]+0/);
    assert.match(script, /Group Policy[\\\\/]+State[\\\\/]+Machine[\\\\/]+Scripts[\\\\/]+Startup[\\\\/]+0[\\\\/]+0/);
    assert.match(script, /Policies[\\\\/]+Microsoft[\\\\/]+Windows[\\\\/]+System[\\\\/]+Scripts[\\\\/]+Startup[\\\\/]+0[\\\\/]+0/);
    assert.match(script, /GpNetworkStartTimeoutPolicyValue/);
    assert.match(script, /Registering LocalGPO startup bootstrap/);
});

test("Chrome checksum survives initrd packing and copying into Windows", { skip: scriptSkip }, async t => {
    const { directory } = await emitWindowsFiles(t, true, false);
    const expected = createHash("sha256").update(readFileSync(path.join(directory, "source-chrome.msi"))).digest("hex");
    for (const root of [path.join(directory, "configs", "bot-tele"), path.join(directory, "os", "Windows", "Temp")]) {
        assert.equal(readFileSync(path.join(root, "google-chrome-enterprise.sha256"), "utf8"), `${expected}\n`);
        assert.equal(createHash("sha256").update(readFileSync(path.join(root, "google-chrome-enterprise.msi"))).digest("hex"), expected);
    }
});

for (const damage of ["package", "manifest"] as const) {
    test(`Chrome ${damage} corruption in initrd stops before copying to Windows`, { skip: scriptSkip }, async t => {
        const directory = temporaryDirectory(t);
        const patched = patchFixture(directory, await installerPatch(directory, true, false));
        assert.equal(patched.status, 0, `${patched.stdout}\n${patched.stderr}`);
        writeFileSync(path.join(directory, "configs", "bot-tele", damage === "package"
            ? "google-chrome-enterprise.msi" : "google-chrome-enterprise.sha256"), damage === "package" ? "damaged-msi!!" : "invalid-hash");
        const emitted = spawnSync(bash!, ["--noprofile", "--norc", "trans.sh"], {
            cwd: directory, encoding: "utf8", timeout: 10_000, windowsHide: true,
            env: { ...process.env, BOT_TELE_CONFIG_ROOT: path.join(directory, "configs", "bot-tele") },
        });
        assert.notEqual(emitted.status, 0);
        assert.match(emitted.stderr, damage === "package" ? /initrd checksum verification/ : /checksum manifest is invalid/);
        assert.equal(existsSync(path.join(directory, "os", "Windows", "Temp", "google-chrome-enterprise.msi")), false);
    });
}

test("Windows rejects a same-size Chrome MSI with valid header and a zeroed tail before installation", {
    skip: scriptSkip || (!powershell && "Native Windows PowerShell is required"),
}, async t => {
    const { directory } = await emitWindowsFiles(t, true, false);
    const chromePs = readFileSync(path.join(directory, "os", "windows-install-chrome.ps1"), "utf8");
    assert.ok(chromePs.indexOf("Get-FileHash") < chromePs.indexOf("Start-Service msiserver"));
    assert.match(chromePs, /\/L\*V!/);
    const msiPath = path.join(directory, "os", "Windows", "Temp", "google-chrome-enterprise.msi");
    const manifestPath = path.join(directory, "os", "Windows", "Temp", "google-chrome-enterprise.sha256");
    const original = Buffer.alloc(10485760 + 204800, 0x5a);
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(original);
    writeFileSync(msiPath, original);
    writeFileSync(manifestPath, createHash("sha256").update(original).digest("hex") + "\n");
    const integrityScript = path.join(directory, "chrome-integrity.ps1");
    writeFileSync(integrityScript, chromePs.slice(0, chromePs.indexOf("Start-Service msiserver")) + "Write-Output CHROME_INTEGRITY_VALIDATED\n");
    const run = () => spawnSync(powershell!, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", integrityScript], {
        cwd: directory, encoding: "utf8", timeout: 15_000, windowsHide: true,
        env: { ...process.env, WINDIR: path.join(directory, "os", "Windows") },
    });
    const intact = run();
    assert.equal(intact.status, 0, `${intact.stdout}\n${intact.stderr}`);
    assert.match(intact.stdout, /CHROME_INTEGRITY_VALIDATED/);
    const damaged = Buffer.from(original);
    damaged.fill(0, damaged.length - 204800);
    assert.equal(damaged.length, original.length);
    assert.deepEqual(damaged.subarray(0, 8), original.subarray(0, 8));
    writeFileSync(msiPath, damaged);
    // Guard all real installer entry points; a bad package must fail before
    // reaching either stub, and cannot create a successful readiness marker.
    writeFileSync(integrityScript, "function Start-Service { throw 'UNEXPECTED_SERVICE_START' }\nfunction Start-Process { throw 'UNEXPECTED_MSI_START' }\n" + chromePs);
    const rejected = run();
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /Preloaded Chrome MSI checksum mismatch/);
    assert.doesNotMatch(rejected.stderr, /UNEXPECTED_SERVICE_START|UNEXPECTED_MSI_START/);
    assert.equal(existsSync(path.join(directory, "os", "Windows", "bot-tele-chrome-ready")), false);
});

type FinalizeScenario = "success" | "unmount-failure" | "reopen-failure" | "persisted-corruption" | "linux";
async function runDiskFinalization(t: TestContext, installChrome: boolean, scenario: FinalizeScenario) {
    const directory = temporaryDirectory(t);
    // These stubs record ordering and model post-unmount disk corruption; no
    // mount, unmount, reboot, or device operation is performed by this test.
    const stubs = `test_scenario='${scenario}'
test_unmounts=0
sync() { printf '%s\\n' sync >> "$PWD/finalize-trace"; }
reboot() { printf '%s\\n' reboot >> "$PWD/finalize-trace"; }
findmnt() { printf '%s\\n' findmnt >> "$PWD/finalize-trace"; printf '%s\\n' '/dev/vps-fixture[/captured-root]'; }
sha256sum() { printf '%s\\n' sha256sum >> "$PWD/finalize-trace"; command sha256sum "$@"; }
umount() {
    printf '%s\\n' umount >> "$PWD/finalize-trace"
    test_unmounts=$((test_unmounts + 1))
    if [ "$test_scenario" = unmount-failure ]; then return 1; fi
}
mount() {
    printf '%s\\n' "mount $*" >> "$PWD/finalize-trace"
    if [ "$test_scenario" = reopen-failure ]; then return 1; fi
    if [ "$test_scenario" = persisted-corruption ]; then
        printf '%s' damaged > "$os_dir/Windows/Temp/google-chrome-enterprise.msi"
    fi
}
`;
    const fixture = transFixture.replace("distro=fixture", `distro=${scenario === "linux" ? "linux" : "dd"}`)
        .replace("bats=\n", stubs + "bats=\n");
    const patched = patchFixture(directory, await installerPatch(directory, installChrome, false), fixture);
    assert.equal(patched.status, 0, `${patched.stdout}\n${patched.stderr}`);
    const result = spawnSync(bash!, ["--noprofile", "--norc", "trans.sh"], {
        cwd: directory, encoding: "utf8", timeout: 10_000, windowsHide: true,
        env: { ...process.env, BOT_TELE_CONFIG_ROOT: path.join(directory, "configs", "bot-tele") },
    });
    const trace = readFileSync(path.join(directory, "finalize-trace"), "utf8").trim().split(/\r?\n/);
    return { result, trace };
}

for (const installChrome of [false, true]) {
    test(`Windows DD closes the filesystem and verifies persisted assets before reboot, Chrome=${installChrome}`, { skip: scriptSkip }, async t => {
        const { result, trace } = await runDiskFinalization(t, installChrome, "success");
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
        const finalTrace = trace.slice(trace.indexOf("findmnt"));
        assert.deepEqual(finalTrace.map(entry => entry.startsWith("mount ") ? "mount" : entry),
            ["findmnt", "sync", "umount", "mount", ...(installChrome ? ["sha256sum"] : []), "umount", "sync", "reboot"]);
        assert.match(finalTrace[3]!, /^mount -o ro \/dev\/vps-fixture /);
    });
}

for (const scenario of ["unmount-failure", "reopen-failure", "persisted-corruption"] as const) {
    test(`Windows DD ${scenario} preserves recovery access and refuses reboot`, { skip: scriptSkip }, async t => {
        const { result, trace } = await runDiskFinalization(t, true, scenario);
        assert.notEqual(result.status, 0);
        assert.equal(trace.includes("reboot"), false);
        assert.match(result.stderr, scenario === "unmount-failure" ? /Cannot cleanly unmount/
            : scenario === "reopen-failure" ? /Cannot reopen/ : /Persisted Chrome package failed checksum/);
    });
}

test("Windows finalization leaves the upstream Linux reboot path unchanged", { skip: scriptSkip }, async t => {
    const { result, trace } = await runDiskFinalization(t, false, "linux");
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.deepEqual(trace, ["sync", "reboot"]);
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

test("LocalGPO startup registration merges into an empty SOFTWARE hive and preserves existing keys on retry", {
    skip: !python ? "Python 3 is required" : !hivexregedit ? "hivexregedit is required for the offline registry regression" : false,
}, async t => {
    const directory = temporaryDirectory(t);
    const patched = patchFixture(directory, await installerPatch(directory, false, false));
    assert.equal(patched.status, 0, `${patched.stdout}\n${patched.stderr}`);
    const registry = readFileSync(path.join(directory, "trans.sh"), "utf8")
        .match(/cat > "\$_gpo_reg" <<'EOF_BOT_GPO_REG'\r?\n([\s\S]*?)\r?\nEOF_BOT_GPO_REG/)?.[1];
    assert.ok(registry, "the patched upstream GPO hook must emit its registry payload");
    const hive = path.join(directory, "SOFTWARE");
    writeFileSync(hive, Buffer.from(readFileSync(new URL("./fixtures/minimal-software-hive.base64", import.meta.url), "utf8"), "base64"));
    const importRegistry = (name: string, content: string): void => {
        const file = path.join(directory, name);
        writeFileSync(file, content);
        const result = spawnSync(hivexregedit!, ["--merge", hive, file], {
            encoding: "utf8", timeout: 10_000, windowsHide: true,
        });
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    };
    const exportRegistry = (): string => {
        const result = spawnSync(hivexregedit!, ["--export", hive, "\\", "--unsafe-printable-strings"], {
            encoding: "utf8", timeout: 10_000, windowsHide: true,
        });
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
        return result.stdout;
    };

    // No Microsoft, Policies, or startup parents exist in this hive.
    importRegistry("startup.reg", registry);
    const registered = exportRegistry();
    for (const startup of [
        "\\Microsoft\\Windows\\CurrentVersion\\Group Policy\\Scripts\\Startup\\0\\0",
        "\\Microsoft\\Windows\\CurrentVersion\\Group Policy\\State\\Machine\\Scripts\\Startup\\0\\0",
        "\\Policies\\Microsoft\\Windows\\System\\Scripts\\Startup\\0\\0",
    ]) {
        assert.ok(registered.includes(`[${startup}]`), `missing startup entry ${startup}`);
    }
    assert.equal((registered.match(/^"Script"=str\(1\):"C:\\windows-fix-rdp\.bat"$/gm) ?? []).length, 3);
    assert.equal((registered.match(/^"FileSysPath"=str\(1\):"C:\\Windows\\System32\\GroupPolicy\\Machine"$/gm) ?? []).length, 3);
    assert.equal((registered.match(/"GpNetworkStartTimeoutPolicyValue"=dword:00000001/g) ?? []).length, 2);
    importRegistry("existing.reg", String.raw`[\Microsoft\Windows\CurrentVersion\Group Policy\Scripts\Startup]
"ExistingSetting"="keep-parent-value"

[\Microsoft\Windows\CurrentVersion\Group Policy\Scripts\Startup\7]
"Script"="keep-other-script"

[\Unrelated]
"Setting"=dword:12345678
`);
    const beforeRetry = exportRegistry();
    importRegistry("startup.reg", registry);
    assert.equal(exportRegistry(), beforeRetry, "retry must preserve parent values and unrelated startup entries");

    // Reproduce the old halted installer: missing ancestors and unescaped paths.
    const oldRegistry = registry.split(/\n\s*\n/)
        .filter(section => section.trim().split(/\r?\n/).length > 1)
        .join("\n\n").replaceAll("\\\\", "\\");
    const stopped = path.join(directory, "stopped-trans.sh");
    writeFileSync(stopped, readFileSync(path.join(directory, "trans.sh"), "utf8").replace(registry, oldRegistry));
    const recovered = spawnSync(python!, [
        fileURLToPath(new URL("../../scripts/repair-windows-gpo.py", import.meta.url)), stopped,
    ], { encoding: "utf8", timeout: 10_000, windowsHide: true });
    assert.equal(recovered.status, 0, `${recovered.stdout}\n${recovered.stderr}`);
    const recoveredRegistry = readFileSync(stopped, "utf8")
        .match(/cat > "\$_gpo_reg" <<'EOF_BOT_GPO_REG'\r?\n([\s\S]*?)\r?\nEOF_BOT_GPO_REG/)?.[1];
    assert.ok(recoveredRegistry);
    writeFileSync(hive, Buffer.from(readFileSync(new URL("./fixtures/minimal-software-hive.base64", import.meta.url), "utf8"), "base64"));
    importRegistry("recovered.reg", recoveredRegistry);
    assert.equal(exportRegistry(), registered, "recovery must produce the same registry values as a newly generated installer");
});

test("stopped installer recovery changes only the GPO payload and keeps its original backup on retry", {
    skip: !python && "Python 3 is required",
}, t => {
    const directory = temporaryDirectory(t);
    const script = path.join(directory, "trans.sh");
    const original = String.raw`#!/bin/sh
echo keep-before
cat > "$_gpo_reg" <<'EOF_BOT_GPO_REG'
[\Microsoft\Windows\CurrentVersion\Group Policy\Scripts\Startup\0]
"FileSysPath"="C:\Windows\System32\GroupPolicy\Machine"

[\Microsoft\Windows\CurrentVersion\Group Policy\Scripts\Startup\0\0]
"Script"="C:\windows-fix-rdp.bat"
EOF_BOT_GPO_REG
echo keep-after
`;
    writeFileSync(script, original, { mode: 0o700 });
    const runRepair = () => spawnSync(python!, [
        fileURLToPath(new URL("../../scripts/repair-windows-gpo.py", import.meta.url)), script,
    ], { encoding: "utf8", timeout: 10_000, windowsHide: true });
    const first = runRepair();
    assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
    const repaired = readFileSync(script, "utf8");
    assert.ok(repaired.startsWith("#!/bin/sh\necho keep-before\n"));
    assert.ok(repaired.endsWith("EOF_BOT_GPO_REG\necho keep-after\n"));
    assert.ok(repaired.includes(String.raw`[\Microsoft]`));
    assert.ok(repaired.includes(String.raw`[\Microsoft\Windows\CurrentVersion\Group Policy\Scripts\Startup]`));
    assert.ok(repaired.includes(String.raw`"Script"="C:\\windows-fix-rdp.bat"`));
    assert.ok(repaired.includes(String.raw`"FileSysPath"="C:\\Windows\\System32\\GroupPolicy\\Machine"`));
    assert.equal(readFileSync(script + ".bot-tele-gpo.bak", "utf8"), original);
    const second = runRepair();
    assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
    assert.equal(readFileSync(script, "utf8"), repaired);
    assert.equal(readFileSync(script + ".bot-tele-gpo.bak", "utf8"), original);

    writeFileSync(script, "echo unmatched-installer\n");
    assert.notEqual(runRepair().status, 0);
    assert.equal(readFileSync(script, "utf8"), "echo unmatched-installer\n");
});

// This is the literal output emitted by the Chrome interpolation before
// 52c7e30: doubled path separators and backslash-n text on one CMD line.
const legacyChromePrerequisite = String.raw`if exist "%SystemRoot%\\bot-tele-chrome-required" if not exist "%SystemRoot%\\bot-tele-chrome-ready" (\n    if exist "%SystemDrive%\\windows-install-chrome.bat" call "%SystemDrive%\\windows-install-chrome.bat"\n)\n`;

function runBootstrapRepair(root: string) {
    return spawnSync(python!, [
        fileURLToPath(new URL("../../scripts/repair-windows-bootstrap.py", import.meta.url)), root,
    ], { encoding: "utf8", timeout: 10_000, windowsHide: true });
}

for (const newline of ["\n", "\r\n"]) {
    test(`mounted Windows recovery repairs only the old Chrome block with ${newline.length === 1 ? "LF" : "CRLF"} endings`, { skip: scriptSkip }, async t => {
        const { directory } = await emitWindowsFiles(t, true, false);
        const root = path.join(directory, "os");
        const config = path.join(root, "Windows", "System32", "config");
        mkdirSync(config, { recursive: true });
        writeFileSync(path.join(config, "SYSTEM"), "untouched-hive");
        const script = path.join(root, "windows-fix-rdp.bat");
        const fixed = (readFileSync(script, "utf8") + String.raw`rem preserve unrelated C:\newfolder` + "\n").replace(/\r?\n/g, newline);
        const chrome = fixed.match(/^if exist "%SystemRoot%\\bot-tele-chrome-required"[^\r\n]*\r?\n    if exist [^\r\n]*\r?\n\)\r?\n/m)?.[0];
        assert.ok(chrome);
        const broken = fixed.replace(chrome, legacyChromePrerequisite);
        assert.notEqual(broken, fixed);
        writeFileSync(script, broken);
        const password = readFileSync(path.join(root, "windows-set-admin-password.ps1"));
        const network = readFileSync(path.join(root, "windows-set-netconf-eth0.bat"));

        const first = runBootstrapRepair(root);
        assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
        assert.match(first.stdout, /Chrome prerequisite block repaired/);
        assert.equal(readFileSync(script, "utf8"), fixed, "recovery must equal the new generator output byte for byte");
        assert.equal(readFileSync(script + ".bot-tele-bootstrap.bak", "utf8"), broken);
        assert.equal(readFileSync(path.join(config, "SYSTEM"), "utf8"), "untouched-hive");
        assert.deepEqual(readFileSync(path.join(root, "windows-set-admin-password.ps1")), password);
        assert.deepEqual(readFileSync(path.join(root, "windows-set-netconf-eth0.bat")), network);
        const second = runBootstrapRepair(root);
        assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
        assert.match(second.stdout, /No known Chrome newline bug found/);
        assert.equal(readFileSync(script, "utf8"), fixed);
        assert.equal(readFileSync(script + ".bot-tele-bootstrap.bak", "utf8"), broken);

        writeFileSync(script, broken.replace("windows-install-chrome.bat", "unknown-chrome-installer.bat"));
        const unknown = readFileSync(script);
        assert.notEqual(runBootstrapRepair(root).status, 0, "unknown legacy blocks must be refused");
        assert.deepEqual(readFileSync(script), unknown);
        assert.equal(readFileSync(script + ".bot-tele-bootstrap.bak", "utf8"), broken);
    });
}

for (const installChrome of [false, true]) {
    test(`mounted Windows recovery leaves a current Chrome=${installChrome} bootstrap unchanged`, { skip: scriptSkip }, async t => {
        const { directory } = await emitWindowsFiles(t, installChrome, false);
        const root = path.join(directory, "os");
        const config = path.join(root, "Windows", "System32", "config");
        mkdirSync(config, { recursive: true });
        writeFileSync(path.join(config, "SYSTEM"), "untouched-hive");
        const script = path.join(root, "windows-fix-rdp.bat");
        const before = readFileSync(script);
        const result = runBootstrapRepair(root);
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
        assert.deepEqual(readFileSync(script), before);
        assert.equal(existsSync(script + ".bot-tele-bootstrap.bak"), false);

        writeFileSync(script, "@echo off\necho unrelated-batch\n");
        assert.notEqual(runBootstrapRepair(root).status, 0);
        assert.equal(readFileSync(script, "utf8"), "@echo off\necho unrelated-batch\n");
        assert.equal(existsSync(script + ".bot-tele-bootstrap.bak"), false);
        assert.notEqual(runBootstrapRepair(path.join(directory, "configs")).status, 0, "a non-Windows root must be refused");
    });
}

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
    const cmd = process.env.ComSpec ?? path.join(process.env.SystemRoot!, "System32", "cmd.exe");
    for (const present of [false, true]) {
        const systemRoot = path.join(directory, present ? "with-wallpaper" : "without-wallpaper");
        mkdirSync(systemRoot);
        if (present) writeFileSync(path.join(systemRoot, "wallpaper.jpg"), "fixture");
        // Keep the real SystemRoot for cmd.exe startup, then override it only
        // in the generated batch to exercise both wallpaper file paths.
        writeFileSync(path.join(directory, "wallpaper-parse.bat"),
            `@set "SystemRoot=${systemRoot}"\r\n@set "SystemDrive=${directory}"\r\n${safeBatch}`);
        const result = spawnSync(cmd, ["/d", "/c", "wallpaper-parse.bat"], {
            cwd: directory, encoding: "utf8", timeout: 10_000, windowsHide: true,
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
