import path from "node:path";
import JSZip from "jszip";

export const REGISTRY_PACKAGE_LIMITS = Object.freeze({
  compressedBytes: 20 * 1024 * 1024,
  multipartBytes: 21 * 1024 * 1024,
  extractedBytes: 50 * 1024 * 1024,
  files: 500,
  manifestBytes: 128 * 1024,
  compressionRatio: 200,
});

export interface ValidatedRegistryPackage {
  zip: JSZip;
  embeddedManifest: Record<string, unknown>;
  names: string[];
  extractedBytes: number;
}

function normalizeEntryName(name: string): string {
  const normalized = name.replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) throw new Error(`invalid ZIP path: ${name}`);
  const segments = normalized.split("/").filter(Boolean);
  if (segments.includes("..")) throw new Error(`ZIP path traversal rejected: ${name}`);
  return segments.join("/");
}

function isSymlink(file: JSZip.JSZipObject): boolean {
  const permissions = typeof file.unixPermissions === "number" ? file.unixPermissions
    : typeof file.unixPermissions === "string" ? Number.parseInt(file.unixPermissions, 8) : 0;
  return (permissions & 0o170000) === 0o120000;
}

function isForbidden(name: string): boolean {
  const lower = name.toLowerCase();
  const base = path.posix.basename(lower);
  return lower.split("/").includes("node_modules")
    || lower.endsWith(".node")
    || ["install.js", "preinstall", "postinstall", "package-lock.json"].includes(base)
    || /\.(exe|dll|so|dylib|bat|cmd|ps1|sh|com|msi)$/i.test(lower);
}

async function measureEntry(file: JSZip.JSZipObject, total: { value: number }): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let entryBytes = 0;
    let settled = false;
    const stream = file.nodeStream();
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      stream.pause();
      reject(error);
    };
    stream.on("data", (chunk: Buffer) => {
      entryBytes += chunk.byteLength;
      total.value += chunk.byteLength;
      if (entryBytes > REGISTRY_PACKAGE_LIMITS.extractedBytes) fail(new Error(`ZIP entry exceeds 50MB: ${file.name}`));
      else if (total.value > REGISTRY_PACKAGE_LIMITS.extractedBytes) fail(new Error("ZIP extracted size exceeds 50MB"));
    });
    stream.on("error", (error: Error) => fail(error));
    stream.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(entryBytes);
    });
    stream.resume();
  });
}

export async function validateRegistryPackage(bytes: Buffer): Promise<ValidatedRegistryPackage> {
  if (bytes.length === 0 || bytes.length > REGISTRY_PACKAGE_LIMITS.compressedBytes) throw new Error("artifact must be between 1 byte and 20MB");
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: false, createFolders: false });
  const files = Object.values(zip.files).filter((file) => !file.dir);
  if (files.length === 0 || files.length > REGISTRY_PACKAGE_LIMITS.files) throw new Error(`ZIP file count must be between 1 and ${REGISTRY_PACKAGE_LIMITS.files}`);
  const total = { value: 0 };
  let declaredTotal = 0;
  const names: string[] = [];
  for (const file of Object.values(zip.files)) {
    const originalName = (file as JSZip.JSZipObject & { unsafeOriginalName?: string }).unsafeOriginalName || file.name;
    const normalized = normalizeEntryName(originalName);
    if (isSymlink(file)) throw new Error(`ZIP symlink rejected: ${normalized}`);
    if (file.dir) continue;
    if (isForbidden(normalized)) throw new Error(`forbidden ZIP entry: ${normalized}`);
    const archiveData = (file as JSZip.JSZipObject & { _data?: { compressedSize?: number; uncompressedSize?: number } })._data;
    const compressedBytes = Number(archiveData?.compressedSize || 0);
    const declaredBytes = Number(archiveData?.uncompressedSize || 0);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0 || declaredBytes > REGISTRY_PACKAGE_LIMITS.extractedBytes) throw new Error(`ZIP entry declared size rejected: ${normalized}`);
    declaredTotal += declaredBytes;
    if (declaredTotal > REGISTRY_PACKAGE_LIMITS.extractedBytes) throw new Error("ZIP declared extracted size exceeds 50MB");
    if (declaredBytes > 1024 * 1024 && compressedBytes > 0 && declaredBytes / compressedBytes > REGISTRY_PACKAGE_LIMITS.compressionRatio) throw new Error(`ZIP declared compression ratio rejected: ${normalized}`);
    const entryBytes = await measureEntry(file, total);
    if (entryBytes > 1024 * 1024 && compressedBytes > 0 && entryBytes / compressedBytes > REGISTRY_PACKAGE_LIMITS.compressionRatio) throw new Error(`ZIP compression ratio rejected: ${normalized}`);
    names.push(normalized);
  }
  const manifestFile = zip.file("manifest.json");
  if (!manifestFile) throw new Error("root manifest.json is required");
  const manifestBytes = await manifestFile.async("uint8array");
  if (manifestBytes.byteLength > REGISTRY_PACKAGE_LIMITS.manifestBytes) throw new Error("manifest.json exceeds 128KB");
  let embeddedManifest: unknown;
  try {
    embeddedManifest = JSON.parse(Buffer.from(manifestBytes).toString("utf8"));
  } catch {
    throw new Error("embedded manifest.json is invalid JSON");
  }
  if (!embeddedManifest || typeof embeddedManifest !== "object" || Array.isArray(embeddedManifest)) throw new Error("embedded manifest.json must be an object");
  return { zip, embeddedManifest: embeddedManifest as Record<string, unknown>, names, extractedBytes: total.value };
}
