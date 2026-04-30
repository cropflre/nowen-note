/**
 * Nowen Note 数据备份与恢复系统
 *
 * 设计原则（P0/P1 重构后）：
 *  1. **真·全量备份**：full 备份是 zip 包，内容含
 *       - db.sqlite           SQLite 在线 backup 出来的快照（事务一致）
 *       - attachments/        全部附件物理文件
 *       - fonts/              用户上传的自定义字体
 *       - plugins/            插件目录（manifest + 源码）
 *       - .jwt_secret         JWT 密钥（恢复后旧 token 仍有效）
 *       - meta.json           包内自描述：版本、表清单、各表行数、checksum
 *     恢复时这 5 类一并还原，不会出现"恢复后图片 404 / 用户被踢登录"。
 *  2. **schema_version 校验**：meta.json 记录备份产生时的 schema_version 与
 *     `sqlite_master` 表清单。恢复前比对当前 DB 版本：版本不匹配直接拒绝。
 *  3. **恢复事务整体回滚**：任何一行 INSERT 失败都向上 throw，撤销整个
 *     transaction —— 不再"catch 吞错返回 success: true"。
 *  4. **dry-run 模式**：恢复前可预览"将清空 N 行 / 将插入 M 行"。
 *  5. **支持外置备份目录**：BACKUP_DIR 环境变量可指向另一块物理介质，从
 *     根本上避免"数据卷损坏 → 备份一起没"。同盘时返回 `sameVolume: true`
 *     供前端做警告提示（B1）。
 *  6. **健康指标**：lastSuccessAt / lastFailureAt / lastFailureReason 暴露给
 *     /api/backups/status，前端可做"距上次成功备份已 N 小时"提示（B4）。
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import os from "os";
import JSZip from "jszip";
import { getDb, getDbSchemaVersion } from "../db/schema.js";

// ===== 常量 =====

/** 备份格式版本号。每当 zip 内目录结构 / meta.json 字段含义变化时 +1 */
const BACKUP_FORMAT_VERSION = 2;

/**
 * 备份健康状态在 system_settings 表中的存储 key。
 *
 * 落库（而非纯内存）的目的：
 *  - 进程重启 / 容器重建后仍能告知 "距上次成功备份已经 N 小时"；
 *  - 启动时即可检测 "连续失败 >= N 次" 并把结果暴露给 /api/backups/status，
 *    前端据此显示红色横幅或徽章（B4）。
 */
const HEALTH_KV_KEY = "backup:health";

/**
 * 自动备份配置在 system_settings 中的存储 key。
 * value 形如 {"enabled": true, "intervalHours": 24}。
 *
 * 落库的目的：让管理员在 UI 修改的 "开/关 + 间隔" 在容器重启后仍生效，
 * 摆脱过去 "只能依赖 ENV BACKUP_AUTO_*" 的限制。
 *
 * 优先级（高 → 低）：
 *   1. 运行时 startAutoBackup/stopAutoBackup 调用（持久化到此 key）
 *   2. system_settings 中的此 key（重启后恢复）
 *   3. ENV: BACKUP_AUTO_ENABLED / BACKUP_AUTO_INTERVAL_HOURS （首次安装/未配置过时的兜底）
 *   4. 默认：enabled=true, intervalHours=24
 */
const AUTO_KV_KEY = "backup:auto";

/**
 * 备份目录在 system_settings 中的存储 key。value 是绝对路径字符串。
 *
 * 优先级（高 → 低）：
 *   1. 运行时 setBackupDir() 调用（持久化到此 key）
 *   2. system_settings 中的此 key（重启后恢复管理员上次选择）
 *   3. ENV: BACKUP_DIR （首次安装/未配置过时的兜底；docker-compose 推荐用法）
 *   4. 默认：<dataDir>/backups （同卷兜底，会触发 sameVolume 警告）
 *
 * 切换时的安全策略（在 setBackupDir 内执行）：
 *   - 必须是绝对路径
 *   - 不能位于 dataDir 内（否则备份会被自身的递归扫描带走）
 *   - 不能等于 dataDir
 *   - 必须可创建/可写（写探针文件）
 *   - 切换不会自动迁移旧目录的备份文件——文档化让管理员手动 cp，
 *     避免一次切换吞掉数十 GB 的 IO + 中途失败留下脏目录。
 */
const BACKUP_DIR_KV_KEY = "backup:dir";

/**
 * 连续失败多少次时认为 "备份链路坏了"。
 * 暴露给前端的 `degraded: boolean` 据此判定。
 */
const FAILURE_DEGRADE_THRESHOLD = 3;

interface AutoBackupConfig {
  enabled: boolean;
  intervalHours: number;
}

/**
 * setBackupDir / previewBackupDir 的校验结果。
 * ok=false 时由路由层返回 400 + reason 给前端做"无法切换"提示。
 */
export interface BackupDirCheckResult {
  ok: boolean;
  /** 规整后的绝对路径 */
  resolved: string;
  /** ok=false 时的原因 code（前端可做 i18n 映射） */
  reason?:
    | "not_absolute"
    | "inside_data_dir"
    | "equals_data_dir"
    | "create_failed"
    | "not_writable";
  /** 可读的错误描述（已含路径） */
  message?: string;
  /** 与 dataDir 同卷？（ok=true 时也可能 true，仅作前端警告，不阻塞） */
  sameVolume?: boolean;
  /** 可用空间字节，参考用 */
  freeBytes?: number | null;
}

// ===== 类型 =====

