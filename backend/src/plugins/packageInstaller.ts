import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { PluginPermissions } from "./permissions.js";
import { PluginRegistry } from "./registry.js";
import { validatePluginPackage, type ValidatedPluginPackage } from "./packageValidator.js";
import type { PluginManifest, PluginRegistryRecord, PluginSource, PluginTrustLevel } from "./types.js";

export interface ValidatedDevelopmentPlugin {
  absolute: string;
  manifest: PluginManifest;
  checksum: string;
}

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

function normalizeCompatibilityValidationError(error: unknown): never {
  const coded = error as Error & { code?: string; issues?: Array<{ path?: Array<string | number> }> };
  if (coded.code) throw coded;
  if (coded.message?.startsWith("插件要求 Nowen ")) {
    throw Object.assign(coded, { code: "PLUGIN_NOWEN_INCOMPATIBLE" });
  }
  if (coded.message?.startsWith("不支持 Plugin API V")) {
    throw Object.assign(coded, { code: "PLUGIN_API_VERSION_UNSUPPORTED" });
  }
  if (coded.issues?.some((issue) => issue.path?.[0] === "runtime" || issue.path?.[0] === "apiVersion")) {
    throw Object.assign(coded, { code: "PLUGIN_API_RUNTIME_INCOMPATIBLE" });
  }
  throw coded;
}

const PACKAGE_INTEGRITY_FILE = ".nowen-package.json";

