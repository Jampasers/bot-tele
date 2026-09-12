import { isIP } from "node:net";
import { getOs, type VpsOs } from "./installer.js";

const API = "https://api.digitalocean.com/v2";
type Json = Record<string, unknown>;
export type DigitalOceanErrorKind = "invalid_token" | "permission" | "rate_limit" | "timeout" | "network" | "api" | "validation" | "cancelled";
const ERROR_MESSAGES: Record<DigitalOceanErrorKind, string> = {
    invalid_token: "Token DigitalOcean tidak valid.", permission: "Izin token untuk endpoint DigitalOcean ini tidak cukup.",
    rate_limit: "Batas request DigitalOcean tercapai. Coba lagi nanti.", timeout: "Request DigitalOcean melewati batas waktu.",
    network: "Koneksi DigitalOcean terputus.", api: "Respons API DigitalOcean tidak dapat dipastikan.",
    validation: "Pilihan VPS tidak tersedia atau respons DigitalOcean tidak lengkap.", cancelled: "Pemeriksaan DigitalOcean dihentikan.",
};

/** Never attach a provider response, request, token, or raw error as `cause`. */
export class DigitalOceanError extends Error {
    constructor(public readonly kind: DigitalOceanErrorKind, public readonly uncertain = false, public readonly httpStatus?: number) {
        super(ERROR_MESSAGES[kind]); this.name = "DigitalOceanError";
    }
}
export interface DoAccount {
    identity: string; uuid: string; teamUuid?: string; teamName?: string;
    status: "active" | "warning" | "locked" | "unknown"; statusMessage: string; dropletLimit?: number;
}
export interface DoDroplet {
    id: number; name: string; status: string; locked: boolean; tags: string[];
    publicIp?: string; region?: string; size?: string; createdAt?: string;
}
export interface DoAction { id: number; status: "in-progress" | "completed" | "errored"; type: string; }
export interface DoRegion { slug: string; name: string; available: boolean; sizes: string[]; }
export interface DoSize { slug: string; available: boolean; regions: string[]; memory: number; vcpus: number; disk: number; priceMonthly: number; }
export interface DoImage { id: number; slug: string; name: string; regions: string[]; minDiskSize: number; }
export interface CreateDropletInput { name: string; region: string; size: string; image: string; userData: string; tags?: string[]; }
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

function record(value: unknown): Json {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new DigitalOceanError("api");
    return value as Json;
}
function str(value: unknown): string { return typeof value === "string" ? value : ""; }
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((s): s is string => typeof s === "string") : []; }
function positive(value: unknown): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new DigitalOceanError("api");
    return value;
}
function nonnegative(value: unknown, fallback = 0): number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}
function parseDroplet(value: unknown): DoDroplet {
    const d = record(value), networks = d.networks ? record(d.networks) : undefined;
    const v4: unknown[] = networks && Array.isArray(networks.v4) ? networks.v4 : [];
    const publicIp = v4.map(record).find((n) => n.type === "public" && isIP(str(n.ip_address)) === 4)?.ip_address;
    return {
        id: positive(d.id), name: str(d.name), status: str(d.status), locked: d.locked === true, tags: strings(d.tags),
        ...(typeof publicIp === "string" ? { publicIp } : {}),
        ...(d.region && str(record(d.region).slug) ? { region: str(record(d.region).slug) } : {}),
        ...(str(d.size_slug) ? { size: str(d.size_slug) } : {}),
        ...(str(d.created_at) ? { createdAt: str(d.created_at) } : {}),
    };
}
function parseAction(value: unknown): DoAction {
    const a = record(value);
    if (a.status !== "in-progress" && a.status !== "completed" && a.status !== "errored") throw new DigitalOceanError("api");
    return { id: positive(a.id), status: a.status, type: str(a.type) };
}

