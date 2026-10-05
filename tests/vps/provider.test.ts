import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "ssh2";
import { DigitalOceanClient, DigitalOceanError, type FetchLike } from "../../src/vps/digitalOcean.js";
import { buildUserData, detectWindowsBootMode, generatePassword, getOs, getWallpaperJpegBase64, inspectWindows, INSTALLER_COMMIT, launchWindows, OS_CATALOG,
    extractInstallerLogUrl, inspectSsh, InstallerError, scheduleInstallerReboot, testSsh, type SshExecutor, type SshRunInput } from "../../src/vps/installer.js";
import { resolveWindowsDdImage } from "../../src/vps/windowsImages.js";

const account = (uuid = "user-one", team = "shared-team") => ({ account: { uuid, team: { uuid: team, name: "Shop" }, status: "active", status_message: "", droplet_limit: 2 } });
const droplet = (id: number) => ({ id, name: `order-${id}`, status: "active", tags: [], networks: { v4: [
    { type: "private", ip_address: "10.1.2.3" }, { type: "public", ip_address: "203.0.113.10" },
] } });
const fakePassword = "ExamplePassword123!xyz";

test("DO tokens from different users in the same team share one identity; missing limit is unknown", async () => {
    const one = new DigitalOceanClient("token-one", { fetch: async () => Response.json(account("user-one")) });
    const two = new DigitalOceanClient("token-two", { fetch: async () => Response.json(account("user-two")) });
    assert.equal((await one.account()).identity, (await two.account()).identity);
    const unknown = new DigitalOceanClient("token-three", { fetch: async () => Response.json({ account: { uuid: "user", status: "active" } }) });
    assert.equal((await unknown.account()).dropletLimit, undefined);
    assert.equal((await unknown.account()).identity, "account:user");
    const incomplete = new DigitalOceanClient("token-four", { fetch: async () => Response.json({ account: { uuid: "user", team: { name: "unknown identity" } } }) });
    await assert.rejects(incomplete.account(), DigitalOceanError);
});

test("DO list includes every unfiltered page without following external pagination URLs", async () => {
    const urls: string[] = [];
    const client = new DigitalOceanClient("private-test-token", { fetch: async (url) => {
        urls.push(url);
        return Response.json(url.endsWith("page=1")
            ? { droplets: [droplet(1)], links: { pages: { next: "https://malicious.invalid/steal-token" } }, meta: { total: 2 } }
            : { droplets: [droplet(2)], links: { pages: {} }, meta: { total: 2 } });
    } });
    const result = await client.listDroplets();
    assert.equal(result.length, 2); assert.equal(result[0]?.publicIp, "203.0.113.10");
    assert.deepEqual(urls, ["https://api.digitalocean.com/v2/droplets?per_page=200&page=1", "https://api.digitalocean.com/v2/droplets?per_page=200&page=2"]);
});

test("DO permission, invalid token, rate-limit and API failures are distinct and never account locked", async () => {
    for (const [status, kind] of [[401, "invalid_token"], [403, "permission"], [429, "rate_limit"], [500, "api"]] as const) {
        const client = new DigitalOceanClient("private-test-token", { fetch: async () => Response.json({ message: "private-test-token locked" }, { status }) });
        await assert.rejects(client.account(), (error: unknown) => {
            assert.ok(error instanceof DigitalOceanError); assert.equal(error.kind, kind); assert.equal(error.httpStatus, status);
            assert.ok(!JSON.stringify(error).includes("private-test-token")); assert.ok(!error.message.includes("locked")); return true;
        });
    }
});

test("DO account status text redacts exact credentials and clients cannot serialize tokens", async () => {
    const client = new DigitalOceanClient("private-test-token", { fetch: async () => Response.json({ account: {
        uuid: "one", status: "warning", status_message: "private-test-token dop_v1_abcdef1234", droplet_limit: 4,
    } }) });
    const result = await client.account();
    assert.equal(result.status, "warning"); assert.equal(result.statusMessage, "[REDACTED] [REDACTED]");
    assert.equal(JSON.stringify(client), "{}");
});

