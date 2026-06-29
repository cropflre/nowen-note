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
import { noteVersionsRepository } from "../repositories";

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

/**
 * 自动备份配置。
 *
 * 兼容性：
 *   - 旧版（v1）只有 enabled + intervalHours。新增字段都给了默认值，
 *     loadAutoConfigFromDb() 会把 v1 行平滑升级为 v2，不会因缺字段
 *     导致 enabled 被误判为 false。
 *
 * 字段语义：
 *   - mode="interval"：从启动那一刻起每 intervalHours 小时跑一次（旧行为）。
 *   - mode="daily"   ：每天到达 dailyAt（"HH:mm"，服务器本地时区）跑一次；
 *                       服务启动时若今日时间点还没到 → 调度到今日；已过 → 明日。
 *                       重启不会立即触发（避免运维半夜重启抖一次备份）。
 *
 *   - keepCount：自动清理保留的 db-only 备份数量。范围 1~100，默认 15。
 *                只清理 db-only（filename 含 "db-only"），full 不动；
 *                由"自动备份完成"和"手动备份完成"两条路径共同触发，
 *                避免旧版本"只在 tick 里清理"导致手动产物无限堆积。
 *
 *   - emailOnSuccess + emailTo：自动备份成功后自动发邮件（SMTP 需启用且
 *                就绪，否则静默跳过，不阻塞备份）。
 */
interface AutoBackupConfig {
  enabled: boolean;
  intervalHours: number;
  mode?: "interval" | "daily";
  /** "HH:mm" 24 小时制（服务器本地时区）；mode="daily" 时使用 */
  dailyAt?: string;
  /** 自动清理保留的 db-only 备份数；默认 15 */
  keepCount?: number;
  /** 自动备份成功后是否自动发邮件 */
  emailOnSuccess?: boolean;
  /** 自动发邮件的收件人地址（emailOnSuccess=true 时必填） */
  emailTo?: string;
}

/** keepCount 上下限（与路由校验保持一致） */
const KEEP_COUNT_MIN = 1;
const KEEP_COUNT_MAX = 100;
const KEEP_COUNT_DEFAULT = 15;

/**
 * note_versions 清理策略（P0-1）
 * --------------------------------------------------------------------------
 * 背景：
 *   每条笔记每次编辑（且距上次版本 >= VERSION_MERGE_WINDOW_MS）就会插入一条
 *   note_versions 行。长期使用下来单条笔记可能积累上千行；普通用户根本不需要
 *   保留这么久的历史。
 *
 * 策略（每篇笔记独立判断）：
 *   - 保留最近 keepRecent 条（按 version DESC），无论时间多老；
 *   - 同时保留 createdAt 距今 keepDays 天内的全部条目；
 *   - 二者取并集——避免“最近一周猛改一篇但 keepRecent=50 不够”的尴尬，
 *     也避免“一篇笔记两年没动过，却被一刀切丢光所有历史”。
 *
 * 配置存储在 system_settings["backup:noteVersionsRetention"]，结构：
 *   { "keepRecent": 50, "keepDays": 30 }
 *
 * 不删 changeType != 'edit' 的版本（manual/snapshot 等通常是用户主动节点）。
 */
const VERSION_RETENTION_KV_KEY = "backup:noteVersionsRetention";
const VERSION_KEEP_RECENT_DEFAULT = 50;
const VERSION_KEEP_RECENT_MAX = 1000;
const VERSION_KEEP_DAYS_DEFAULT = 30;
const VERSION_KEEP_DAYS_MAX = 3650;

