import { Capacitor } from "@capacitor/core";
import {
  Directory,
  Filesystem,
  type StatResult,
} from "@capacitor/filesystem";

export type NativeAttachmentData = Blob | ArrayBuffer | Uint8Array;

export interface NativeAttachmentSaveInput {
  attachmentId: string;
  data: NativeAttachmentData;
  expectedSize?: number;
  /** SHA-256 十六进制，可选 `sha256:` 前缀。 */
  expectedHash?: string;
}

export interface NativeAttachmentFileInfo {
  attachmentId: string;
  path: string;
  size: number;
  sha256: string;
  mtime: number;
  uri: string;
}

export interface NativeAttachmentStore {
  readonly accountHash: string;
  save(input: NativeAttachmentSaveInput): Promise<NativeAttachmentFileInfo>;
  read(attachmentId: string, mimeType?: string): Promise<Blob>;
  exists(attachmentId: string): Promise<boolean>;
  stat(attachmentId: string): Promise<NativeAttachmentFileInfo | null>;
  resolveUrl(attachmentId: string): Promise<string | null>;
  /** 只删除二进制且幂等；是否允许删除由 Repository 判断。 */
  remove(attachmentId: string): Promise<void>;
}

interface VerifiedFile {
  bytes: Uint8Array;
  stat: StatResult;
  sha256: string;
}

type FilesystemErrorLike = Error & { code?: string };

const ACCOUNT_HASH_PATTERN = /^[a-f0-9]{16}$/;
const ATTACHMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const NOT_FOUND_ERROR_CODE = "OS-PLUG-FILE-0008";
const BASE64_ENCODE_CHUNK_BYTES = 3 * 8192;
const BASE64_DECODE_CHUNK_CHARS = 4 * 8192;

function assertNativePlatform(): void {
  if (!Capacitor.isNativePlatform()) {
    throw new Error("原生附件存储只能在 Android 或 iOS 运行时使用");
  }
}

function validateAccountHash(accountHash: string): string {
  const normalized = accountHash.trim().toLowerCase();
  if (!ACCOUNT_HASH_PATTERN.test(normalized)) {
    throw new Error("原生附件账户哈希必须是 16 位十六进制字符串");
  }
  return normalized;
}

function validateAttachmentId(attachmentId: string): string {
  if (
    attachmentId !== attachmentId.trim()
    || !ATTACHMENT_ID_PATTERN.test(attachmentId)
    || attachmentId.includes("..")
    || /[\u0000-\u001f\u007f]/.test(attachmentId)
  ) {
    throw new Error("attachmentId 格式无效，已拒绝访问附件路径");
  }
  return attachmentId;
}

function normalizeExpectedSize(expectedSize: number | undefined): number | undefined {
  if (expectedSize == null) return undefined;
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) {
    throw new Error("expectedSize 必须是非负安全整数");
  }
  return expectedSize;
}

function normalizeExpectedHash(expectedHash: string | undefined): string | undefined {
  if (expectedHash == null) return undefined;
  const normalized = expectedHash.trim().toLowerCase().replace(/^sha256:/, "");
  if (!SHA256_PATTERN.test(normalized)) {
    throw new Error("expectedHash 必须是 SHA-256 十六进制字符串");
  }
  return normalized;
}

function isNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error
    && (error as FilesystemErrorLike).code === NOT_FOUND_ERROR_CODE
  );
}

function attachmentDirectory(accountHash: string): string {
  return `attachments/${accountHash}`;
}

function attachmentPath(accountHash: string, attachmentId: string): string {
  return `${attachmentDirectory(accountHash)}/${attachmentId}`;
}

