import { createHash } from "node:crypto";
import type { VpsUiPlan, VpsServiceType } from "../plugins/vps/contracts.js";

export interface PlanCatalog {
  regions: { slug: string; name: string; country: string }[];
  sizes: { slug: string; cpu: number; ram: string; disk: string; transfer: string; price: string }[];
  os: { key: string; name: string; family: "linux" | "windows" }[];
}

export function catalogPlanId(service: VpsServiceType, size: string): string {
  const hex = createHash("sha256").update(`vps-catalog-v1:${service}:${size}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export const DIRECT_INSTALL_PLAN_ID = catalogPlanId("install", "__buyer-owned-vps__");

export function supportsWindows(size: PlanCatalog["sizes"][number]): boolean {
  const ram = /^(\d+(?:\.\d+)?)\s*(GB|MB)$/i.exec(size.ram.trim());
  const disk = /^(\d+(?:\.\d+)?)\s*(GB|TB)$/i.exec(size.disk.trim());
  return size.cpu >= 1 && !!ram && Number(ram[1]) * (ram[2]!.toUpperCase() === "GB" ? 1024 : 1) >= 2048
    && !!disk && Number(disk[1]) * (disk[2]!.toUpperCase() === "TB" ? 1024 : 1) >= 50;
}

export function directInstallPlans(catalog: PlanCatalog): VpsUiPlan[] {
  return catalogPlans(catalog, "install").filter(plan => plan.osPrices.some(os => os.family === "windows")).map(plan => ({
    ...plan, id: catalogPlanId("install", `__buyer-owned-vps__:${plan.sizeSlug}`),
    sourceMode: "direct", regions: ["external"], regionLabels: { external: "VPS milik buyer" },
    osPrices: plan.osPrices.filter(os => os.family === "windows"),
  }));
}

export function directInstallPlan(
  catalog: PlanCatalog,
  saved?: Pick<VpsUiPlan, "enabled" | "osPrices">,
): VpsUiPlan {
  const savedPrices = new Map((saved?.osPrices ?? []).map(item => [item.os, item.price] as const));
  return {
    id: DIRECT_INSTALL_PLAN_ID,
    name: "Install Windows di VPS Buyer",
    serviceType: "install",
    sizeSlug: "external-vps",
    sizeLabel: "VPS Buyer · Direct SSH",
    regions: ["external"],
    regionLabels: { external: "VPS milik buyer" },
    osPrices: catalog.os
      .filter(os => os.family === "windows")
      .map(os => ({ os: os.key, label: os.name, family: os.family, price: savedPrices.get(os.key) ?? null })),
    priceMatrix: [],
    enabled: saved?.enabled ?? true,
    catalogManaged: false,
  };
}

/** Price records are separate from choices: missing prices must not hide catalog options. */
export function catalogPlans(catalog: PlanCatalog, serviceType?: VpsServiceType): VpsUiPlan[] {
  const services: VpsServiceType[] = serviceType ? [serviceType] : ["purchase", "install"];
  return services.flatMap(service => catalog.sizes.map(size => ({
    id: catalogPlanId(service, size.slug), name: `${size.cpu} vCPU · ${size.ram}`, serviceType: service,
    sizeSlug: size.slug, sizeLabel: `${size.cpu} vCPU · ${size.ram} RAM · ${size.disk} SSD`,
    providerPrice: size.price, transfer: size.transfer,
    regions: catalog.regions.map(region => region.slug),
    regionLabels: Object.fromEntries(catalog.regions.map(region => [region.slug, `${region.name}, ${region.country} (${region.slug})`])),
    osPrices: catalog.os.filter(os => os.family !== "windows" || supportsWindows(size)).map(os => ({ os: os.key, label: os.name, family: os.family, price: null })),
    priceMatrix: [], enabled: true, catalogManaged: true,
  })));
}

export function planPrice(plan: Pick<VpsUiPlan, "osPrices" | "priceMatrix" | "catalogManaged" | "globalPrice">, region: string, os: string): number | undefined {
  if (!plan.osPrices.some(item => item.os === os)) return undefined;
  const amount = plan.priceMatrix?.find(item => item.region === region && item.os === os)?.price
    ?? (plan.catalogManaged ? undefined : plan.osPrices.find(item => item.os === os)?.price) ?? plan.globalPrice;
  return typeof amount === "number" && Number.isSafeInteger(amount) && amount > 0 ? amount : undefined;
}

export function mergeCatalogPrices(plan: VpsUiPlan, saved?: Pick<VpsUiPlan, "enabled" | "priceMatrix" | "globalPrice">): VpsUiPlan {
  return { ...plan, globalPrice: saved?.globalPrice ?? null, enabled: saved?.enabled ?? true, priceMatrix: (saved?.priceMatrix ?? [])
    .filter(item => plan.regions.includes(item.region) && plan.osPrices.some(os => os.os === item.os)) };
}
