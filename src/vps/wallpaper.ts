import { BotConfig } from "../models/BotConfig.js";
import { getWallpaperJpegBase64 } from "./installer.js";

export const MAX_VPS_WALLPAPER_BYTES = 4 * 1024 * 1024;

function decodeStoredJpeg(value: string): Buffer | null {
  const normalized = value.trim();
  if (!normalized || normalized.length > Math.ceil(MAX_VPS_WALLPAPER_BYTES * 4 / 3) + 8) return null;
  if (normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) return null;
  const buffer = Buffer.from(normalized, "base64");
  if (!buffer.length || buffer.length > MAX_VPS_WALLPAPER_BYTES) return null;
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[2] !== 0xff) return null;
  return buffer;
}

export function encodeVpsWallpaperJpeg(buffer: Buffer): string {
  if (!buffer.length || buffer.length > MAX_VPS_WALLPAPER_BYTES) throw new Error("Wallpaper file size is invalid.");
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[2] !== 0xff) throw new Error("Wallpaper must be a JPEG photo.");
  return buffer.toString("base64");
}

export async function setVpsWallpaperJpeg(buffer: Buffer): Promise<{ bytes: number; updatedAt: Date }> {
  const base64 = encodeVpsWallpaperJpeg(buffer);
  const config = await BotConfig.getOrCreate();
  const updatedAt = new Date();
  config.vpsWallpaperBase64 = base64;
  config.vpsWallpaperUpdatedAt = updatedAt;
  await config.save();
  return { bytes: buffer.length, updatedAt };
}

export async function resetVpsWallpaper(): Promise<void> {
  const config = await BotConfig.getOrCreate();
  config.vpsWallpaperBase64 = "";
  config.vpsWallpaperUpdatedAt = null;
  await config.save();
}

export async function getVpsWallpaperStatus(): Promise<{ custom: boolean; bytes: number; updatedAt: Date | null }> {
  const config = await BotConfig.getOrCreate();
  const decoded = decodeStoredJpeg(config.vpsWallpaperBase64 || "");
  return {
    custom: Boolean(decoded),
    bytes: decoded?.length ?? 0,
    updatedAt: config.vpsWallpaperUpdatedAt ?? null,
  };
}

export async function resolveVpsWallpaperBase64(): Promise<string | null> {
  const config = await BotConfig.getOrCreate();
  const custom = decodeStoredJpeg(config.vpsWallpaperBase64 || "");
  if (custom) return custom.toString("base64");
  return getWallpaperJpegBase64();
}
