import { sniffRemoteImageMime } from "./remote-image-security";

const MAX_IMAGE_BYTES = 1024 * 1024;

export async function normalizeShareBannerImage(value: unknown): Promise<string> {
  if (value === "") return "";
  if (typeof value !== "string" || value.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 40) {
    throw new Error("横幅图片超过大小限制");
  }
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) throw new Error("横幅只支持 PNG、JPEG 或 WebP 图片");
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || bytes.toString("base64") !== match[2]
    || sniffRemoteImageMime(bytes) !== match[1]) {
    throw new Error("横幅图片格式无效");
  }
  // 重新解码并编码为固定横幅，拒绝损坏图片和超大像素输入，去除原始元数据。
  const { default: sharp } = await import("sharp");
  const output = await sharp(bytes, { limitInputPixels: 16_000_000 })
    .rotate().resize(1600, 400, { fit: "cover" }).flatten({ background: "#ffffff" }).jpeg({ quality: 82 }).toBuffer();
  return `data:image/jpeg;base64,${output.toString("base64")}`;
}
