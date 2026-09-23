import { InstallerError } from "./installerError.js";

export type WindowsBootMode = "bios" | "efi";

export interface WindowsDdImage {
  bios: string;
  efi: string;
}

type WindowsDdOs = "windows2012r2" | "windows2016" | "windows2019" | "windows2022";

interface WindowsImageDefinition extends WindowsDdImage {
  env: Readonly<Record<WindowsBootMode, string>>;
}

const WINDOWS_DD_IMAGES: Readonly<Record<WindowsDdOs, WindowsImageDefinition>> = Object.freeze({
  windows2012r2: {
    bios: "https://dl.lamp.sh/vhd/en_win2012r2.xz",
    efi: "https://dl.lamp.sh/vhd/en_win2012r2_uefi.xz",
    env: { bios: "VPS_WIN2012R2_BIOS_URL", efi: "VPS_WIN2012R2_EFI_URL" },
  },
  windows2016: {
    bios: "https://dl.lamp.sh/vhd/en_win2016.xz",
    efi: "https://dl.lamp.sh/vhd/en_win2016_uefi.xz",
    env: { bios: "VPS_WIN2016_BIOS_URL", efi: "VPS_WIN2016_EFI_URL" },
  },
  windows2019: {
    bios: "https://dl.lamp.sh/vhd/en_win2019.xz",
    efi: "https://dl.lamp.sh/vhd/en_win2019_uefi.xz",
    env: { bios: "VPS_WIN2019_BIOS_URL", efi: "VPS_WIN2019_EFI_URL" },
  },
  windows2022: {
    bios: "https://dl.lamp.sh/vhd/en-us_win2022.xz",
    efi: "https://dl.lamp.sh/vhd/en-us_win2022_uefi.xz",
    env: { bios: "VPS_WIN2022_BIOS_URL", efi: "VPS_WIN2022_EFI_URL" },
  },
});

function isWindowsDdOs(value: string): value is WindowsDdOs {
  return Object.hasOwn(WINDOWS_DD_IMAGES, value);
}

/** Reject input that URL parsers normalize away or that could obscure shell intent. */
export function validateWindowsImageUrl(value: string): string {
  if (!value || value !== value.trim() || value.length > 2048 || /[\u0000-\u0020\u007f`$;|<>\\]/.test(value)) {
    throw new InstallerError("validation");
  }
  try {
    const parsed = new URL(value);
    if (!(["http:", "https:"] as string[]).includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) {
      throw new InstallerError("validation");
    }
  } catch (error) {
    if (error instanceof InstallerError) throw error;
    throw new InstallerError("validation");
  }
  return value;
}

export function resolveWindowsDdImage(
  os: string,
  bootMode: WindowsBootMode,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!isWindowsDdOs(os) || (bootMode !== "bios" && bootMode !== "efi")) throw new InstallerError("validation");
  const definition = WINDOWS_DD_IMAGES[os];
  const envName = definition.env[bootMode];
  return validateWindowsImageUrl(env[envName] === undefined ? definition[bootMode] : env[envName]!);
}
