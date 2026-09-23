import assert from "node:assert/strict";
import test from "node:test";
import type { IVpsOrder } from "../../src/models/VpsOrder.js";
import { advanceVpsOrder, type VpsStepDependencies } from "../../src/vps/worker.js";
import { DigitalOceanClient } from "../../src/vps/digitalOcean.js";
import { InstallerError } from "../../src/vps/installer.js";
import { getOs } from "../../src/vps/installer.js";

function orderFixture(patch: Partial<IVpsOrder> = {}): IVpsOrder {
    const now = new Date();
    return {
        _id: "b8c9d838-2e34-4c56-88aa-83f4194f381c", tenantId: "platform", buyerId: "1234", chatId: "1234", service: "install",
        snapshot: { planId: "plan", planName: "Windows", size: "s-2vcpu-4gb", region: "sgp1", os: "windows2022", image: "ubuntu-24-04-x64", price: 10_000, vcpus: 2, memory: 4096, disk: 80 },
        paymentStatus: "paid", paymentMethod: "balance", paymentPaidAt: now, paymentInvoiceLeaseUntil: null, refundReason: null, refundedAt: null,
        stage: "rebooting", resumeStage: null, credentialId: null, accountId: "team:one", dropletId: 42, publicIp: "203.0.113.10", createName: "bt-vps-order-one",
        createAttemptedAt: now, reservationActive: false, passwordEncrypted: "encrypted-fixture", lastError: null, evidence: "", installerLogUrl: null,
        installerBootMode: "efi", installerImageUrl: "https://images.example.test/windows2022-efi.xz",
        stageStartedAt: now, rdpSuccesses: 0, lockOwner: "worker-one", lockUntil: new Date(now.getTime() + 120000), nextRunAt: now,
        rebootState: "idle", rebootActionId: null, rebootRequestedAt: null, createdAt: now, updatedAt: now, ...patch,
    };
}
function dependencies(patch: Partial<VpsStepDependencies> = {}): VpsStepDependencies {
    return {
        save: async () => {}, client: async () => { throw new Error("API must not be used in this step"); },
        reserve: async () => { throw new Error("No new capacity may be reserved"); }, password: () => "MockPassword123!xyz",
        testSsh: async () => { throw new Error("Linux SSH must not be checked again"); },
        detectWindowsBootMode: async () => { throw new Error("Boot detection must not be repeated"); },
        resolveWindowsDdImage: () => { throw new Error("Image selection must not be repeated"); },
        launchWindows: async () => { throw new Error("Installer preparation must not be repeated"); },
        scheduleInstallerReboot: async () => "scheduled", inspectWindows: async () => ({ rdpOpen: false, loginVerified: false, logState: "unavailable", detail: "Waiting" }),
        clearToken: () => {}, now: Date.now, signal: new AbortController().signal, ...patch,
    };
}

test("reboot recovery keeps durable intent until scheduling is actually attempted", async () => {
    const order = orderFixture(); const writes: Partial<IVpsOrder>[] = [];
    const deps = dependencies({ save: async (patch) => { writes.push(patch); }, scheduleInstallerReboot: async () => {
        assert.equal(order.stage, "rebooting"); assert.equal(writes.length, 0); return "scheduled";
    } });
    await advanceVpsOrder(order, deps);
    assert.equal(order.stage, "monitoring"); assert.equal(writes[0]?.stage, "monitoring");
});

test("direct buyer VPS skips DigitalOcean creation and installs Windows with supplied SSH access", async () => {
    const order = orderFixture({ stage: "queued", accountId: null, dropletId: null, createAttemptedAt: null,
        sourceUsername: "ubuntu", sourcePasswordEncrypted: "encrypted-source", publicIp: "192.0.2.10",
        installerBootMode: null, installerImageUrl: null });
    let providerCalls = 0; let sshChecks = 0; let installs = 0;
    const deps = dependencies({
        client: async () => { providerCalls++; throw new Error("DigitalOcean must not be used"); },
        sourceUsername: () => "ubuntu", sourcePassword: () => "synthetic-source-password",
        testSsh: async input => {
            sshChecks++;
            assert.deepEqual(input, { ip: "192.0.2.10", username: "ubuntu", password: "synthetic-source-password" });
            return true;
        },
        detectWindowsBootMode: async () => "efi",
        resolveWindowsDdImage: () => "https://images.example.test/windows2022-efi.xz",
        launchWindows: async input => {
            installs++;
            assert.equal(input.ip, "192.0.2.10"); assert.equal(input.username, "ubuntu");
            assert.equal(input.password, "synthetic-source-password"); assert.equal(input.windowsPassword, "MockPassword123!xyz");
            assert.equal(input.bootMode, "efi"); assert.match(input.imageUrl, /windows2022-efi/);
            return { state: "prepared", bootMode: input.bootMode, imageUrl: input.imageUrl };
        },
    });

    await advanceVpsOrder(order, deps);
    assert.equal(order.stage, "ssh");
    await advanceVpsOrder(order, deps);
    assert.equal(order.stage, "installing");
    await advanceVpsOrder(order, deps);
    assert.equal(order.stage, "rebooting");
    assert.equal(providerCalls, 0); assert.equal(sshChecks, 1); assert.equal(installs, 1);
});

