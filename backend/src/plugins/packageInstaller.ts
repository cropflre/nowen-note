import fs from "node:fs";
import path from "node:path";
import { PluginPermissions } from "./permissions.js";
import { PluginRegistry } from "./registry.js";
import { validatePluginPackage, type ValidatedPluginPackage } from "./packageValidator.js";
import type { PluginRegistryRecord, PluginSource, PluginTrustLevel } from "./types.js";

export function getPluginRoot(): string {
  return path.join(process.env.ELECTRON_USER_DATA || path.join(process.cwd(), "data"), "plugins");
}

export function getPluginDevRoot(): string {
  return path.join(process.env.ELECTRON_USER_DATA || path.join(process.cwd(), "data"), "plugins-dev");
}

function assertInside(root: string, target: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("插件路径逃逸");
}

async function extract(zip: Awaited<ReturnType<typeof validatePluginPackage>>["zip"], destination: string): Promise<void> {
  fs.mkdirSync(destination, { recursive: true });
  for (const file of Object.values(zip.files)) {
    const normalized = file.name.replace(/\\/g, "/").replace(/\/$/, "");
    if (!normalized) continue;
    const target = path.join(destination, ...normalized.split("/"));
    assertInside(destination, target);
    if (file.dir) {
      fs.mkdirSync(target, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, await file.async("nodebuffer"), { flag: "wx" });
    }
  }
}

export class PluginPackageInstaller {
  constructor(
    private readonly registry = new PluginRegistry(),
    private readonly permissions = new PluginPermissions(),
  ) {}

  async install(bytes: Buffer, installedBy: string): Promise<PluginRegistryRecord> {
    return this.installValidated(await this.inspect(bytes), installedBy);
  }

  inspect(bytes: Buffer): Promise<ValidatedPluginPackage> {
    return validatePluginPackage(bytes);
  }

  async installValidated(
    validated: ValidatedPluginPackage,
    installedBy: string,
    provenance: { source?: PluginSource; trustLevel?: PluginTrustLevel; publisherKeyId?: string; signature?: string; signatureState?: "unsigned" | "verified"; artifactUrl?: string } = {},
  ): Promise<PluginRegistryRecord> {
    const root = getPluginRoot();
    const quarantineRoot = path.join(root, "quarantine");
    const destination = path.join(quarantineRoot, validated.manifest.id, validated.manifest.version);
    assertInside(quarantineRoot, destination);
    if (fs.existsSync(destination)) throw new Error("相同插件版本已存在，请先卸载");
    try {
      await extract(validated.zip, destination);
      const record = this.registry.upsert({
        manifest: validated.manifest,
        source: provenance.source || "package",
        trustLevel: provenance.trustLevel || "community",
        status: "quarantined",
        checksum: validated.checksum,
        installedPath: destination,
        installedBy,
        publisherKeyId: provenance.publisherKeyId,
        signature: provenance.signature,
        signatureState: provenance.signatureState,
        artifactUrl: provenance.artifactUrl,
      });
      this.permissions.initialize(validated.manifest);
      return record;
    } catch (error) {
      try { if (fs.existsSync(destination)) fs.rmSync(destination, { recursive: true, force: true }); } catch { /* best effort */ }
      throw error;
    }
  }

  async loadDevelopmentDirectory(directory: string, installedBy: string): Promise<PluginRegistryRecord> {
    const absolute = path.resolve(directory);
    const manifestPath = path.join(absolute, "manifest.json");
    if (!fs.statSync(absolute).isDirectory() || !fs.existsSync(manifestPath)) throw new Error("开发目录缺少 manifest.json");
    const { parsePluginManifest } = await import("./manifest.js");
    const manifest = parsePluginManifest(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
    const mainPath = path.resolve(absolute, manifest.main);
    assertInside(absolute, mainPath);
    if (!fs.existsSync(mainPath)) throw new Error(`插件入口不存在: ${manifest.main}`);
    const { createHash } = await import("node:crypto");
    const checksum = createHash("sha256").update(fs.readFileSync(manifestPath)).update(fs.readFileSync(mainPath)).digest("hex");
    const record = this.registry.upsert({ manifest, source: "dev", trustLevel: "developer", status: "quarantined", checksum, installedPath: absolute, installedBy });
    this.permissions.initialize(manifest);
    return record;
  }

  moveToInstalled(record: PluginRegistryRecord): PluginRegistryRecord {
    if (record.source === "dev") return record;
    const root = getPluginRoot();
    const installedRoot = path.join(root, "installed");
    const destination = path.join(installedRoot, record.id, record.version);
    assertInside(installedRoot, destination);
    if (path.resolve(record.installedPath) !== path.resolve(destination)) {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      if (fs.existsSync(destination)) fs.rmSync(destination, { recursive: true, force: true });
      fs.renameSync(record.installedPath, destination);
      this.registry.setPath(record.id, destination);
    }
    return this.registry.get(record.id)!;
  }

  removeFiles(record: PluginRegistryRecord): void {
    if (record.source === "dev") return;
    const root = getPluginRoot();
    for (const bucket of ["installed", "quarantine"]) {
      const pluginRoot = path.join(root, bucket, record.id);
      assertInside(root, pluginRoot);
      if (fs.existsSync(pluginRoot)) fs.rmSync(pluginRoot, { recursive: true, force: true });
    }
  }
}
