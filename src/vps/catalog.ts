import { VpsCatalog } from "../models/VpsCatalog.js";
import { registerOs } from "./installer.js";

export const DEFAULT_REGIONS = [
  ["nyc1", "New York 1", "USA"], ["nyc2", "New York 2", "USA"], ["nyc3", "New York 3", "USA"], ["ams3", "Amsterdam", "Netherlands"],
  ["sfo2", "San Francisco 2", "USA"], ["sfo3", "San Francisco 3", "USA"], ["sgp1", "Singapore", "Singapore"], ["lon1", "London", "United Kingdom"],
  ["fra1", "Frankfurt", "Germany"], ["tor1", "Toronto", "Canada"], ["blr1", "Bangalore", "India"], ["syd1", "Sydney", "Australia"],
  ["atl1", "Atlanta", "USA"], ["ric1", "Richmond", "USA"], ["mkc1", "Kansas City", "USA"], ["mem1", "Memphis", "USA"],
] as const;
export const DEFAULT_SIZES = [
  ["512mb", "s-1vcpu-512mb-10gb", 1, "512 MB", "10 GB", "500 GB", "$4/month"], ["1gb", "s-1vcpu-1gb", 1, "1 GB", "25 GB", "1 TB", "$6/month"],
  ["2gb", "s-1vcpu-2gb", 1, "2 GB", "50 GB", "2 TB", "$12/month"], ["2cpu-2gb", "s-2vcpu-2gb", 2, "2 GB", "60 GB", "3 TB", "$18/month"],
  ["2cpu-4gb", "s-2vcpu-4gb", 2, "4 GB", "80 GB", "4 TB", "$24/month"], ["4cpu-8gb", "s-4vcpu-8gb", 4, "8 GB", "160 GB", "5 TB", "$48/month"],
  ["8cpu-16gb", "s-8vcpu-16gb", 8, "16 GB", "320 GB", "6 TB", "$96/month"],
] as const;
export const DEFAULT_OS = [
  ["ubuntu22", "Ubuntu 22.04 LTS", "ubuntu-22-04-x64", "linux"], ["ubuntu24", "Ubuntu 24.04 LTS", "ubuntu-24-04-x64", "linux"], ["ubuntu26", "Ubuntu 26.04 LTS", "ubuntu-26-04-x64", "linux"],
  ["debian13", "Debian 13", "debian-13-x64", "linux"], ["almalinux8", "AlmaLinux 8", "almalinux-8-x64", "linux"], ["almalinux9", "AlmaLinux 9", "almalinux-9-x64", "linux"], ["almalinux10", "AlmaLinux 10", "almalinux-10-x64", "linux"],
  ["rocky8", "Rocky Linux 8", "rockylinux-8-x64", "linux"], ["rocky9", "Rocky Linux 9", "rockylinux-9-x64", "linux"], ["rocky10", "Rocky Linux 10", "rockylinux-10-x64", "linux"],
  ["centos9", "CentOS Stream 9", "centos-stream-9-x64", "linux"], ["centos10", "CentOS Stream 10", "centos-stream-10-x64", "linux"], ["fedora43", "Fedora 43", "fedora-43-x64", "linux"], ["fedora44", "Fedora 44", "fedora-44-x64", "linux"],
  ["windows2012r2", "Windows Server 2012 R2", "ubuntu-24-04-x64", "windows"], ["windows2016", "Windows Server 2016", "ubuntu-24-04-x64", "windows"], ["windows2019", "Windows Server 2019", "ubuntu-24-04-x64", "windows"], ["windows2022", "Windows Server 2022", "ubuntu-24-04-x64", "windows"],
] as const;

export interface VpsCatalogData {
  _id: string;
  regions: { slug: string; name: string; country: string }[];
  sizes: { slug: string; cpu: number; ram: string; disk: string; transfer: string; price: string }[];
  os: { key: string; name: string; slug: string; family: "linux" | "windows"; installerImage?: string | null; windowsImageName?: string | null }[];
}
export function defaultVpsCatalog(): VpsCatalogData {
  return { _id: "platform", regions: DEFAULT_REGIONS.map(([slug, name, country]) => ({ slug, name, country })),
    sizes: DEFAULT_SIZES.map(([, slug, cpu, ram, disk, transfer, price]) => ({ slug, cpu, ram, disk, transfer, price })),
    os: DEFAULT_OS.map(([key, name, slug, family]) => ({ key, name, slug, family, installerImage: slug,
      windowsImageName: family === "windows" ? `${name} ServerStandard` : null })) };
}

export async function getVpsCatalog(): Promise<VpsCatalogData> {
  const catalog = await VpsCatalog.findById("platform").lean() ?? defaultVpsCatalog();
  for (const entry of catalog.os) registerOs({ key: entry.key, name: entry.name, family: entry.family, image: entry.installerImage ?? "", ...(entry.windowsImageName ? { windowsImageName: entry.windowsImageName } : {}) });
  return catalog;
}
