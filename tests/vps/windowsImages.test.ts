import assert from "node:assert/strict";
import test from "node:test";
import { InstallerError } from "../../src/vps/installer.js";
import { resolveWindowsDdImage, validateWindowsImageUrl, type WindowsBootMode } from "../../src/vps/windowsImages.js";

const expected: ReadonlyArray<readonly [string, WindowsBootMode, string]> = [
  ["windows2012r2", "bios", "en_win2012r2.xz"],
  ["windows2012r2", "efi", "en_win2012r2_uefi.xz"],
  ["windows2016", "bios", "en_win2016.xz"],
  ["windows2016", "efi", "en_win2016_uefi.xz"],
  ["windows2019", "bios", "en_win2019.xz"],
  ["windows2019", "efi", "en_win2019_uefi.xz"],
  ["windows2022", "bios", "en-us_win2022.xz"],
  ["windows2022", "efi", "en-us_win2022_uefi.xz"],
];

test("Windows DD resolver maps every supported OS and boot mode", () => {
  for (const [os, mode, filename] of expected) {
    const resolved = resolveWindowsDdImage(os, mode, {});
    assert.equal(new URL(resolved).pathname.split("/").at(-1), filename);
  }
});

test("Windows DD resolver honors the selected mirror without reusing another mode", () => {
  const env = {
    VPS_WIN2019_BIOS_URL: "https://r2.example.test/windows-2019-bios.xz?version=1&source=bot",
    VPS_WIN2019_EFI_URL: "https://r2.example.test/windows-2019-efi.xz?version=2&source=bot",
  };
  assert.equal(resolveWindowsDdImage("windows2019", "bios", env), env.VPS_WIN2019_BIOS_URL);
  assert.equal(resolveWindowsDdImage("windows2019", "efi", env), env.VPS_WIN2019_EFI_URL);
});

test("Windows image URLs reject invalid protocols, empty values, controls, and shell payloads", () => {
  for (const value of [
    "", "ftp://example.test/windows.xz", "https://", "https://example.test/image.xz\nwhoami",
    "https://example.test/$(whoami).xz", "https://example.test/image.xz;reboot", "https://user:secret@example.test/image.xz",
  ]) {
    assert.throws(() => validateWindowsImageUrl(value), InstallerError, value);
  }
  assert.throws(() => resolveWindowsDdImage("windows2019", "efi", { VPS_WIN2019_EFI_URL: "" }), InstallerError);
  assert.throws(() => resolveWindowsDdImage("windows2030", "efi", {}), InstallerError);
});