/** Per-order client. No global token, automatic retry, mutation queue, or logging. */
export class DigitalOceanClient {
    readonly #token: string;
    readonly #fetch: FetchLike;
    readonly #timeoutMs: number;
    constructor(token: string, options: { fetch?: FetchLike; timeoutMs?: number } = {}) {
        if (!token || /[\r\n\0]/.test(token) || token.length > 1024) throw new DigitalOceanError("invalid_token");
        this.#token = token; this.#fetch = options.fetch ?? fetch;
        this.#timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? 20_000, 60_000));
    }

    private safeText(value: unknown): string {
        return str(value).split(this.#token).join("[REDACTED]").replace(/dop_v1_[A-Za-z0-9_-]+/g, "[REDACTED]")
            .replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 500);
    }

    private async request(path: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<Json> {
        if (signal?.aborted) throw new DigitalOceanError("cancelled");
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal?.addEventListener("abort", abort, { once: true });
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.#timeoutMs);
        const mutation = method !== "GET";
        try {
            const response = await this.#fetch(`${API}${path}`, {
                method, headers: { Authorization: `Bearer ${this.#token}`, "Content-Type": "application/json" },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal, redirect: "error",
            });
            if (!response.ok) {
                void response.body?.cancel().catch(() => {});
                const kind: DigitalOceanErrorKind = response.status === 401 ? "invalid_token" : response.status === 403 ? "permission"
                    : response.status === 429 ? "rate_limit" : response.status === 408 ? "timeout"
                    : response.status === 400 || response.status === 422 ? "validation" : "api";
                throw new DigitalOceanError(kind, mutation && (response.status >= 500 || response.status === 408), response.status);
            }
            // Bound both response bytes and time; unknown bodies never reach logs.
            const reader = response.body?.getReader();
            if (!reader) throw new DigitalOceanError("api", mutation);
            const chunks: Uint8Array[] = []; let length = 0;
            for (;;) {
                const chunk = await reader.read();
                if (chunk.done) break;
                length += chunk.value.byteLength;
                if (length > 8 * 1024 * 1024) { await reader.cancel(); throw new DigitalOceanError("api", mutation); }
                chunks.push(chunk.value);
            }
            return record(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
        } catch (error) {
            if (error instanceof DigitalOceanError) {
                if (mutation && error.httpStatus === undefined && !error.uncertain) throw new DigitalOceanError(error.kind, true);
                throw error;
            }
            if (timedOut) throw new DigitalOceanError("timeout", mutation);
            if (signal?.aborted) throw new DigitalOceanError("cancelled", mutation);
            throw new DigitalOceanError(error instanceof SyntaxError ? "api" : "network", mutation);
        } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
    }

    private async list(path: string, key: string, signal?: AbortSignal): Promise<unknown[]> {
        const rows: unknown[] = [];
        for (let page = 1; page <= 1000; page++) {
            const data = await this.request(`${path}${path.includes("?") ? "&" : "?"}per_page=200&page=${page}`, "GET", undefined, signal);
            if (!Array.isArray(data[key])) throw new DigitalOceanError("api");
            const items = data[key]; rows.push(...items);
            const links = data.links ? record(data.links) : undefined;
            const pages = links?.pages ? record(links.pages) : undefined;
            const total = data.meta ? record(data.meta).total : undefined;
            if (!pages?.next && (typeof total === "number" ? rows.length >= total : items.length < 200)) return rows;
            // Do not follow provider-supplied URLs with a bearer token. Reconstruct local page numbers.
            if (items.length === 0) throw new DigitalOceanError("api");
        }
        throw new DigitalOceanError("api");
    }

