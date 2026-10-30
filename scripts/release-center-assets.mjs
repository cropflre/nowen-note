// Debug-only manifest. Does not publish, upload, or modify updater metadata.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const {
  verifyLocalDirectory,
  isUpdateMetadataName,
} = require("./lib/update-metadata-validator.cjs");
const {
  requiredDebugReleaseAssets,
} = require("./lib/release-platform-assets.cjs");

export async function createManifest(
  directory,
  { platform, taskId, sha, version },
) {
  if (
    !["windows", "macos", "linux"].includes(platform) ||
    !/^[a-f0-9-]{36}$/.test(taskId) ||
    !/^[a-f0-9]{40}$/.test(sha) ||
    !/^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/.test(version)
  )
    throw Error("Invalid debug manifest input");
  const entries = await readdir(directory);
  if (entries.some((n) => /\.appx$/i.test(n)))
    throw Error("Store artifacts cannot enter Full debug manifest");
  const names = entries.filter(
    (n) =>
      n !== "builder-debug.yml" &&
      /\.(exe|dmg|zip|AppImage|deb|blockmap|yml)$/.test(n),
  );
  const expected = requiredDebugReleaseAssets(platform, version);
  for (const name of expected)
    if (!names.includes(name)) throw Error(`Missing debug artifact: ${name}`);
  if (names.some((n) => /lite|appx/i.test(n)))
    throw Error("Store/Lite artifacts cannot enter Full debug manifest");
  for (const name of names) {
    if (
      !expected.includes(name) &&
      !expected.some((required) => name === `${required}.blockmap`)
    )
      throw Error(`Unexpected debug artifact: ${name}`);
    const stat = await lstat(join(directory, name));
    if (!stat.isFile() || stat.isSymbolicLink())
      throw Error(`Invalid artifact file: ${name}`);
  }
  const report = verifyLocalDirectory({
    directory,
    expectedVersion: version,
    requireMetadata: true,
  });
  const files = [];
  for (const name of names.sort()) {
    const path = join(directory, name);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw Error(`Invalid artifact file: ${name}`);
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(path)) digest.update(chunk);
    files.push({
      name,
      architecture: /arm64/.test(name)
        ? "arm64"
        : isUpdateMetadataName(name)
          ? "metadata"
          : "x64",
      size: stat.size,
      sha256: digest.digest("hex"),
      updaterMetadata: isUpdateMetadataName(name),
    });
  }
  const result = {
    schema: 1,
    purpose: "debug-only",
    taskId,
    sha,
    version,
    platform,
    signed: false,
    updaterVerification: report.metadataFiles,
    files,
  };
  await writeFile(
    join(directory, "release-center-manifest.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  return result;
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] || "")).href) {
  const directory = resolve("dist-electron");
  const manifest = await createManifest(directory, {
    platform: process.env.RC_PLATFORM,
    taskId: process.env.RC_TASK_ID,
    sha: process.env.RC_SHA,
    version: process.env.RC_VERSION,
  });
  const stage = join(directory, "rc-debug");
  await mkdir(stage, { recursive: true });
  for (const name of [
    ...manifest.files.map((file) => file.name),
    "release-center-manifest.json",
  ])
    await copyFile(join(directory, name), join(stage, name));
}
