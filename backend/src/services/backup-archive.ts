import archiver from "archiver";
import crypto from "crypto";
import fs from "fs";
import path from "path";

export interface BackupDirectoryStats {
  count: number;
  bytes: number;
}

export interface FullBackupFileStats {
  attachments: BackupDirectoryStats;
  fonts: BackupDirectoryStats;
  plugins: BackupDirectoryStats;
}

interface FullBackupArchiveOptions {
  zipPath: string;
  dbPath: string;
  dataDir: string;
  buildMeta: (files: FullBackupFileStats, hasSecret: boolean) => unknown;
}

export function createBackupFilename(
  type: "full" | "db-only",
  id: string,
  now = new Date(),
): string {
  const timestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const ext = type === "full" ? ".zip" : ".bak";
  return `nowen-backup-${type}-${timestamp}-${id.slice(0, 8)}${ext}`;
}

function addDirectory(
  archive: archiver.Archiver,
  srcDir: string,
  archiveDir: string,
): BackupDirectoryStats {
  let count = 0;
  let bytes = 0;

  const walk = (currentDir: string, relativeDir: string): void => {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const absolutePath = path.join(currentDir, entry.name);
      const relativePath = path.posix.join(relativeDir, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath, relativePath);
      } else if (entry.isFile()) {
        archive.file(absolutePath, { name: path.posix.join(archiveDir, relativePath) });
        count += 1;
        bytes += fs.statSync(absolutePath).size;
      }
    }
  };

  if (fs.existsSync(srcDir)) walk(srcDir, "");
  if (count === 0) archive.append("", { name: `${archiveDir}/.keep` });
  return { count, bytes };
}

/**
 * 通过文件流生成完整备份，内存占用不随附件总大小线性增长。
 * 压缩等级使用 1，优先降低 NAS 的 CPU 峰值；图片、视频等附件继续保持 ZIP 兼容格式。
 */
export async function createFullBackupArchive(options: FullBackupArchiveOptions): Promise<FullBackupFileStats> {
  const archive = archiver("zip", { zlib: { level: 1 } });

  archive.file(options.dbPath, { name: "db.sqlite" });
  const files: FullBackupFileStats = {
    attachments: addDirectory(archive, path.join(options.dataDir, "attachments"), "attachments"),
    fonts: addDirectory(archive, path.join(options.dataDir, "fonts"), "fonts"),
    // 只备份正式安装包；runtime、quarantine 和 plugins-dev 都是临时/未信任状态。
    plugins: addDirectory(archive, path.join(options.dataDir, "plugins", "installed"), "plugins/installed"),
  };

  const secretPath = path.join(options.dataDir, ".jwt_secret");
  let hasSecret = false;
  try {
    fs.accessSync(secretPath, fs.constants.R_OK);
    archive.file(secretPath, { name: ".jwt_secret" });
    hasSecret = true;
  } catch {
    // 密钥不存在或不可读时保持旧行为：跳过该文件，并在 meta.json 中明确标记。
  }
  const pluginSecretKeyPath = path.join(options.dataDir, ".plugin_secret_key");
  try {
    fs.accessSync(pluginSecretKeyPath, fs.constants.R_OK);
    archive.file(pluginSecretKeyPath, { name: ".plugin_secret_key" });
  } catch {
    // 尚未配置任何插件连接时该密钥可能不存在。
  }
  archive.append(JSON.stringify(options.buildMeta(files, hasSecret), null, 2), { name: "meta.json" });

  const output = fs.createWriteStream(options.zipPath, { flags: "wx" });
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      if (error) {
        archive.abort();
        output.destroy();
        reject(error);
      } else {
        resolve();
      }
    };

    output.once("close", () => finish());
    output.once("error", finish);
    archive.once("error", finish);
    archive.once("warning", finish);
    archive.pipe(output);
    archive.finalize().catch(finish);
  });

  return files;
}

/** 使用流式读取计算校验值，避免为大备份再分配一个等体积 Buffer。 */
export async function hashFileSha256(filePath: string): Promise<{ checksum: string; size: number }> {
  const hash = crypto.createHash("sha256");
  let size = 0;
  for await (const chunk of fs.createReadStream(filePath)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(buffer);
    size += buffer.length;
  }
  return { checksum: hash.digest("hex"), size };
}
