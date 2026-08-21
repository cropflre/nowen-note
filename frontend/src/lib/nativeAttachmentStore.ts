import { Capacitor } from "@capacitor/core";
import {
  Directory,
  Filesystem,
  type FileInfo,
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

interface StreamedFileInfo {
  stat: StatResult;
  size: number;
  sha256: string;
}

interface AccountAttachmentState {
  queue: Promise<void>;
  recoveryNeeded: boolean;
}

interface NativeAttachmentGlobalState {
  accounts: Map<string, AccountAttachmentState>;
}

interface RecoveryArtifact {
  attachmentId: string;
  kind: "tmp" | "backup" | "failed";
  name: string;
  path: string;
  mtime: number;
}

type NativeAttachmentGlobal = typeof globalThis & {
  __nowenNoteNativeAttachmentState?: NativeAttachmentGlobalState;
};

type FilesystemErrorLike = Error & { code?: string };

const ACCOUNT_HASH_PATTERN = /^[a-f0-9]{16}$/;
const ATTACHMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const RECOVERY_ARTIFACT_PATTERN = /^\.([A-Za-z0-9][A-Za-z0-9_-]{0,127})\.(tmp|backup|failed)-([A-Za-z0-9-]+)$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const NOT_FOUND_ERROR_CODE = "OS-PLUG-FILE-0008";
const IO_CHUNK_BYTES = 192 * 1024;
const BASE64_BINARY_CHUNK_BYTES = 3 * 4096;

const SHA256_INITIAL_STATE = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const SHA256_ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

/** 只保留 64 字节缓冲区的轻量增量 SHA-256。 */
class IncrementalSha256 {
  private readonly state = new Uint32Array(SHA256_INITIAL_STATE);
  private readonly schedule = new Uint32Array(64);
  private readonly block = new Uint8Array(64);
  private blockLength = 0;
  private totalLength = 0;
  private finalized = false;

  update(bytes: Uint8Array): this {
    if (this.finalized) throw new Error("SHA-256 已结束，不能继续写入");
    if (this.totalLength + bytes.byteLength > Number.MAX_SAFE_INTEGER) {
      throw new Error("附件过大，超出 SHA-256 长度计数范围");
    }
    this.totalLength += bytes.byteLength;

    let offset = 0;
    if (this.blockLength > 0) {
      const count = Math.min(64 - this.blockLength, bytes.byteLength);
      this.block.set(bytes.subarray(0, count), this.blockLength);
      this.blockLength += count;
      offset = count;
      if (this.blockLength === 64) {
        this.processBlock(this.block, 0);
        this.blockLength = 0;
      }
    }

    while (offset + 64 <= bytes.byteLength) {
      this.processBlock(bytes, offset);
      offset += 64;
    }

    if (offset < bytes.byteLength) {
      this.block.set(bytes.subarray(offset), 0);
      this.blockLength = bytes.byteLength - offset;
    }
    return this;
  }

  digestHex(): string {
    if (this.finalized) throw new Error("SHA-256 摘要只能读取一次");
    this.finalized = true;

    const tailLength = this.blockLength < 56 ? 64 : 128;
    const tail = new Uint8Array(tailLength);
    tail.set(this.block.subarray(0, this.blockLength));
    tail[this.blockLength] = 0x80;

    const bitLengthHigh = Math.floor(this.totalLength / 0x20000000) >>> 0;
    const bitLengthLow = (this.totalLength * 8) >>> 0;
    const lengthOffset = tailLength - 8;
    tail[lengthOffset] = bitLengthHigh >>> 24;
    tail[lengthOffset + 1] = bitLengthHigh >>> 16;
    tail[lengthOffset + 2] = bitLengthHigh >>> 8;
    tail[lengthOffset + 3] = bitLengthHigh;
    tail[lengthOffset + 4] = bitLengthLow >>> 24;
    tail[lengthOffset + 5] = bitLengthLow >>> 16;
    tail[lengthOffset + 6] = bitLengthLow >>> 8;
    tail[lengthOffset + 7] = bitLengthLow;

    for (let offset = 0; offset < tail.byteLength; offset += 64) {
      this.processBlock(tail, offset);
    }

    let result = "";
    for (const value of this.state) {
      result += value.toString(16).padStart(8, "0");
    }
    return result;
  }

  private processBlock(bytes: Uint8Array, offset: number): void {
    const words = this.schedule;
    for (let index = 0; index < 16; index += 1) {
      const position = offset + index * 4;
      words[index] = (
        (bytes[position] << 24)
        | (bytes[position + 1] << 16)
        | (bytes[position + 2] << 8)
        | bytes[position + 3]
      ) >>> 0;
    }
    for (let index = 16; index < 64; index += 1) {
      const previous15 = words[index - 15];
      const previous2 = words[index - 2];
      const sigma0 = rotateRight(previous15, 7)
        ^ rotateRight(previous15, 18)
        ^ (previous15 >>> 3);
      const sigma1 = rotateRight(previous2, 17)
        ^ rotateRight(previous2, 19)
        ^ (previous2 >>> 10);
      words[index] = (
        words[index - 16]
        + sigma0
        + words[index - 7]
        + sigma1
      ) >>> 0;
    }

    let a = this.state[0];
    let b = this.state[1];
    let c = this.state[2];
    let d = this.state[3];
    let e = this.state[4];
    let f = this.state[5];
    let g = this.state[6];
    let h = this.state[7];

    for (let index = 0; index < 64; index += 1) {
      const upperSigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temporary1 = (
        h + upperSigma1 + choose + SHA256_ROUND_CONSTANTS[index] + words[index]
      ) >>> 0;
      const upperSigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (upperSigma0 + majority) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }

    this.state[0] = (this.state[0] + a) >>> 0;
    this.state[1] = (this.state[1] + b) >>> 0;
    this.state[2] = (this.state[2] + c) >>> 0;
    this.state[3] = (this.state[3] + d) >>> 0;
    this.state[4] = (this.state[4] + e) >>> 0;
    this.state[5] = (this.state[5] + f) >>> 0;
    this.state[6] = (this.state[6] + g) >>> 0;
    this.state[7] = (this.state[7] + h) >>> 0;
  }
}

function assertNativePlatform(): void {
  if (!Capacitor.isNativePlatform()) {
    throw new Error("原生附件存储只能在 Android 或 iOS 运行时使用");
  }
}

function getGlobalState(): NativeAttachmentGlobalState {
  const globalObject = globalThis as NativeAttachmentGlobal;
  if (!globalObject.__nowenNoteNativeAttachmentState) {
    globalObject.__nowenNoteNativeAttachmentState = { accounts: new Map() };
  }
  return globalObject.__nowenNoteNativeAttachmentState;
}

function getAccountState(accountHash: string): AccountAttachmentState {
  const accounts = getGlobalState().accounts;
  const existing = accounts.get(accountHash);
  if (existing) return existing;

  const created: AccountAttachmentState = {
    queue: Promise.resolve(),
    recoveryNeeded: true,
  };
  accounts.set(accountHash, created);
  return created;
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

function parseRecoveryArtifact(
  accountHash: string,
  file: FileInfo,
): RecoveryArtifact | null {
  const match = RECOVERY_ARTIFACT_PATTERN.exec(file.name);
  if (!match) return null;
  return {
    attachmentId: match[1],
    kind: match[2] as RecoveryArtifact["kind"],
    name: file.name,
    path: `${attachmentDirectory(accountHash)}/${file.name}`,
    mtime: file.mtime,
  };
}

function dataSize(data: NativeAttachmentData): number {
  if (data instanceof Blob) return data.size;
  return data.byteLength;
}

async function hashAccountId(accountId: string): Promise<string> {
  const normalized = accountId.trim();
  if (!normalized) throw new Error("无法创建原生附件存储：accountId 不能为空");
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("当前原生运行时不支持 SHA-256");
  const digest = await subtle.digest(
    "SHA-256",
    new TextEncoder().encode(normalized),
  );
  let accountHash = "";
  for (const value of new Uint8Array(digest).subarray(0, 8)) {
    accountHash += value.toString(16).padStart(2, "0");
  }
  return accountHash;
}

async function* inputChunks(
  data: NativeAttachmentData,
): AsyncGenerator<Uint8Array, void, void> {
  if (data instanceof Blob) {
    for (let offset = 0; offset < data.size; offset += IO_CHUNK_BYTES) {
      const part = data.slice(offset, Math.min(offset + IO_CHUNK_BYTES, data.size));
      yield new Uint8Array(await part.arrayBuffer());
    }
    return;
  }

  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  for (let offset = 0; offset < bytes.byteLength; offset += IO_CHUNK_BYTES) {
    yield bytes.subarray(offset, Math.min(offset + IO_CHUNK_BYTES, bytes.byteLength));
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let encoded = "";
  for (
    let offset = 0;
    offset < bytes.byteLength;
    offset += BASE64_BINARY_CHUNK_BYTES
  ) {
    const end = Math.min(offset + BASE64_BINARY_CHUNK_BYTES, bytes.byteLength);
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

  for (let offset = 0; offset < normalized.length; offset += 4 * 4096) {
    const binary = atob(normalized.slice(offset, offset + 4 * 4096));
    for (let index = 0; index < binary.length; index += 1) {
      bytes[writeOffset] = binary.charCodeAt(index);
      writeOffset += 1;
    }
  }
  return bytes;
}

async function chunkDataToBytes(data: string | Blob): Promise<Uint8Array> {
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  return base64ToBytes(data);
}

async function readFileByChunks(
  path: string,
  consume: (bytes: Uint8Array) => void | Promise<void>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let ended = false;
    let processing = Promise.resolve();

    const fail = (error: unknown) => {
      if (ended) return;
      ended = true;
      void processing.then(
        () => reject(error),
        (processingError) => reject(processingError),
      );
    };
    const finish = () => {
      if (ended) return;
      ended = true;
      void processing.then(resolve, reject);
    };

    void Filesystem.readFileInChunks(
      {
        path,
        directory: Directory.Data,
        chunkSize: IO_CHUNK_BYTES,
      },
      (chunk, error) => {
        if (ended) return;
        if (error) {
          fail(error);
          return;
        }
        if (
          chunk == null
          || (typeof chunk.data === "string" && chunk.data.length === 0)
          || (chunk.data instanceof Blob && chunk.data.size === 0)
        ) {
          finish();
          return;
        }

        processing = processing.then(async () => {
          await consume(await chunkDataToBytes(chunk.data));
        });
        void processing.catch(fail);
      },
    ).catch(fail);
  });
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

async function inspectFile(path: string): Promise<StreamedFileInfo> {
  const before = await Filesystem.stat({ path, directory: Directory.Data });
  if (before.type !== "file") throw new Error("原生附件持久化路径不是文件");

  const hasher = new IncrementalSha256();
  let size = 0;
  await readFileByChunks(path, (bytes) => {
    hasher.update(bytes);
    size += bytes.byteLength;
  });

  const after = await Filesystem.stat({ path, directory: Directory.Data });
  if (
    after.type !== "file"
    || before.size !== after.size
    || before.mtime !== after.mtime
    || size !== after.size
  ) {
    throw new Error("原生附件在流式读取期间发生变化或大小不一致");
  }

  return { stat: after, size, sha256: hasher.digestHex() };
}

async function verifyFile(
  path: string,
  expectedSize: number,
  expectedHash: string,
): Promise<StreamedFileInfo> {
  const persisted = await inspectFile(path);
  if (persisted.size !== expectedSize) {
    throw new Error(
      `原生附件大小校验失败：预期 ${expectedSize}，实际 ${persisted.size}`,
    );
  }
  if (persisted.sha256 !== expectedHash) {
    throw new Error(
      `原生附件 SHA-256 校验失败：预期 ${expectedHash}，实际 ${persisted.sha256}`,
    );
  }
  return persisted;
}

async function writeFileByChunks(
  path: string,
  data: NativeAttachmentData,
): Promise<{ size: number; sha256: string }> {
  const hasher = new IncrementalSha256();
  let size = 0;
  let firstChunk = true;

  for await (const bytes of inputChunks(data)) {
    hasher.update(bytes);
    size += bytes.byteLength;
    const encoded = bytesToBase64(bytes);
    if (firstChunk) {
      await Filesystem.writeFile({
        path,
        directory: Directory.Data,
        data: encoded,
        recursive: true,
      });
      firstChunk = false;
    } else {
      await Filesystem.appendFile({
        path,
        directory: Directory.Data,
        data: encoded,
      });
    }
  }

  if (firstChunk) {
    await Filesystem.writeFile({
      path,
      directory: Directory.Data,
      data: "",
      recursive: true,
    });
  }

  return { size, sha256: hasher.digestHex() };
}

async function restoreBackupAfterFailure(
  stablePath: string,
  backupPath: string,
  failedPath: string,
): Promise<boolean> {
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

  if (!failedFileMoved) return false;
  try {
    await deleteIfPresent(failedPath);
    return false;
  } catch {
    return true;
  }
}

async function discardNewStableFile(
  stablePath: string,
  failedPath: string,
): Promise<boolean> {
  try {
    await Filesystem.rename({
      from: stablePath,
      to: failedPath,
      directory: Directory.Data,
      toDirectory: Directory.Data,
    });
  } catch {
    await deleteIfPresent(stablePath);
    return false;
  }

  try {
    await deleteIfPresent(failedPath);
    return false;
  } catch {
    return true;
  }
}

async function recoverAccountDirectory(accountHash: string): Promise<boolean> {
  let files: FileInfo[];
  try {
    const result = await Filesystem.readdir({
      path: attachmentDirectory(accountHash),
      directory: Directory.Data,
    });
    files = result.files;
  } catch (error) {
    if (isNotFoundError(error)) return false;
    throw error;
  }

  const groups = new Map<string, RecoveryArtifact[]>();
  for (const file of files) {
    const artifact = parseRecoveryArtifact(accountHash, file);
    if (!artifact) continue;
    const group = groups.get(artifact.attachmentId) ?? [];
    group.push(artifact);
    groups.set(artifact.attachmentId, group);
  }

  const restoreErrors: unknown[] = [];
  const cleanupErrors: unknown[] = [];

  for (const [attachmentId, artifacts] of groups) {
    const stablePath = attachmentPath(accountHash, attachmentId);
    let stable = await statOrNull(stablePath);
    const backups = artifacts
      .filter((artifact) => artifact.kind === "backup")
      .sort((left, right) => right.mtime - left.mtime);
    let restoredBackupPath: string | null = null;

    if (!stable && backups.length > 0) {
      const backup = backups[0];
      try {
        await Filesystem.rename({
          from: backup.path,
          to: stablePath,
          directory: Directory.Data,
          toDirectory: Directory.Data,
        });
        stable = await Filesystem.stat({ path: stablePath, directory: Directory.Data });
        restoredBackupPath = backup.path;
      } catch (error) {
        restoreErrors.push(error);
        continue;
      }
    }

    if (stable && stable.type !== "file") {
      restoreErrors.push(new Error(`附件稳定路径不是文件：${attachmentId}`));
      continue;
    }

    for (const artifact of artifacts) {
      if (artifact.path === restoredBackupPath) continue;
      try {
        await deleteIfPresent(artifact.path);
      } catch (error) {
        // 不能带着旧备份继续业务操作，否则随后删除稳定文件会被错误恢复。
        cleanupErrors.push(error);
      }
    }
  }

  if (restoreErrors.length > 0 || cleanupErrors.length > 0) {
    throw new AggregateError(
      [...restoreErrors, ...cleanupErrors],
      "原生附件目录恢复或清理未完成",
    );
  }
  return false;
}

class NativeAttachmentStoreImpl implements NativeAttachmentStore {
  constructor(
    readonly accountHash: string,
    private readonly accountState: AccountAttachmentState,
  ) {}

  save(input: NativeAttachmentSaveInput): Promise<NativeAttachmentFileInfo> {
    return this.enqueue(() => this.saveDirect(input));
  }

  read(attachmentId: string, mimeType = "application/octet-stream"): Promise<Blob> {
    return this.enqueue(async () => {
      const id = validateAttachmentId(attachmentId);
      const parts: BlobPart[] = [];
      await readFileByChunks(attachmentPath(this.accountHash, id), (bytes) => {
        const copy = new Uint8Array(bytes.byteLength);
        copy.set(bytes);
        parts.push(copy.buffer);
      });
      return new Blob(parts, { type: mimeType });
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
      if (!(await statOrNull(path))) return null;
      const inspected = await inspectFile(path);
      return {
        attachmentId: id,
        path,
        size: inspected.size,
        sha256: inspected.sha256,
        mtime: inspected.stat.mtime,
        uri: inspected.stat.uri,
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
    const inputSize = dataSize(input.data);
    if (expectedSize != null && expectedSize !== inputSize) {
      throw new Error(`附件大小校验失败：预期 ${expectedSize}，实际 ${inputSize}`);
    }

    const stablePath = attachmentPath(this.accountHash, attachmentId);
    const temporaryPath = createSiblingPath(this.accountHash, attachmentId, "tmp");
    const backupPath = createSiblingPath(this.accountHash, attachmentId, "backup");
    const failedPath = createSiblingPath(this.accountHash, attachmentId, "failed");
    let temporaryPresent = false;
    let backupPresent = false;
    let stableInstalled = false;

    try {
      temporaryPresent = true;
      const written = await writeFileByChunks(temporaryPath, input.data);
      if (written.size !== inputSize) {
        throw new Error(`附件流式写入大小不一致：输入 ${inputSize}，写入 ${written.size}`);
      }
      if (expectedHash != null && expectedHash !== written.sha256) {
        throw new Error(
          `附件 SHA-256 校验失败：预期 ${expectedHash}，实际 ${written.sha256}`,
        );
      }
      await verifyFile(temporaryPath, written.size, written.sha256);

      const existing = await statOrNull(stablePath);
      if (existing && existing.type !== "file") {
        throw new Error("原生附件稳定路径不是文件，已拒绝替换");
      }
      if (existing) {
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

      const persisted = await verifyFile(stablePath, written.size, written.sha256);
      if (backupPresent) {
        try {
          await deleteIfPresent(backupPath);
          backupPresent = false;
        } catch {
          // 保留可解析备份，并让下次共享队列操作再次清理。
          this.accountState.recoveryNeeded = true;
        }
      }

      return {
        attachmentId,
        path: stablePath,
        size: persisted.size,
        sha256: persisted.sha256,
        mtime: persisted.stat.mtime,
        uri: persisted.stat.uri,
      };
    } catch (error) {
      const recoveryErrors: unknown[] = [];

      if (backupPresent) {
        try {
          if (stableInstalled) {
            if (await restoreBackupAfterFailure(stablePath, backupPath, failedPath)) {
              this.accountState.recoveryNeeded = true;
            }
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
          this.accountState.recoveryNeeded = true;
          recoveryErrors.push(recoveryError);
        }
      } else if (stableInstalled) {
        try {
          if (await discardNewStableFile(stablePath, failedPath)) {
            this.accountState.recoveryNeeded = true;
          }
        } catch (cleanupError) {
          this.accountState.recoveryNeeded = true;
          recoveryErrors.push(cleanupError);
        }
      }

      if (temporaryPresent) {
        try {
          await deleteIfPresent(temporaryPath);
          temporaryPresent = false;
        } catch (cleanupError) {
          this.accountState.recoveryNeeded = true;
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
          this.accountState.recoveryNeeded = true;
        }
      }
    }
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const scheduled = this.accountState.queue.then(async () => {
      if (this.accountState.recoveryNeeded) {
        this.accountState.recoveryNeeded = false;
        try {
          this.accountState.recoveryNeeded = await recoverAccountDirectory(
            this.accountHash,
          );
        } catch (error) {
          this.accountState.recoveryNeeded = true;
          throw error;
        }
      }
      return work();
    });
    this.accountState.queue = scheduled.then(
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
  const normalized = validateAccountHash(accountHash);
  return new NativeAttachmentStoreImpl(normalized, getAccountState(normalized));
}