test("DO create timeout sends exactly one POST and marks outcome uncertain", async () => {
    let calls = 0;
    const client = new DigitalOceanClient("private-test-token", { timeoutMs: 5, fetch: async (_url, init) => {
        calls++; assert.equal(init.method, "POST");
        return new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("private-test-token")), { once: true }));
    } });
    await assert.rejects(client.createDroplet({ name: "order-timeout", region: "sgp1", size: "s-2vcpu-4gb", image: "ubuntu-24-04-x64", userData: "fake-user-data" }), (error: unknown) => {
        assert.ok(error instanceof DigitalOceanError); assert.equal(error.kind, "timeout"); assert.equal(error.uncertain, true); return true;
    });
    assert.equal(calls, 1);
});

test("DO create successful malformed response remains uncertain and is never retried", async () => {
    let calls = 0;
    const client = new DigitalOceanClient("token", { fetch: async () => { calls++; return Response.json({ droplet: {} }); } });
    await assert.rejects(client.createDroplet({ name: "order-malformed", region: "sgp1", size: "test", image: "test", userData: "test" }), (error: unknown) => {
        assert.ok(error instanceof DigitalOceanError); assert.equal(error.uncertain, true); return true;
    });
    assert.equal(calls, 1);
});

test("DO selection checks paginated image, live region/size/image and image disk minimum", async () => {
    const fetchMock: FetchLike = async (url) => {
        if (url.includes("/regions")) return Response.json({ regions: [{ slug: "sgp1", name: "Singapore", available: true, sizes: ["s-2vcpu-4gb"] }] });
        if (url.includes("/sizes")) return Response.json({ sizes: [{ slug: "s-2vcpu-4gb", available: true, regions: ["sgp1"], memory: 4096, vcpus: 2, disk: 80 }] });
        return Response.json(url.endsWith("page=1") ? { images: [{ id: 1, slug: "other", name: "Other", regions: ["sgp1"] }], links: { pages: { next: "page2" } } }
            : { images: [{ id: 2, slug: "ubuntu-24-04-x64", name: "Ubuntu", regions: ["sgp1"], min_disk_size: 25 }] });
    };
    const client = new DigitalOceanClient("token", { fetch: fetchMock });
    const selection = await client.validateSelection({ region: "sgp1", size: "s-2vcpu-4gb", os: "windows2022" });
    assert.equal(selection.os.family, "windows"); assert.equal(selection.image.id, 2);
    await assert.rejects(client.validateSelection({ region: "nyc1", size: "s-2vcpu-4gb", os: "windows2022" }), DigitalOceanError);
});

test("DO per-order clients never exchange credentials; reboot uses action resource", async () => {
    const calls: { url: string; auth: string; body: unknown }[] = [];
    const fetchMock: FetchLike = async (url, init) => {
        calls.push({ url, auth: new Headers(init.headers).get("Authorization") ?? "", body: init.body ? JSON.parse(String(init.body)) as unknown : undefined });
        await Promise.resolve();
        return Response.json(url.endsWith("/actions") ? { action: { id: 9, status: "in-progress", type: "reboot" } }
            : url.endsWith("/9") ? { action: { id: 9, status: "completed", type: "reboot" } } : account());
    };
    await Promise.all([new DigitalOceanClient("one", { fetch: fetchMock }).account(), new DigitalOceanClient("two", { fetch: fetchMock }).account()]);
    assert.deepEqual(calls.map((c) => c.auth), ["Bearer one", "Bearer two"]);
    const client = new DigitalOceanClient("one", { fetch: fetchMock });
    assert.equal((await client.reboot(44)).id, 9); assert.equal((await client.action(44, 9)).status, "completed");
    assert.deepEqual(calls[2]?.body, { type: "reboot" }); assert.ok(calls[3]?.url.endsWith("/droplets/44/actions/9"));
});

test("DO cancellation before create issues no request", async () => {
    let calls = 0; const controller = new AbortController(); controller.abort();
    const client = new DigitalOceanClient("one", { fetch: async () => { calls++; return Response.json({}); } });
    await assert.rejects(client.createDroplet({ name: "order-cancel", region: "sgp1", size: "test", image: "test", userData: "test" }, controller.signal), DigitalOceanError);
    assert.equal(calls, 0);
});

test("DO delete targets one droplet and accepts empty 204 responses", async () => {
    const calls: { url: string; method?: string; body?: BodyInit | null }[] = [];
    const client = new DigitalOceanClient("isolated-delete-token", { fetch: async (url, init) => {
        calls.push({ url, method: init.method, body: init.body });
        return new Response(null, { status: 204 });
    } });
    await client.deleteDroplet(123);
    assert.equal(calls.length, 1); assert.equal(calls[0]!.method, "DELETE");
    assert.equal(calls[0]!.url, "https://api.digitalocean.com/v2/droplets/123"); assert.equal(calls[0]!.body, undefined);
    await assert.rejects(client.deleteDroplet(-1), DigitalOceanError);
    assert.equal(calls.length, 1);
});

