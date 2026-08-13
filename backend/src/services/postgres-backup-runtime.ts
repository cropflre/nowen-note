import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import JSZip from "jszip";

import type { DatabaseAdapter } from "../db/adapters/types";
import { getDatabaseAdapter } from "../db/runtime";

const POSTGRES_BACKUP_FORMAT_VERSION = 3;
const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;
const MANIFEST_SUFFIX = ".meta.json";

type BackupType = "db-only" | "full";

type ProcessResult = {
  stdout: string;
  stderr: string;
};

export interface ProcessRunOptions {
  env: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface ProcessRunner {
  run(command: string, args: string[], options: ProcessRunOptions): Promise<ProcessResult>;
}

export interface PostgresBackupRuntimeOptions {
  adapter?: DatabaseAdapter;
  databaseUrl?: string;
  backupDir?: string;
  dataDir?: string;
  appVersion?: string;
  pgDumpPath?: string;
  pgRestorePath?: string;
  processRunner?: ProcessRunner;
  now?: () => Date;
  randomId?: () => string;
}

export interface BackupFileSummary {
  count: number;
  bytes: number;
  checksum: string;
}

export interface PostgresBackupManifest {
  formatVersion: number;
  backupType: BackupType;
  createdAt: string;
  applicationVersion: string;
  description?: string;
  database: {
    driver: "postgres";
    dumpFile: "database.dump";
    dumpFormat: "custom";
    checksum: string;
    schemaVersion: string | null;
    postgresVersion: string;
    pgDumpVersion: string;
    tables: Record<string, number>;
  };
  files: {
    attachments: BackupFileSummary;
    fonts: BackupFileSummary;
    plugins: BackupFileSummary;
  };
  secrets: {
    jwtSecretIncluded: boolean;
  };
}

export interface PostgresBackupInfo {
  id: string;
  filename: string;
  size: number;
  type: BackupType;
  createdAt: string;
  noteCount: number;
  notebookCount: number;
  checksum: string;
  formatVersion: number;
  schemaVersion: string | null;
  databaseDriver: "postgres";
  description?: string;
  manifest: PostgresBackupManifest;
}

export interface PostgresBackupDryRun {
  success: true;
  dryRun: {
    databaseDriver: "postgres";
    backupType: BackupType;
    schemaVersion: string | null;
    applicationVersion: string;
    tables: Record<string, number>;
    files: PostgresBackupManifest["files"];
    checksumVerified: true;
    restoreToolVersion: string;
  };
}

export class PostgresBackupRuntimeError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: 400 | 403 | 404 | 500 | 503,
  ) {
    super(message);
    this.name = "PostgresBackupRuntimeError";
  }
}

function redactSecrets(value: string): string {
  return value
    .replace(/(postgres(?:ql)?:\/\/[^:\s/@]+:)[^@\s]+@/gi, "$1***@")
    .replace(/(password=)[^\s]+/gi, "$1***");
}

class SpawnProcessRunner implements ProcessRunner {
  async run(command: string, args: string[], options: ProcessRunOptions): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      const append = (current: string, chunk: Buffer): string => {
        if (Buffer.byteLength(current) >= MAX_PROCESS_OUTPUT_BYTES) return current;
        return (current + chunk.toString("utf8")).slice(0, MAX_PROCESS_OUTPUT_BYTES);
      };
      child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
      child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
      child.once("error", (error) => {
        reject(new PostgresBackupRuntimeError(
          `无法启动 ${path.basename(command)}：${redactSecrets(error.message)}`,
          "POSTGRES_BACKUP_TOOL_UNAVAILABLE",
          503,
        ));
      });
      child.once("close", (code) => {
        if (code === 0) {
          resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
          return;
        }
        reject(new PostgresBackupRuntimeError(
          `${path.basename(command)} 执行失败（退出码 ${code ?? "unknown"}）：${redactSecrets(stderr || stdout || "无错误输出")}`,
          "POSTGRES_BACKUP_TOOL_FAILED",
          500,
        ));
      });
    });
  }
}

