import net from "node:net";

export const REMOTE_IMAGE_MIME_TO_EXT: Readonly<Record<string, string>> = Object.freeze({
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
});

const MIME_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  "image/jpg": "image/jpeg",
  "image/pjpeg": "image/jpeg",
  "image/ico": "image/x-icon",
  "image/vnd.microsoft.icon": "image/x-icon",
});

const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home"];

export function normalizeRemoteImageMime(value: unknown): string {
  const raw = String(value || "").toLowerCase().split(";", 1)[0].trim();
  return MIME_ALIASES[raw] || raw;
}

function parseIpv4(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((part) => Number(part));
  if (nums.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return nums;
}

function isBlockedIpv4(address: string): boolean {
  const parts = parseIpv4(address);
  if (!parts) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && (b === 0 || b === 168)) return true;
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return true;
  if (a === 203 && b === 0) return true;
  if (a >= 224) return true;
  return false;
}

function firstIpv6Hextet(address: string): number | null {
  const first = address.split(":", 1)[0];
  if (!first) return 0;
  const value = Number.parseInt(first, 16);
  return Number.isFinite(value) ? value : null;
}

function isBlockedIpv6(address: string): boolean {
  const normalized = address.toLowerCase().split("%", 1)[0];
  if (normalized === "::" || normalized === "::1") return true;

  const dottedTail = normalized.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1];
  if (dottedTail && isBlockedIpv4(dottedTail)) return true;

  const first = firstIpv6Hextet(normalized);
  if (first == null) return true;
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  if ((first & 0xff00) === 0xff00) return true; // multicast
  if (normalized.startsWith("2001:db8:")) return true; // documentation range
  return false;
}

/** Reject loopback, private, link-local, multicast and documentation addresses. */
export function isBlockedRemoteAddress(address: string): boolean {
  const normalized = String(address || "").trim().toLowerCase();
  const family = net.isIP(normalized.split("%", 1)[0]);
  if (family === 4) return isBlockedIpv4(normalized);
  if (family === 6) return isBlockedIpv6(normalized);
  return true;
}

/** Cheap hostname guard before DNS resolution. Every resolved address must still be checked. */
export function isBlockedRemoteHostname(hostname: string): boolean {
  const normalized = String(hostname || "").trim().toLowerCase().replace(/\.$/, "");
  if (!normalized) return true;
  if (normalized === "localhost" || normalized === "metadata.google.internal") return true;
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) return true;
  if (net.isIP(normalized)) return isBlockedRemoteAddress(normalized);
  return false;
}

/** Determine the real supported raster image type from magic bytes. SVG is intentionally rejected. */
export function sniffRemoteImageMime(input: Uint8Array): string | null {
  const bytes = input;
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6) {
    const head = Buffer.from(bytes.subarray(0, 6)).toString("ascii");
    if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" &&
    Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP"
  ) return "image/webp";
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return "image/bmp";
  if (bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) return "image/x-icon";
  return null;
}

export function sanitizeRemoteImageFilename(rawName: string, mimeType: string): string {
  const ext = REMOTE_IMAGE_MIME_TO_EXT[normalizeRemoteImageMime(mimeType)] || "img";
  let name = String(rawName || "").replace(/\\/g, "/").split("/").pop() || "";
  try { name = decodeURIComponent(name); } catch { /* keep undecoded */ }
  name = name
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/[.\s]+$/g, "")
    .trim();
  name = name.replace(/\.[a-z0-9]{1,10}$/i, "").trim();
  if (!name) name = "remote-image";
  if (name.length > 100) name = name.slice(0, 100).trim();
  return `${name}.${ext}`;
}