test("persisted Windows image selection skips detection and resolution on retry", async () => {
    const order = orderFixture({ stage: "installing", installerBootMode: "efi", installerImageUrl: "https://images.example.test/persisted-efi.xz" });
    let launches = 0;
    await advanceVpsOrder(order, dependencies({
        detectWindowsBootMode: async () => { throw new Error("must not detect again"); },
        resolveWindowsDdImage: () => { throw new Error("must not resolve against changed environment"); },
        launchWindows: async input => {
            launches++;
            assert.equal(input.bootMode, "efi");
            assert.equal(input.imageUrl, "https://images.example.test/persisted-efi.xz");
            return { state: "prepared", bootMode: input.bootMode, imageUrl: input.imageUrl };
        },
    }));
    assert.equal(launches, 1);
    assert.equal(order.stage, "rebooting");
});

test("installer cannot launch until detected mode and image are durably saved", async () => {
    const order = orderFixture({ stage: "installing", installerBootMode: null, installerImageUrl: null });
    let launches = 0;
    await assert.rejects(advanceVpsOrder(order, dependencies({
        detectWindowsBootMode: async () => "efi",
        resolveWindowsDdImage: () => "https://images.example.test/windows2022-efi.xz",
        save: async patch => {
            if (patch.installerBootMode || patch.installerImageUrl) throw new Error("simulated persistence outage");
        },
        launchWindows: async () => { launches++; throw new Error("must not launch"); },
    })));
    assert.equal(launches, 0);
    assert.equal(order.installerBootMode, null);
    assert.equal(order.installerImageUrl, null);
});

test("unsupported container virtualization fails before installer launch", async () => {
    const order = orderFixture({ stage: "installing", installerBootMode: null, installerImageUrl: null });
    let launches = 0;
    await advanceVpsOrder(order, dependencies({
        detectWindowsBootMode: async () => { throw new InstallerError("validation", false, "unsupported_virtualization"); },
        launchWindows: async () => { launches++; throw new Error("must not launch"); },
    }));
    assert.equal(launches, 0);
    assert.equal(order.stage, "failed");
    assert.equal(order.lastError, "validation_failed");
    assert.match(order.evidence, /LXC\/OpenVZ/);
});

test("crash after guarded scheduling retains rebooting; recovery observes marker without another reboot", async () => {
    const order = orderFixture(); let remoteScheduled = false; let actualReboots = 0; let schedules = 0;
    const guardedSchedule: VpsStepDependencies["scheduleInstallerReboot"] = async () => {
        schedules++; if (remoteScheduled) return "already_scheduled";
        remoteScheduled = true; actualReboots++; return "scheduled";
    };
    await assert.rejects(advanceVpsOrder(order, dependencies({ scheduleInstallerReboot: guardedSchedule, save: async () => { throw new Error("simulated process death before durable stage save"); } })));
    assert.equal(order.stage, "rebooting");
    await advanceVpsOrder(order, dependencies({ scheduleInstallerReboot: guardedSchedule }));
    assert.equal(order.stage, "monitoring"); assert.equal(schedules, 2); assert.equal(actualReboots, 1);
});

test("ambiguous reboot SSH result resumes observation and never Windows preparation", async () => {
    const order = orderFixture();
    await advanceVpsOrder(order, dependencies({ scheduleInstallerReboot: async () => { throw new InstallerError("timeout", true); } }));
    assert.equal(order.stage, "monitoring");
    await advanceVpsOrder(order, dependencies());
    assert.equal(order.stage, "monitoring"); assert.equal(order.rdpSuccesses, 0);
});

test("missing prepared marker after OS disk replacement goes to observation, not install", async () => {
    const order = orderFixture();
    await advanceVpsOrder(order, dependencies({ scheduleInstallerReboot: async () => "failed" }));
    assert.equal(order.stage, "review"); assert.equal(order.resumeStage, "monitoring");
    await advanceVpsOrder(order, dependencies({ inspectWindows: async () => ({ rdpOpen: true, loginVerified: false, logState: "unavailable", detail: "RDP only" }) }));
    assert.equal(order.stage, "review"); assert.equal(order.rdpSuccesses, 1);
});

