import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Worker } from "node:worker_threads";
import * as yauzl from "yauzl";
import type { Platform, Task, Verification, VerifiedFile } from "../shared.ts";
import { AppError } from "./errors.ts";
import type { GitHub } from "./github.ts";

export const ARCHIVE_LIMITS = {
  archive: 2 * 1024 ** 3,
  file: 2 * 1024 ** 3,
  expanded: 6 * 1024 ** 3,
  entries: 64,
};
export interface ArtifactContext {
  taskId: string;
  sha: string;
  version: string;
  platform: Platform;
  purpose?: "formal-import";
}

async function unpack(
  path: string,
  directory: string,
  signal: AbortSignal,
  limits: typeof ARCHIVE_LIMITS,
) {
  signal.throwIfAborted();
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) =>
    yauzl.open(
      path,
      {
        lazyEntries: true,
        autoClose: false,
        strictFileNames: true,
        validateEntrySizes: true,
      },
      (error, value) => (error ? reject(error) : resolve(value!)),
    ),
  );
  const extraction = new AbortController();
  const ioSignal = AbortSignal.any([signal, extraction.signal]);
  let pending: Promise<void> = Promise.resolve();
  try {
    await new Promise<void>((resolve, reject) => {
      let ended = false;
      let expanded = 0;
      let count = 0;
      const names = new Set<string>();
      const finish = (error?: unknown) => {
        if (ended) return;
        ended = true;
        signal.removeEventListener("abort", abort);
        zip.close();
        if (error) extraction.abort(error);
        if (error) reject(error);
        else resolve();
      };
      const abort = () => finish(signal.reason || new Error("校验已取消"));
      signal.addEventListener("abort", abort, { once: true });
      zip.on("error", finish);
      zip.once("end", () => finish());
      zip.on("entry", (entry: yauzl.Entry) => {
        pending = (async () => {
          signal.throwIfAborted();
          const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
          if (
            !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.fileName) ||
            (mode && mode !== 0o100000) ||
            entry.externalFileAttributes & 0x10 ||
            names.has(entry.fileName.toLowerCase())
          )
            throw new AppError(422, "artifact 含不安全路径、链接或重复文件");
          names.add(entry.fileName.toLowerCase());
          count++;
          expanded += entry.uncompressedSize;
          const max =
            entry.fileName === "release-center-manifest.json"
              ? 128_000
              : /\.yml$/.test(entry.fileName)
                ? 2_000_000
                : limits.file;
          if (
            count > limits.entries ||
            entry.uncompressedSize > max ||
            expanded > limits.expanded ||
            entry.isEncrypted()
          )
            throw new AppError(413, "artifact 解压超过上限或包含加密文件");
          const stream = await new Promise<NodeJS.ReadableStream>(
            (resolveStream, rejectStream) =>
              zip.openReadStream(entry, (error, value) =>
                error ? rejectStream(error) : resolveStream(value!),
              ),
          );
          await pipeline(
            stream,
            createWriteStream(join(directory, entry.fileName), {
              flags: "wx",
              mode: 0o600,
            }),
            { signal: ioSignal },
          );
          if (!ended) zip.readEntry();
        })().catch(finish);
      });
      if (signal.aborted) abort();
      else zip.readEntry();
    });
  } finally {
    zip.close();
    await pending.catch(() => {});
  }
}

async function checkFiles(
  directory: string,
  context: ArtifactContext,
  signal: AbortSignal,
): Promise<{ files: VerifiedFile[]; updaterVerification: string[] }> {
  signal.throwIfAborted();
  // Hashing and the existing synchronous updater validator run off the HTTP loop.
  const worker = new Worker(
    new URL("./verification-worker.mjs", import.meta.url),
    { workerData: { directory, context }, env: {} },
  );
  let abort: () => void = () => {};
  try {
    return await new Promise((resolve, reject) => {
      abort = () => reject(signal.reason || new Error("校验已取消"));
      signal.addEventListener("abort", abort, { once: true });
      worker.once("message", (result) =>
        result.ok
          ? resolve(result.manifest)
          : reject(new AppError(422, result.error)),
      );
      worker.once("error", reject);
      worker.once("exit", (code) => {
        if (code !== 0) reject(new AppError(422, "产物校验进程异常退出"));
      });
      if (signal.aborted) abort();
    });
  } finally {
    signal.removeEventListener("abort", abort);
    await worker.terminate();
  }
}

