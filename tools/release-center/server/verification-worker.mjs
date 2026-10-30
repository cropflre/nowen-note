import { parentPort, workerData } from "node:worker_threads";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createManifest } from "../../../scripts/release-center-assets.mjs";
import { verifyFormalDirectory } from "../../../scripts/release-center-formal-assets.mjs";

try {
  const { directory, context } = workerData;
  if (context.purpose === "formal-import") {
    const manifest = await verifyFormalDirectory(directory, context);
    parentPort.postMessage({ ok: true, manifest });
  } else {
  const original = JSON.parse(
    await readFile(join(directory, "release-center-manifest.json"), "utf8"),
  );
  if (
    original.schema !== 1 ||
    original.purpose !== "debug-only" ||
    original.signed !== false ||
    original.taskId !== context.taskId ||
    original.sha !== context.sha ||
    original.version !== context.version ||
    original.platform !== context.platform
  )
    throw Error("manifest 的任务、SHA、版本、平台或用途不匹配");
  const actual = await createManifest(directory, context);
  const expectedNames = new Set([
    ...actual.files.map((file) => file.name),
    "release-center-manifest.json",
  ]);
  const names = await readdir(directory);
  if (
    names.length !== expectedNames.size ||
    names.some((name) => !expectedNames.has(name))
  )
    throw Error("artifact 包含 manifest 以外的文件");
  const normalize = (files) =>
    files
      .map(({ name, architecture, size, sha256, updaterMetadata }) => ({
        name,
        architecture,
        size,
        sha256,
        updaterMetadata,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  if (
    !Array.isArray(original.files) ||
    !Array.isArray(original.updaterVerification) ||
    JSON.stringify(normalize(original.files)) !==
      JSON.stringify(normalize(actual.files)) ||
    JSON.stringify([...original.updaterVerification].sort()) !==
      JSON.stringify([...actual.updaterVerification].sort())
  )
    throw Error(
      "manifest 文件清单、大小、SHA-256 或更新元数据与实际内容不一致",
    );
  parentPort.postMessage({ ok: true, manifest: actual });
  }
} catch (error) {
  parentPort.postMessage({ ok: false, error: error.message || "产物校验失败" });
}
parentPort.close();
