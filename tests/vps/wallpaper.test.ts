import assert from "node:assert/strict";
import test from "node:test";
import jpeg from "jpeg-js";
import { encodeVpsWallpaperJpeg, MAX_VPS_WALLPAPER_BYTES } from "../../src/vps/wallpaper.js";

const jpegLib = ((jpeg as unknown as { default?: typeof jpeg }).default || jpeg);

test("custom VPS wallpaper accepts Telegram-style JPEG bytes", () => {
  const encoded = jpegLib.encode({
    data: Buffer.from([20, 40, 60, 255]),
    width: 1,
    height: 1,
  }, 90).data;
  const base64 = encodeVpsWallpaperJpeg(encoded);
  assert.deepEqual(Buffer.from(base64, "base64"), encoded);
});

test("custom VPS wallpaper rejects non-JPEG and oversized payloads", () => {
  assert.throws(() => encodeVpsWallpaperJpeg(Buffer.from("not-a-jpeg")), /JPEG/i);
  const oversized = Buffer.alloc(MAX_VPS_WALLPAPER_BYTES + 1);
  oversized[0] = 0xff; oversized[1] = 0xd8; oversized[2] = 0xff;
  assert.throws(() => encodeVpsWallpaperJpeg(oversized), /size/i);
});
