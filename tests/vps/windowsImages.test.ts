import assert from "node:assert/strict";
import test from "node:test";
import { InstallerError } from "../../src/vps/installer.js";
import { resolveWindowsDdImage, resolveWindowsDdImageCandidates, validateWindowsImageUrl, type WindowsBootMode } from "../../src/vps/windowsImages.js";

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


test("Windows DD resolver prioritizes exact override, then fast mirror, then default fallback", () => {
  const env = {
    VPS_WIN2022_EFI_URL: "https://priority.example.test/custom-win2022.zst",
    VPS_WINDOWS_IMAGE_MIRROR_BASE_URL: "https://r2.example.test/windows",
    VPS_WINDOWS_IMAGE_MIRROR_FORMAT: "zst",
  };
  assert.deepEqual(resolveWindowsDdImageCandidates("windows2022", "efi", env), [
    env.VPS_WIN2022_EFI_URL,
    "https://r2.example.test/windows/en-us_win2022_uefi.zst",
    "https://dl.lamp.sh/vhd/en-us_win2022_uefi.xz",
  ]);
  assert.equal(resolveWindowsDdImage("windows2022", "efi", env), env.VPS_WIN2022_EFI_URL);
});

test("Windows fast mirror can use xz when a zst mirror is not available", () => {
  const env = {
    VPS_WINDOWS_IMAGE_MIRROR_BASE_URL: "https://cdn.example.test/vhd/",
    VPS_WINDOWS_IMAGE_MIRROR_FORMAT: "xz",
  };
  assert.equal(resolveWindowsDdImageCandidates("windows2019", "bios", env)[0], "https://cdn.example.test/vhd/en_win2019.xz");
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
  assert.throws(() => resolveWindowsDdImageCandidates("windows2019", "efi", {
    VPS_WINDOWS_IMAGE_MIRROR_BASE_URL: "https://mirror.example.test/vhd",
    VPS_WINDOWS_IMAGE_MIRROR_FORMAT: "zip",
  }), InstallerError);
});

