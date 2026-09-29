import { sniffHeifMime } from "./heif-mime";

export interface MediaAnalysis {
  version: 1;
  mimeType: string;
  kind: "image" | "heif" | "live-photo" | "motion-photo" | "video" | "file";
  assetIdentifier?: string;
  motion?: { offset: number; length: number };
}

interface Box { type: string; start: number; data: number; end: number }

/** 只遍历真实容器边界，拒绝越界、截断及不安全的 64 位长度。 */
function boxes(bytes: Buffer, start = 0, end = bytes.length): Box[] {
  const result: Box[] = [];
  while (start + 8 <= end && result.length < 10000) {
    let size = bytes.readUInt32BE(start);
    let header = 8;
    if (size === 1) {
      if (start + 16 > end) return [];
      size = Number(bytes.readBigUInt64BE(start + 8));
      header = 16;
    } else if (size === 0) size = end - start;
    if (!Number.isSafeInteger(size) || size < header || start + size > end) return [];
    result.push({ type: bytes.toString("ascii", start + 4, start + 8), start, data: start + header, end: start + size });
    start += size;
  }
  return start === end ? result : [];
}

function videoMime(bytes: Buffer): string | null {
  if (bytes.length < 16 || bytes.toString("ascii", 4, 8) !== "ftyp") return null;
  const brand = bytes.toString("ascii", 8, 12);
  if (!/^(qt  |isom|iso[2-9]|mp4[12]|M4V |MSNV|avc1|3gp\w)$/.test(brand)) return null;
  const entries = boxes(bytes);
  if (!entries.some((box) => box.type === "moov") || !entries.some((box) => box.type === "mdat")) return null;
  return brand === "qt  " ? "video/quicktime" : "video/mp4";
}

function validIdentifier(value: string): string | undefined {
  const cleaned = value.replace(/\0+$/, "").trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleaned)
    ? cleaned.toLowerCase() : undefined;
}

/** Apple MakerNote 的 0x11 与 QuickTime content.identifier 对应。 */
function applePhotoIdentifier(bytes: Buffer): string | undefined {
  const base = bytes.indexOf(Buffer.from("Apple iOS\0", "ascii"));
  if (base < 0 || base + 16 > bytes.length) return;
  const order = bytes.toString("ascii", base + 12, base + 14);
  if (order !== "MM" && order !== "II") return;
  const u16 = (at: number) => order === "MM" ? bytes.readUInt16BE(at) : bytes.readUInt16LE(at);
  const u32 = (at: number) => order === "MM" ? bytes.readUInt32BE(at) : bytes.readUInt32LE(at);
  const count = u16(base + 14);
  if (count > 1024 || base + 16 + count * 12 > bytes.length) return;
  for (let i = 0; i < count; i++) {
    const at = base + 16 + i * 12;
    if (u16(at) !== 0x11 || u16(at + 2) !== 2) continue;
    const length = u32(at + 4);
    const value = base + u32(at + 8);
    if (length < 36 || length > 128 || value < base || value + length > bytes.length) return;
    return validIdentifier(bytes.toString("utf8", value, value + length));
  }
}

function appleVideoIdentifier(bytes: Buffer): string | undefined {
  const visit = (start: number, end: number, depth: number): string | undefined => {
    if (depth > 6) return;
    const entries = boxes(bytes, start, end);
    const keys = entries.find((box) => box.type === "keys");
    const ilst = entries.find((box) => box.type === "ilst");
    if (keys && ilst && keys.data + 8 <= keys.end) {
      const count = bytes.readUInt32BE(keys.data + 4);
      let at = keys.data + 8;
      for (let index = 1; index <= Math.min(count, 1024) && at + 8 <= keys.end; index++) {
        const length = bytes.readUInt32BE(at);
        if (length < 8 || at + length > keys.end) break;
        const name = bytes.toString("utf8", at + 8, at + length);
        if (name === "com.apple.quicktime.content.identifier") {
          const entry = boxes(bytes, ilst.data, ilst.end).find((box) => bytes.readUInt32BE(box.start + 4) === index);
          const data = entry && boxes(bytes, entry.data, entry.end).find((box) => box.type === "data");
          if (data && data.data + 8 <= data.end) return validIdentifier(bytes.toString("utf8", data.data + 8, data.end));
        }
        at += length;
      }
    }
    for (const box of entries) {
      if (!["moov", "udta", "meta"].includes(box.type)) continue;
      const value = visit(box.data + (box.type === "meta" ? 4 : 0), box.end, depth + 1);
      if (value) return value;
    }
  };
  return visit(0, bytes.length, 0);
}

function xmpPackets(bytes: Buffer): string[] {
  const result: string[] = [];
  let at = 0;
  while (result.length < 8) {
    const word = bytes.indexOf(Buffer.from("xmpmeta"), at);
    if (word < 0) break;
    at = word + 7;
    const start = bytes.lastIndexOf(0x3c, word);
    if (start < 0 || word - start > 64) continue;
    const tag = bytes.toString("ascii", start + 1, word + 7);
    if (!/^(?:\w+:)?xmpmeta$/.test(tag)) continue;
    const closing = Buffer.from(`</${tag}>`);
    const end = bytes.indexOf(closing, at);
    if (end < 0 || end - start > 1024 * 1024) continue;
    result.push(bytes.toString("utf8", start, end + closing.length));
    at = end + closing.length;
  }
  return result;
}

