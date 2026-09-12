import assert from "node:assert/strict";
import test from "node:test";
import { DigitalOceanClient, DigitalOceanError, type FetchLike } from "./digitalOcean.js";
import { buildUserData, generatePassword, getOs, inspectWindows, INSTALLER_COMMIT, launchWindows, OS_CATALOG,
    extractInstallerLogUrl, scheduleInstallerReboot, testSsh, type SshExecutor, type SshRunInput } from "./installer.js";

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

test("OS reference catalog preserves Linux and four Windows bootstrap choices", () => {
    assert.equal(Object.values(OS_CATALOG).filter((os) => os.family === "linux").length, 14);
    const win = Object.values(OS_CATALOG).filter((os) => os.family === "windows");
    assert.equal(win.length, 4); assert.ok(win.every((os) => os.image === "ubuntu-24-04-x64"));
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
        { ip: "203.0.113.10", password: fakePassword, windowsPassword: "ExampleWindows987!xyz", os: "windows2019", orderId: "order-one" },
        { ip: "203.0.113.11", password: "OtherPassword123!xyz", windowsPassword: "AnotherWindows123!xyz", os: "windows2022", orderId: "order-two" },
    ];
    const results = await Promise.all(inputs.map((input) => launchWindows(input, undefined, { ssh })));
    assert.equal(calls[0]?.ip, inputs[0]?.ip); assert.equal(calls[1]?.ip, inputs[1]?.ip);
    assert.ok(calls[0]?.stdin?.includes("/order-one")); assert.ok(!calls[0]?.stdin?.includes("/order-two"));
    assert.ok(calls[0]?.stdin?.includes("Windows Server 2019 ServerStandard")); assert.ok(calls[1]?.stdin?.includes("Windows Server 2022 ServerStandard"));
    assert.ok(calls[0]?.stdin?.includes(INSTALLER_COMMIT)); assert.ok(calls[0]?.stdin?.includes("--force-boot-mode bios"));
    assert.equal(calls[0]?.command, "bash -s");
    assert.ok(calls[0]?.stdin?.includes('if ! mkdir "$state"')); assert.ok(calls[0]?.stdin?.includes('touch "$state/prepared"'));
    assert.ok(calls[0]?.stdin?.includes("patch_trans.py")); assert.ok(calls[0]?.stdin?.includes("DisableCAD")); assert.ok(calls[0]?.stdin?.includes("UserAuthentication"));
    assert.equal(results[0]?.logUrl, "http://203.0.113.10/aB1cD2eF"); assert.equal(results[1]?.logUrl, "http://203.0.113.11/aB1cD2eF");
    assert.ok(!JSON.stringify(results).includes(fakePassword)); assert.ok(!JSON.stringify(results).includes("ExampleWindows"));
});

test("Linux is never passed to Windows installer and uncertain remote job is not relaunched", async () => {
    let calls = 0; const ssh: SshExecutor = async () => { calls++; return { code: 0, output: "__VPS_RUNNING__" }; };
    const input = { ip: "203.0.113.10", password: fakePassword, windowsPassword: fakePassword, os: "ubuntu24", orderId: "order-linux" };
    await assert.rejects(launchWindows(input, undefined, { ssh })); assert.equal(calls, 0);
    assert.equal((await launchWindows({ ...input, os: "windows2016" }, undefined, { ssh })).state, "running");
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
    assert.equal(result.rdpOpen, true); assert.equal(result.loginVerified, false); assert.match(result.detail, /belum diverifikasi/);
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

test("installer log active state forces rdpOpen false to prevent premature ready while installer is running", async () => {
    const result = await inspectWindows({ ip: "203.0.113.10", windowsPassword: fakePassword, logUrl: "http://203.0.113.10/aB1cD2eF" }, undefined, {
        tcp: async () => true,
        fetch: async () => new Response("<title>Reinstall Logs</title>"),
    });
    assert.equal(result.logState, "ready");
    assert.equal(result.rdpOpen, false);
    assert.match(result.detail, /masih dipantau/);
});