test("DO delete timeout remains uncertain and permission errors cannot confirm deletion", async () => {
    let calls = 0;
    const uncertain = new DigitalOceanClient("isolated-delete-token", { fetch: async () => { calls++; throw new Error("connection interrupted"); } });
    await assert.rejects(uncertain.deleteDroplet(123), (error: unknown) => error instanceof DigitalOceanError && error.uncertain);
    assert.equal(calls, 1);
    const denied = new DigitalOceanClient("isolated-delete-token", { fetch: async () => Response.json({}, { status: 403 }) });
    await assert.rejects(denied.deleteDroplet(123), (error: unknown) => error instanceof DigitalOceanError && error.kind === "permission" && !error.uncertain);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(uncertain.deleteDroplet(123, controller.signal), DigitalOceanError);
    assert.equal(calls, 1);
});

test("OS reference catalog preserves Linux and ten Windows bootstrap choices", () => {
    assert.equal(Object.values(OS_CATALOG).filter((os) => os.family === "linux").length, 14);
    const win = Object.values(OS_CATALOG).filter((os) => os.family === "windows");
    assert.equal(win.length, 10); assert.ok(win.every((os) => os.image === "ubuntu-24-04-x64"));
    assert.equal(getOs("__proto__"), undefined);
});

test("per-VPS passwords have OS complexity and safe Linux setup", () => {
    const passwords = new Set(Array.from({ length: 100 }, generatePassword));
    assert.equal(passwords.size, 100);
    for (const password of passwords) {
        assert.equal(password.length, 24); assert.match(password, /[a-z]/); assert.match(password, /[A-Z]/); assert.match(password, /\d/); assert.match(password, /[^A-Za-z0-9]/);
    }
    const script = buildUserData(fakePassword); assert.ok(script.includes("chpasswd")); assert.ok(script.includes("sshd -t"));
    assert.throws(() => buildUserData("weak"));
});

