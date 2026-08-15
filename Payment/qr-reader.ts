import { readFile } from "node:fs/promises";
import jpeg from "jpeg-js";
import jsQR_default from "jsqr";
import { PNG } from "pngjs";

type jsQRFunction = (
  data: Uint8ClampedArray,
  width: number,
  height: number,
  options?: unknown
) => { data: string } | null;

// ESM interop fallback for commonjs default exports
const jsQR = (jsQR_default.default || jsQR_default) as jsQRFunction;

export async function readQrCodeImage(imagePathOrBuffer: string | Uint8Array): Promise<string> {
  const buffer = typeof imagePathOrBuffer === "string"
    ? await readFile(imagePathOrBuffer)
    : Buffer.from(imagePathOrBuffer);

  let width: number;
  let height: number;
  let rgbaData: Uint8ClampedArray;

  // Detect PNG format: 89 50 4E 47 0D 0A 1A 0A
  const isPng =
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a;

  if (isPng) {
    const png = PNG.sync.read(buffer);
    width = png.width;
    height = png.height;
    rgbaData = new Uint8ClampedArray(png.data);
  } else {
    try {
      const decoded = jpeg.decode(buffer);
      width = decoded.width;
      height = decoded.height;
      rgbaData = new Uint8ClampedArray(decoded.data);
    } catch (error) {
      throw new Error(`Gagal membaca format gambar QRIS. Pastikan file berupa PNG atau JPEG valid. Detail: ${(error as Error).message}`);
    }
  }

  const code = jsQR(rgbaData, width, height);
  if (!code || !code.data) {
    throw new Error("QR Code tidak ditemukan dalam gambar QRIS yang diberikan.");
  }

  return code.data;
}