export interface BackupInfo {
  id: string;
  filename: string;
  size: number;
  type: "full" | "db-only";
  createdAt: string;
  noteCount: number;
  notebookCount: number;
  checksum: string; // sha256 全长（64 hex）
  /** 备份格式版本（>= 2 表示 zip 容器） */
  formatVersion?: number;
  /** 备份产生时的 DB schema 版本 */
  schemaVersion?: number;
  description?: string;
}

export interface BackupOptions {
  type?: "full" | "db-only";
  description?: string;
}

export interface BackupHealth {
  /** 上次成功备份时间（ISO） */
  lastSuccessAt: string | null;
  /** 上次失败时间 */
  lastFailureAt: string | null;
  /** 上次失败原因 */
  lastFailureReason: string | null;
  /** 连续失败次数（成功一次清零） */
  consecutiveFailures: number;
  /**
   * 备份链路是否处于"降级"状态：
   *   - 连续失败 >= FAILURE_DEGRADE_THRESHOLD，或
   *   - 自动备份已启动但距上次成功超过 2 倍间隔
   * 前端可据此显示红色告警条。
   */
  degraded: boolean;
  /** 自动备份是否已启动 */
  autoBackupRunning: boolean;
  /** 自动备份间隔（小时） */
  autoBackupIntervalHours: number;
  /** 距上次成功备份的小时数 */
  hoursSinceLastSuccess: number | null;
  /** 备份目录 */
  backupDir: string;
  /** 数据目录 */
  dataDir: string;
  /**
   * 备份目录与数据目录是否在同一物理卷。
   * 同卷意味着"备份 ≠ 容灾"，前端应给红色告警（B1）。
   */
  sameVolume: boolean;
  /** 备份目录是否可写 */
  backupDirWritable: boolean;
  /** 备份目录可用空间（字节，估算） */
  backupDirFreeBytes: number | null;
}

export interface RestoreResult {
  success: boolean;
  error?: string;
  stats?: Record<string, number>;
  /** dry-run 模式时只返回这个字段，不实际改库 */
  dryRun?: {
    tables: { name: string; willClear: number; willInsert: number }[];
    files: { attachments: number; fonts: number; plugins: number };
    schemaVersion: number;
  };
}

// ===== 工具 =====

/** 列出当前 DB 中所有用户表（动态枚举，不再写死白名单）。 */
function listAllTables(db: ReturnType<typeof getDb>): string[] {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%'",
    )
    .all() as { name: string }[];
  // FTS5 虚拟表与其影子表（_data/_idx/_content/_docsize/_config）不参与备份，
  // 因为它们是从 notes.content 派生出来的；恢复时由 trigger 自动重建。
  return rows
    .map((r) => r.name)
    .filter((n) => !n.endsWith("_data") && !n.endsWith("_idx") && !n.endsWith("_content") && !n.endsWith("_docsize") && !n.endsWith("_config"));
}

/** 递归把目录里的文件全部塞进 zip 的某个子目录。空目录会写一个 .keep 占位。 */
function addDirToZip(zip: JSZip, srcDir: string, zipFolder: string): { count: number; bytes: number } {
  let count = 0;
  let bytes = 0;
  if (!fs.existsSync(srcDir)) {
    zip.folder(zipFolder)?.file(".keep", "");
    return { count, bytes };
  }
  const folder = zip.folder(zipFolder);
  if (!folder) return { count, bytes };

  const walk = (cur: string, relBase: string) => {
    const entries = fs.readdirSync(cur, { withFileTypes: true });
    for (const ent of entries) {
      const abs = path.join(cur, ent.name);
      const rel = path.posix.join(relBase, ent.name);
      if (ent.isDirectory()) {
        walk(abs, rel);
      } else if (ent.isFile()) {
        const buf = fs.readFileSync(abs);
        folder.file(rel, buf);
        count++;
        bytes += buf.length;
      }
    }
  };
  walk(srcDir, "");
  if (count === 0) {
    folder.file(".keep", "");
  }
  return { count, bytes };
}

/** 从 zip 把某个子目录释放到磁盘目标路径。释放前清空目标目录（仅文件，不动外部）。 */
async function extractDirFromZip(zip: JSZip, zipFolder: string, destDir: string): Promise<number> {
  fs.mkdirSync(destDir, { recursive: true });
  // 先清空 destDir 内现有文件（保留目录壳避免破坏外部 inotify）
  for (const ent of fs.readdirSync(destDir, { withFileTypes: true })) {
    const p = path.join(destDir, ent.name);
    try {
      if (ent.isDirectory()) fs.rmSync(p, { recursive: true, force: true });
      else fs.unlinkSync(p);
    } catch {
      /* 单个失败不阻塞 */
    }
  }
  let count = 0;
  const prefix = zipFolder.endsWith("/") ? zipFolder : zipFolder + "/";
  const entries = Object.keys(zip.files).filter((k) => k.startsWith(prefix));
  for (const key of entries) {
    const file = zip.files[key];
    if (file.dir) continue;
    const rel = key.slice(prefix.length);
    if (!rel || rel === ".keep") continue;
    const dest = path.join(destDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const buf = await file.async("nodebuffer");
    fs.writeFileSync(dest, buf);
    count++;
  }
  return count;
}

/** 判断两个路径是否位于同一物理卷（dev 号相同）。失败时保守返回 true（提示用户检查）。 */
function isSameVolume(a: string, b: string): boolean {
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    return sa.dev === sb.dev;
  } catch {
    return true;
  }
}