test("concurrent installer jobs keep IP, OS, password and durable markers isolated and redact output", async () => {
    const calls: SshRunInput[] = [];
    const ssh: SshExecutor = async (input) => { calls.push(input); await Promise.resolve(); return { code: 0,
        output: `${input.password}\nExampleWindows987!xyz\nhttp://IP:80/aB1cD2eF\n__VPS_PREPARED__\n` }; };
    const inputs = [
        { ip: "203.0.113.10", password: fakePassword, windowsPassword: "ExampleWindows987!xyz", os: "windows2019", orderId: "order-one", bootMode: "efi" as const, imageUrl: resolveWindowsDdImage("windows2019", "efi", {}), installChrome: true },
        { ip: "203.0.113.11", password: "OtherPassword123!xyz", windowsPassword: "AnotherWindows123!xyz", os: "windows2022", orderId: "order-two", bootMode: "bios" as const, imageUrl: resolveWindowsDdImage("windows2022", "bios", {}) },
    ];
    const results = await Promise.all(inputs.map((input) => launchWindows(input, undefined, { ssh })));
    assert.equal(calls[0]?.ip, inputs[0]?.ip); assert.equal(calls[1]?.ip, inputs[1]?.ip);
    assert.ok(calls[0]?.stdin?.includes("/order-one")); assert.ok(!calls[0]?.stdin?.includes("/order-two"));
    assert.ok(calls[0]?.stdin?.includes("reinstall.sh dd")); assert.ok(calls[0]?.stdin?.includes("--img"));
    assert.ok(calls[0]?.stdin?.includes("en_win2019_uefi.xz")); assert.ok(calls[1]?.stdin?.includes("en-us_win2022.xz"));
    assert.ok(calls[0]?.stdin?.includes(INSTALLER_COMMIT)); assert.ok(!calls[0]?.stdin?.includes("--force-boot-mode"));
    assert.ok((calls[0]?.stdin?.indexOf("--range 0-0") ?? -1) < (calls[0]?.stdin?.indexOf("reinstall.sh dd") ?? -1));
    assert.equal(calls[0]?.command, "bash -s");
    assert.ok(calls[0]?.stdin?.includes('if ! mkdir "$state"')); assert.ok(calls[0]?.stdin?.includes('touch "$state/prepared"'));
    assert.ok(calls[0]?.stdin?.includes("patch_trans.py")); assert.ok(calls[0]?.stdin?.includes("DisableCAD")); assert.ok(calls[0]?.stdin?.includes("UserAuthentication"));
    assert.ok(calls[0]?.stdin?.includes("windows-set-admin-password.bat")); assert.ok(calls[0]?.stdin?.includes("Win32_UserAccount"));
    assert.ok(calls[0]?.stdin?.includes("bot-tele-password-ready"));
    assert.ok(calls[0]?.stdin?.includes("DisableAntiSpyware")); assert.ok(calls[0]?.stdin?.includes("NoAutoUpdate")); assert.ok(calls[0]?.stdin?.includes("wuauserv")); assert.ok(calls[0]?.stdin?.includes("SysMain"));
    assert.ok(!calls[0]?.stdin?.includes("/tmp/autounattend.xml"), "custom XML mutation must not corrupt Windows specialize pass");
    assert.ok(calls[0]?.stdin?.includes("windows-install-chrome.bat")); assert.ok(calls[0]?.stdin?.includes("googlechromestandaloneenterprise64.msi"));
    assert.match(calls[0]?.stdin ?? "", /fix_bat_code = r'''[\s\S]*?bot-tele-rdp-ready[\s\S]*?'''/);
    assert.match(calls[0]?.stdin ?? "", /bats="windows-fix-rdp\.bat\$_bot_tele_after"/);
    assert.match(calls[0]?.stdin ?? "", /chrome_bat_code = r'''[\s\S]*?EOF_CHROME_INSTALL[\s\S]*?'''/,
        "generated patch_trans.py must keep the Chrome batch inside a safely-delimited raw block");
    assert.doesNotMatch(calls[0]?.stdin ?? "", /bats="\$bats windows-install-chrome\.bat"/);
    assert.match(calls[0]?.stdin ?? "", /windows-fix-rdp\.bat[\s\S]*?windows-install-chrome\.bat/);
    assert.ok(calls[0]?.stdin?.includes("EOF_WALLPAPER_B64"));
    assert.ok(calls[0]?.stdin?.includes("wallpaper.jpg"));
    assert.ok(calls[0]?.stdin?.includes("wallpaper_copy_code = r'''"));
    assert.ok(calls[0]?.stdin?.includes("SetDankaWallpaper"));
    assert.ok(!calls[1]?.stdin?.includes("windows-install-chrome.bat"));
    assert.equal(results[0]?.logUrl, "http://203.0.113.10/aB1cD2eF"); assert.equal(results[1]?.logUrl, "http://203.0.113.11/aB1cD2eF");
    assert.ok(!JSON.stringify(results).includes(fakePassword)); assert.ok(!JSON.stringify(results).includes("ExampleWindows"));
});

test("image URL is shell-quoted and invalid payloads never reach SSH", async () => {
    const safeUrl = "https://r2.example.test/windows-2019.xz?version=1&source=bot";
    let calls = 0; let script = "";
    await launchWindows({ ip: "203.0.113.10", password: fakePassword, windowsPassword: fakePassword, os: "windows2019",
        orderId: "order-safe-url", bootMode: "bios", imageUrl: safeUrl }, undefined, { ssh: async input => {
        calls++; script = input.stdin ?? ""; return { code: 0, output: "__VPS_PREPARED__" };
    } });
    assert.equal(calls, 1);
    assert.ok(script.includes(`--img '${safeUrl}'`));
    await assert.rejects(launchWindows({ ip: "203.0.113.10", password: fakePassword, windowsPassword: fakePassword, os: "windows2019",
        orderId: "order-bad-url", bootMode: "bios", imageUrl: "https://example.test/$(reboot).xz" }, undefined, { ssh: async () => {
        calls++; return { code: 0, output: "__VPS_PREPARED__" };
    } }));
    assert.equal(calls, 1);
});

test("getWallpaperJpegBase64 encodes Wallpaper.png to valid base64 JPEG", () => {
    const b64 = getWallpaperJpegBase64();
    assert.ok(typeof b64 === "string");
    assert.ok(b64.length > 100_000);
    const buf = Buffer.from(b64, "base64");
    assert.equal(buf[0], 0xff);
    assert.equal(buf[1], 0xd8);
    assert.equal(buf[2], 0xff);
});