function property(xml: string, prefixes: string[], name: string): string | undefined {
  for (const prefix of prefixes) {
    const tag = `${prefix}:${name}`;
    const attribute = xml.match(new RegExp(`\\b${tag}\\s*=\\s*["']([^"']*)["']`));
    const element = xml.match(new RegExp(`<${tag}\\b[^>]*>\\s*([^<]*)\\s*</${tag}>`));
    if (attribute || element) return (attribute?.[1] || element?.[1] || "").trim();
  }
}

function namespacePrefixes(xml: string, uri: string): string[] {
  return [...xml.matchAll(/xmlns:([\w]+)\s*=\s*["']([^"']+)["']/g)]
    .filter((match) => match[2] === uri).map((match) => match[1]);
}

function samsungMotion(bytes: Buffer): MediaAnalysis["motion"] {
  if (bytes.length < 20 || bytes.toString("ascii", bytes.length - 4) !== "SEFT") return;
  const length = bytes.readUInt32LE(bytes.length - 8);
  const dir = bytes.length - 8 - length;
  if (length < 12 || length > 65536 || dir < 0 || bytes.toString("ascii", dir, dir + 4) !== "SEFH") return;
  const count = bytes.readUInt32LE(dir + 8);
  if (12 + count * 12 > length) return;
  for (let i = 0; i < count; i++) {
    const entry = dir + 12 + i * 12;
    if (bytes.readUInt16LE(entry + 2) !== 0x0a30) continue;
    const offset = dir - bytes.readUInt32LE(entry + 4);
    const size = bytes.readUInt32LE(entry + 8);
    if (offset < 0 || size < 8 || offset + size > dir) continue;
    const nameLength = bytes.readUInt32LE(offset + 4);
    if (nameLength > size - 8 || bytes.toString("utf8", offset + 8, offset + 8 + nameLength) !== "MotionPhoto_Data") continue;
    let videoOffset = offset + 8 + nameLength;
    let videoLength = size - 8 - nameLength;
    if (videoLength === 12 && bytes.toString("ascii", videoOffset, videoOffset + 4) === "mpv2") {
      videoLength = bytes.readUInt32BE(videoOffset + 8);
      videoOffset = bytes.readUInt32BE(videoOffset + 4);
    }
    if (videoOffset >= 0 && videoLength > 0 && videoOffset + videoLength <= bytes.length
      && videoMime(bytes.subarray(videoOffset, videoOffset + videoLength))) return { offset: videoOffset, length: videoLength };
  }
}

export function analyzeModernMedia(bytes: Buffer, declaredMime = ""): MediaAnalysis {
  const heif = sniffHeifMime(bytes);
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const video = !heif && videoMime(bytes);
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const mimeType = heif || (jpeg ? "image/jpeg" : png ? "image/png" : video) || declaredMime || "application/octet-stream";
  const analysis: MediaAnalysis = { version: 1, mimeType, kind: heif ? "heif" : mimeType.startsWith("image/") ? "image" : video ? "video" : "file" };
  if (video) {
    analysis.assetIdentifier = appleVideoIdentifier(bytes);
    return analysis;
  }
  if (!jpeg && !heif) return analysis;
  analysis.assetIdentifier = applePhotoIdentifier(bytes);
  if (analysis.assetIdentifier) analysis.kind = "live-photo";
  const packets = xmpPackets(bytes);
  const cameras = packets.map((xml) => ({ xml, prefixes: namespacePrefixes(xml, "http://ns.google.com/photos/1.0/camera/") }));
  // 明确的 MotionPhoto=0 优先于旧偏移或厂商尾部标记。
  if (cameras.some(({ xml, prefixes }) => property(xml, prefixes, "MotionPhoto") === "0")) return analysis;
  for (const { xml, prefixes } of cameras) {
    const flag = property(xml, prefixes, "MotionPhoto");
    if (flag === "1") {
      const itemPrefixes = namespacePrefixes(xml, "http://ns.google.com/photos/1.0/container/item/");
      const items = [...xml.matchAll(/<(?:[\w]+:)?Item\b[^>]*(?:\/>|>[\s\S]*?<\/(?:[\w]+:)?Item>)/g)].map((match) => match[0]);
      const motion = items.filter((item) => property(item, itemPrefixes, "Semantic") === "MotionPhoto");
      const last = items.at(-1);
      const value = motion.length === 1 && motion[0] === last ? property(last, itemPrefixes, "Length") : undefined;
      const length = value && /^\d+$/.test(value) ? Number(value) : NaN;
      if (Number.isSafeInteger(length) && length > 0 && length < bytes.length && videoMime(bytes.subarray(bytes.length - length))) {
        analysis.motion = { offset: bytes.length - length, length };
        break;
      }
    } else if (flag === undefined && property(xml, prefixes, "MicroVideo") === "1") {
      const value = property(xml, prefixes, "MicroVideoOffset");
      const length = value && /^\d+$/.test(value) ? Number(value) : NaN;
      if (Number.isSafeInteger(length) && length > 0 && length < bytes.length && videoMime(bytes.subarray(bytes.length - length))) {
        analysis.motion = { offset: bytes.length - length, length };
        break;
      }
    }
  }
  analysis.motion ??= samsungMotion(bytes);
  if (!analysis.motion && heif) {
    const last = boxes(bytes).at(-1);
    if (last?.type === "mpvd" && videoMime(bytes.subarray(last.data, last.end))) analysis.motion = { offset: last.data, length: last.end - last.data };
  }
  if (analysis.motion) analysis.kind = "motion-photo";
  return analysis;
}
