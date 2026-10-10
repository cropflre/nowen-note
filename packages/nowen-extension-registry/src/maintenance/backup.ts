import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { REGISTRY_OPERATION_LEASE_MIGRATION_VERSION } from "../db/operationLeaseMigration.js";

export const REGISTRY_BACKUP_FORMAT = 1;
export const SUPPORTED_REGISTRY_SCHEMA_VERSION = REGISTRY_OPERATION_LEASE_MIGRATION_VERSION;

export interface RegistryBackupManifest {
  format: 1;
  createdAt: string;
  databaseFile: string;
  databaseSha256: string;
  databaseBytes: number;
  schemaVersion: number;
  indexSequence: number;
  activeRootKeyId: string | null;
  artifactReferenceCount: number;
}

export interface RegistryBackupVerification {
  ok: boolean;
  schemaVersion: number;
  errors: string[];
  warnings: string[];
  databaseSha256: string;
  databaseBytes: number;
}

function escapeSqliteString(value: string): string {
  return value.replace(/'/g, "''");
}

async function fileSha256(filePath: string): Promise<{ sha256: string; bytes: number }> {
  const hash = crypto.createHash("sha256");
  let bytes = 0;
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(buffer);
    bytes += buffer.byteLength;
  }
  return { sha256: hash.digest("hex"), bytes };
}

function scalar(db: DatabaseSync, sql: string): number {
  const row = db.prepare(sql).get() as Record<string, unknown> | undefined;
  return Number(row ? Object.values(row)[0] || 0 : 0);
}

function stringScalar(db: DatabaseSync, sql: string): string | null {
  const row = db.prepare(sql).get() as Record<string, unknown> | undefined;
  const value = row ? Object.values(row)[0] : null;
  return typeof value === "string" ? value : null;
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function backupName(now = new Date()): string {
  return `registry-${now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}-${crypto.randomUUID().slice(0, 8)}`;
}

export async function createRegistryBackup(options: {
  sourceDbPath: string;
  outputDirectory: string;
}): Promise<{ databasePath: string; manifestPath: string; manifest: RegistryBackupManifest }> {
  const sourceDbPath = path.resolve(options.sourceDbPath);
  const outputDirectory = path.resolve(options.outputDirectory);
  const sourceStat = await fs.promises.stat(sourceDbPath).catch(() => null);
  if (!sourceStat?.isFile()) throw new Error("registry backup source database does not exist or is not a regular file");
  await fs.promises.mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const base = backupName();
  const databasePath = path.join(outputDirectory, `${base}.sqlite`);
  const manifestPath = path.join(outputDirectory, `${base}.manifest.json`);
  if (fs.existsSync(databasePath) || fs.existsSync(manifestPath)) throw new Error("backup destination already exists");

  const source = new DatabaseSync(sourceDbPath);
  try {
    source.exec("PRAGMA busy_timeout=5000");
    source.exec("PRAGMA wal_checkpoint(PASSIVE)");
    source.exec(`VACUUM INTO '${escapeSqliteString(databasePath)}'`);
  } finally {
    source.close();
  }
  await fs.promises.chmod(databasePath, 0o600).catch(() => undefined);

  const verification = await verifyRegistryDatabase(databasePath);
  if (!verification.ok) {
    await fs.promises.rm(databasePath, { force: true }).catch(() => undefined);
    throw new Error(`backup snapshot verification failed: ${verification.errors.join("; ")}`);
  }
  const snapshot = new DatabaseSync(databasePath, { readOnly: true });
  let manifest: RegistryBackupManifest;
  try {
    const indexSequence = tableExists(snapshot, "registry_metadata_sequence")
      ? scalar(snapshot, "SELECT COALESCE(sequence,0) FROM registry_metadata_sequence WHERE documentType='index'")
      : 0;
    const activeRootKeyId = tableExists(snapshot, "registry_root_chain")
      ? stringScalar(snapshot, "SELECT keyId FROM registry_root_chain WHERE state='active' LIMIT 1")
      : null;
    const artifactReferenceCount = tableExists(snapshot, "extension_versions")
      ? scalar(snapshot, "SELECT COUNT(*) FROM extension_versions")
      : 0;
    manifest = {
      format: REGISTRY_BACKUP_FORMAT,
      createdAt: new Date().toISOString(),
      databaseFile: path.basename(databasePath),
      databaseSha256: verification.databaseSha256,
      databaseBytes: verification.databaseBytes,
      schemaVersion: verification.schemaVersion,
      indexSequence,
      activeRootKeyId,
      artifactReferenceCount,
    };
  } finally {
    snapshot.close();
  }
  await fs.promises.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return { databasePath, manifestPath, manifest };
}

export async function verifyRegistryDatabase(databasePath: string): Promise<RegistryBackupVerification> {
  const absolute = path.resolve(databasePath);
  const errors: string[] = [];
  const warnings: string[] = [];
  const digest = await fileSha256(absolute);
  let db: DatabaseSync | undefined;
  let schemaVersion = 0;
  try {
    db = new DatabaseSync(absolute, { readOnly: true });
    const integrity = db.prepare("PRAGMA integrity_check").all() as Array<Record<string, unknown>>;
    const integrityValues = integrity.map((row) => String(Object.values(row)[0] || ""));
    if (integrityValues.length !== 1 || integrityValues[0] !== "ok") errors.push(`SQLite integrity_check failed: ${integrityValues.join(", ")}`);
    const foreignKeyFailures = db.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeyFailures.length) errors.push(`SQLite foreign_key_check reported ${foreignKeyFailures.length} violation(s)`);
    if (!tableExists(db, "registry_schema_migrations")) errors.push("registry_schema_migrations table is missing");
    else {
      schemaVersion = scalar(db, "SELECT COALESCE(MAX(version),0) FROM registry_schema_migrations");
      if (schemaVersion > SUPPORTED_REGISTRY_SCHEMA_VERSION) errors.push(`backup schema v${schemaVersion} is newer than supported v${SUPPORTED_REGISTRY_SCHEMA_VERSION}`);
      if (schemaVersion <= 0) errors.push("registry schema version is missing");
    }
    if (tableExists(db, "registry_root_chain")) {
      const activeRoots = scalar(db, "SELECT COUNT(*) FROM registry_root_chain WHERE state='active'");
      if (activeRoots > 1) errors.push("registry root chain contains multiple active roots");
      if (activeRoots === 0) warnings.push("registry root chain has no active root");
    }
    if (tableExists(db, "extension_versions") && tableExists(db, "artifact_objects")) {
      const mismatched = scalar(db, `SELECT COUNT(*) FROM extension_versions ev JOIN artifact_objects ao ON ao.sha256=ev.sha256
        WHERE ao.storageKey<>ev.artifactKey OR ao.sizeBytes<>ev.sizeBytes`);
      if (mismatched) errors.push(`${mismatched} extension version(s) conflict with artifact object metadata`);
      const missing = scalar(db, `SELECT COUNT(*) FROM extension_versions ev LEFT JOIN artifact_objects ao ON ao.sha256=ev.sha256 WHERE ao.sha256 IS NULL`);
      if (missing) warnings.push(`${missing} extension version(s) have no artifact_objects metadata row; verify object storage before restore`);
    }
  } catch (error) {
    errors.push(`cannot open or inspect registry database: ${(error as Error).message}`);
  } finally {
    db?.close();
  }
  return { ok: errors.length === 0, schemaVersion, errors, warnings, databaseSha256: digest.sha256, databaseBytes: digest.bytes };
}