test("Linux is never passed to Windows installer and uncertain remote job is not relaunched", async () => {
    let calls = 0; const ssh: SshExecutor = async () => { calls++; return { code: 0, output: "__VPS_RUNNING__" }; };
    const input = { ip: "203.0.113.10", password: fakePassword, windowsPassword: fakePassword, os: "ubuntu24", orderId: "order-linux", bootMode: "bios" as const, imageUrl: resolveWindowsDdImage("windows2016", "bios", {}) };
    await assert.rejects(launchWindows(input, undefined, { ssh })); assert.equal(calls, 0);
    assert.equal((await launchWindows({ ...input, os: "windows2016" }, undefined, { ssh })).state, "running");
});

test("boot mode detection uses deterministic Linux markers", async () => {
    for (const mode of ["efi", "bios"] as const) {
        let probe = "";
        const detected = await detectWindowsBootMode({ ip: "203.0.113.10", password: fakePassword }, undefined, { ssh: async input => {
            probe = input.stdin ?? "";
            return { code: 0, output: `noise\n**VPS_BOOT_MODE**:${mode}\n**VPS_VIRTUALIZATION**:kvm\n` };
        } });
        assert.equal(detected, mode);
        assert.match(probe, /\/sys\/firmware\/efi/);
        assert.match(probe, /systemd-detect-virt/);
    }
});

test("LXC and OpenVZ are rejected before installer mutation", async () => {
    for (const virtualization of ["lxc", "openvz"]) {
        let mutation = false;
        await assert.rejects(detectWindowsBootMode({ ip: "203.0.113.10", password: fakePassword }, undefined, { ssh: async input => {
            mutation = input.mutation === true;
            return { code: 0, output: `**VPS_BOOT_MODE**:bios\n**VPS_VIRTUALIZATION**:${virtualization}\n` };
        } }), (error: unknown) => error instanceof Error && error.name === "InstallerError");
        assert.equal(mutation, false);
    }
});

test("installer reboot uses remote one-time marker and existing marker is not treated as another request", async () => {
    let command = "";
    const result = await scheduleInstallerReboot({ ip: "203.0.113.10", password: fakePassword, orderId: "order-reboot" }, undefined,
        { ssh: async (input) => { command = input.stdin!; return { code: 0, output: "__VPS_REBOOT_ALREADY__" }; } });
    assert.equal(result, "already_scheduled"); assert.ok(command.includes('mkdir "$state/reboot-requested"')); assert.ok(command.includes("shutdown -r +1"));
});

test("Linux readiness proves authenticated root command; TCP RDP never claims Windows login", async () => {
    assert.equal(await testSsh({ ip: "203.0.113.10", password: fakePassword }, undefined, { ssh: async () => ({ code: 0, output: "__VPS_SSH_READY__" }) }), true);
    assert.equal(await testSsh({ ip: "203.0.113.10", password: fakePassword }, undefined, { ssh: async () => ({ code: 0, output: "not root" }) }), false);
    const result = await inspectWindows({ ip: "203.0.113.10", windowsPassword: fakePassword }, undefined, {
        tcp: async () => true, ssh: async () => { throw new Error("SSH should not be tried after RDP opens"); },
    });
    assert.equal(result.rdpOpen, true); assert.equal(result.loginVerified, false); assert.match(result.detail, /RDP merespons dari luar/);
});

test("SSH diagnostics distinguish routing, TCP, authentication and handshake failures without leaking raw errors", async () => {
    const cases = [
        [{ code: "ENETUNREACH" }, "network_unreachable"],
        [{ code: "EHOSTUNREACH" }, "network_unreachable"],
        [{ code: "EADDRNOTAVAIL" }, "network_unreachable"],
        [{ code: "ECONNREFUSED" }, "connection_refused"],
        [{ code: "ETIMEDOUT" }, "connection_timeout"],
        [{ code: "ECONNRESET" }, "connection_reset"],
        [{ code: "EPIPE" }, "connection_reset"],
        [{ level: "client-authentication" }, "authentication"],
        [{ level: "client-timeout" }, "handshake_timeout"],
        [{ code: "UNKNOWN", level: "client-ssh" }, "ssh"],
    ] as const;
    for (const [metadata, reason] of cases) {
        const result = await inspectSsh({ ip: "203.0.113.10", password: fakePassword }, undefined, { ssh: async () => {
            throw Object.assign(new Error(`unsafe server output: ${fakePassword} dop_v1_private_test_token`), metadata);
        } });
        assert.equal(result.ready, false);
        if (!result.ready) assert.equal(result.reason, reason);
        assert.doesNotMatch(JSON.stringify(result), /unsafe server output|dop_v1_private_test_token/);
        assert.ok(!JSON.stringify(result).includes(fakePassword));
    }
    const sanitized = await inspectSsh({ ip: "203.0.113.10", password: fakePassword }, undefined, {
        ssh: async () => { throw new InstallerError("ssh", false, "network_unreachable"); },
    });
    assert.equal(sanitized.ready, false);
    if (!sanitized.ready) assert.equal(sanitized.reason, "network_unreachable");
});

