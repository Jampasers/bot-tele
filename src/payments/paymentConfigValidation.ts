/** Validate the static payload before storing it; never accept an arbitrary URL/path. */
export function validateTenantQrisPayload(payload: string): void {
  const invalid = () => new Error("QRIS payload tidak valid (struktur, negara, mata uang, atau CRC).");
  if (!/^[\x20-\x7e]{20,8192}$/.test(payload)) throw invalid();
  const fields = new Map<string, string>();
  let cursor = 0;
  while (cursor < payload.length) {
    const header = payload.slice(cursor, cursor + 4);
    if (!/^\d{4}$/.test(header)) throw invalid();
    const id = header.slice(0, 2);
    const length = Number(header.slice(2));
    const end = cursor + 4 + length;
    if (!length || end > payload.length || fields.has(id)) throw invalid();
    fields.set(id, payload.slice(cursor + 4, end));
    if (id === "63" && end !== payload.length) throw invalid();
    cursor = end;
  }
  if (fields.get("00") !== "01" || !["11", "12"].includes(fields.get("01") ?? "") ||
      fields.get("53") !== "360" || fields.get("58") !== "ID" ||
      !Array.from(fields.keys()).some((id) => Number(id) >= 26 && Number(id) <= 51) ||
      !/^6304[A-F\d]{4}$/i.test(payload.slice(-8))) throw invalid();
  let crc = 0xffff;
  for (const char of payload.slice(0, -4)) {
    crc ^= char.charCodeAt(0) << 8;
    for (let bit = 0; bit < 8; bit++) crc = ((crc & 0x8000) ? (crc << 1) ^ 0x1021 : crc << 1) & 0xffff;
  }
  if (crc.toString(16).padStart(4, "0").toUpperCase() !== payload.slice(-4).toUpperCase()) throw invalid();
}

/** Reject decompression bombs before passing renter-supplied images to a decoder. */
export function validateTenantQrisImage(buffer: Buffer): void {
  const checkDimensions = (width: number, height: number) => {
    if (width < 1 || height < 1 || width > 4096 || height > 4096 || width * height > 4_000_000) {
      throw new Error("Ukuran gambar QRIS melebihi batas 4 megapiksel / 4096 piksel per sisi.");
    }
  };
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    checkDimensions(buffer.readUInt32BE(16), buffer.readUInt32BE(20));
    return;
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let cursor = 2;
    while (cursor + 4 <= buffer.length) {
      if (buffer[cursor] !== 0xff) break;
      const marker = buffer[cursor + 1]!;
      const length = buffer.readUInt16BE(cursor + 2);
      if (length < 2 || cursor + 2 + length > buffer.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (length < 7) break;
        checkDimensions(buffer.readUInt16BE(cursor + 7), buffer.readUInt16BE(cursor + 5));
        return;
      }
      cursor += length + 2;
    }
  }
  throw new Error("Gambar QRIS harus PNG/JPEG dengan dimensi valid.");
}
