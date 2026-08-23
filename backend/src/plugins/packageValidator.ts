import crypto from "node:crypto";
import path from "node:path";
import { Readable } from "node:stream";
import JSZip from "jszip";
import { parsePluginManifest } from "./manifest.js";
import type { PluginManifest } from "./types.js";

const unzipper = require("unzipper") as { Parse(options: { forceStream: true }): NodeJS.ReadWriteStream };

export const PACKAGE_LIMITS = {
  compressedBytes: 20 * 1024 * 1024,
  extractedBytes: 50 * 1024 * 1024,
  files: 500,
  manifestBytes: 128 * 1024,
  inputBytes: 256 * 1024,
  outputBytes: 1024 * 1024,
};

export interface ValidatedPluginPackage {
  zip: JSZip;
  manifest: PluginManifest;
  checksum: string;
  fileCount: number;
  extractedBytes: number;
}

interface StreamValidationResult {
  fileCount: number;
  extractedBytes: number;
}

function normalizeEntryName(name: string): string {
  const normalized = name.replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
    throw new Error(`非法 ZIP 路径: ${name}`);
  }
  const segments = normalized.split("/").filter(Boolean);
  if (segments.includes("..")) throw new Error(`ZIP 路径穿越: ${name}`);
  return segments.join("/");
}

function isSymlink(file: JSZip.JSZipObject): boolean {
  const unixPermissions = typeof file.unixPermissions === "number" ? file.unixPermissions : 0;
  return (unixPermissions & 0o170000) === 0o120000;
}

function isForbidden(name: string): boolean {
  const lower = name.toLowerCase();
  const base = path.posix.basename(lower);
  return lower.split("/").includes("node_modules")
    || lower.endsWith(".node")
    || base === "install.js"
    || base === "preinstall"
    || base === "postinstall"
    || base === "package-lock.json"
    || /\.(exe|dll|so|dylib|bat|cmd|ps1|sh|com|msi)$/i.test(lower);
}

async function validateArchiveStream(bytes: Buffer): Promise<StreamValidationResult> {
  let fileCount = 0;
  let extractedBytes = 0;
  const archive = Readable.from(bytes).pipe(unzipper.Parse({ forceStream: true })) as unknown as AsyncIterable<any> & { destroy(error?: Error): void };
  try {
    for await (const entry of archive) {
      const normalized = normalizeEntryName(String(entry.path || ""));
      const directory = entry.type === "Directory" || String(entry.path || "").endsWith("/");
      const mode = Number(entry.vars?.externalFileAttributes || 0) >>> 16;
      if (entry.type === "SymbolicLink" || (mode & 0o170000) === 0o120000) {
        throw new Error(`插件包禁止符号链接: ${normalized}`);
      }
      if (!directory) {
        fileCount += 1;
        if (fileCount > PACKAGE_LIMITS.files) throw new Error(`插件包文件数量不能超过 ${PACKAGE_LIMITS.files}`);
        if (isForbidden(normalized)) throw new Error(`插件包包含禁止文件: ${normalized}`);
        const declared = Number(entry.vars?.uncompressedSize || 0);
        const compressed = Number(entry.vars?.compressedSize || 0);
        if (declared > PACKAGE_LIMITS.extractedBytes) throw new Error("插件 ZIP 条目超过 50MB");
        if (declared > 1024 * 1024 && compressed > 0 && declared / compressed > 200) {
          throw new Error(`插件 ZIP 压缩比异常: ${normalized}`);
        }
      }
      let entryBytes = 0;
      for await (const chunk of entry as AsyncIterable<Buffer>) {
        entryBytes += chunk.length;
        extractedBytes += chunk.length;
        if (entryBytes > PACKAGE_LIMITS.extractedBytes || extractedBytes > PACKAGE_LIMITS.extractedBytes) {
          throw new Error("插件解压后超过 50MB");
        }
      }
    }
  } catch (error) {
    archive.destroy(error as Error);
    throw error;
  }
  if (fileCount === 0) throw new Error("插件包不能为空");
  return { fileCount, extractedBytes };
}

export async function validatePluginPackage(bytes: Buffer): Promise<ValidatedPluginPackage> {
  if (bytes.length === 0 || bytes.length > PACKAGE_LIMITS.compressedBytes) {
    throw new Error("插件包必须大于 0 且不超过 20MB");
  }
  const streamed = await validateArchiveStream(bytes);
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true, createFolders: false });
  const files = Object.values(zip.files).filter((file) => !file.dir);
  if (files.length === 0 || files.length > PACKAGE_LIMITS.files) {
    throw new Error(`插件包文件数量必须在 1-${PACKAGE_LIMITS.files} 之间`);
  }
  for (const file of Object.values(zip.files)) {
    // JSZip 会把 ../ 自动清洗掉，但保留 unsafeOriginalName；必须检查原始名，
    // 否则校验层会看见安全名而遗漏上传包本身的 Zip Slip 意图。
    const originalName = (file as JSZip.JSZipObject & { unsafeOriginalName?: string }).unsafeOriginalName || file.name;
    const normalized = normalizeEntryName(originalName);
    if (isSymlink(file)) throw new Error(`插件包禁止符号链接: ${normalized}`);
    if (!file.dir && isForbidden(normalized)) throw new Error(`插件包包含禁止文件: ${normalized}`);
  }
  const manifestFile = zip.file("manifest.json");
  if (!manifestFile) throw new Error("插件包根目录缺少 manifest.json");
  const manifestBytes = await manifestFile.async("uint8array");
  if (manifestBytes.byteLength > PACKAGE_LIMITS.manifestBytes) throw new Error("manifest.json 超过 128KB");
  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(Buffer.from(manifestBytes).toString("utf8"));
  } catch {
    throw new Error("manifest.json 不是有效 JSON");
  }
  const manifest = parsePluginManifest(rawManifest);
  const main = normalizeEntryName(manifest.main);
  if (!zip.file(main)) throw new Error(`插件入口不存在: ${manifest.main}`);
  if (!main.endsWith(".mjs") && !main.endsWith(".js")) throw new Error("插件入口必须是已构建的 ESM JavaScript");
  for (const asset of [manifest.icon, ...(manifest.screenshots || [])].filter((value): value is string => Boolean(value))) {
    const normalized = normalizeEntryName(asset);
    if (!zip.file(normalized)) throw new Error(`Manifest 资源不存在: ${asset}`);
  }
  if (manifest.apiVersion === 2) for (const template of manifest.contributes?.automationTemplates || []) {
    const normalized = normalizeEntryName(template.file);
    if (!zip.file(normalized)) throw new Error(`Automation Template 不存在: ${template.file}`);
  }
  return {
    zip,
    manifest,
    checksum: crypto.createHash("sha256").update(bytes).digest("hex"),
    fileCount: streamed.fileCount,
    extractedBytes: streamed.extractedBytes,
  };
}
