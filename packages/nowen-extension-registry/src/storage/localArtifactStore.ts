import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ArtifactListPrefix, ArtifactStore, ArtifactStoreEntry } from "./artifactStore.js";
import {
  artifactKeyForDigest,
  assertArtifactKey,
  assertArtifactListPrefix,
  assertRemovableArtifactKey,
  assertSha256,
  assertStagedKey,
  createStagedKey,
} from "./artifactStore.js";

async function fileDigest(filePath: string): Promise<{ sha256: string; sizeBytes: number }> {
  const hash = crypto.createHash("sha256");
  let sizeBytes = 0;
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(bytes);
    sizeBytes += bytes.byteLength;
  }
  return { sha256: hash.digest("hex"), sizeBytes };
}

export class LocalArtifactStore implements ArtifactStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  async stage(operationId: string, bytes: Buffer): Promise<string> {
    if (bytes.byteLength === 0) throw new Error("artifact cannot be empty");
    const stagedKey = createStagedKey(operationId, crypto.randomUUID());
    const stagedPath = this.resolveStaged(stagedKey);
    const temporaryPath = `${stagedPath}.${crypto.randomUUID()}.tmp`;
    await fs.promises.mkdir(path.dirname(stagedPath), { recursive: true });
    try {
      await fs.promises.writeFile(temporaryPath, bytes, { flag: "wx", mode: 0o600 });
      await fs.promises.rename(temporaryPath, stagedPath);
      return stagedKey;
    } catch (error) {
      await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async commit(stagedKey: string, sha256: string): Promise<string> {
    assertSha256(sha256);
    const stagedPath = this.resolveStaged(stagedKey);
    const staged = await fileDigest(stagedPath);
    if (staged.sha256 !== sha256) throw new Error("staged artifact digest mismatch");
    const finalKey = artifactKeyForDigest(sha256);
    const finalPath = this.resolveArtifact(finalKey);
    await fs.promises.mkdir(path.dirname(finalPath), { recursive: true });
    try {
      await fs.promises.link(stagedPath, finalPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await fileDigest(finalPath);
      if (existing.sha256 !== sha256 || existing.sizeBytes !== staged.sizeBytes) {
        throw new Error("immutable artifact key already contains different content");
      }
    }
    await fs.promises.rm(stagedPath, { force: true });
    return finalKey;
  }

  async read(key: string): Promise<NodeJS.ReadableStream> {
    return fs.createReadStream(this.resolveArtifact(key));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fs.promises.access(this.resolveArtifact(key), fs.constants.R_OK);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async *list(prefix: ArtifactListPrefix): AsyncIterable<ArtifactStoreEntry> {
    assertArtifactListPrefix(prefix);
    const directory = path.join(this.root, ...prefix.slice(0, -1).split("/"));
    yield* this.walk(directory, prefix.slice(0, -1));
  }

  async remove(key: string): Promise<void> {
    assertRemovableArtifactKey(key);
    const resolved = key.startsWith("staging/") ? this.resolveStaged(key) : this.resolveArtifact(key);
    await fs.promises.rm(resolved, { force: true });
  }

  async removeStaged(stagedKey: string): Promise<void> {
    assertStagedKey(stagedKey);
    await this.remove(stagedKey);
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    const probeDirectory = path.join(this.root, "staging");
    const probe = path.join(probeDirectory, `.health-${crypto.randomUUID()}`);
    try {
      await fs.promises.mkdir(probeDirectory, { recursive: true });
      await fs.promises.writeFile(probe, "ok", { flag: "wx", mode: 0o600 });
      await fs.promises.access(probe, fs.constants.R_OK | fs.constants.W_OK);
      return { ok: true, detail: "local artifact store ready" };
    } catch (error) {
      return { ok: false, detail: (error as Error).message };
    } finally {
      await fs.promises.rm(probe, { force: true }).catch(() => undefined);
    }
  }

  private async *walk(directory: string, relativeDirectory: string): AsyncIterable<ArtifactStoreEntry> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(directory, entry.name);
      const relative = `${relativeDirectory}/${entry.name}`.replace(/\\/g, "/");
      if (entry.isDirectory()) {
        yield* this.walk(fullPath, relative);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = await fs.promises.stat(fullPath);
      yield { key: relative, sizeBytes: stat.size, lastModifiedAt: stat.mtime.toISOString() };
    }
  }

  private resolveArtifact(key: string): string {
    assertArtifactKey(key);
    return path.join(this.root, ...key.split("/"));
  }

  private resolveStaged(key: string): string {
    assertStagedKey(key);
    return path.join(this.root, ...key.split("/"));
  }
}