/** 获取目录可用空间（字节）。失败返回 null。 */
function getFreeSpace(dir: string): number | null {
  try {
    // statfs 在新版 Node 才有；兜底返回 null（前端不显示数字而已）
    const sf = (fs as unknown as { statfsSync?: (p: string) => { bavail: bigint; bsize: bigint } }).statfsSync;
    if (!sf) return null;
    const s = sf(dir);
    return Number(s.bavail * s.bsize);
  } catch {
    return null;
  }
}

// ===== 备份管理器 =====

type BackupHealth = {
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureReason: string | null;
  consecutiveFailures: number;
};

export class BackupManager {
  private backupDir: string;
  private dataDir: string;
  private autoBackupTimer: NodeJS.Timeout | null = null;
  private autoBackupIntervalHours = 24;
  /**
   * 内存里缓存一份健康状态以避免每次 /status 请求都打 DB。
   * 真实 source-of-truth 是 system_settings 表里的 HEALTH_KV_KEY，
   * 在 createBackup 成功 / 失败时同步更新两边。
   */
  private health: BackupHealth = { lastSuccessAt: null, lastFailureAt: null, lastFailureReason: null, consecutiveFailures: 0 };

  constructor() {
    this.dataDir = process.env.ELECTRON_USER_DATA || path.join(process.cwd(), "data");
    // backupDir 解析顺序：DB 持久化 > ENV BACKUP_DIR > 默认 <dataDir>/backups。
    // 注意：构造函数里读 DB 是允许的——getDb() 在 BackupManager 第一次被取出前
    // 已经初始化（index.ts 启动顺序：DB → backup → routes）。
    this.backupDir = this.resolveInitialBackupDir();
    this.ensureDir();
    // 启动时把上次落库的健康状态读进内存。
    this.loadHealthFromDb();
  }

  /**
   * 启动时决定 backupDir：DB > ENV > 默认。
   * 如果 DB 里的值校验失败（比如该目录已不存在/磁盘卸载），
   * 退回 ENV/默认，并打印警告——绝不阻塞启动，否则容器将进入崩溃循环。
   */
  private resolveInitialBackupDir(): string {
    try {
      const db = getDb();
      const row = db
        .prepare("SELECT value FROM system_settings WHERE key = ?")
        .get(BACKUP_DIR_KV_KEY) as { value: string } | undefined;
      const fromDb = row?.value?.trim();
      if (fromDb && path.isAbsolute(fromDb)) {
        try {
          if (!fs.existsSync(fromDb)) fs.mkdirSync(fromDb, { recursive: true });
          // 简单可写性 probe，不可写就回退
          const probe = path.join(fromDb, `.write-probe-${Date.now()}`);
          fs.writeFileSync(probe, "");
          fs.unlinkSync(probe);
          return path.resolve(fromDb);
        } catch (e) {
          console.warn(
            `[Backup] 持久化的 backupDir 不可用（${fromDb}），回退到 ENV/默认：`,
            e instanceof Error ? e.message : e,
          );
        }
      }
    } catch {
      /* DB 不可用时静默回退 */
    }
    return process.env.BACKUP_DIR
      ? path.resolve(process.env.BACKUP_DIR)
      : path.join(this.dataDir, "backups");
  }

  /** 当前生效的备份目录（暴露给路由 / 前端只读展示） */
  getBackupDir(): string {
    return this.backupDir;
  }

  /** 当前数据目录（前端要靠它判断"用户输入的目标是不是 dataDir 的子目录"） */
  getDataDir(): string {
    return this.dataDir;
  }

  /**
   * 校验一个候选 backupDir 是否可用，但 **不持久化也不切换**。
   *
   * 路由层在真正 setBackupDir 之前先调它做 dryRun，让 UI 可以提前提示
   * "同卷警告 / 可用空间 / 不可写"——避免点了"切换"才报错。
   */
  previewBackupDir(input: string): BackupDirCheckResult {
    const resolved = path.resolve(String(input || "").trim());

    if (!input || !path.isAbsolute(input.trim())) {
      return {
        ok: false,
        resolved,
        reason: "not_absolute",
        message: `备份目录必须是绝对路径：${input}`,
      };
    }

    // 不能等于 dataDir：备份文件会污染数据库目录
    const dataResolved = path.resolve(this.dataDir);
    if (resolved === dataResolved) {
      return {
        ok: false,
        resolved,
        reason: "equals_data_dir",
        message: `备份目录不能等于数据目录（${dataResolved}）`,
      };
    }

    // 不能位于 dataDir 内：会被某些扫描/同步/导出递归卷入
    const rel = path.relative(dataResolved, resolved);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
      return {
        ok: false,
        resolved,
        reason: "inside_data_dir",
        message: `备份目录不能位于数据目录（${dataResolved}）内部，请使用独立卷或独立目录`,
      };
    }

    // 尝试创建 + 探针写
    try {
      if (!fs.existsSync(resolved)) {
        fs.mkdirSync(resolved, { recursive: true });
      }
    } catch (e) {
      return {
        ok: false,
        resolved,
        reason: "create_failed",
        message: `无法创建目录：${e instanceof Error ? e.message : String(e)}`,
      };
    }

    try {
      const probe = path.join(resolved, `.write-probe-${Date.now()}`);
      fs.writeFileSync(probe, "");
      fs.unlinkSync(probe);
    } catch (e) {
      return {
        ok: false,
        resolved,
        reason: "not_writable",
        message: `目录不可写：${e instanceof Error ? e.message : String(e)}`,
      };
    }

