import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZipFile } from "yazl";
import type { ArtifactContext } from "../server/verification.ts";
// @ts-expect-error Existing release scripts have no TypeScript declarations.
import { createManifest } from "../../../scripts/release-center-assets.mjs";

export async function zipBuffer(
  entries: { name: string; data: Buffer; mode?: number }[],
): Promise<Buffer> {
  const zip = new ZipFile();
  const chunks: Buffer[] = [];
  const result = new Promise<Buffer>((resolve, reject) => {
    zip.on("error", reject);
    zip.outputStream.on("error", reject);
    zip.outputStream.on("data", (chunk) => chunks.push(chunk));
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
  });
  for (const entry of entries)
    zip.addBuffer(entry.data, entry.name, {
      mode: entry.mode,
      mtime: new Date("2026-01-01T00:00:00Z"),
    });
  zip.end();
  return result;
}
export const archiveDigest = (data: Buffer) =>
  `sha256:${createHash("sha256").update(data).digest("hex")}`;

export async function buildArchive(
  context: ArtifactContext,
  mutate?: (directory: string) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "nowen-rc-archive-fixture-"));
  try {
    const binary = Buffer.from(
      "test fixture bytes; never an installable package",
    );
    const prefix = `Nowen-Note-${context.version}`;
    const installer =
      context.platform === "windows"
        ? `${prefix}-setup.exe`
        : `${prefix}-x86_64.AppImage`;
    const sha512 = createHash("sha512").update(binary).digest("base64");
    await writeFile(join(directory, installer), binary);
    if (context.platform === "windows") {
      await writeFile(join(directory, `${prefix}-portable.exe`), binary);
      await writeFile(
        join(directory, `${installer}.blockmap`),
        "blockmap fixture",
      );
    } else await writeFile(join(directory, `${prefix}-amd64.deb`), binary);
    const metadata =
      context.platform === "windows" ? "latest.yml" : "latest-linux.yml";
    await writeFile(
      join(directory, metadata),
      `version: ${context.version}\nfiles:\n  - url: ${installer}\n    sha512: ${sha512}\n    size: ${binary.length}\n${context.platform === "linux" ? "    blockMapSize: 8\n" : ""}path: ${installer}\nsha512: ${sha512}\n`,
    );
    await createManifest(directory, context);
    await mutate?.(directory);
    const entries = await Promise.all(
      (await readdir(directory)).map(async (name) => ({
        name,
        data: await readFile(join(directory, name)),
      })),
    );
    const archive = await zipBuffer(entries);
    return { archive, digest: archiveDigest(archive), context };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