test("review monitoring observes quietly and becomes ready without bouncing stages", async () => {
    const old = new Date("2026-09-12T15:51:00.000Z");
    const now = new Date("2026-09-13T00:40:00.000Z");
    const order = orderFixture({ stage: "review", resumeStage: "monitoring", stageStartedAt: old, updatedAt: old });
    const deps = dependencies({
        now: () => now.getTime(),
        inspectWindows: async () => ({ rdpOpen: true, loginVerified: false, logState: "unavailable", detail: "RDP only" }),
    });
    await advanceVpsOrder(order, deps);
    assert.equal(order.stage, "review");
    assert.equal(order.rdpSuccesses, 1);
    assert.equal(order.stageStartedAt.getTime(), old.getTime());
    await advanceVpsOrder(order, deps);
    assert.equal(order.stage, "review");
    assert.equal(order.rdpSuccesses, 2);
    await advanceVpsOrder(order, deps);
    assert.equal(order.stage, "ready");
    assert.equal(order.resumeStage, null);
});

test("buyer token loss during ambiguous create review preserves creating recovery target", async () => {
    const order = orderFixture({ stage: "review", resumeStage: "creating", dropletId: null, publicIp: null });
    await advanceVpsOrder(order, dependencies({ client: async () => undefined }));
    assert.equal(order.stage, "needs_token"); assert.equal(order.resumeStage, "creating");
    // Same transition used after verified same-team token re-entry in service.ts.
    order.stage = order.resumeStage as IVpsOrder["stage"]; order.resumeStage = null;
    let gets = 0;
    const client = new DigitalOceanClient("mock-memory-only-token", { fetch: async (url, init) => {
        assert.equal(init.method, "GET"); assert.ok(url.includes("/droplets?")); gets++;
        return Response.json({ droplets: [{ id: 42, name: order.createName, status: "active", networks: { v4: [{ type: "public", ip_address: "203.0.113.10" }] } }] });
    } });
    await advanceVpsOrder(order, dependencies({ client: async () => client }));
    assert.equal(gets, 1); assert.equal(order.stage, "droplet"); assert.equal(order.dropletId, 42);
});

function providerForOrder(order: IVpsOrder, token: string, behavior: {
    post?: (body: Record<string, unknown>) => Promise<Response>;
    list?: () => Promise<Response>;
    calls?: { url: string; auth: string; method: string; body: Record<string, unknown> | null }[];
} = {}): DigitalOceanClient {
    return new DigitalOceanClient(token, { fetch: async (url, init) => {
        const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
        behavior.calls?.push({ url, auth: new Headers(init.headers).get("Authorization") ?? "", method: init.method ?? "GET", body });
        await Promise.resolve();
        if (url.includes("/regions")) return Response.json({ regions: [{ slug: order.snapshot.region, name: "Region", available: true, sizes: [order.snapshot.size] }] });
        if (url.includes("/sizes")) return Response.json({ sizes: [{ slug: order.snapshot.size, available: true, regions: [order.snapshot.region], memory: order.snapshot.memory, vcpus: order.snapshot.vcpus, disk: order.snapshot.disk }] });
        if (url.includes("/images")) return Response.json({ images: [{ id: 1, slug: getOs(order.snapshot.os)!.image, name: "Image", regions: [order.snapshot.region], min_disk_size: 25 }] });
        if (init.method === "POST") return behavior.post ? behavior.post(body!) : Response.json({ droplet: { id: 42, name: order.createName, status: "new" } });
        if (url.includes("/droplets?")) return behavior.list ? behavior.list() : Response.json({ droplets: [] });
        if (url.includes("/droplets/42")) return Response.json({ droplet: { id: 42, name: order.createName, status: "active", networks: { v4: [{ type: "public", ip_address: "203.0.113.10" }] } } });
        throw new Error("Unexpected provider request in test");
    } });
}

test("create timeout stays paid for review, makes no second POST and resumes discovered droplet", async () => {
    const order = orderFixture({ stage: "queued", createAttemptedAt: null, dropletId: null, publicIp: null });
    let posts = 0; let lists = 0; let cleared = 0;
    const client = providerForOrder(order, "token-kept-only-in-client", {
        post: async () => { posts++; throw new Error("timeout after provider accepted token-kept-only-in-client"); },
        list: async () => { lists++; return Response.json({ droplets: lists === 1 ? [] : [{ id: 42, name: order.createName, status: "active" }] }); },
    });
    const patches: Partial<IVpsOrder>[] = [];
    const deps = dependencies({ client: async () => client, save: async (patch) => { patches.push(patch); }, clearToken: () => { cleared++; } });
    await advanceVpsOrder(order, deps);
    assert.equal(order.stage, "review"); assert.equal(order.resumeStage, "creating"); assert.equal(order.paymentStatus, "paid");
    assert.ok(order.createAttemptedAt); assert.equal(order.dropletId, null);
    await advanceVpsOrder(order, deps); assert.equal(order.stage, "review");
    await advanceVpsOrder(order, deps); assert.equal(order.stage, "droplet"); assert.equal(order.dropletId, 42);
    await advanceVpsOrder(order, deps); assert.equal(order.stage, "ssh"); assert.equal(order.publicIp, "203.0.113.10");
    assert.equal(posts, 1); assert.equal(lists, 2); assert.equal(cleared, 0);
    assert.ok(!JSON.stringify(patches).includes("token-kept-only-in-client"));
});