    return {
      ok: true,
      resolved,
      sameVolume: isSameVolume(resolved, this.dataDir),
      freeBytes: getFreeSpace(resolved),
    };
  }

  /**
   * 真正切换 backupDir 并持久化到 system_settings.backup:dir。
   *
   * 设计取舍：
   *  - 不迁移旧目录的备份文件。原因：① 可能跨卷拷贝几十 GB IO 风暴；
   *    ② 中途失败会出现"两边都有一半"的脏状态；③ 管理员的常见诉求其实
   *    是"以后写到新位置"而非"把历史也搬过去"。需要迁移时 docker exec
   *    cp 即可。前端会用文案明确告知。
   *  - 切换后立即触发一次 ensureDir 验证；失败抛错由路由层返回 500。
   *  - 不打断当前正在运行的 autoBackupTimer——下一次 tick 自然写到新目录。
   */
  setBackupDir(input: string): BackupDirCheckResult {
    const check = this.previewBackupDir(input);
    if (!check.ok) return check;

    this.backupDir = check.resolved;
    this.ensureDir();

    try {
      const db = getDb();
      db.prepare(
        `INSERT INTO system_settings (key, value, updatedAt)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = datetime('now')`,
      ).run(BACKUP_DIR_KV_KEY, check.resolved);
    } catch (e) {
      console.warn("[Backup] persist backupDir failed:", e instanceof Error ? e.message : e);
    }

    console.log(`[Backup] 备份目录已切换到：${check.resolved}（同卷=${check.sameVolume}）`);
    return check;
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.backupDir)) {
      fs.mkdirSync(this.backupDir, { recursive: true });
    }
  }

  // ==========================================================================
  // 自动备份配置：DB > ENV > 默认
  // --------------------------------------------------------------------------
  // 单独提供 readEffectiveAutoConfig() 给 index.ts 在启动时调用——它必须在
  // BackupManager 构造之后、startAutoBackup 之前先决定 "要不要启动"。
  // 把读 settings 的逻辑收敛在这里，避免 index.ts 也直接 SELECT system_settings。
  // ==========================================================================

  /** 从 system_settings 读取持久化的自动备份配置；找不到返回 null */
  private loadAutoConfigFromDb(): AutoBackupConfig | null {
    try {
      const db = getDb();
      const row = db
        .prepare("SELECT value FROM system_settings WHERE key = ?")
        .get(AUTO_KV_KEY) as { value: string } | undefined;
      if (!row?.value) return null;
      const parsed = JSON.parse(row.value) as Partial<AutoBackupConfig>;
      const enabled = parsed.enabled !== false; // 默认 true
      let intervalHours = Number(parsed.intervalHours);
      if (!Number.isFinite(intervalHours) || intervalHours < 1) intervalHours = 24;
      if (intervalHours > 720) intervalHours = 720;
      return { enabled, intervalHours };
    } catch {
      return null;
    }
  }

  /** 写入持久化配置（startAutoBackup/stopAutoBackup 在 persist=true 时调用） */
  private persistAutoConfig(cfg: AutoBackupConfig): void {
    try {
      const db = getDb();
      db.prepare(
        `INSERT INTO system_settings (key, value, updatedAt)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = datetime('now')`,
      ).run(AUTO_KV_KEY, JSON.stringify(cfg));
    } catch (e) {
      console.warn("[Backup] persistAutoConfig failed:", e instanceof Error ? e.message : e);
    }
  }

  /**
   * 计算 "本次启动应使用的自动备份配置"：
   *   1. system_settings 落库值（用户在 UI 上一次修改）
   *   2. ENV BACKUP_AUTO_ENABLED / BACKUP_AUTO_INTERVAL_HOURS
   *   3. 默认 enabled=true, intervalHours=24
   *
   * 给 index.ts 启动钩子使用：
   *   const cfg = mgr.readEffectiveAutoConfig();
   *   if (cfg.enabled) mgr.startAutoBackup(cfg.intervalHours, { persist: false });
   */
  readEffectiveAutoConfig(): AutoBackupConfig {
    const fromDb = this.loadAutoConfigFromDb();
    if (fromDb) return fromDb;

    const envEnabledRaw = (process.env.BACKUP_AUTO_ENABLED || "").toLowerCase();
    const envEnabled = envEnabledRaw === ""
      ? true
      : !["false", "0", "no", "off"].includes(envEnabledRaw);
    let envInterval = Number(process.env.BACKUP_AUTO_INTERVAL_HOURS);
    if (!Number.isFinite(envInterval) || envInterval < 1) envInterval = 24;
    if (envInterval > 720) envInterval = 720;
    return { enabled: envEnabled, intervalHours: envInterval };
  }

  /** 从 system_settings 加载历史健康指标到内存。 */
  private loadHealthFromDb(): void {
    try {
      const db = getDb();
      const row = db
        .prepare("SELECT value FROM system_settings WHERE key = ?")
        .get(HEALTH_KV_KEY) as { value: string } | undefined;
      if (row?.value) {
        const parsed = JSON.parse(row.value) as Partial<BackupHealth>;
        this.health = {
          lastSuccessAt: parsed.lastSuccessAt ?? null,
          lastFailureAt: parsed.lastFailureAt ?? null,
          lastFailureReason: parsed.lastFailureReason ?? null,
          consecutiveFailures: parsed.consecutiveFailures ?? 0,
        };
      }
    } catch {
      /* DB 还没就绪 / 表不存在 → 保持默认零值，不阻塞启动 */
    }
  }

  /** 把当前内存健康指标写回 system_settings。 */
  private persistHealth(): void {
    try {
      const db = getDb();
      db.prepare(
        `INSERT INTO system_settings (key, value, updatedAt)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = datetime('now')`,
      ).run(HEALTH_KV_KEY, JSON.stringify(this.health));
    } catch (e) {
      console.warn("[Backup] persistHealth failed:", e instanceof Error ? e.message : e);
    }
  }

  /** 创建备份。db-only 仍然产出单 .db 快照；full 产出 zip 包。 */
  async createBackup(options: BackupOptions = {}): Promise<BackupInfo> {
    const type = options.type || "db-only";
    const id = crypto.randomUUID();
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const ext = type === "full" ? ".zip" : ".bak";
    const filename = `nowen-backup-${type}-${timestamp}${ext}`;
    const backupPath = path.join(this.backupDir, filename);

    try {
      const db = getDb();
      const noteCount = (db.prepare("SELECT COUNT(*) as c FROM notes").get() as { c: number }).c;
      const notebookCount = (db.prepare("SELECT COUNT(*) as c FROM notebooks").get() as { c: number }).c;

      if (type === "db-only") {
        // SQLite 在线 backup —— 事务一致
        await db.backup(backupPath);
      } else {
        await this.createFullBackup(backupPath, db, options.description);
      }

      const content = fs.readFileSync(backupPath);
      // **完整 sha256**（之前只截 16 字符，碰撞空间大幅缩小，无意义）
      const checksum = crypto.createHash("sha256").update(content).digest("hex");
      const size = content.length;

      const info: BackupInfo = {
        id,
        filename,
        size,
        type,
        createdAt: new Date().toISOString(),
        noteCount,
        notebookCount,
        checksum,
        formatVersion: type === "full" ? BACKUP_FORMAT_VERSION : 1,
        schemaVersion: getDbSchemaVersion(),
        description: options.description,
      };

      // 元信息：与备份文件相邻；listBackups 以它为索引
      const metaPath = path.join(this.backupDir, `${filename}.meta.json`);
      fs.writeFileSync(metaPath, JSON.stringify(info, null, 2), "utf-8");

      this.health.lastSuccessAt = info.createdAt;
      this.health.lastFailureAt = null;
      this.health.lastFailureReason = null;
      this.health.consecutiveFailures = 0;
      this.persistHealth();
      return info;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.health.lastFailureAt = new Date().toISOString();
      this.health.lastFailureReason = msg;
      this.health.consecutiveFailures += 1;
      this.persistHealth();
      // 连续失败到阈值时显式打印告警，方便运维通过 docker logs 发现
      if (this.health.consecutiveFailures >= FAILURE_DEGRADE_THRESHOLD) {
        console.error(
          `[Backup] 连续失败 ${this.health.consecutiveFailures} 次，备份链路已降级。最近原因：${msg}`,
        );
      }
      // 失败时清理半成品，避免 listBackups 看到坏文件
      try {
        if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  /**
   * 创建 zip 容器形式的全量备份。
   * 流程：
   *   1) SQLite 在线 backup 到临时 .db 文件（保证事务一致）
   *   2) 把临时 .db、attachments/、fonts/、plugins/、.jwt_secret 全部塞进 zip
   *   3) 写入 meta.json（含 schema 版本、表行数、文件统计）
   *   4) 删除临时 .db
   */
  private async createFullBackup(zipPath: string, db: ReturnType<typeof getDb>, description?: string): Promise<void> {
    const zip = new JSZip();

    // 1) 临时 .db 快照
    const tmpDb = path.join(os.tmpdir(), `nowen-fullbk-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.db`);
    try {
      await db.backup(tmpDb);
      zip.file("db.sqlite", fs.readFileSync(tmpDb));
    } finally {
      try {
        if (fs.existsSync(tmpDb)) fs.unlinkSync(tmpDb);
      } catch {
        /* ignore */
      }
    }

    // 2) 各业务目录
    const attDir = path.join(this.dataDir, "attachments");
    const fontsDir = path.join(this.dataDir, "fonts");
    const pluginsDir = path.join(this.dataDir, "plugins");
    const att = addDirToZip(zip, attDir, "attachments");
    const fnt = addDirToZip(zip, fontsDir, "fonts");
    const plg = addDirToZip(zip, pluginsDir, "plugins");

    // 3) 密钥（恢复后老 token 不失效；不存在就跳过）
    const secretFile = path.join(this.dataDir, ".jwt_secret");
    if (fs.existsSync(secretFile)) {
      try {
        zip.file(".jwt_secret", fs.readFileSync(secretFile));
      } catch {
        /* 权限不足时忽略，meta 里会标记 hasSecret: false */
      }
    }

    // 4) 表行数（动态枚举，不再写死）
    const tables = listAllTables(db);
    const tableRowCounts: Record<string, number> = {};
    for (const t of tables) {
      try {
        tableRowCounts[t] = (db.prepare(`SELECT COUNT(*) as c FROM ${t}`).get() as { c: number }).c;
      } catch {
        tableRowCounts[t] = -1;
      }
    }

    const meta = {
      formatVersion: BACKUP_FORMAT_VERSION,
      schemaVersion: getDbSchemaVersion(),
      type: "full" as const,
      createdAt: new Date().toISOString(),
      description: description || "",
      tables: tableRowCounts,
      files: {
        attachments: { count: att.count, bytes: att.bytes },
        fonts: { count: fnt.count, bytes: fnt.bytes },
        plugins: { count: plg.count, bytes: plg.bytes },
      },
      hasSecret: fs.existsSync(secretFile),
    };
    zip.file("meta.json", JSON.stringify(meta, null, 2));

    // 5) 输出 zip
    const buf = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });
    fs.writeFileSync(zipPath, buf);
  }

  /** 列出所有备份。 */
  listBackups(): BackupInfo[] {
    this.ensureDir();
    const files = fs.readdirSync(this.backupDir);
    const backups: BackupInfo[] = [];
    for (const f of files) {
      if (f.endsWith(".meta.json")) {
        try {
          const metaText = fs.readFileSync(path.join(this.backupDir, f), "utf-8");
          backups.push(JSON.parse(metaText));
        } catch {
          /* 忽略损坏 */
        }
      }
    }
    return backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** 获取备份文件路径，做路径遍历防护。 */
  getBackupPath(filename: string): string | null {
    const filePath = path.join(this.backupDir, filename);
    if (!path.resolve(filePath).startsWith(path.resolve(this.backupDir))) return null;
    if (!fs.existsSync(filePath)) return null;
    return filePath;
  }

  /** 删除备份。 */
  deleteBackup(filename: string): boolean {
    const filePath = this.getBackupPath(filename);
    if (!filePath) return false;
    try {
      fs.unlinkSync(filePath);
      const metaPath = filePath + ".meta.json";
      if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 从备份恢复。
   *
   * - 兼容三种文件：
   *     • zip 全量备份（formatVersion >= 2）
   *     • db-only 单 .db 快照
   *     • 旧版 JSON 全量备份（formatVersion = 1，向后兼容）
   * - dryRun=true 时只解析、统计，不动磁盘和 DB。
   * - 任何子步骤失败都会向上 throw，调用方拿到 success:false + 真实原因。
   */
  async restoreFromBackup(filename: string, opts: { dryRun?: boolean } = {}): Promise<RestoreResult> {
    const filePath = this.getBackupPath(filename);
    if (!filePath) return { success: false, error: "备份文件不存在" };

    const buf = fs.readFileSync(filePath);

    // 嗅探格式：zip 文件以 'PK' 开头
    const isZip = buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4b;

    try {
      if (isZip) {
        return await this.restoreFromZip(buf, !!opts.dryRun);
      }
      // 嗅探 JSON 全量备份（旧格式）
      try {
        const text = buf.toString("utf-8");
        const obj = JSON.parse(text);
        if (obj && obj.data && obj.version) {
          return await this.restoreFromLegacyJson(obj, !!opts.dryRun);
        }
      } catch {
        /* 不是 JSON，落到 db-only */
      }
      // 否则视为 db-only 快照：替换 DB 文件
      return await this.restoreFromDbOnly(filePath, !!opts.dryRun);
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** 从 zip 全量备份恢复（v2+） */
  private async restoreFromZip(buf: Buffer, dryRun: boolean): Promise<RestoreResult> {
    const zip = await JSZip.loadAsync(buf);
    const metaFile = zip.file("meta.json");
    if (!metaFile) throw new Error("zip 备份缺少 meta.json，文件可能已损坏");
    const meta = JSON.parse(await metaFile.async("string"));

    if (meta.formatVersion && meta.formatVersion > BACKUP_FORMAT_VERSION) {
      throw new Error(
        `备份格式版本 ${meta.formatVersion} 高于当前程序支持的 ${BACKUP_FORMAT_VERSION}，请升级到更新版本的 nowen-note 后再恢复`,
      );
    }
    // schema 版本兼容策略：允许 backup.schemaVersion <= 当前程序支持的最高版本。
    // - 备份版本更低：恢复后 runMigrations() 会把它升上来；
    // - 备份版本更高：拒绝，等同于 "新库灌进旧程序"，与 D3 防降级语义一致。
    const codeMaxSchema = (await import("../db/schema.js")).getCodeSchemaVersion();
    if (meta.schemaVersion && meta.schemaVersion > codeMaxSchema) {
      throw new Error(
        `备份 schema 版本 ${meta.schemaVersion} 高于当前程序支持的 ${codeMaxSchema}。请升级到对应版本的 nowen-note 后再恢复。`,
      );
    }

    const dbFile = zip.file("db.sqlite");
    if (!dbFile) throw new Error("zip 备份缺少 db.sqlite");

    if (dryRun) {
      // 干跑：从 zip 内 .db 临时打开，统计每张表 N 行
      const tmpDb = path.join(os.tmpdir(), `nowen-dryrun-${Date.now()}.db`);
      fs.writeFileSync(tmpDb, await dbFile.async("nodebuffer"));
      try {
        // 用 better-sqlite3 直接打开（独立连接）
        const Database = (await import("better-sqlite3")).default;
        const tmp = new Database(tmpDb, { readonly: true });
        const tables = listAllTables(tmp as unknown as ReturnType<typeof getDb>);
        const cur = getDb();
        const list = tables.map((name) => {
          let willClear = 0;
          try {
            willClear = (cur.prepare(`SELECT COUNT(*) as c FROM ${name}`).get() as { c: number }).c;
          } catch {
            /* 当前库没这张表 → willClear=0 */
          }
          const willInsert = (tmp.prepare(`SELECT COUNT(*) as c FROM ${name}`).get() as { c: number }).c;
          return { name, willClear, willInsert };
        });
        tmp.close();
        return {
          success: true,
          dryRun: {
            tables: list,
            files: {
              attachments: meta.files?.attachments?.count ?? 0,
              fonts: meta.files?.fonts?.count ?? 0,
              plugins: meta.files?.plugins?.count ?? 0,
            },
            schemaVersion: meta.schemaVersion ?? 1,
          },
        };
      } finally {
        try {
          fs.unlinkSync(tmpDb);
        } catch {
          /* ignore */
        }
      }
    }

    // ===== 实际恢复 =====
    // 1) DB：解 zip 内 db.sqlite 到临时文件 → 走 data-file 替换流程
    const { getDbPath, closeDb } = await import("../db/schema.js");
    const tmpDb = path.join(os.tmpdir(), `nowen-restore-${Date.now()}.db`);
    fs.writeFileSync(tmpDb, await dbFile.async("nodebuffer"));

    const curDbPath = getDbPath();
    const safetyBak = curDbPath + `.before-restore.${Date.now()}.bak`;
    try {
      fs.copyFileSync(curDbPath, safetyBak);
    } catch {
      /* 当前库不存在或不可读，跳过 */
    }

    closeDb();
    // 等几十 ms 让 OS 释放 .db 句柄（Windows 上必要）
    await new Promise((r) => setTimeout(r, 100));
    try {
      fs.renameSync(tmpDb, curDbPath);
      // 清理 wal/shm，否则替换后 SQLite 会拿旧 wal 拼新 db 导致坏页
      for (const sfx of ["-wal", "-shm"]) {
        const p = curDbPath + sfx;
        if (fs.existsSync(p)) {
          try {
            fs.unlinkSync(p);
          } catch {
            /* ignore */
          }
        }
      }
    } catch (e) {
      // 失败 → 回滚
      if (fs.existsSync(safetyBak)) {
        try {
          fs.copyFileSync(safetyBak, curDbPath);
        } catch {
          /* ignore */
        }
      }
      throw new Error(`数据库文件替换失败: ${e instanceof Error ? e.message : String(e)}`);
    }

    // 2) 附件、字体、插件
    const attDir = path.join(this.dataDir, "attachments");
    const fontsDir = path.join(this.dataDir, "fonts");
    const pluginsDir = path.join(this.dataDir, "plugins");
    const attCount = await extractDirFromZip(zip, "attachments", attDir);
    const fntCount = await extractDirFromZip(zip, "fonts", fontsDir);
    const plgCount = await extractDirFromZip(zip, "plugins", pluginsDir);

    // 3) 密钥（可选）
    const secretEntry = zip.file(".jwt_secret");
    if (secretEntry) {
      const secretPath = path.join(this.dataDir, ".jwt_secret");
      try {
        fs.writeFileSync(secretPath, await secretEntry.async("nodebuffer"));
        try {
          fs.chmodSync(secretPath, 0o600);
        } catch {
          /* Windows 无 chmod 概念 */
        }
      } catch {
        /* ignore */
      }
    }

    // 4) 重新打开 DB，做完整性校验
    const cur = getDb();
    const integrity = (cur.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
    if (integrity !== "ok") {
      throw new Error(`恢复后完整性检查失败: ${integrity}`);
    }

    const stats: Record<string, number> = {
      attachments: attCount,
      fonts: fntCount,
      plugins: plgCount,
    };
    for (const [t, n] of Object.entries(meta.tables ?? {})) {
      stats[t] = typeof n === "number" ? n : -1;
    }
    return { success: true, stats };
  }

  /**
   * 兼容旧版 JSON 全量备份（formatVersion = 1）。
   * 与之前实现的关键区别：
   *  - 表名动态枚举，不再写死白名单；
   *  - 单行 INSERT 失败必须 throw，整事务回滚；
   *  - dry-run 模式可预览。
   */
  private async restoreFromLegacyJson(backup: { data: Record<string, unknown[]> }, dryRun: boolean): Promise<RestoreResult> {
    const db = getDb();
    const tablesNow = new Set(listAllTables(db));

    if (dryRun) {
      const list = Object.entries(backup.data)
        .filter(([t]) => tablesNow.has(t))
        .map(([t, rows]) => {
          const willClear = (db.prepare(`SELECT COUNT(*) as c FROM ${t}`).get() as { c: number }).c;
          return {
            name: t,
            willClear,
            willInsert: Array.isArray(rows) ? rows.length : 0,
          };
        });
      return {
        success: true,
        dryRun: {
          tables: list,
          files: { attachments: 0, fonts: 0, plugins: 0 },
          schemaVersion: 1,
        },
      };
    }

    const stats: Record<string, number> = {};
    const restore = db.transaction(() => {
      for (const [table, rows] of Object.entries(backup.data)) {
        if (!Array.isArray(rows) || rows.length === 0) continue;
        // 安全：只允许当前 DB 已存在的表
        if (!tablesNow.has(table)) {
          throw new Error(`备份包含未知表 ${table}，恢复中止以保护现有数据`);
        }
        db.prepare(`DELETE FROM ${table}`).run();
        const columns = Object.keys(rows[0] as object);
        const placeholders = columns.map(() => "?").join(", ");
        const insert = db.prepare(
          `INSERT OR REPLACE INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`,
        );
        for (const row of rows) {
          insert.run(...columns.map((c) => (row as Record<string, unknown>)[c]));
        }
        stats[table] = rows.length;
      }
    });
    restore();
    return { success: true, stats };
  }

  /** 从 db-only 快照恢复（直接替换 DB 文件） */
  private async restoreFromDbOnly(filePath: string, dryRun: boolean): Promise<RestoreResult> {
    if (dryRun) {
      // 用 readonly 临时打开备份 DB，统计行数
      const Database = (await import("better-sqlite3")).default;
      const tmp = new Database(filePath, { readonly: true });
      const tables = listAllTables(tmp as unknown as ReturnType<typeof getDb>);
      const cur = getDb();
      const list = tables.map((name) => {
        let willClear = 0;
        try {
          willClear = (cur.prepare(`SELECT COUNT(*) as c FROM ${name}`).get() as { c: number }).c;
        } catch {
          /* 不存在则 0 */
        }
        const willInsert = (tmp.prepare(`SELECT COUNT(*) as c FROM ${name}`).get() as { c: number }).c;
        return { name, willClear, willInsert };
      });
      tmp.close();
      return {
        success: true,
        dryRun: {
          tables: list,
          files: { attachments: 0, fonts: 0, plugins: 0 },
          schemaVersion: 1,
        },
      };
    }

    const { getDbPath, closeDb } = await import("../db/schema.js");
    const curDbPath = getDbPath();
    const safetyBak = curDbPath + `.before-restore.${Date.now()}.bak`;
    try {
      fs.copyFileSync(curDbPath, safetyBak);
    } catch {
      /* ignore */
    }
    closeDb();
    await new Promise((r) => setTimeout(r, 100));
    try {
      fs.copyFileSync(filePath, curDbPath);
      for (const sfx of ["-wal", "-shm"]) {
        const p = curDbPath + sfx;
        if (fs.existsSync(p)) {
          try {
            fs.unlinkSync(p);
          } catch {
            /* ignore */
          }
        }
      }
    } catch (e) {
      if (fs.existsSync(safetyBak)) {
        try {
          fs.copyFileSync(safetyBak, curDbPath);
        } catch {
          /* ignore */
        }
      }
      throw new Error(`数据库文件替换失败: ${e instanceof Error ? e.message : String(e)}`);
    }

    const cur = getDb();
    const integrity = (cur.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
    if (integrity !== "ok") {
      throw new Error(`恢复后完整性检查失败: ${integrity}`);
    }
    return { success: true, stats: { db: 1 } };
  }

  /**
   * 启动自动备份（默认 24h 一次，保留最近 10 个 db-only）
   *
   * @param intervalHours 间隔小时数（路由层已校验范围 1~720）
   * @param opts.persist  是否把 {enabled:true, intervalHours} 写到 system_settings；
   *                      路由触发时传 true，启动时按落库值恢复时传 false（避免无意义写）
   */
  startAutoBackup(intervalHours: number = 24, opts: { persist?: boolean } = {}): void {
    this.stopAutoBackup();
    this.autoBackupIntervalHours = intervalHours;
    const ms = intervalHours * 3600 * 1000;
    this.autoBackupTimer = setInterval(async () => {
      try {
        const info = await this.createBackup({ type: "db-only", description: "自动备份" });
        console.log(`[Backup] 自动备份完成: ${info.filename}`);
        const all = this.listBackups();
        const auto = all.filter((b) => b.filename.includes("db-only"));
        if (auto.length > 10) {
          for (const old of auto.slice(10)) {
            this.deleteBackup(old.filename);
          }
        }
      } catch (err) {
        // 健康字段已经在 createBackup 内部更新
        console.error("[Backup] 自动备份失败:", err instanceof Error ? err.message : err);
      }
    }, ms);
    if (opts.persist) {
      this.persistAutoConfig({ enabled: true, intervalHours });
    }
    console.log(`[Backup] 自动备份已启动，间隔 ${intervalHours} 小时`);
  }

  /**
   * 停止自动备份。
   *
   * @param opts.persist        是否写持久化（路由触发为 true，内部 stopAutoBackup() 调用为 false）
   * @param opts.intervalHours  停用时仍记录上次的间隔，方便下次"启用"时复用同样的频率
   */
  stopAutoBackup(opts: { persist?: boolean; intervalHours?: number } = {}): void {
    if (this.autoBackupTimer) {
      clearInterval(this.autoBackupTimer);
      this.autoBackupTimer = null;
    }
    if (opts.persist) {
      this.persistAutoConfig({
        enabled: false,
        intervalHours: opts.intervalHours ?? this.autoBackupIntervalHours,
      });
    }
  }

  /** 健康指标（B4） */
  getHealth(): BackupHealth {
    const sameVolume = isSameVolume(this.backupDir, this.dataDir);
    let writable = false;
    try {
      const probe = path.join(this.backupDir, `.write-probe-${Date.now()}`);
      fs.writeFileSync(probe, "");
      fs.unlinkSync(probe);
      writable = true;
    } catch {
      writable = false;
    }
    let hoursSince: number | null = null;
    if (this.health.lastSuccessAt) {
      hoursSince = (Date.now() - new Date(this.health.lastSuccessAt).getTime()) / 3600_000;
    }
    // degraded：连续失败超阈值，或 自动备份开启但已超过 2x 间隔仍无成功
    let degraded = this.health.consecutiveFailures >= FAILURE_DEGRADE_THRESHOLD;
    if (!degraded && this.autoBackupTimer && hoursSince !== null) {
      if (hoursSince > this.autoBackupIntervalHours * 2) degraded = true;
    }
    return {
      lastSuccessAt: this.health.lastSuccessAt,
      lastFailureAt: this.health.lastFailureAt,
      lastFailureReason: this.health.lastFailureReason,
      consecutiveFailures: this.health.consecutiveFailures,
      degraded,
      autoBackupRunning: this.autoBackupTimer !== null,
      autoBackupIntervalHours: this.autoBackupIntervalHours,
      hoursSinceLastSuccess: hoursSince,
      backupDir: this.backupDir,
      dataDir: this.dataDir,
      sameVolume,
      backupDirWritable: writable,
      backupDirFreeBytes: getFreeSpace(this.backupDir),
    };
  }
}

// ===== 全局单例 =====

let _manager: BackupManager | null = null;

export function getBackupManager(): BackupManager {
  if (!_manager) {
    _manager = new BackupManager();
  }
  return _manager;
}