    async account(signal?: AbortSignal): Promise<DoAccount> {
        const a = record((await this.request("/account", "GET", undefined, signal)).account);
        const uuid = str(a.uuid), team = a.team ? record(a.team) : undefined, teamUuid = str(team?.uuid);
        if (!uuid || (team && !teamUuid)) throw new DigitalOceanError("api");
        return {
            identity: teamUuid ? `team:${teamUuid}` : `account:${uuid}`, uuid,
            ...(teamUuid ? { teamUuid, teamName: this.safeText(team?.name) } : {}),
            status: a.status === "active" || a.status === "warning" || a.status === "locked" ? a.status : "unknown",
            statusMessage: this.safeText(a.status_message),
            ...(typeof a.droplet_limit === "number" && Number.isSafeInteger(a.droplet_limit) && a.droplet_limit >= 0 ? { dropletLimit: a.droplet_limit } : {}),
        };
    }
    async listDroplets(signal?: AbortSignal): Promise<DoDroplet[]> {
        const droplets = (await this.list("/droplets", "droplets", signal)).map(parseDroplet);
        // Pagination can overlap while an external actor creates/deletes a Droplet.
        return [...new Map(droplets.map((d) => [d.id, d])).values()];
    }
    async getDroplet(id: number, signal?: AbortSignal): Promise<DoDroplet> {
        return parseDroplet((await this.request(`/droplets/${positive(id)}`, "GET", undefined, signal)).droplet);
    }
    async regions(signal?: AbortSignal): Promise<DoRegion[]> {
        return (await this.list("/regions", "regions", signal)).map((value) => {
            const r = record(value); return { slug: str(r.slug), name: this.safeText(r.name), available: r.available === true, sizes: strings(r.sizes) };
        });
    }
    async sizes(signal?: AbortSignal): Promise<DoSize[]> {
        return (await this.list("/sizes", "sizes", signal)).map((value) => {
            const s = record(value); return { slug: str(s.slug), available: s.available === true, regions: strings(s.regions),
                memory: positive(s.memory), vcpus: positive(s.vcpus), disk: positive(s.disk), priceMonthly: nonnegative(s.price_monthly) };
        });
    }
    async images(signal?: AbortSignal): Promise<DoImage[]> {
        return (await this.list("/images?type=distribution", "images", signal)).map((value) => {
            const i = record(value); return { id: positive(i.id), slug: str(i.slug), name: this.safeText(i.name), regions: strings(i.regions), minDiskSize: nonnegative(i.min_disk_size) };
        });
    }
    async validateSelection(selection: { region: string; size: string; os: string }, signal?: AbortSignal): Promise<{ os: VpsOs; region: DoRegion; size: DoSize; image: DoImage }> {
        const os = getOs(selection.os);
        if (!os) throw new DigitalOceanError("validation");
        const [regions, sizes, images] = await Promise.all([this.regions(signal), this.sizes(signal), this.images(signal)]);
        const region = regions.find((r) => r.slug === selection.region && r.available);
        const size = sizes.find((s) => s.slug === selection.size && s.available && s.regions.includes(selection.region));
        const image = images.find((i) => i.slug === os.image && i.regions.includes(selection.region));
        if (!region || !size || !image || size.disk < image.minDiskSize || (region.sizes.length > 0 && !region.sizes.includes(size.slug))) throw new DigitalOceanError("validation");
        return { os, region, size, image };
    }
    async createDroplet(input: CreateDropletInput, signal?: AbortSignal): Promise<DoDroplet> {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(input.name) || !input.userData || !input.region || !input.size || !input.image) throw new DigitalOceanError("validation");
        const response = await this.request("/droplets", "POST", {
            name: input.name, region: input.region, size: input.size, image: input.image, user_data: input.userData,
            backups: false, ipv6: false, monitoring: true, ...(input.tags?.length ? { tags: input.tags } : {}),
        }, signal);
        try { return parseDroplet(response.droplet); } catch { throw new DigitalOceanError("api", true); }
    }
    async reboot(id: number, signal?: AbortSignal): Promise<DoAction> {
        const response = await this.request(`/droplets/${positive(id)}/actions`, "POST", { type: "reboot" }, signal);
        try { return parseAction(response.action); } catch { throw new DigitalOceanError("api", true); }
    }
    async action(dropletId: number, actionId: number, signal?: AbortSignal): Promise<DoAction> {
        return parseAction((await this.request(`/droplets/${positive(dropletId)}/actions/${positive(actionId)}`, "GET", undefined, signal)).action);
    }
}
