const HEIF_MIMES = new Set([
  "image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence",
]);
const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs"]);

export function isHeifMime(mime: string | null | undefined): boolean {
  return HEIF_MIMES.has((mime || "").toLowerCase().split(";")[0].trim());
}

/** 检查 ISO BMFF 的 ftyp 品牌；AVIF 使用同一容器，不能误判为 HEIC。 */
export function sniffHeifMime(buffer: Buffer): string | null {
  if (buffer.length < 16 || buffer.toString("ascii", 4, 8) !== "ftyp") return null;
  const boxSize = buffer.readUInt32BE(0);
  if (boxSize < 16 || boxSize > buffer.length || boxSize % 4 !== 0) return null;
  const brands = [buffer.toString("ascii", 8, 12)];
  for (let offset = 16; offset < boxSize; offset += 4) {
    brands.push(buffer.toString("ascii", offset, offset + 4));
  }
  if (brands.some((brand) => brand === "avif" || brand === "avis")) return null;
  if (brands.some((brand) => HEIC_BRANDS.has(brand))) return "image/heic";
  if (brands.some((brand) => brand === "mif1" || brand === "msf1")) return "image/heif";
  return null;
}

/** 只补全本次兼容的格式，其他类型继续使用既有上传校验。 */
export function resolveHeifUploadMime(buffer: Buffer, declaredMime: string): string {
  return sniffHeifMime(buffer) || (declaredMime || "application/octet-stream").toLowerCase();
}