test("SSH permission failures omit remote output and cancelled probes remain cancelled", async () => {
    const result = await inspectSsh({ ip: "203.0.113.10", password: fakePassword }, undefined, {
        ssh: async () => ({ code: 1, output: `permission denied ${fakePassword}` }),
    });
    assert.equal(result.ready, false);
    if (!result.ready) assert.equal(result.reason, "permission");
    assert.ok(!JSON.stringify(result).includes(fakePassword));
    const abort = new AbortController(); abort.abort();
    await assert.rejects(inspectSsh({ ip: "203.0.113.10", password: fakePassword }, abort.signal, {
        ssh: async () => { throw new Error("aborted check must not connect"); },
    }), (error: unknown) => error instanceof InstallerError && error.kind === "cancelled");
    const interrupted = new AbortController();
    await assert.rejects(inspectSsh({ ip: "203.0.113.10", password: fakePassword }, interrupted.signal, {
        ssh: async () => { interrupted.abort(); return { code: 0, output: "__VPS_SSH_READY__" }; },
    }), (error: unknown) => error instanceof InstallerError && error.kind === "cancelled");
});

test("real SSH executor distinguishes a pre-connect timeout from a timeout after TCP connects", async t => {
    let tcpConnected = false;
    t.mock.method(Client.prototype, "connect", function(this: Client) {
        if (tcpConnected) this.emit("connect");
        this.emit("error", Object.assign(new Error("unsafe timeout data"), { level: "client-timeout" }));
        return this;
    });
    const before = await inspectSsh({ ip: "203.0.113.10", password: fakePassword });
    assert.equal(before.ready, false);
    if (!before.ready) assert.equal(before.reason, "connection_timeout");
    tcpConnected = true;
    const after = await inspectSsh({ ip: "203.0.113.10", password: fakePassword });
    assert.equal(after.ready, false);
    if (!after.ready) assert.equal(after.reason, "handshake_timeout");
});

test("installer log discovery reads only random path metadata, restricts host and confirms viewer title", async () => {
    let command = "";
    const result = await inspectWindows({ ip: "203.0.113.10", windowsPassword: fakePassword }, undefined, {
        tcp: async () => false,
        ssh: async (input) => { command = input.command; return { code: 0, output: "extra_web_path=/aB1cD2eF\nextra_web_port=80\n" }; },
        fetch: async (url, init) => { assert.equal(url, "http://203.0.113.10/aB1cD2eF"); assert.equal(init.redirect, "error"); return new Response("<title>Reinstall Logs</title>"); },
    });
    assert.ok(command.includes("^extra_web_(path|port)=")); assert.equal(result.logState, "ready"); assert.equal(result.loginVerified, false);
    assert.equal(extractInstallerLogUrl("http://198.51.100.1/aB1cD2eF", "203.0.113.10"), undefined);
    assert.equal(extractInstallerLogUrl("http://IP/", "203.0.113.10"), undefined);
    const wrong = await inspectWindows({ ip: "203.0.113.10", windowsPassword: fakePassword, logUrl: "http://203.0.113.10/aB1cD2eF" }, undefined, {
        tcp: async () => false, fetch: async () => new Response("Wrong Path"),
    });
    assert.equal(wrong.logState, "unavailable"); assert.equal(wrong.rdpOpen, false);
});

test("external RDP wins immediately over a stale installer viewer", async () => {
    let fetches = 0;
    const result = await inspectWindows({ ip: "203.0.113.10", windowsPassword: fakePassword, logUrl: "http://203.0.113.10/aB1cD2eF" }, undefined, {
        tcp: async () => true,
        fetch: async () => { fetches++; return new Response("<title>Reinstall Logs</title>"); },
    });
    assert.equal(result.rdpOpen, true);
    assert.equal(result.logState, "unavailable");
    assert.equal(fetches, 0);
    assert.match(result.detail, /RDP merespons dari luar/);
});
