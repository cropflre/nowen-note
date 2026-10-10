/** 原生照片提供者可能不给 MIME；只以实际文件头修正类型，扩展名不代替解码校验。 */
export async function resolvePhotoUploadMime(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.slice(0, 128).arrayBuffer());
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return "image/png";
  const text = (offset: number) => String.fromCharCode(...bytes.slice(offset, offset + 4));
  if (bytes.length >= 16 && text(4) === "ftyp") {
    const size = new DataView(bytes.buffer).getUint32(0);
    const brands = [text(8)];
    if (size >= 16 && size <= bytes.length && size % 4 === 0) {
      for (let at = 16; at + 4 <= size; at += 4) brands.push(text(at));
      if (!brands.some((brand) => brand === "avif" || brand === "avis")) {
        if (brands.some((brand) => /^(?:hei[cxms]|hev[cxms])$/.test(brand))) return "image/heic";
        if (brands.includes("mif1") || brands.includes("msf1")) return "image/heif";
      }
    }
    if (brands[0] === "qt  ") return "video/quicktime";
  }
  return file.type || "application/octet-stream";
}
