import QRCode from "qrcode";
import { readQrCodeImage } from "./qr-reader.js";

export type QrisImage = string | Uint8Array;

export interface QrisGeneratorOptions {
  qrisImage?: QrisImage;
  qrisPayload?: string;
  qrisStaticPayload?: string | Promise<string>;
  render?: (payload: string) => Promise<string>;
}

export class QrisGenerator {
  private readonly render: (payload: string) => Promise<string>;
  private staticPayloadPromise?: Promise<string>;

  public constructor(private readonly options: QrisGeneratorOptions) {
    this.render = options.render ?? renderQris;

    if (options.qrisStaticPayload !== undefined) {
      this.staticPayloadPromise = Promise.resolve(options.qrisStaticPayload);
    } else if (options.qrisPayload !== undefined) {
      this.staticPayloadPromise = Promise.resolve(options.qrisPayload);
    } else if (options.qrisImage !== undefined) {
      this.staticPayloadPromise = readQrCodeImage(options.qrisImage);
    }
  }

  public async generate(amount: number): Promise<string> {
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new Error("Nominal QRIS harus angka bulat dan lebih dari 0.");
    }

    if (!this.staticPayloadPromise) {
      throw new Error("Konfigurasi QRIS static payload atau qrisImage tidak ditemukan.");
    }

    const staticPayload = await this.staticPayloadPromise;
    if (!staticPayload || !staticPayload.trim()) {
      throw new Error("QRIS static payload tidak terkonfigurasi atau tidak valid.");
    }

    const dynamicPayload = createDynamicPayload(staticPayload.trim(), amount);
    return this.render(dynamicPayload);
  }
}

function createDynamicPayload(staticPayload: string, amount: number): string {
  const withoutCrc = stripCrc(staticPayload).replace("010211", "010212");
  const countryIndex = withoutCrc.indexOf("5802");
  if (countryIndex === -1) {
    throw new Error("QRIS static payload tidak valid.");
  }

  const payload = removeTopLevelTag(withoutCrc, "54");
  const amountText = amount.toString();
  const amountTag = `54${amountText.length.toString().padStart(2, "0")}${amountText}`;
  const insertAt = payload.indexOf("5802");
  const crcInput = `${payload.slice(0, insertAt)}${amountTag}${payload.slice(insertAt)}6304`;
  return `${crcInput}${crc16(crcInput)}`;
}

function stripCrc(payload: string): string {
  const index = payload.lastIndexOf("6304");
  return index === -1 ? payload : payload.slice(0, index);
}

function removeTopLevelTag(payload: string, tagId: string): string {
  let cursor = 0;
  let result = "";

  while (cursor + 4 <= payload.length) {
    const id = payload.slice(cursor, cursor + 2);
    const length = Number.parseInt(payload.slice(cursor + 2, cursor + 4), 10);
    const end = cursor + 4 + length;
    if (!Number.isInteger(length) || length < 0 || end > payload.length) {
      throw new Error("QRIS static payload tidak valid.");
    }

    if (id !== tagId) result += payload.slice(cursor, end);
    cursor = end;
  }

  if (cursor !== payload.length) {
    throw new Error("QRIS static payload tidak valid.");
  }
  return result;
}

function crc16(value: string): string {
  let crc = 0xffff;
  for (const character of value) {
    crc ^= character.charCodeAt(0) << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) !== 0 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

async function renderQris(payload: string): Promise<string> {
  return QRCode.toDataURL(payload, {
    errorCorrectionLevel: "M",
    margin: 2,
    type: "image/png",
    width: 512,
  });
}