function sha256(content: Buffer | string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function safeTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function safeOperationId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || crypto.randomUUID();
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function resolveDirectory(value: string | undefined, fallback: string): string {
  return path.resolve(value?.trim() || fallback);
}

function safeBackupPath(backupDir: string, filename: string): string | null {
  const safeName = path.basename(filename || "");
  if (!safeName || safeName !== filename) return null;
  const candidate = path.resolve(backupDir, safeName);
  return path.dirname(candidate) === path.resolve(backupDir) ? candidate : null;
}

function isRegularFile(candidate: string): boolean {
  try {
    const stat = fs.lstatSync(candidate);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function connectionEnvironment(databaseUrl: string, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new PostgresBackupRuntimeError(
      "DATABASE_URL 不是合法的 PostgreSQL URL",
      "POSTGRES_BACKUP_DATABASE_URL_INVALID",
      503,
    );
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new PostgresBackupRuntimeError(
      "DATABASE_URL 必须使用 postgres:// 或 postgresql://",
      "POSTGRES_BACKUP_DATABASE_URL_INVALID",
      503,
    );
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!parsed.hostname || !database) {
    throw new PostgresBackupRuntimeError(
      "DATABASE_URL 缺少主机或数据库名",
      "POSTGRES_BACKUP_DATABASE_URL_INVALID",
      503,
    );
  }
  const env: NodeJS.ProcessEnv = {
    ...base,
    PGHOST: parsed.hostname,
    PGPORT: parsed.port || "5432",
    PGUSER: decodeURIComponent(parsed.username || ""),
    PGDATABASE: database,
    PGPASSWORD: decodeURIComponent(parsed.password || ""),
  };
  const sslMode = parsed.searchParams.get("sslmode");
  if (sslMode) env.PGSSLMODE = sslMode;
  return env;
}

function ensureWritableDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true });
  const probe = path.join(directory, `.nowen-backup-probe-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(probe, "ok", { flag: "wx" });
  } catch (error) {
    throw new PostgresBackupRuntimeError(
      `备份目录不可写：${error instanceof Error ? error.message : String(error)}`,
      "POSTGRES_BACKUP_DIR_NOT_WRITABLE",
      503,
    );
  } finally {
    try { fs.unlinkSync(probe); } catch { /* ignore */ }
  }
}

function addDirectoryToZip(zip: JSZip, source: string, target: string): BackupFileSummary {
  const entries: Array<{ name: string; checksum: string; bytes: number }> = [];
  const root = zip.folder(target);
  if (!root) return { count: 0, bytes: 0, checksum: sha256("") };
  if (!fs.existsSync(source)) {
    root.file(".keep", "");
    return { count: 0, bytes: 0, checksum: sha256("") };
  }
  const walk = (directory: string, relativeBase: string) => {
    const children = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const absolute = path.join(directory, child.name);
      const relative = path.posix.join(relativeBase, child.name);
      if (child.isDirectory()) {
        walk(absolute, relative);
      } else if (child.isFile()) {
        const content = fs.readFileSync(absolute);
        root.file(relative, content);
        entries.push({ name: relative, checksum: sha256(content), bytes: content.length });
      }
    }
  };
  walk(source, "");
  if (entries.length === 0) root.file(".keep", "");
  return {
    count: entries.length,
    bytes: entries.reduce((total, entry) => total + entry.bytes, 0),
    checksum: sha256(entries.map((entry) => `${entry.name}:${entry.bytes}:${entry.checksum}`).join("\n")),
  };
}

function emptyFileSummary(): BackupFileSummary {
  return { count: 0, bytes: 0, checksum: sha256("") };
}

async function summarizeZipDirectory(zip: JSZip, target: string): Promise<BackupFileSummary> {
  const prefix = `${target.replace(/\/+$/, "")}/`;
  const entries = Object.entries(zip.files)
    .filter(([name, file]) => name.startsWith(prefix) && !file.dir)
    .map(([name, file]) => ({ name: name.slice(prefix.length), file }))
    .filter((entry) => entry.name && entry.name !== ".keep")
    .sort((left, right) => left.name.localeCompare(right.name));
  const details: Array<{ name: string; checksum: string; bytes: number }> = [];
  for (const entry of entries) {
    const content = await entry.file.async("nodebuffer");
    details.push({ name: entry.name, checksum: sha256(content), bytes: content.length });
  }
  return {
    count: details.length,
    bytes: details.reduce((total, entry) => total + entry.bytes, 0),
    checksum: sha256(details.map((entry) => `${entry.name}:${entry.bytes}:${entry.checksum}`).join("\n")),
  };
}

function sameFileSummary(left: BackupFileSummary, right: BackupFileSummary): boolean {
  return left.count === right.count && left.bytes === right.bytes && left.checksum === right.checksum;
}

function parseBackupJson<T>(source: string, label: string): T {
  try {
    return JSON.parse(source) as T;
  } catch (error) {
    throw new PostgresBackupRuntimeError(
      `${label} 解析失败：${error instanceof Error ? error.message : String(error)}`,
      "POSTGRES_BACKUP_MANIFEST_INVALID",
      400,
    );
  }
}

function validFileSummary(value: unknown): value is BackupFileSummary {
  if (!value || typeof value !== "object") return false;
  const summary = value as Partial<BackupFileSummary>;
  return Number.isInteger(summary.count)
    && Number(summary.count) >= 0
    && Number.isFinite(summary.bytes)
    && Number(summary.bytes) >= 0
    && typeof summary.checksum === "string"
    && /^[a-f0-9]{64}$/i.test(summary.checksum);
}

function assertManifestStructure(manifest: PostgresBackupManifest): void {
  if (
    !manifest
    || typeof manifest !== "object"
    || typeof manifest.formatVersion !== "number"
    || !["db-only", "full"].includes(manifest.backupType)
    || manifest.database?.driver !== "postgres"
    || manifest.database?.dumpFormat !== "custom"
    || typeof manifest.database?.checksum !== "string"
    || !/^[a-f0-9]{64}$/i.test(manifest.database.checksum)
    || !manifest.files
    || !validFileSummary(manifest.files.attachments)
    || !validFileSummary(manifest.files.fonts)
    || !validFileSummary(manifest.files.plugins)
    || typeof manifest.secrets?.jwtSecretIncluded !== "boolean"
  ) {
    throw new PostgresBackupRuntimeError(
      "PostgreSQL 备份清单结构无效",
      "POSTGRES_BACKUP_MANIFEST_INVALID",
      400,
    );
  }
}

export function createPostgresBackupRuntime(options: PostgresBackupRuntimeOptions = {}) {
  const adapter = options.adapter ?? getDatabaseAdapter();
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL ?? "";
  const dataDir = resolveDirectory(
    options.dataDir,
    process.env.ELECTRON_USER_DATA || path.join(process.cwd(), "data"),
  );
  const backupDir = resolveDirectory(
    options.backupDir,
    process.env.BACKUP_DIR || path.join(dataDir, "backups"),
  );
  const appVersion = options.appVersion
    ?? process.env.APP_VERSION
    ?? process.env.npm_package_version
    ?? "unknown";
  const pgDumpPath = options.pgDumpPath ?? process.env.PG_DUMP_PATH ?? "pg_dump";
  const pgRestorePath = options.pgRestorePath ?? process.env.PG_RESTORE_PATH ?? "pg_restore";
  const runner = options.processRunner ?? new SpawnProcessRunner();
  const now = options.now ?? (() => new Date());
  const randomId = options.randomId ?? crypto.randomUUID;

  const pgEnv = () => connectionEnvironment(databaseUrl, process.env);

  async function toolVersion(command: string): Promise<string> {
    const result = await runner.run(command, ["--version"], { env: pgEnv() });
    return result.stdout || result.stderr || "unknown";
  }

  async function assertAdmin(userId: string): Promise<void> {
    const user = await adapter.queryOne<{ role: string; isDisabled: boolean | number }>(
      `SELECT role, "isDisabled" AS "isDisabled" FROM users WHERE id = ?`,
      [userId],
    );
    if (!user || user.isDisabled === true || user.isDisabled === 1 || user.role !== "admin") {
      throw new PostgresBackupRuntimeError("需要系统管理员权限", "FORBIDDEN", 403);
    }
  }

  async function readTableCounts(): Promise<Record<string, number>> {
    const tables = await adapter.queryMany<{ tableName: string }>(`
      SELECT table_name AS "tableName"
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);
    const counts: Record<string, number> = {};
    for (const table of tables) {
      const row = await adapter.queryOne<{ count: string | number }>(
        `SELECT COUNT(*)::bigint AS count FROM ${quoteIdentifier(table.tableName)}`,
      );
      const count = Number(row?.count ?? 0);
      counts[table.tableName] = Number.isSafeInteger(count) ? count : 0;
    }
    return counts;
  }

  async function readDatabaseMetadata(): Promise<{
    schemaVersion: string | null;
    postgresVersion: string;
  }> {
    const [migration, server] = await Promise.all([
      adapter.queryOne<{ version: string }>(
        `SELECT version FROM postgres_schema_migrations ORDER BY version DESC LIMIT 1`,
      ),
      adapter.queryOne<{ version: string }>(`SELECT current_setting('server_version') AS version`),
    ]);
    return {
      schemaVersion: migration?.version ?? null,
      postgresVersion: server?.version ?? "unknown",
    };
  }

  async function createDump(target: string): Promise<string> {
    const version = await toolVersion(pgDumpPath);
    await runner.run(
      pgDumpPath,
      [
        "--format=custom",
        "--no-owner",
        "--no-privileges",
        "--file",
        target,
      ],
      { env: pgEnv() },
    );
    if (!fs.existsSync(target) || fs.statSync(target).size === 0) {
      throw new PostgresBackupRuntimeError(
        "pg_dump 未生成有效备份文件",
        "POSTGRES_BACKUP_EMPTY_DUMP",
        500,
      );
    }
    return version;
  }

  async function health(userId: string) {
    await assertAdmin(userId);
    ensureWritableDirectory(backupDir);
    const [pgDumpVersion, pgRestoreVersion, database] = await Promise.all([
      toolVersion(pgDumpPath),
      toolVersion(pgRestorePath),
      readDatabaseMetadata(),
    ]);
    return {
      ok: true,
      databaseDriver: "postgres" as const,
      backupDir,
      pgDumpVersion,
      pgRestoreVersion,
      postgresVersion: database.postgresVersion,
      schemaVersion: database.schemaVersion,
      dbOnlyReady: true,
      fullReady: true,
      dryRunRestoreReady: true,
      restoreApplyReady: false,
    };
  }

  async function createBackup(
    userId: string,
    input: { type?: BackupType; description?: string } = {},
  ): Promise<PostgresBackupInfo> {
    await assertAdmin(userId);
    ensureWritableDirectory(backupDir);
    const type: BackupType = input.type === "full" ? "full" : "db-only";
    const createdAt = now().toISOString();
    const id = safeOperationId(randomId());
    const baseName = `nowen-backup-postgres-${type}-${safeTimestamp(new Date(createdAt))}-${id.slice(0, 8)}`;
    const filename = `${baseName}${type === "full" ? ".zip" : ".pgdump"}`;
    const finalPath = path.join(backupDir, filename);
    const tempDump = path.join(os.tmpdir(), `.nowen-pgdump-${id}.dump`);
    const tempArtifact = `${finalPath}.tmp-${id}`;

    try {
      const pgDumpVersion = await createDump(tempDump);
      const dump = fs.readFileSync(tempDump);
      const [tables, database] = await Promise.all([
        readTableCounts(),
        readDatabaseMetadata(),
      ]);
      let files = {
        attachments: emptyFileSummary(),
        fonts: emptyFileSummary(),
        plugins: emptyFileSummary(),
      };
      let jwtSecretIncluded = false;
      const manifestBase = {
        formatVersion: POSTGRES_BACKUP_FORMAT_VERSION,
        backupType: type,
        createdAt,
        applicationVersion: appVersion,
        ...(input.description?.trim() ? { description: input.description.trim().slice(0, 500) } : {}),
        database: {
          driver: "postgres" as const,
          dumpFile: "database.dump" as const,
          dumpFormat: "custom" as const,
          checksum: sha256(dump),
          schemaVersion: database.schemaVersion,
          postgresVersion: database.postgresVersion,
          pgDumpVersion,
          tables,
        },
      };

      let manifest: PostgresBackupManifest;
      if (type === "full") {
        const zip = new JSZip();
        zip.file("database.dump", dump);
        files = {
          attachments: addDirectoryToZip(zip, path.join(dataDir, "attachments"), "attachments"),
          fonts: addDirectoryToZip(zip, path.join(dataDir, "fonts"), "fonts"),
          plugins: addDirectoryToZip(zip, path.join(dataDir, "plugins"), "plugins"),
        };
        const secretPath = path.join(dataDir, ".jwt_secret");
        if (fs.existsSync(secretPath) && fs.statSync(secretPath).isFile()) {
          zip.file(".jwt_secret", fs.readFileSync(secretPath));
          jwtSecretIncluded = true;
        }
        manifest = {
          ...manifestBase,
          files,
          secrets: { jwtSecretIncluded },
        };
        zip.file("meta.json", JSON.stringify(manifest, null, 2));
        const archive = await zip.generateAsync({
          type: "nodebuffer",
          compression: "DEFLATE",
          compressionOptions: { level: 6 },
        });
        fs.writeFileSync(tempArtifact, archive, { flag: "wx" });
      } else {
        manifest = {
          ...manifestBase,
          files,
          secrets: { jwtSecretIncluded },
        };
        fs.copyFileSync(tempDump, tempArtifact, fs.constants.COPYFILE_EXCL);
      }
      fs.renameSync(tempArtifact, finalPath);
      const artifact = fs.readFileSync(finalPath);
      const info: PostgresBackupInfo = {
        id,
        filename,
        size: artifact.length,
        type,
        createdAt,
        noteCount: tables.notes ?? 0,
        notebookCount: tables.notebooks ?? 0,
        checksum: sha256(artifact),
        formatVersion: POSTGRES_BACKUP_FORMAT_VERSION,
        schemaVersion: database.schemaVersion,
        databaseDriver: "postgres",
        description: input.description?.trim().slice(0, 500) || undefined,
        manifest,
      };
      fs.writeFileSync(`${finalPath}${MANIFEST_SUFFIX}`, JSON.stringify(info, null, 2), {
        encoding: "utf8",
        flag: "wx",
      });
      return info;
    } catch (error) {
      try { fs.rmSync(tempArtifact, { force: true }); } catch { /* ignore */ }
      try { fs.rmSync(finalPath, { force: true }); } catch { /* ignore */ }
      try { fs.rmSync(`${finalPath}${MANIFEST_SUFFIX}`, { force: true }); } catch { /* ignore */ }
      throw error;
    } finally {
      try { fs.rmSync(tempDump, { force: true }); } catch { /* ignore */ }
    }
  }

  async function listBackups(userId: string): Promise<PostgresBackupInfo[]> {
    await assertAdmin(userId);
    ensureWritableDirectory(backupDir);
    return fs.readdirSync(backupDir)
      .filter((name) => name.endsWith(MANIFEST_SUFFIX))
      .map((name) => {
        try {
          return parseBackupJson<PostgresBackupInfo>(
            fs.readFileSync(path.join(backupDir, name), "utf8"),
            "PostgreSQL 备份索引",
          );
        } catch {
          return null;
        }
      })
      .filter((item): item is PostgresBackupInfo => Boolean(
        item
        && item.databaseDriver === "postgres"
        && safeBackupPath(backupDir, item.filename)
        && isRegularFile(path.join(backupDir, item.filename)),
      ))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async function getBackupPath(userId: string, filename: string): Promise<string> {
    await assertAdmin(userId);
    const candidate = safeBackupPath(backupDir, filename);
    if (!candidate || !isRegularFile(candidate)) {
      throw new PostgresBackupRuntimeError("备份不存在", "POSTGRES_BACKUP_NOT_FOUND", 404);
    }
    return candidate;
  }

  async function readAndValidateManifest(filename: string): Promise<{
    manifest: PostgresBackupManifest;
    dump: Buffer;
    backupType: BackupType;
  }> {
    const candidate = safeBackupPath(backupDir, filename);
    if (!candidate || !isRegularFile(candidate)) {
      throw new PostgresBackupRuntimeError("备份不存在", "POSTGRES_BACKUP_NOT_FOUND", 404);
    }
    const sidecar = `${candidate}${MANIFEST_SUFFIX}`;
    if (!isRegularFile(sidecar)) {
      throw new PostgresBackupRuntimeError(
        "PostgreSQL 备份缺少元数据清单",
        "POSTGRES_BACKUP_MANIFEST_MISSING",
        400,
      );
    }
    const artifact = fs.readFileSync(candidate);
    const info = parseBackupJson<PostgresBackupInfo>(
      fs.readFileSync(sidecar, "utf8"),
      "PostgreSQL 备份元数据",
    );
    if (info.filename !== filename || info.databaseDriver !== "postgres") {
      throw new PostgresBackupRuntimeError(
        "PostgreSQL 备份清单与文件不匹配",
        "POSTGRES_BACKUP_MANIFEST_MISMATCH",
        400,
      );
    }
    if (sha256(artifact) !== info.checksum) {
      throw new PostgresBackupRuntimeError(
        "PostgreSQL 备份文件 checksum 校验失败，备份可能已损坏",
        "POSTGRES_BACKUP_CHECKSUM_MISMATCH",
        400,
      );
    }
    if (filename.endsWith(".zip")) {
      let zip: JSZip;
      try {
        zip = await JSZip.loadAsync(artifact);
      } catch (error) {
        throw new PostgresBackupRuntimeError(
          `PostgreSQL 全量备份 ZIP 解析失败：${error instanceof Error ? error.message : String(error)}`,
          "POSTGRES_BACKUP_INVALID_ARCHIVE",
          400,
        );
      }
      const metaFile = zip.file("meta.json");
      const dumpFile = zip.file("database.dump");
      if (!metaFile || !dumpFile) {
        throw new PostgresBackupRuntimeError(
          "PostgreSQL 全量备份缺少 meta.json 或 database.dump",
          "POSTGRES_BACKUP_INVALID_ARCHIVE",
          400,
        );
      }
      const manifest = parseBackupJson<PostgresBackupManifest>(
        await metaFile.async("string"),
        "PostgreSQL 全量备份清单",
      );
      assertManifestStructure(manifest);
      assertManifestStructure(info.manifest);
      if (JSON.stringify(manifest) !== JSON.stringify(info.manifest)) {
        throw new PostgresBackupRuntimeError(
          "PostgreSQL 全量备份内外清单不一致",
          "POSTGRES_BACKUP_MANIFEST_MISMATCH",
          400,
        );
      }
      const [attachments, fonts, plugins] = await Promise.all([
        summarizeZipDirectory(zip, "attachments"),
        summarizeZipDirectory(zip, "fonts"),
        summarizeZipDirectory(zip, "plugins"),
      ]);
      if (
        !sameFileSummary(attachments, manifest.files.attachments)
        || !sameFileSummary(fonts, manifest.files.fonts)
        || !sameFileSummary(plugins, manifest.files.plugins)
        || Boolean(zip.file(".jwt_secret")) !== manifest.secrets.jwtSecretIncluded
      ) {
        throw new PostgresBackupRuntimeError(
          "PostgreSQL 全量备份资源 checksum 校验失败",
          "POSTGRES_BACKUP_RESOURCE_CHECKSUM_MISMATCH",
          400,
        );
      }
      const dump = await dumpFile.async("nodebuffer");
      return { manifest, dump, backupType: "full" };
    }
    assertManifestStructure(info.manifest);
    return { manifest: info.manifest, dump: artifact, backupType: "db-only" };
  }

  async function dryRunRestore(userId: string, filename: string): Promise<PostgresBackupDryRun> {
    await assertAdmin(userId);
    const { manifest, dump, backupType } = await readAndValidateManifest(filename);
    if (
      manifest.formatVersion !== POSTGRES_BACKUP_FORMAT_VERSION
      || manifest.database?.driver !== "postgres"
      || manifest.backupType !== backupType
    ) {
      throw new PostgresBackupRuntimeError(
        "备份清单与当前 PostgreSQL 备份格式不兼容",
        "POSTGRES_BACKUP_MANIFEST_INCOMPATIBLE",
        400,
      );
    }
    if (sha256(dump) !== manifest.database.checksum) {
      throw new PostgresBackupRuntimeError(
        "PostgreSQL dump checksum 校验失败，备份可能已损坏",
        "POSTGRES_BACKUP_CHECKSUM_MISMATCH",
        400,
      );
    }
    const tempDump = path.join(os.tmpdir(), `.nowen-pgrestore-${randomId()}.dump`);
    try {
      fs.writeFileSync(tempDump, dump, { flag: "wx" });
      const restoreToolVersion = await toolVersion(pgRestorePath);
      await runner.run(pgRestorePath, ["--list", tempDump], { env: pgEnv() });
      return {
        success: true,
        dryRun: {
          databaseDriver: "postgres",
          backupType,
          schemaVersion: manifest.database.schemaVersion,
          applicationVersion: manifest.applicationVersion,
          tables: manifest.database.tables,
          files: manifest.files,
          checksumVerified: true,
          restoreToolVersion,
        },
      };
    } finally {
      try { fs.rmSync(tempDump, { force: true }); } catch { /* ignore */ }
    }
  }

  return {
    backupDir,
    assertAdmin,
    health,
    createBackup,
    listBackups,
    getBackupPath,
    dryRunRestore,
  };
}

export type PostgresBackupRuntime = ReturnType<typeof createPostgresBackupRuntime>;