function readPackageIntegrity(directory: string): { id?: string; version?: string; checksum?: string } | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(directory, PACKAGE_INTEGRITY_FILE), "utf8")) as {
      id?: string;
      version?: string;
      checksum?: string;
    };
  } catch {
    return null;
  }
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

  async inspect(bytes: Buffer): Promise<ValidatedPluginPackage> {
    try {
      return await validatePluginPackage(bytes);
    } catch (error) {
      normalizeCompatibilityValidationError(error);
    }
  }

  async installValidated(
    validated: ValidatedPluginPackage,
    installedBy: string,
    provenance: {
      source?: PluginSource;
      trustLevel?: PluginTrustLevel;
      publisherKeyId?: string;
      signature?: string;
      signatureState?: string;
      artifactUrl?: string;
      nodeRuntimeConfirmedBy?: string | null;
    } = {},
  ): Promise<PluginRegistryRecord> {
    if (this.registry.get(validated.manifest.id)) {
      throw Object.assign(new Error("已有插件必须通过更新协调器安装"), { code: "PLUGIN_UPDATE_COORDINATOR_REQUIRED" });
    }
    const operationId = crypto.randomUUID();
    let stagingPath: string | null = null;
    try {
      stagingPath = await this.stageValidated(validated, operationId);
      const destination = this.commitStaged(stagingPath, validated.manifest, validated.checksum);
      stagingPath = null;
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
        nodeRuntimeConfirmedBy: provenance.nodeRuntimeConfirmedBy,
      });
      this.permissions.initialize(validated.manifest);
      return record;
    } catch (error) {
      try { if (stagingPath) this.removeStaging(stagingPath); } catch { /* 尽力清理未完成 staging */ }
      throw error;
    }
  }

  async stageValidated(validated: ValidatedPluginPackage, operationId: string): Promise<string> {
    const stagingRoot = path.join(getPluginRoot(), "staging");
    const destination = path.join(stagingRoot, operationId);
    assertInside(stagingRoot, destination);
    if (fs.existsSync(destination)) {
      throw Object.assign(new Error("插件更新 staging 已存在"), { code: "PLUGIN_UPDATE_STAGING_EXISTS" });
    }
    await extract(validated.zip, destination);
    fs.writeFileSync(path.join(destination, PACKAGE_INTEGRITY_FILE), JSON.stringify({
      id: validated.manifest.id,
      version: validated.manifest.version,
      checksum: validated.checksum,
    }), { encoding: "utf8", flag: "wx" });
    return destination;
  }

  commitStaged(stagingPath: string, manifest: PluginManifest, checksum: string): string {
    const stagingRoot = path.join(getPluginRoot(), "staging");
    assertInside(stagingRoot, stagingPath);
    const versionsRoot = path.join(getPluginRoot(), "versions");
    const destination = path.join(versionsRoot, manifest.id, manifest.version);
    assertInside(versionsRoot, destination);
    const existing = this.registry.getVersion(manifest.id, manifest.version);
    const destinationExists = fs.existsSync(destination);
    if (existing || destinationExists) {
      const integrity = destinationExists ? readPackageIntegrity(destination) : null;
      const integrityMatches = integrity?.id === manifest.id
        && integrity.version === manifest.version
        && integrity.checksum === checksum;
      if (!destinationExists || !existing || existing.checksum !== checksum || !integrityMatches) {
        throw Object.assign(new Error("相同插件坐标对应不同内容"), { code: "PLUGIN_VERSION_COORDINATE_CONFLICT" });
      }
      this.removeStaging(stagingPath);
      return destination;
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.renameSync(stagingPath, destination);
    return destination;
  }

  removeStaging(stagingPath: string): void {
    const stagingRoot = path.join(getPluginRoot(), "staging");
    assertInside(stagingRoot, stagingPath);
    if (fs.existsSync(stagingPath)) fs.rmSync(stagingPath, { recursive: true, force: true });
  }

  removeUnregisteredVersion(manifest: PluginManifest, checksum: string): void {
    this.removeUnregisteredVersionCoordinate(manifest.id, manifest.version, checksum);
  }

  removeUnregisteredVersionCoordinate(pluginId: string, version: string, checksum: string): void {
    if (this.registry.getVersion(pluginId, version)) return;
    const versionsRoot = path.join(getPluginRoot(), "versions");
    const destination = path.join(versionsRoot, pluginId, version);
    assertInside(versionsRoot, destination);
    const integrity = readPackageIntegrity(destination);
    if (integrity?.id !== pluginId || integrity.version !== version || integrity.checksum !== checksum) return;
    if (fs.existsSync(destination)) fs.rmSync(destination, { recursive: true, force: true });
  }

  async inspectDevelopmentDirectory(directory: string): Promise<ValidatedDevelopmentPlugin> {
    const absolute = path.resolve(directory);
    const manifestPath = path.join(absolute, "manifest.json");
    if (!fs.statSync(absolute).isDirectory() || !fs.existsSync(manifestPath)) throw new Error("开发目录缺少 manifest.json");
    const { parsePluginManifest } = await import("./manifest.js");
    let manifest: PluginManifest;
    try {
      manifest = parsePluginManifest(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
    } catch (error) {
      normalizeCompatibilityValidationError(error);
    }
    const mainPath = path.resolve(absolute, manifest.main);
    assertInside(absolute, mainPath);
    if (!fs.existsSync(mainPath)) throw new Error(`插件入口不存在: ${manifest.main}`);
    const { createHash } = await import("node:crypto");
    const checksum = createHash("sha256").update(fs.readFileSync(manifestPath)).update(fs.readFileSync(mainPath)).digest("hex");
    return { absolute, manifest, checksum };
  }

  loadDevelopmentDirectory(
    validated: ValidatedDevelopmentPlugin,
    installedBy: string,
    nodeRuntimeConfirmedBy: string | null = null,
  ): PluginRegistryRecord {
    const { absolute, manifest, checksum } = validated;
    if (this.registry.get(manifest.id)) {
      throw Object.assign(new Error("开发插件 ID 已存在，请先卸载后重新加载"), { code: "PLUGIN_DEV_RELOAD_REQUIRES_UNINSTALL" });
    }
    const record = this.registry.upsert({
      manifest,
      source: "dev",
      trustLevel: "developer",
      status: "quarantined",
      checksum,
      installedPath: absolute,
      installedBy,
      nodeRuntimeConfirmedBy,
    });
    this.permissions.initialize(manifest);
    return record;
  }

  moveToInstalled(record: PluginRegistryRecord): PluginRegistryRecord {
    if (record.source === "dev") return record;
    const root = getPluginRoot();
    const versionsRoot = path.join(root, "versions");
    const destination = path.join(versionsRoot, record.id, record.version);
    assertInside(versionsRoot, destination);
    if (path.resolve(record.installedPath) !== path.resolve(destination)) {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      if (fs.existsSync(destination)) {
        const existing = this.registry.getVersion(record.id, record.version);
        if (!existing || existing.checksum !== record.checksum) {
          throw Object.assign(new Error("相同插件坐标对应不同内容"), { code: "PLUGIN_VERSION_COORDINATE_CONFLICT" });
        }
        fs.rmSync(record.installedPath, { recursive: true, force: true });
      } else {
        fs.renameSync(record.installedPath, destination);
      }
      this.registry.setPath(record.id, destination);
    }
    return this.registry.get(record.id)!;
  }

  removeFiles(record: PluginRegistryRecord): void {
    if (record.source === "dev") return;
    const root = getPluginRoot();
    for (const bucket of ["versions", "installed", "quarantine"]) {
      const pluginRoot = path.join(root, bucket, record.id);
      assertInside(root, pluginRoot);
      if (fs.existsSync(pluginRoot)) fs.rmSync(pluginRoot, { recursive: true, force: true });
    }
  }
}