function createSiblingPath(
  accountHash: string,
  attachmentId: string,
  purpose: "tmp" | "backup" | "failed",
): string {
  const random = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${attachmentDirectory(accountHash)}/.${attachmentId}.${purpose}-${random}`;
}

async function toBytes(data: NativeAttachmentData): Promise<Uint8Array> {
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  if (data instanceof Uint8Array) return new Uint8Array(data);
  return new Uint8Array(data.slice(0));
}

function bytesToBase64(bytes: Uint8Array): string {
  let encoded = "";
  for (let offset = 0; offset < bytes.length; offset += BASE64_ENCODE_CHUNK_BYTES) {
    const end = Math.min(offset + BASE64_ENCODE_CHUNK_BYTES, bytes.length);
    let binary = "";
    for (let index = offset; index < end; index += 1) {
      binary += String.fromCharCode(bytes[index]);
    }
    encoded += btoa(binary);
  }
  return encoded;
}

function base64ToBytes(encoded: string): Uint8Array {
  const normalized = encoded.replace(/\s/g, "");
  if (
    normalized.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(normalized)
  ) {
    throw new Error("原生附件文件返回了无效的 Base64 数据");
  }

  const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  const bytes = new Uint8Array((normalized.length / 4) * 3 - padding);
  let writeOffset = 0;

  for (
    let offset = 0;
    offset < normalized.length;
    offset += BASE64_DECODE_CHUNK_CHARS
  ) {
    const binary = atob(normalized.slice(offset, offset + BASE64_DECODE_CHUNK_CHARS));
    for (let index = 0; index < binary.length; index += 1) {
      bytes[writeOffset] = binary.charCodeAt(index);
      writeOffset += 1;
    }
  }
  return bytes;
}

async function readBytes(path: string): Promise<Uint8Array> {
  const result = await Filesystem.readFile({ path, directory: Directory.Data });
  if (result.data instanceof Blob) {
    return new Uint8Array(await result.data.arrayBuffer());
  }
  return base64ToBytes(result.data);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("当前原生运行时不支持 SHA-256");

  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await subtle.digest("SHA-256", copy.buffer);
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function hashAccountId(accountId: string): Promise<string> {
  const normalized = accountId.trim();
  if (!normalized) throw new Error("无法创建原生附件存储：accountId 不能为空");
  const digest = await sha256(new TextEncoder().encode(normalized));
  return digest.slice(0, 16);
}

async function statOrNull(path: string): Promise<StatResult | null> {
  try {
    return await Filesystem.stat({ path, directory: Directory.Data });
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

async function deleteIfPresent(path: string): Promise<void> {
  try {
    await Filesystem.deleteFile({ path, directory: Directory.Data });
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }
}

async function verifyFile(
  path: string,
  expectedSize: number,
  expectedHash: string,
): Promise<VerifiedFile> {
  const fileStat = await Filesystem.stat({ path, directory: Directory.Data });
  const bytes = await readBytes(path);
  const actualHash = await sha256(bytes);

  if (fileStat.type !== "file") {
    throw new Error("原生附件持久化路径不是文件");
  }
  if (fileStat.size !== expectedSize || bytes.byteLength !== expectedSize) {
    throw new Error(
      `原生附件大小校验失败：预期 ${expectedSize}，STAT ${fileStat.size}，读取 ${bytes.byteLength}`,
    );
  }
  if (actualHash !== expectedHash) {
    throw new Error(
      `原生附件 SHA-256 校验失败：预期 ${expectedHash}，实际 ${actualHash}`,
    );
  }

  return { bytes, stat: fileStat, sha256: actualHash };
}

async function moveAsideAndRestore(
  stablePath: string,
  backupPath: string,
  failedPath: string,
): Promise<void> {
  let failedFileMoved = false;
  try {
    await Filesystem.rename({
      from: stablePath,
      to: failedPath,
      directory: Directory.Data,
      toDirectory: Directory.Data,
    });
    failedFileMoved = true;
  } catch (moveError) {
    try {
      await deleteIfPresent(stablePath);
    } catch (deleteError) {
      throw new AggregateError(
        [moveError, deleteError],
        "新附件切换失败，且无法让出稳定路径以恢复旧文件",
      );
    }
  }

  await Filesystem.rename({
    from: backupPath,
    to: stablePath,
    directory: Directory.Data,
    toDirectory: Directory.Data,
  });

  if (failedFileMoved) {
    try {
      await deleteIfPresent(failedPath);
    } catch {
      // 旧稳定文件已恢复；残留失败副本不应让 save 覆盖原始错误。
    }
  }
}

class NativeAttachmentStoreImpl implements NativeAttachmentStore {
  private queue: Promise<void> = Promise.resolve();

  constructor(readonly accountHash: string) {}

  save(input: NativeAttachmentSaveInput): Promise<NativeAttachmentFileInfo> {
    return this.enqueue(() => this.saveDirect(input));
  }

  read(attachmentId: string, mimeType = "application/octet-stream"): Promise<Blob> {
    return this.enqueue(async () => {
      const id = validateAttachmentId(attachmentId);
      return new Blob([await readBytes(attachmentPath(this.accountHash, id))], {
        type: mimeType,
      });
    });
  }

  exists(attachmentId: string): Promise<boolean> {
    return this.enqueue(async () => {
      const id = validateAttachmentId(attachmentId);
      return (await statOrNull(attachmentPath(this.accountHash, id)))?.type === "file";
    });
  }

  stat(attachmentId: string): Promise<NativeAttachmentFileInfo | null> {
    return this.enqueue(async () => {
      const id = validateAttachmentId(attachmentId);
      const path = attachmentPath(this.accountHash, id);
      const fileStat = await statOrNull(path);
      if (!fileStat || fileStat.type !== "file") return null;
      const bytes = await readBytes(path);
      return {
        attachmentId: id,
        path,
        size: bytes.byteLength,
        sha256: await sha256(bytes),
        mtime: fileStat.mtime,
        uri: fileStat.uri,
      };
    });
  }

  resolveUrl(attachmentId: string): Promise<string | null> {
    return this.enqueue(async () => {
      const id = validateAttachmentId(attachmentId);
      const path = attachmentPath(this.accountHash, id);
      const fileStat = await statOrNull(path);
      if (!fileStat || fileStat.type !== "file") return null;
      const { uri } = await Filesystem.getUri({ path, directory: Directory.Data });
      return Capacitor.convertFileSrc(uri);
    });
  }

  remove(attachmentId: string): Promise<void> {
    return this.enqueue(async () => {
      const id = validateAttachmentId(attachmentId);
      await deleteIfPresent(attachmentPath(this.accountHash, id));
    });
  }

  private async saveDirect(
    input: NativeAttachmentSaveInput,
  ): Promise<NativeAttachmentFileInfo> {
    const attachmentId = validateAttachmentId(input.attachmentId);
    const expectedSize = normalizeExpectedSize(input.expectedSize);
    const expectedHash = normalizeExpectedHash(input.expectedHash);
    const bytes = await toBytes(input.data);
    const actualSize = bytes.byteLength;
    const actualHash = await sha256(bytes);

    if (expectedSize != null && expectedSize !== actualSize) {
      throw new Error(
        `附件大小校验失败：预期 ${expectedSize}，实际 ${actualSize}`,
      );
    }
    if (expectedHash != null && expectedHash !== actualHash) {
      throw new Error(
        `附件 SHA-256 校验失败：预期 ${expectedHash}，实际 ${actualHash}`,
      );
    }

    const stablePath = attachmentPath(this.accountHash, attachmentId);
    const temporaryPath = createSiblingPath(this.accountHash, attachmentId, "tmp");
    const backupPath = createSiblingPath(this.accountHash, attachmentId, "backup");
    const failedPath = createSiblingPath(this.accountHash, attachmentId, "failed");
    let temporaryPresent = false;
    let backupPresent = false;
    let stableInstalled = false;

    try {
      await Filesystem.writeFile({
        path: temporaryPath,
        directory: Directory.Data,
        data: bytesToBase64(bytes),
        recursive: true,
      });
      temporaryPresent = true;
      await verifyFile(temporaryPath, actualSize, actualHash);

      if (await statOrNull(stablePath)) {
        await Filesystem.rename({
          from: stablePath,
          to: backupPath,
          directory: Directory.Data,
          toDirectory: Directory.Data,
        });
        backupPresent = true;
      }

      await Filesystem.rename({
        from: temporaryPath,
        to: stablePath,
        directory: Directory.Data,
        toDirectory: Directory.Data,
      });
      temporaryPresent = false;
      stableInstalled = true;

      const persisted = await verifyFile(stablePath, actualSize, actualHash);
      if (backupPresent) {
        try {
          await deleteIfPresent(backupPath);
          backupPresent = false;
        } catch {
          // 新稳定文件已经完整落盘；清理备份失败不回滚成功写入。
        }
      }

      return {
        attachmentId,
        path: stablePath,
        size: persisted.bytes.byteLength,
        sha256: persisted.sha256,
        mtime: persisted.stat.mtime,
        uri: persisted.stat.uri,
      };
    } catch (error) {
      const recoveryErrors: unknown[] = [];

      if (backupPresent) {
        try {
          if (stableInstalled) {
            await moveAsideAndRestore(stablePath, backupPath, failedPath);
          } else {
            await Filesystem.rename({
              from: backupPath,
              to: stablePath,
              directory: Directory.Data,
              toDirectory: Directory.Data,
            });
          }
          backupPresent = false;
        } catch (recoveryError) {
          recoveryErrors.push(recoveryError);
        }
      } else if (stableInstalled) {
        try {
          await deleteIfPresent(stablePath);
        } catch (cleanupError) {
          recoveryErrors.push(cleanupError);
        }
      }

      if (temporaryPresent) {
        try {
          await deleteIfPresent(temporaryPath);
          temporaryPresent = false;
        } catch (cleanupError) {
          recoveryErrors.push(cleanupError);
        }
      }

      if (recoveryErrors.length > 0) {
        throw new AggregateError(
          [error, ...recoveryErrors],
          "原生附件保存失败，且清理或旧文件恢复未完全成功",
        );
      }
      throw error;
    } finally {
      if (temporaryPresent) {
        try {
          await deleteIfPresent(temporaryPath);
        } catch {
          // 主流程已经结束，不能用临时文件清理错误覆盖原始结果。
        }
      }
    }
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const scheduled = this.queue.then(work, work);
    this.queue = scheduled.then(
      () => undefined,
      () => undefined,
    );
    return scheduled;
  }
}

/** 使用 accountId 的 SHA-256 短哈希创建账号隔离的附件存储。 */
export async function createNativeAttachmentStore(
  accountId: string,
): Promise<NativeAttachmentStore> {
  assertNativePlatform();
  return createNativeAttachmentStoreForAccountHash(await hashAccountId(accountId));
}

/** 使用已经持久化的稳定 accountHash 创建附件存储。 */
export function createNativeAttachmentStoreForAccountHash(
  accountHash: string,
): NativeAttachmentStore {
  assertNativePlatform();
  return new NativeAttachmentStoreImpl(validateAccountHash(accountHash));
}
