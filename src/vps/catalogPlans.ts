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

/** Price records are separate from choices: missing prices must not hide catalog options. */
export function catalogPlans(catalog: PlanCatalog, serviceType?: VpsServiceType): VpsUiPlan[] {
  const services: VpsServiceType[] = serviceType ? [serviceType] : ["purchase", "install"];
  return services.flatMap(service => catalog.sizes.map(size => ({
    id: catalogPlanId(service, size.slug), name: `${size.cpu} vCPU · ${size.ram}`, serviceType: service,
    sizeSlug: size.slug, sizeLabel: `${size.cpu} vCPU · ${size.ram} RAM · ${size.disk} SSD`,
    providerPrice: size.price, transfer: size.transfer,
    regions: catalog.regions.map(region => region.slug),
    regionLabels: Object.fromEntries(catalog.regions.map(region => [region.slug, `${region.name}, ${region.country} (${region.slug})`])),
    osPrices: catalog.os.map(os => ({ os: os.key, label: os.name, family: os.family, price: null })),
    priceMatrix: [], enabled: true, catalogManaged: true,
  })));
}

export function planPrice(plan: Pick<VpsUiPlan, "osPrices" | "priceMatrix" | "catalogManaged">, region: string, os: string): number | undefined {
  const amount = plan.priceMatrix?.find(item => item.region === region && item.os === os)?.price
    ?? (plan.catalogManaged ? undefined : plan.osPrices.find(item => item.os === os)?.price);
  return typeof amount === "number" && Number.isSafeInteger(amount) && amount > 0 ? amount : undefined;
}

export function mergeCatalogPrices(plan: VpsUiPlan, saved?: Pick<VpsUiPlan, "enabled" | "priceMatrix">): VpsUiPlan {
  return { ...plan, enabled: saved?.enabled ?? true, priceMatrix: (saved?.priceMatrix ?? [])
    .filter(item => plan.regions.includes(item.region) && plan.osPrices.some(os => os.os === item.os)) };
}