export async function verifyArchive(
  path: string,
  context: ArtifactContext,
  digest: string,
  signal: AbortSignal,
  limits = ARCHIVE_LIMITS,
  consume?: (directory: string, result: Awaited<ReturnType<typeof checkFiles>>) => Promise<void>,
) {
  if (!/^sha256:[a-f0-9]{64}$/.test(digest))
    throw new AppError(
      422,
      "GitHub 未提供有效 archive SHA-256，不能标记已验证",
    );
  if ((await stat(path)).size > limits.archive)
    throw new AppError(413, "artifact 超过下载上限");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { signal }))
    hash.update(chunk);
  if (`sha256:${hash.digest("hex")}` !== digest)
    throw new AppError(422, "artifact archive SHA-256 不匹配");
  const directory = await mkdtemp(join(tmpdir(), "nowen-rc-unpack-"));
  try {
    await unpack(path, directory, signal, limits);
    signal.throwIfAborted();
    const result = await checkFiles(directory, context, signal);
    signal.throwIfAborted();
    if (consume) await consume(directory, result);
    return result;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function verifyArtifacts(
  github: GitHub,
  source: Task,
  signal: AbortSignal,
  progress: (results: Verification[]) => void,
): Promise<Verification[]> {
  if (source.mode !== "debug" || source.state !== "succeeded" || !source.runId)
    throw new AppError(409, "只能复核成功调试任务的产物");
  const run = await github.run(source.runId);
  signal.throwIfAborted();
  if (
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    run.head_sha !== source.plan.workflowSha ||
    run.event !== "workflow_dispatch" ||
    run.display_title !== `Release Center debug ${source.id}`
  )
    throw new AppError(409, "远端 Run 来源或状态与调试任务不一致");
  const results: Verification[] = [];
  for (const platform of source.plan.platforms) {
    signal.throwIfAborted();
    const candidates = source.artifacts.filter(
      (a) => a.name === `rc-debug-${source.id}-${platform}`,
    );
    if (candidates.length !== 1)
      throw new AppError(422, `缺少唯一的 ${platform} artifact`);
    const artifact = candidates[0];
    const metadata = await github.artifactMeta(artifact.id);
    signal.throwIfAborted();
    if (
      metadata.id !== artifact.id ||
      metadata.name !== artifact.name ||
      metadata.expired ||
      metadata.workflow_run?.id !== source.runId ||
      metadata.workflow_run?.head_sha !== source.plan.workflowSha ||
      !Number.isSafeInteger(metadata.size_in_bytes) ||
      metadata.size_in_bytes <= 0 ||
      metadata.size_in_bytes > ARCHIVE_LIMITS.archive ||
      !/^sha256:[a-f0-9]{64}$/.test(metadata.digest || "") ||
      (artifact.digest && artifact.digest !== metadata.digest)
    )
      throw new AppError(
        422,
        `${platform} artifact 来源、有效期、大小或 digest 不符合预期`,
      );
    const directory = await mkdtemp(join(tmpdir(), "nowen-rc-download-"));
    try {
      const path = join(directory, "artifact.zip");
      await github.downloadArtifact(
        artifact.id,
        path,
        signal,
        Math.min(metadata.size_in_bytes, ARCHIVE_LIMITS.archive),
      );
      signal.throwIfAborted();
      if ((await stat(path)).size !== metadata.size_in_bytes)
        throw new AppError(422, "artifact archive 大小不匹配");
      const manifest = await verifyArchive(
        path,
        {
          taskId: source.id,
          sha: source.plan.sha,
          version: source.plan.version,
          platform,
        },
        metadata.digest,
        signal,
      );
      results.push({
        artifactId: artifact.id,
        platform,
        archiveDigest: metadata.digest,
        verifiedAt: new Date().toISOString(),
        metadata: manifest.updaterVerification,
        files: manifest.files,
      });
      progress([...results]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  return results;
}
