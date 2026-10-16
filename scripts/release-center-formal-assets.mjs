// Read-only validation of the existing release.yml's Full + Lite desktop artifacts.
import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { requiredDebugReleaseAssets } = require("./lib/release-platform-assets.cjs");
const { verifyLocalDirectory, isUpdateMetadataName } = require("./lib/update-metadata-validator.cjs");

export async function verifyFormalDirectory(directory, { platform, version }) {
  const expected = [...requiredDebugReleaseAssets(platform, version)];
  if (platform === "windows") expected.push(
    `Nowen-Note-Lite-${version}-setup.exe`, `Nowen-Note-Lite-${version}-portable.exe`,
    `Nowen-Note-Lite-${version}-setup.exe.blockmap`, "latest-lite.yml",
  );
  const names = await readdir(directory);
  if (expected.some((name) => !names.includes(name))) throw Error("正式产物缺少必要文件或 Lite 更新元数据");
  const allowed = new Set([...expected, ...expected.filter((n) => /\.(dmg|zip)$/.test(n)).map((n) => `${n}.blockmap`)]);
  if (names.some((name) => !allowed.has(name))) throw Error("正式产物含清单外文件；不能混入调试 manifest 或 Store 包");
  const report = verifyLocalDirectory({ directory, expectedVersion: version, requireMetadata: true });
  const files = [];
  for (const name of names.sort()) {
    const path = join(directory, name);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) throw Error("无效正式产物文件");
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    files.push({ name, size: stat.size, sha256: hash.digest("hex"),
      architecture: isUpdateMetadataName(name) ? "metadata" : /arm64/.test(name) ? "arm64" : "x64", updaterMetadata: isUpdateMetadataName(name) });
  }
  return { files, updaterVerification: report.metadataFiles };
}