test("DB save failure before create issues no POST; failure after POST only reconciles", async () => {
    const before = orderFixture({ stage: "queued", createAttemptedAt: null, dropletId: null, publicIp: null });
    let beforePosts = 0;
    const beforeClient = providerForOrder(before, "mock-before-token", { post: async () => { beforePosts++; return Response.json({}); } });
    await assert.rejects(advanceVpsOrder(before, dependencies({ client: async () => beforeClient, save: async () => { throw new Error("DB unavailable before intent"); } })));
    assert.equal(beforePosts, 0); assert.equal(before.createAttemptedAt, null);

    const after = orderFixture({ stage: "queued", createAttemptedAt: null, dropletId: null, publicIp: null });
    let afterPosts = 0; let saveNumber = 0;
    const afterClient = providerForOrder(after, "mock-after-token", {
        post: async () => { afterPosts++; return Response.json({ droplet: { id: 42, name: after.createName, status: "new" } }); },
        list: async () => Response.json({ droplets: [{ id: 42, name: after.createName, status: "active" }] }),
    });
    await assert.rejects(advanceVpsOrder(after, dependencies({ client: async () => afterClient, save: async () => { saveNumber++; if (saveNumber > 1) throw new Error("DB unavailable after provider accepted create"); } })));
    assert.equal(after.stage, "creating"); assert.ok(after.createAttemptedAt); assert.equal(afterPosts, 1);
    await advanceVpsOrder(after, dependencies({ client: async () => afterClient }));
    assert.equal(after.stage, "droplet"); assert.equal(after.dropletId, 42); assert.equal(afterPosts, 1);
});

test("concurrent orders retain separate provider token, specification and generated password", async () => {
    const one = orderFixture({ stage: "queued", createAttemptedAt: null, dropletId: null, publicIp: null });
    const two = orderFixture({ _id: "a56d7038-e3bb-44d4-b2a5-6164014b2f91", buyerId: "5678", chatId: "5678", createName: "bt-vps-order-two", accountId: "team:two", stage: "queued", createAttemptedAt: null, dropletId: null, publicIp: null,
        snapshot: { ...one.snapshot, os: "debian13", image: "debian-13-x64", region: "nyc3", size: "s-4vcpu-8gb", vcpus: 4, memory: 8192, disk: 160 },
    });
    const calls: { url: string; auth: string; method: string; body: Record<string, unknown> | null }[] = [];
    const oneClient = providerForOrder(one, "mock-order-one-token", { calls });
    const twoClient = providerForOrder(two, "mock-order-two-token", { calls });
    const onePassword = "FirstPassword123!example"; const twoPassword = "SecondPassword456!sample";
    await Promise.all([
        advanceVpsOrder(one, dependencies({ client: async () => oneClient, password: () => onePassword })),
        advanceVpsOrder(two, dependencies({ client: async () => twoClient, password: () => twoPassword })),
    ]);
    const first = calls.find((call) => call.method === "POST" && call.auth === "Bearer mock-order-one-token")!;
    const second = calls.find((call) => call.method === "POST" && call.auth === "Bearer mock-order-two-token")!;
    assert.equal(first.body?.name, one.createName); assert.equal(first.body?.region, "sgp1"); assert.equal(first.body?.image, "ubuntu-24-04-x64");
    assert.equal(second.body?.name, two.createName); assert.equal(second.body?.region, "nyc3"); assert.equal(second.body?.image, "debian-13-x64");
    assert.ok(String(first.body?.user_data).includes(onePassword)); assert.ok(!String(first.body?.user_data).includes(twoPassword));
    assert.ok(String(second.body?.user_data).includes(twoPassword)); assert.ok(!String(second.body?.user_data).includes(onePassword));
    assert.equal(one.stage, "droplet"); assert.equal(two.stage, "droplet");
});

test("worker monitoring resets rdpSuccesses and avoids ready when installer log is still active", async () => {
    const order = orderFixture({ stage: "monitoring", rdpSuccesses: 2 });
    await advanceVpsOrder(order, dependencies({
        inspectWindows: async () => ({ rdpOpen: true, loginVerified: false, logState: "ready", logUrl: "http://203.0.113.10/test", detail: "Viewer log installer tersedia" }),
    }));
    assert.equal(order.stage, "monitoring");
    assert.equal(order.rdpSuccesses, 0);
});