/** "HH:mm" 24h 校验 */
function isValidHHmm(s: string | undefined): s is string {
  return typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
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
  /** 自动备份调度模式 */
  autoBackupMode?: "interval" | "daily";
  /** mode="daily" 时的每日触发时间 "HH:mm" */
  autoBackupDailyAt?: string;
  /** 自动清理保留的 db-only 备份数 */
  autoBackupKeepCount?: number;
  /** 是否启用"备份成功后自动发邮件" */
  autoBackupEmailOnSuccess?: boolean;
  /** 自动发送邮件的收件人（已存在则原样返回，方便前端回填） */
  autoBackupEmailTo?: string;
  /** 下一次预计触发时间（ISO，仅展示） */
  autoBackupNextRunAt?: string | null;
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

export class BackupManager {
  private backupDir: string;
  private dataDir: string;
  private autoBackupTimer: NodeJS.Timeout | null = null;
  private autoBackupIntervalHours = 24;
  /** 当前生效的完整自动备份配置，tick 时按它工作；运行期变更必须先 stop 再 start。 */
  private autoBackupConfig: AutoBackupConfig = {
    enabled: false,
    intervalHours: 24,
    mode: "interval",
    dailyAt: "03:00",
    keepCount: KEEP_COUNT_DEFAULT,
    emailOnSuccess: false,
    emailTo: "",
  };
  /** 调度模式：interval 用周期 setInterval；daily 用链式 setTimeout（每次执行后重排） */
  private autoBackupMode: "interval" | "daily" = "interval";
  /** 下一次预计触发时间（ms 时间戳，仅用于 /status 展示） */
  private autoBackupNextRunAt: number | null = null;
  /**
   * 内存里缓存一份健康状态以避免每次 /status 请求都打 DB。
   * 真实 source-of-truth 是 system_settings 表里的 HEALTH_KV_KEY，
   * 在 createBackup 成功 / 失败时同步更新两边。
   */
  private health: {
    lastSuccessAt: string | null;
    lastFailureAt: string | null;
    lastFailureReason: string | null;
    consecutiveFailures: number;
  } = { lastSuccessAt: null, lastFailureAt: null, lastFailureReason: null, consecutiveFailures: 0 };

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
      // 兼容旧行：mode/dailyAt/keepCount 缺失时按默认值补齐——
      // 关键：不能因为旧行没这些字段就把 enabled 推翻成 false。
      const mode: "interval" | "daily" = parsed.mode === "daily" ? "daily" : "interval";
      const dailyAt = isValidHHmm(parsed.dailyAt) ? parsed.dailyAt : "03:00";
      let keepCount = Number(parsed.keepCount);
      if (!Number.isFinite(keepCount)) keepCount = KEEP_COUNT_DEFAULT;
      keepCount = Math.max(KEEP_COUNT_MIN, Math.min(KEEP_COUNT_MAX, Math.round(keepCount)));
      const emailOnSuccess = parsed.emailOnSuccess === true;
      const emailTo = typeof parsed.emailTo === "string" ? parsed.emailTo.trim() : "";
      return { enabled, intervalHours, mode, dailyAt, keepCount, emailOnSuccess, emailTo };
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
    return {
      enabled: envEnabled,
      intervalHours: envInterval,
      mode: "interval",
      dailyAt: "03:00",
      keepCount: KEEP_COUNT_DEFAULT,
      emailOnSuccess: false,
      emailTo: "",
    };
  }

  /** 从 system_settings 加载历史健康指标到内存。 */
  private loadHealthFromDb(): void {
    try {
      const db = getDb();
      const row = db
        .prepare("SELECT value FROM system_settings WHERE key = ?")
        .get(HEALTH_KV_KEY) as { value: string } | undefined;
      if (row?.value) {
        const parsed = JSON.parse(row.value) as {
          lastSuccessAt?: string | null;
          lastFailureAt?: string | null;
          lastFailureReason?: string | null;
          consecutiveFailures?: number;
        };
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
      // 手动备份完成后也清理多余的 db-only——避免旧版"只有 tick 触发清理"
      // 导致管理员频繁手动备份后列表无限堆积。
      // 容错：若 prune 内部抛错也不能让 createBackup 整体失败。
      try { this.pruneDbOnly(); } catch { /* ignore */ }
      // P0-1：顺路清理过期 note_versions，避免单表无限膨胀。
      try { this.pruneNoteVersions(); } catch { /* ignore */ }
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
        // P1-3：阈值边沿触发一次告警邮件（fire-and-forget，绝不阻塞主流程）。
        // 注意只在"刚好达到阈值的那次"发，否则后续每次失败都连发同样邮件
        // 会变成噪音；如果运维想再收一次，恢复一次成功后下次再降级即可。
        if (this.health.consecutiveFailures === FAILURE_DEGRADE_THRESHOLD) {
          void this.sendBackupFailureAlert(msg);
        }
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
   * 导入一份外部备份文件（管理员从邮件附件 / U盘 / 异机拷贝拿到的 .bak 或 .zip）
   * 到 backupDir，补齐 .meta.json，让它与"就地创建的备份"完全同构——之后既能走
   * listBackups() 列出，也能走 restoreFromBackup() 恢复，不需要任何二次处理。
   *
   * 与 /api/data-file/import（直接覆盖 DB 文件）的本质区别：
   *   - 这里只是"把备份文件放进备份仓库"，**不触及现网数据**；是否覆盖 DB 由后续
   *     用户点击"恢复"来决定，走 dryRun 预览 + sudo 再确认的老路径。这样"导入"
   *     本身是安全的 —— 即便文件内容有问题，也只是多一份坏备份躺在那。
   *   - 避免把"投递 + 覆盖"耦合成一步：邮件里拿到的 .bak 管理员往往想先接上看
   *     预览（"将清空 N 行 / 插入 M 行"）再下决定，而不是一键灌库。
   *
   * 安全校验：
   *   1. 扩展名必须是 .bak（SQLite 快照）或 .zip（full 全量包），其他一律拒收，
   *      防止管理员顺手上传 pdf/docx 污染备份目录；
   *   2. 文件大小不为 0（早筛空上传）；
   *   3. 按扩展名做魔数校验：
   *      - .bak → 前 16 字节必须是 "SQLite format 3\0"；
   *      - .zip → 前 2 字节必须是 "PK"；
   *      杜绝改扩展名绕过；
   *   4. .zip 还会进一步解析 meta.json、比对 formatVersion / schemaVersion，
   *      形式非法直接拒绝（与 restoreFromZip 的前置检查语义一致，避免无法恢复
   *      的坏包进库）；
   *   5. 生成的文件名固定为 `nowen-backup-<type>-imported-<ts>.<ext>`，
   *      强制前缀"imported"让管理员在列表里一眼区分"这份是外部导入的"。
   *
   * 元信息：
   *   - .bak：formatVersion=1（与 db-only 等同）；noteCount/notebookCount 会用
   *     只读连接打开快照数一次，让列表 UI 的"N 条笔记"也能正常显示；
   *   - .zip：meta.json 里的 schemaVersion / formatVersion 直接继承；noteCount
   *     / notebookCount 取自 meta.tables.notes / meta.tables.notebooks（旧包没
   *     这字段的用 0 占位）；
   *   - checksum 重新计算 sha256（不信任外部来源）；
   *   - description 默认带上"[imported] 原始文件名 xxx"，让管理员知道它是哪来的。
   */
  async ingestUploadedBackup(
    originalFilename: string,
    bytes: Buffer,
    opts: { description?: string } = {},
  ): Promise<BackupInfo> {
    if (!bytes || bytes.length === 0) {
      throw new Error("上传文件为空");
    }

    // —— 1. 扩展名校验
    const safeName = path.basename(originalFilename || "").trim();
    const extLower = path.extname(safeName).toLowerCase();
    if (extLower !== ".bak" && extLower !== ".zip") {
      throw new Error(`仅支持 .bak / .zip 格式的备份文件，收到：${extLower || "无扩展名"}`);
    }

    // —— 2. 魔数校验（杜绝改扩展名）
    let type: "full" | "db-only";
    let schemaVersion = getDbSchemaVersion();
    let formatVersion = 1;
    let noteCount = 0;
    let notebookCount = 0;

    if (extLower === ".bak") {
      // SQLite 文件头固定前 16 字节 = "SQLite format 3\0"
      const sqliteMagic = Buffer.from("SQLite format 3\u0000", "utf-8");
      if (bytes.length < 16 || !bytes.slice(0, 16).equals(sqliteMagic)) {
        throw new Error(".bak 文件不是合法的 SQLite 数据库（文件头校验失败）");
      }
      type = "db-only";
      formatVersion = 1;

      // 只读打开临时文件，数一下行数，让列表 UI 正常展示。
      // 临时文件放 backupDir 而非 os.tmpdir()：Windows 下后者含中文用户名 /
      // 被 AV 实时扫描时 better-sqlite3 readonly 打开会偶发 SQLITE_CANTOPEN，
      // 而 backupDir 是管理员已确认可写、路径稳定的目录。
      this.ensureDir();
      const tmp = path.join(
        this.backupDir,
        `.nowen-ingest-probe-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.db`,
      );
      fs.writeFileSync(tmp, bytes);
      try {
        const Database = (await import("better-sqlite3")).default;
        let probe: InstanceType<typeof Database> | null = null;
        try {
          probe = new Database(tmp, { readonly: true });
        } catch (e) {
          // 打不开也不要硬失败——导入阶段不需要行数统计。透传警告、静默用 0。
          // 主路径（落盘 + 生成 meta）仍会继续，避免"导入一份合法 .bak 却因
          // 探测失败而报错"这种反直觉行为。
          console.warn(
            `[Backup] ingest probe open failed (tmp=${tmp}): ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
        }
        if (probe) {
          try {
            // 有些 .bak 可能不是本项目 schema，表不存在时静默为 0，不阻塞导入
            try {
              noteCount = (probe.prepare("SELECT COUNT(*) as c FROM notes").get() as { c: number }).c;
            } catch { noteCount = 0; }
            try {
              notebookCount = (probe.prepare("SELECT COUNT(*) as c FROM notebooks").get() as { c: number }).c;
            } catch { notebookCount = 0; }
          } finally {
            probe.close();
          }
        }
      } finally {
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      }
    } else {
      // .zip：PK\x03\x04 前两字节必是 "PK"
      if (bytes.length < 2 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
        throw new Error(".zip 文件头非法（不是合法的 ZIP 容器）");
      }
      type = "full";
      // 解析 meta.json，拒绝无法恢复的坏包
      const zip = await JSZip.loadAsync(bytes);
      const metaFile = zip.file("meta.json");
      if (!metaFile) {
        throw new Error(".zip 内缺少 meta.json，非 nowen-note 全量备份格式");
      }
      const dbFile = zip.file("db.sqlite");
      if (!dbFile) {
        throw new Error(".zip 内缺少 db.sqlite，非 nowen-note 全量备份格式");
      }
      let meta: {
        formatVersion?: number;
        schemaVersion?: number;
        tables?: Record<string, number>;
      };
      try {
        meta = JSON.parse(await metaFile.async("string"));
      } catch (e) {
        throw new Error(`meta.json 解析失败：${e instanceof Error ? e.message : String(e)}`);
      }
    if (meta.formatVersion && meta.formatVersion > BACKUP_FORMAT_VERSION) {
      // P0-3：多行引导，让管理员一眼看出"是什么黑什么”、"该怎么办"
      throw new Error(
        [
          `无法导入：备份格式版本太高。`,
          `  备份调用的格式版本：${meta.formatVersion}`,
          `  当前程序支持的最高格式版本：${BACKUP_FORMAT_VERSION}`,
          `  请升级 nowen-note 到该备份产生时的版本（或更新）后再导入。`,
        ].join("\n"),
      );
    }
      formatVersion = meta.formatVersion ?? BACKUP_FORMAT_VERSION;
      schemaVersion = meta.schemaVersion ?? schemaVersion;
      noteCount = Number(meta.tables?.notes ?? 0) || 0;
      notebookCount = Number(meta.tables?.notebooks ?? 0) || 0;
    }

    // —— 3. 落盘 + 生成 meta.json
    this.ensureDir();
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const destFilename = `nowen-backup-${type}-imported-${ts}${extLower}`;
    const destPath = path.join(this.backupDir, destFilename);

    fs.writeFileSync(destPath, bytes);

    const checksum = crypto.createHash("sha256").update(bytes).digest("hex");
    const info: BackupInfo = {
      id: crypto.randomUUID(),
      filename: destFilename,
      size: bytes.length,
      type,
      createdAt: new Date().toISOString(),
      noteCount,
      notebookCount,
      checksum,
      formatVersion,
      schemaVersion,
      description:
        opts.description?.toString().slice(0, 500) ||
        `[imported] 原始文件：${safeName}`,
    };
    fs.writeFileSync(path.join(this.backupDir, `${destFilename}.meta.json`), JSON.stringify(info, null, 2), "utf-8");

    console.log(`[Backup] 外部备份已导入：${destFilename}（size=${bytes.length}, type=${type}）`);
    return info;
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
      // P0-3：与 ingestUploadedBackup 保持一致的结构化多行说明
      throw new Error(
        [
          `无法恢复：备份格式版本高于当前程序。`,
          `  备份格式版本：${meta.formatVersion}（备份产生时间 ${meta.createdAt || "unknown"}）`,
          `  当前程序支持的最高格式版本：${BACKUP_FORMAT_VERSION}`,
          `  请升级 nowen-note 到该备份产生时的版本或更新后再恢复；`,
          `  若仅需从该备份拼选数据，可在 https://github.com/ 查看项目 Releases 页获取对应版本。`,
        ].join("\n"),
      );
    }
    // schema 版本兼容策略：允许 backup.schemaVersion <= 当前程序支持的最高版本。
    // - 备份版本更低：恢复后 runMigrations() 会把它升上来；
    // - 备份版本更高：拒绝，等同于 "新库灌进旧程序"，与 D3 防降级语义一致。
    const codeMaxSchema = (await import("../db/schema.js")).getCodeSchemaVersion();
    if (meta.schemaVersion && meta.schemaVersion > codeMaxSchema) {
      // P0-3：带上 backup、当前 两个 schema 版本、以及备份产生时间，方便判断
      // "差多远"、是否值得费劲升级应用
      throw new Error(
        [
          `无法恢复：备份 schema 版本高于当前程序。`,
          `  备份 schema 版本：${meta.schemaVersion}`,
          `  当前程序支持的最高 schema 版本：${codeMaxSchema}`,
          `  备份产生时间：${meta.createdAt || "unknown"}`,
          ``,
          `原因：该备份是从更新版本的 nowen-note 产生的，错误地被灌到了旧程序。`,
          `解决方案：升级 nowen-note 到与该备份同版或更新后再试。`,
          `提示：不要手动修改 meta.json 来绕过此检查，将造成数据不一致。`,
        ].join("\n"),
      );
    }

    const dbFile = zip.file("db.sqlite");
    if (!dbFile) throw new Error("zip 备份缺少 db.sqlite");

    if (dryRun) {
      // 干跑：从 zip 内 .db 临时打开，统计每张表 N 行
      //
      // 这里刻意不用 os.tmpdir()：
      //   - Windows 下 `os.tmpdir()` 解析为 `C:\Users\<用户名>\AppData\Local\Temp`，
      //     中文用户名 / 含空格的路径在 better-sqlite3 原生层偶发打不开，
      //     症状为 `SQLITE_CANTOPEN: unable to open database file`；
      //   - 且 Windows Defender 会对 Temp 目录实时扫描，刚 writeFileSync 的文件
      //     可能短暂被 AV 进程独占，readonly 打开时抢不到 share-read；
      //   - 相比之下 backupDir 是管理员显式确认可写、路径稳定（ENV/DB 持久化值）
      //     的目录，副作用小、不会被不相关工具扫描。
      // 文件名加 crypto 随机串避免两次并发 dryRun 撞名。
      const tmpDb = path.join(
        this.backupDir,
        `.nowen-dryrun-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.db`,
      );
      fs.writeFileSync(tmpDb, await dbFile.async("nodebuffer"));
      try {
        // 用 better-sqlite3 直接打开（独立连接）
        const Database = (await import("better-sqlite3")).default;
        let tmp: InstanceType<typeof Database>;
        try {
          tmp = new Database(tmpDb, { readonly: true });
        } catch (e) {
          // 透传 SQLite 错误 + 临时路径，管理员可凭此定位 AV / 权限 / 路径问题
          throw new Error(
            `预览恢复失败：无法打开 zip 内的数据库快照（tmp=${tmpDb}）：${
              e instanceof Error ? e.message : String(e)
            }`,
          );
        }
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
    //
    // 也放在 backupDir 而非 os.tmpdir()：
    //   - 与 dryRun 同理避免 Windows 下路径 / AV 造成的 CANTOPEN；
    //   - 下一步 `fs.renameSync(tmpDb, curDbPath)` 要求源和目标 **同卷**，否则
    //     Windows 会报 EXDEV（跨卷 rename 不可原子）。把 tmp 放 backupDir 时，
    //     若 backupDir 与 dataDir 同卷则走 rename；不同卷（常见于用户把备份
    //     挂到独立卷的最佳实践）则 rename 会失败——因此下面的替换逻辑也改成
    //     rename 失败时自动降级 copy+unlink，保持跨卷也能工作。
    const { getDbPath, closeDb } = await import("../db/schema.js");
    const tmpDb = path.join(
      this.backupDir,
      `.nowen-restore-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.db`,
    );
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
      // rename 是原子的，但要求同卷。跨卷（backupDir 挂在独立卷是推荐做法）
      // 会抛 EXDEV，此时降级为 copy + unlink；copy 失败才 throw。
      try {
        fs.renameSync(tmpDb, curDbPath);
      } catch (renameErr) {
        const code = (renameErr as NodeJS.ErrnoException)?.code;
        if (code === "EXDEV" || code === "EPERM") {
          // EXDEV：跨卷；EPERM：Windows 下目标被占用时偶发（closeDb 后罕见，兜底一下）
          fs.copyFileSync(tmpDb, curDbPath);
          try { fs.unlinkSync(tmpDb); } catch { /* ignore tmp 清理失败 */ }
        } else {
          throw renameErr;
        }
      }
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
      // tmpDb 可能还在 backupDir 里，顺手清理避免残留
      try { if (fs.existsSync(tmpDb)) fs.unlinkSync(tmpDb); } catch { /* ignore */ }
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
   * 启动自动备份。
   *
   * 兼容两种调度模式：
   *   - mode="interval"：以固定毫秒周期 setInterval 触发（旧行为）。
   *   - mode="daily"   ：使用链式 setTimeout，每次触发完计算下一次"今天/明天的 HH:mm"再排。
   *                     这样能精确落在管理员指定的低峰时段，而不会被进程重启踢出节奏。
   *
   * @param cfg  完整配置；intervalHours 范围由路由层做了 1~720 校验
   * @param opts.persist  路由触发为 true，启动期按落库值恢复为 false
   */
  startAutoBackup(cfg: AutoBackupConfig, opts?: { persist?: boolean }): void;
  /** @deprecated 旧签名，仅保留以兼容历史调用 —— 仅 enabled+intervalHours，mode 强制 interval */
  startAutoBackup(intervalHours: number, opts?: { persist?: boolean }): void;
  startAutoBackup(
    cfgOrInterval: AutoBackupConfig | number,
    opts: { persist?: boolean } = {},
  ): void {
    this.stopAutoBackup();

    // 归一化为完整 AutoBackupConfig
    const cfg: AutoBackupConfig = typeof cfgOrInterval === "number"
      ? {
          enabled: true,
          intervalHours: cfgOrInterval,
          mode: "interval",
          dailyAt: "03:00",
          keepCount: KEEP_COUNT_DEFAULT,
          emailOnSuccess: false,
          emailTo: "",
        }
      : cfgOrInterval;

    this.autoBackupConfig = { ...cfg, enabled: true };
    this.autoBackupIntervalHours = cfg.intervalHours;
    this.autoBackupMode = cfg.mode === "daily" ? "daily" : "interval";

    if (this.autoBackupMode === "interval") {
      const ms = cfg.intervalHours * 3600 * 1000;
      this.autoBackupNextRunAt = Date.now() + ms;
      this.autoBackupTimer = setInterval(() => {
        this.autoBackupNextRunAt = Date.now() + ms;
        void this.runAutoTick();
      }, ms);
      console.log(`[Backup] 自动备份已启动（间隔模式，每 ${cfg.intervalHours} 小时）`);
    } else {
      this.scheduleNextDaily(cfg.dailyAt || "03:00");
      console.log(`[Backup] 自动备份已启动（每日 ${cfg.dailyAt} 模式）`);
    }

    if (opts.persist) {
      this.persistAutoConfig(this.autoBackupConfig);
    }
  }

  /**
   * 排定下一次 daily 触发。
   * 当前时间 < 今日 HH:mm → 排到今日；否则 → 排到明日同一时刻。
   * 触发完后递归调用自己重排下一日，形成稳定的"每天一次"链。
   */
  private scheduleNextDaily(hhmm: string): void {
    const [hh, mm] = hhmm.split(":").map((n) => Number(n));
    const now = new Date();
    const next = new Date(now);
    next.setHours(hh, mm, 0, 0);
    if (next.getTime() <= now.getTime()) {
      next.setDate(next.getDate() + 1);
    }
    const delay = next.getTime() - now.getTime();
    this.autoBackupNextRunAt = next.getTime();
    this.autoBackupTimer = setTimeout(async () => {
      try {
        await this.runAutoTick();
      } finally {
        // 即便 tick 失败也继续排明天的——避免"一次失败永久哑火"
        if (this.autoBackupConfig.enabled && this.autoBackupMode === "daily") {
          this.scheduleNextDaily(this.autoBackupConfig.dailyAt || "03:00");
        }
      }
    }, delay);
  }

  /**
   * 一次自动备份的实际执行体。两种调度模式共用。
   *   1. 产 db-only 备份；
   *   2. 按 keepCount 清理多余 db-only；
   *   3. emailOnSuccess && SMTP ready → 发邮件（失败仅记日志，不影响备份成功）。
   */
  private async runAutoTick(): Promise<void> {
    try {
      const info = await this.createBackup({ type: "db-only", description: "自动备份" });
      console.log(`[Backup] 自动备份完成: ${info.filename}`);

      // 保留策略：手动备份也会调用 pruneDbOnly()，这里再触发一次属正常冗余
      this.pruneDbOnly();

      // 自动发邮件：动态 import 避免循环依赖，且 SMTP 没启用直接 skip
      const cfg = this.autoBackupConfig;
      if (cfg.emailOnSuccess && cfg.emailTo) {
        await this.sendAutoBackupEmail(info.filename, cfg.emailTo).catch((err) => {
          console.warn("[Backup] 自动备份邮件发送失败:", err instanceof Error ? err.message : err);
        });
      }
    } catch (err) {
      console.error("[Backup] 自动备份失败:", err instanceof Error ? err.message : err);
    }
  }

  /**
   * 清理多余的 db-only 备份。
   *
   * 由两条路径触发：
   *   - 自动 tick 完成后
   *   - 手动 createBackup() 完成后（在 createBackup 末尾调用，避免手动产物无限堆积）
   *
   * 仅清理 db-only；full 类型由管理员手动管理，避免误删大体积归档。
   */
  pruneDbOnly(): void {
    try {
      const keep = this.autoBackupConfig.keepCount ?? KEEP_COUNT_DEFAULT;
      const all = this.listBackups();
      const dbOnly = all.filter((b) => b.filename.includes("db-only"));
      if (dbOnly.length > keep) {
        for (const old of dbOnly.slice(keep)) {
          this.deleteBackup(old.filename);
        }
      }
    } catch (e) {
      console.warn("[Backup] pruneDbOnly failed:", e instanceof Error ? e.message : e);
    }
  }

  /**
   * 发送"自动备份完成邮件"。
   *   - 仅当 SMTP 启用且就绪时才发；否则静默跳过（不应阻塞或失败化备份本身）。
   *   - 附件大小若超过 EMAIL_ATTACHMENT_LIMIT 则只发文字摘要，附件位置注明"请手动下载"。
   *     避免把 50MB 的备份硬塞给会拒收的邮箱服务商。
   */
  private async sendAutoBackupEmail(filename: string, to: string): Promise<void> {
    const { readSmtpConfig, sendMail, EMAIL_ATTACHMENT_LIMIT } = await import("./email");
    const smtp = readSmtpConfig();
    if (!smtp.enabled || !smtp.host || !smtp.username || !smtp.password) {
      console.log("[Backup] 跳过自动备份邮件：SMTP 未启用或未就绪");
      return;
    }

    const filePath = this.getBackupPath(filename);
    if (!filePath || !fs.existsSync(filePath)) return;

    const stat = fs.statSync(filePath);
    const sizeMB = (stat.size / 1024 / 1024).toFixed(2);
    const tooLarge = stat.size > EMAIL_ATTACHMENT_LIMIT;

    const lines = [
      `这是一封由 nowen-note 自动发送的备份完成通知。`,
      ``,
      `备份文件：${filename}`,
      `大小：${sizeMB} MB`,
      `时间：${new Date().toLocaleString()}`,
    ];
    if (tooLarge) {
      lines.push(
        ``,
        `⚠️ 附件超过邮件 25MB 上限，本邮件未包含附件，请登录系统手动下载备份。`,
      );
    }

    const attachments = tooLarge
      ? []
      : [{
          filename,
          content: fs.readFileSync(filePath),
          contentType: filename.endsWith(".zip") ? "application/zip" : "application/octet-stream",
        }];

    const result = await sendMail({
      to,
      subject: `[nowen-note] 自动备份 ${filename}`,
      text: lines.join("\n"),
      attachments,
    });
    if (!result.success) {
      console.warn(`[Backup] 自动备份邮件发送失败: ${result.error}`);
    } else {
      console.log(`[Backup] 自动备份邮件已发送至 ${to}`);
    }
  }

  /**
   * 停止自动备份。
   *
   * @param opts.persist        是否写持久化（路由触发为 true，内部 stopAutoBackup() 调用为 false）
   * @param opts.intervalHours  停用时仍记录上次的间隔，方便下次"启用"时复用同样的频率
   */
  stopAutoBackup(opts: { persist?: boolean; intervalHours?: number } = {}): void {
    if (this.autoBackupTimer) {
      // 同时兼容 setInterval 和 setTimeout 两种 timer：clearTimeout 在 Node 内部
      // 等价于 clearInterval（都是 clear unref 的句柄），但显式两次更稳。
      clearInterval(this.autoBackupTimer as NodeJS.Timeout);
      clearTimeout(this.autoBackupTimer as NodeJS.Timeout);
      this.autoBackupTimer = null;
    }
    this.autoBackupNextRunAt = null;
    if (opts.persist) {
      // 复用上次完整配置，只把 enabled 翻为 false——这样下次"启用"时
      // 用户的 mode/dailyAt/keepCount/邮件设置都还在。
      this.autoBackupConfig = {
        ...this.autoBackupConfig,
        enabled: false,
        intervalHours: opts.intervalHours ?? this.autoBackupConfig.intervalHours ?? this.autoBackupIntervalHours,
      };
      this.persistAutoConfig(this.autoBackupConfig);
    }
  }

  /**
   * 清理 note_versions（P0-1）
   *
   * 每篇笔记保留最近 keepRecent 条 + createdAt 距今 keepDays 天内的全部条目。
   * 用一条 DELETE + 子查询完成，避免逐 noteId 循环。
   *
   * 注意：
   *   - **不删 changeSummary != 'edit' 的版本**（如 manual/snapshot）
   *     这些通常是用户主动保存的关键节点，无论多老都保留；
   *   - rowid 子查询走 idx_note_versions_note(noteId, version DESC) 索引，
   *     即使版本表很大也能快速定位每篇 top-N。
   *
   * 返回删除行数（日志用）。
   */
  pruneNoteVersions(): number {
    try {
      const db = getDb();
      // 读策略
      let keepRecent = VERSION_KEEP_RECENT_DEFAULT;
      let keepDays = VERSION_KEEP_DAYS_DEFAULT;
      try {
        const row = db
          .prepare("SELECT value FROM system_settings WHERE key = ?")
          .get(VERSION_RETENTION_KV_KEY) as { value: string } | undefined;
        if (row?.value) {
          const parsed = JSON.parse(row.value) as { keepRecent?: number; keepDays?: number };
          if (Number.isFinite(parsed.keepRecent)) {
            keepRecent = Math.max(1, Math.min(VERSION_KEEP_RECENT_MAX, Math.round(Number(parsed.keepRecent))));
          }
          if (Number.isFinite(parsed.keepDays)) {
            keepDays = Math.max(1, Math.min(VERSION_KEEP_DAYS_MAX, Math.round(Number(parsed.keepDays))));
          }
        }
      } catch {
        /* 配置坏掉就用默认 */
      }

      // SQLite datetime('now') 默认 UTC，与 createdAt 默认值同语境
      const removed = noteVersionsRepository.pruneOldVersions(keepRecent, keepDays);
      if (removed > 0) {
        console.log(
          `[Backup] pruneNoteVersions: 清理了 ${removed} 行旧版本（keepRecent=${keepRecent}, keepDays=${keepDays}）`,
        );
      }
      return removed;
    } catch (e) {
      console.warn("[Backup] pruneNoteVersions failed:", e instanceof Error ? e.message : e);
      return 0;
    }
  }

  /**
   * 备份连续失败时的告警邮件（P1-3）。
   *
   * 触发条件：consecutiveFailures 刚好达到 FAILURE_DEGRADE_THRESHOLD（去抖：
   * 仅在阈值边沿发一次，避免同样的失败连发 N 封）。
   *
   * 收件人：复用 autoBackupConfig.emailTo（管理员配置自动备份邮件时已经给过），
   * 没配则跳过——不强行向 SMTP fromEmail 发，避免与“成功通知”混淆。
   *
   * 失败本身不阻断主流程：sendMail 抛错只记日志。
   */
  private async sendBackupFailureAlert(reason: string): Promise<void> {
    try {
      const cfg = this.autoBackupConfig;
      if (!cfg.emailTo) {
        console.log("[Backup] 跳过失败告警邮件：未配置 emailTo");
        return;
      }
      const { readSmtpConfig, sendMail } = await import("./email");
      const smtp = readSmtpConfig();
      if (!smtp.enabled || !smtp.host || !smtp.username || !smtp.password) {
        console.log("[Backup] 跳过失败告警邮件：SMTP 未启用或未就绪");
        return;
      }
      const lines = [
        `nowen-note 备份链路连续失败 ${this.health.consecutiveFailures} 次，已进入降级状态。`,
        ``,
        `最近失败时间：${this.health.lastFailureAt || new Date().toISOString()}`,
        `失败原因：${reason}`,
        `备份目录：${this.backupDir}`,
        `上次成功时间：${this.health.lastSuccessAt || "（暂无成功记录）"}`,
        ``,
        `请尽快登录管理后台 → 数据管理 → 备份页签 排查（常见：磁盘满 / 备份目录不可写 / 跨卷权限）。`,
      ];
      const result = await sendMail({
        to: cfg.emailTo,
        subject: `[nowen-note] 备份连续失败告警（${this.health.consecutiveFailures} 次）`,
        text: lines.join("\n"),
      });
      if (result.success) {
        console.log(`[Backup] 失败告警邮件已发送至 ${cfg.emailTo}`);
      } else {
        console.warn(`[Backup] 失败告警邮件发送失败: ${result.error}`);
      }
    } catch (e) {
      console.warn("[Backup] sendBackupFailureAlert error:", e instanceof Error ? e.message : e);
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
      autoBackupMode: this.autoBackupMode,
      autoBackupDailyAt: this.autoBackupConfig.dailyAt,
      autoBackupKeepCount: this.autoBackupConfig.keepCount ?? KEEP_COUNT_DEFAULT,
      autoBackupEmailOnSuccess: this.autoBackupConfig.emailOnSuccess === true,
      autoBackupEmailTo: this.autoBackupConfig.emailTo ?? "",
      autoBackupNextRunAt: this.autoBackupNextRunAt
        ? new Date(this.autoBackupNextRunAt).toISOString()
        : null,
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
