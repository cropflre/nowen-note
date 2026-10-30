import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ARCHIVE_LIMITS,
  verifyArchive,
  type ArtifactContext,
} from "../server/verification.ts";
import { buildArchive, zipBuffer, archiveDigest } from "./archive-fixture.ts";

const context = {
  taskId: randomUUID(),
  sha: "a".repeat(40),
  version: "1.5.2",
  platform: "windows" as const,
};
async function check(
  archive: Buffer,
  digest = archiveDigest(archive),
  limits = ARCHIVE_LIMITS,
  identity: ArtifactContext = context,
) {
  const directory = await mkdtemp(join(tmpdir(), "nowen-rc-verify-test-"));
  try {
    const path = join(directory, "archive.zip");
    await writeFile(path, archive);
    return await verifyArchive(
      path,
      identity,
      digest,
      new AbortController().signal,
      limits,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
test("real ZIP archive validates archive digest, manifest, every file and updater metadata", async () => {
  const { archive, digest } = await buildArchive(context);
  const manifest = await check(archive, digest);
  assert.equal(manifest.files.length, 4);
  assert.deepEqual(manifest.updaterVerification, ["latest.yml"]);
  assert.ok(manifest.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256)));
});
test("missing or mismatched archive digest is rejected before extraction", async () => {
  const { archive } = await buildArchive(context);
  await assert.rejects(check(archive, ""), /未提供有效/);
  await assert.rejects(
    check(archive, `sha256:${"0".repeat(64)}`),
    /SHA-256 不匹配/,
  );
});
test("manifest provenance, portable file SHA and update SHA-512 are independently verified", async () => {
  const mutations = [
    async (directory: string) => {
      const path = join(directory, "release-center-manifest.json");
      const value = JSON.parse(await readFile(path, "utf8"));
      value.sha = "c".repeat(40);
      await writeFile(path, JSON.stringify(value));
    },
    async (directory: string) =>
      writeFile(
        join(directory, "Nowen-Note-1.5.2-portable.exe"),
        "corrupt manual-download binary",
      ),
    async (directory: string) => {
      const path = join(directory, "latest.yml");
      await writeFile(
        path,
        (await readFile(path, "utf8")).replace(
          /sha512: .+/g,
          "sha512: corrupted",
        ),
      );
    },
  ];
  for (const mutate of mutations) {
    const { archive } = await buildArchive(context, mutate);
    await assert.rejects(check(archive), /不匹配|不一致|sha512 mismatch/);
  }
});
test("unlisted files, missing manifests and duplicate entries cannot be marked verified", async () => {
  const extra = await buildArchive(context, async (directory) => {
    await writeFile(join(directory, "payload.js"), "never executed");
  });
  await assert.rejects(check(extra.archive), /manifest 以外/);
  const missing = await buildArchive(context, (directory) =>
    rm(join(directory, "release-center-manifest.json")),
  );
  await assert.rejects(check(missing.archive), /ENOENT/);
  const duplicate = await zipBuffer([
    { name: "same.exe", data: Buffer.from("a") },
    { name: "SAME.exe", data: Buffer.from("b") },
  ]);
  await assert.rejects(check(duplicate), /重复文件/);
});
test("ZIP traversal, symlinks and decompression quotas fail without executing any file", async () => {
  const safe = await zipBuffer([
    { name: "safe.txt", data: Buffer.from("fixture") },
  ]);
  const traversal = Buffer.from(
    safe.toString("latin1").replaceAll("safe.txt", "../x.txt"),
    "latin1",
  );
  await assert.rejects(check(traversal), /invalid relative path|不安全路径/);
  const link = await zipBuffer([
    { name: "link.exe", data: Buffer.from("target"), mode: 0o120777 },
  ]);
  await assert.rejects(check(link), /链接/);
  const { archive } = await buildArchive(context);
  await assert.rejects(
    check(archive, archiveDigest(archive), { ...ARCHIVE_LIMITS, entries: 1 }),
    /超过上限/,
  );
  await assert.rejects(
    check(archive, archiveDigest(archive), { ...ARCHIVE_LIMITS, expanded: 1 }),
    /超过上限/,
  );
});
test("already cancelled verification never extracts or runs the hashing worker", async () => {
  const { archive, digest } = await buildArchive(context);
  const directory = await mkdtemp(join(tmpdir(), "nowen-rc-abort-test-"));
  try {
    const path = join(directory, "archive.zip");
    await writeFile(path, archive);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      verifyArchive(path, context, digest, controller.signal),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Linux verification accepts the actual x86_64 AppImage and amd64 Debian names", async () => {
  const identity = { ...context, platform: "linux" as const };
  const { archive, digest } = await buildArchive(identity);
  const manifest = await check(archive, digest, ARCHIVE_LIMITS, identity);
  assert.ok(
    manifest.files.some(
      (file) =>
        file.name === "Nowen-Note-1.5.2-x86_64.AppImage" &&
        file.architecture === "x64",
    ),
  );
  assert.ok(
    manifest.files.some(
      (file) =>
        file.name === "Nowen-Note-1.5.2-amd64.deb" &&
        file.architecture === "x64",
    ),
  );
  assert.deepEqual(manifest.updaterVerification, ["latest-linux.yml"]);
});