export async function verifyRegistryBackup(databasePath: string, manifestPath: string): Promise<RegistryBackupVerification> {
  const verification = await verifyRegistryDatabase(databasePath);
  try {
    const raw = await fs.promises.readFile(manifestPath, "utf8");
    const manifest = JSON.parse(raw) as Partial<RegistryBackupManifest>;
    if (manifest.format !== REGISTRY_BACKUP_FORMAT) verification.errors.push("backup manifest format is unsupported");
    if (manifest.databaseFile !== path.basename(databasePath)) verification.errors.push("backup manifest database filename does not match");
    if (manifest.databaseSha256 !== verification.databaseSha256) verification.errors.push("backup database SHA-256 does not match manifest");
    if (manifest.databaseBytes !== verification.databaseBytes) verification.errors.push("backup database size does not match manifest");
    if (manifest.schemaVersion !== verification.schemaVersion) verification.errors.push("backup schema version does not match manifest");
  } catch (error) {
    verification.errors.push(`backup manifest is invalid: ${(error as Error).message}`);
  }
  verification.ok = verification.errors.length === 0;
  return verification;
}

export async function restoreRegistryBackup(options: {
  databasePath: string;
  manifestPath: string;
  targetDbPath: string;
  apply: boolean;
}): Promise<{ applied: boolean; previousDatabasePath?: string; verification: RegistryBackupVerification }> {
  const databasePath = path.resolve(options.databasePath);
  const targetDbPath = path.resolve(options.targetDbPath);
  const verification = await verifyRegistryBackup(databasePath, path.resolve(options.manifestPath));
  if (!verification.ok) throw new Error(`backup verification failed: ${verification.errors.join("; ")}`);
  if (!options.apply) return { applied: false, verification };
  if (databasePath === targetDbPath) throw new Error("backup database and restore target must be different files");
  if (fs.existsSync(`${targetDbPath}-wal`) || fs.existsSync(`${targetDbPath}-shm`)) {
    throw new Error("restore target appears active or unclean; stop the Registry and remove/checkpoint WAL/SHM before restoring");
  }

  await fs.promises.mkdir(path.dirname(targetDbPath), { recursive: true, mode: 0o700 });
  const temporary = `${targetDbPath}.restore-${crypto.randomUUID()}.tmp`;
  await fs.promises.copyFile(databasePath, temporary, fs.constants.COPYFILE_EXCL);
  await fs.promises.chmod(temporary, 0o600).catch(() => undefined);
  const copied = await fileSha256(temporary);
  if (copied.sha256 !== verification.databaseSha256 || copied.bytes !== verification.databaseBytes) {
    await fs.promises.rm(temporary, { force: true });
    throw new Error("restore staging copy checksum mismatch");
  }

  let previousDatabasePath: string | undefined;
  if (fs.existsSync(targetDbPath)) {
    previousDatabasePath = `${targetDbPath}.pre-restore-${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`;
    await fs.promises.rename(targetDbPath, previousDatabasePath);
  }
  try {
    await fs.promises.rename(temporary, targetDbPath);
  } catch (error) {
    await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
    if (previousDatabasePath && !fs.existsSync(targetDbPath)) await fs.promises.rename(previousDatabasePath, targetDbPath).catch(() => undefined);
    throw error;
  }
  return { applied: true, ...(previousDatabasePath ? { previousDatabasePath } : {}), verification };
}
