/**
 * 数据备份与恢复 API
 *
 * - GET    /api/backups                       — 列出备份
 * - GET    /api/backups/status                — 健康指标（含同卷告警）
 * - GET    /api/backups/dir                   — 当前备份目录 + 数据目录（管理员）
 * - POST   /api/backups/dir                   — 切换备份目录（管理员 + sudo；?dryRun=1 仅校验）
 * - POST   /api/backups                       — 创建备份（管理员 + sudo）
 * - POST   /api/backups/upload                — 导入外部 .bak/.zip 备份（管理员 + sudo）
 * - GET    /api/backups/:filename/download    — 下载备份（管理员）
 * - POST   /api/backups/:filename/restore     — 从备份恢复（管理员 + sudo；支持 ?dryRun=1）
 * - DELETE /api/backups/:filename             — 删除备份（管理员 + sudo）
 * - POST   /api/backups/auto                  — 启动/停止自动备份（管理员 + sudo）
 *
 * 安全：
 *  - 整个路由组都强制 requireAdmin —— 备份文件是全库 dump，普通用户既不该看到
 *    其他人的快照，也不该有权限恢复 / 删除。
 *  - 破坏性操作（POST、DELETE、restore、auto）额外要求 sudoToken：
 *    与 /api/data-file/import 一致的 H2 二次验证模式，避免会话被劫持后被一键
 *    "恢复到三个月前"或"删光所有备份"。
 *  - restore 必须先以 dryRun=true 调用一次让前端弹出
 *    "将清空 N 行 / 将插入 M 行 / 含 K 个附件" 的二次确认对话框，再正式提交。
 *  - 当 status.sameVolume=true 时前端应在备份页给出红色横幅，明确告知"备份与
 *    数据在同一物理卷，无法防御卷级故障，请在 docker-compose 配置 BACKUP_DIR
 *    指向独立卷"。
 */

import { Hono } from "hono";
import type { Context } from "hono";
import fs from "fs";
import path from "path";
import { getBackupManager } from "../services/backup.js";
import { requireAdmin } from "../middleware/acl.js";
import { getDb } from "../db/schema.js";
import { verifySudoFromRequest } from "../lib/auth-security.js";
import { sendMail, EMAIL_ATTACHMENT_LIMIT, readSmtpConfig } from "../services/email.js";
import { logAudit } from "../services/audit.js";

const backupsRouter = new Hono();

// ============================================================================
// 全路由守门：必须是系统管理员
// ----------------------------------------------------------------------------
// 备份文件覆盖全库（含其他用户的私密笔记 / 加密 secret），不能让普通用户访问。
// 采用 router.use(*, requireAdmin) 避免每个 handler 重复挂。
// ============================================================================
backupsRouter.use("*", requireAdmin);

/**
 * 高危操作的 sudo 校验封装。
 *
 * 与 routes/users.ts 的 requireSudoOrDeny 一脉相承：拿当前 userId 的
 * tokenVersion 去 verifySudoFromRequest，命中即返回 null（放行），未命中
 * 返回带 SUDO_REQUIRED/SUDO_INVALID 的 403/401，前端会据此弹密码框重试。
 *
 * 备份场景下不接审计日志（routes/users.ts 才接），原因：
 *  - 操作主体已是单一管理员（不像用户管理涉及"我对别人做了什么"）；
 *  - 备份创建/删除已经在 BackupManager 内部 console.log 留痕；
 *  - 服务器日志足够追踪谁在何时点了 restore。
 */
function requireBackupSudo(c: Context): Response | null {
  const userId = c.req.header("X-User-Id") || "";
  const db = getDb();
  const me = db
    .prepare("SELECT tokenVersion FROM users WHERE id = ?")
    .get(userId) as { tokenVersion: number } | undefined;
  const sudo = verifySudoFromRequest(c, userId, me?.tokenVersion ?? 0);
  if (!sudo.ok) {
    return c.json({ error: sudo.message, code: sudo.code }, sudo.status as 401 | 403);
  }
  return null;
}

// ===== GET /api/backups =====
backupsRouter.get("/", (c) => {
  const manager = getBackupManager();
  return c.json(manager.listBackups());
});

// ===== GET /api/backups/status =====
backupsRouter.get("/status", (c) => {
  const manager = getBackupManager();
  return c.json(manager.getHealth());
});

// ===== GET /api/backups/dir =====
// 返回 { backupDir, dataDir }，供前端"备份目录配置区"显示当前生效值。
// 不需要 sudo——只是读路径字符串，不暴露备份内容。
backupsRouter.get("/dir", (c) => {
  const manager = getBackupManager();
  return c.json({
    backupDir: manager.getBackupDir(),
    dataDir: manager.getDataDir(),
  });
});

// ===== POST /api/backups/dir =====
// body: { path: string }
// query: ?dryRun=1   仅校验路径合法性 + 同卷/可用空间，不真正切换
//
// 安全：
//   - dryRun 仍需 admin（防嗅探）但不需 sudo——前端要先用它给出
//     "同卷警告/可用空间显示/不可写报错"才决定要不要弹密码框；
//   - 真正切换必须 sudo——这是会影响往后所有备份落地位置的全局性操作。
//
// 注意：切换后旧目录的备份文件不会被自动迁移，需管理员手动 cp（前端文案已说明）。
backupsRouter.post("/dir", async (c) => {
  const qDry = c.req.query("dryRun");
  const body = (await c.req.json().catch(() => ({}))) as { path?: string; dryRun?: boolean };
  const dryRun = qDry === "1" || qDry === "true" || body.dryRun === true;
  const target = String(body.path || "").trim();

  if (!target) {
    return c.json({ error: "缺少 path 参数" }, 400);
  }

  if (!dryRun) {
    const denied = requireBackupSudo(c);
    if (denied) return denied;
  }

  const manager = getBackupManager();
  const result = dryRun ? manager.previewBackupDir(target) : manager.setBackupDir(target);

  if (!result.ok) {
    // 校验失败属于客户端输入错（路径不合法/不可写），返回 400 + reason 让前端做 i18n
    return c.json(
      {
        ok: false,
        reason: result.reason,
        message: result.message,
        resolved: result.resolved,
      },
      400,
    );
  }

  return c.json({
    ok: true,
    dryRun,
    resolved: result.resolved,
    sameVolume: result.sameVolume,
    freeBytes: result.freeBytes,
  });
});

// ===== POST /api/backups =====
// 创建备份本身不是破坏性的，但会消耗磁盘 + 暴露全库快照路径，
// 仍要求 sudo —— 与 /data-file/export 的"管理员可下载"语义保持一致严格度。
backupsRouter.post("/", async (c) => {
  const userId = c.req.header("X-User-Id") || "";
  const denied = requireBackupSudo(c);
  if (denied) return denied;

  const body = (await c.req.json().catch(() => ({}))) as { type?: "full" | "db-only"; description?: string };
  const manager = getBackupManager();

  try {
    const info = await manager.createBackup({
      type: body.type || "db-only",
      description: body.description,
    });

    // SEC-AUDIT-01
    logAudit(userId, "system", "backup_create", {
      filename: info.filename, type: body.type || "db-only",
    }, { targetType: "backup", targetId: info.filename });

    return c.json(info, 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: `备份失败: ${msg}` }, 500);
  }
});

// ===== POST /api/backups/upload =====
// multipart/form-data，字段名 "file"（可选 "description"）
//
// 用途：把"外部"备份文件（邮件附件回收、U盘拷贝、异机迁移）放进当前实例的备份
// 列表。进去之后就能走既有的 dryRun 预览 → sudo 恢复的完整流程，与就地创建的
// 备份完全同构。
//
// 刻意"只导入、不恢复"：上传这一步本身不触及现网数据，即便文件有问题也只是多
// 一份坏备份躺在目录里，管理员下一步点"恢复"时仍有 dryRun 可以看预览 + 再确
// 认。这与 /api/data-file/import 的"直接覆盖"是不同语义，不能合并。
//
// 安全：
//   - 管理员 + sudo（备份文件含全库快照，写入会进入备份目录，强度与 create/delete 一致）；
//   - 大小上限 500 MB：足以覆盖绝大多数实际备份，同时避免恶意巨大文件打爆磁盘；
//   - 文件类型白名单 .bak / .zip（BackupManager.ingestUploadedBackup 内再做魔数校验）。
backupsRouter.post("/upload", async (c) => {
  const denied = requireBackupSudo(c);
  if (denied) return denied;

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: "请求必须是 multipart/form-data" }, 400);
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return c.json({ error: "缺少 file 字段" }, 400);
  }
  if (file.size === 0) {
    return c.json({ error: "上传文件为空" }, 400);
  }
  // 500 MB 上限。全量 .zip 可能偏大，比 SMTP 的 25MB 要宽很多。
  if (file.size > 500 * 1024 * 1024) {
    return c.json({ error: "文件过大（>500MB），请通过服务器文件系统拷贝" }, 413);
  }

  const description = (form.get("description") ?? "").toString().slice(0, 500) || undefined;
  const bytes = Buffer.from(await file.arrayBuffer());

  const manager = getBackupManager();
  try {
    const info = await manager.ingestUploadedBackup(file.name || "uploaded.bak", bytes, { description });
    return c.json(info, 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 文件格式非法 → 400（客户端问题）；其他 → 500
    const isFormatErr = /文件头|缺少|仅支持|格式|meta\.json|非法|损坏/.test(msg);
    return c.json({ error: `导入失败: ${msg}` }, isFormatErr ? 400 : 500);
  }
});

// ===== GET /api/backups/:filename/download =====
backupsRouter.get("/:filename/download", (c) => {
  const filename = c.req.param("filename");
  const manager = getBackupManager();
  const filePath = manager.getBackupPath(filename);

  if (!filePath) return c.json({ error: "备份不存在" }, 404);

  const content = fs.readFileSync(filePath);
  return new Response(content, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": content.length.toString(),
    },
  });
});

// ===== POST /api/backups/:filename/restore =====
// 查询参数 ?dryRun=1 时只预览不动数据；body 也可传 { dryRun: true }
//
// 安全分层：
//   - dryRun=true 仍需 admin（防嗅探），但 **不强制 sudo**——前端要先调它
//     才能展示"将清空 N 行"的预览，让用户在密码框前看到风险；
//   - dryRun=false 必须 sudo——这是真正的破坏性提交。
backupsRouter.post("/:filename/restore", async (c) => {
  const filename = c.req.param("filename");
  const manager = getBackupManager();
  const qDry = c.req.query("dryRun");
  const body = (await c.req.json().catch(() => ({}))) as { dryRun?: boolean };
  const dryRun = qDry === "1" || qDry === "true" || body.dryRun === true;

  if (!dryRun) {
    const denied = requireBackupSudo(c);
    if (denied) return denied;
  }

  const result = await manager.restoreFromBackup(filename, { dryRun });
  if (!result.success) {
    return c.json({ error: result.error }, 400);
  }

  // SEC-AUDIT-01
  if (!dryRun) {
    const userId = c.req.header("X-User-Id") || "";
    logAudit(userId, "system", "backup_restore", {
      filename, success: result.success,
    }, { targetType: "backup", targetId: filename, level: "warn" });
  }

  return c.json(result);
});

// ===== DELETE /api/backups/:filename =====
backupsRouter.delete("/:filename", (c) => {
  const userId = c.req.header("X-User-Id") || "";
  const denied = requireBackupSudo(c);
  if (denied) return denied;

  const filename = c.req.param("filename");
  const manager = getBackupManager();
  const result = manager.deleteBackup(filename);

  // SEC-AUDIT-01
  logAudit(userId, "system", "backup_delete", {
    filename, success: result,
  }, { targetType: "backup", targetId: filename, level: "warn" });

  return c.json({ success: result });
});

// ===== POST /api/backups/auto =====
// body: { enabled: boolean, intervalHours?: number, mode?, dailyAt?, keepCount?, email*? }
//   - enabled=false: 立即停止；intervalHours 仍会被持久化为"下次启用时使用的值"
//   - enabled=true:  以 intervalHours（缺省 24）启动并持久化
//   - keepCount:     只控制 db-only 保留数量；full 不参与自动清理
//
// 持久化由 BackupManager.startAutoBackup / stopAutoBackup 内部完成，
// 写入 system_settings 表的 backup:auto 键。重启后启动钩子会读取并恢复完整配置。
backupsRouter.post("/auto", async (c) => {
  const denied = requireBackupSudo(c);
  if (denied) return denied;

  const body = (await c.req.json().catch(() => ({}))) as {
    enabled?: boolean;
    intervalHours?: number;
    mode?: "interval" | "daily";
    dailyAt?: string;
    keepCount?: number;
    emailOnSuccess?: boolean;
    emailTo?: string;
  };
  const manager = getBackupManager();

  // 间隔范围校验：1h ~ 720h(30 天)。低于 1h 会让备份吞 IO；高于 30 天等于没开。
  let interval = body.intervalHours ?? 24;
  if (!Number.isFinite(interval) || interval < 1) interval = 1;
  if (interval > 720) interval = 720;

  // mode 校验：默认 interval；daily 必须带合法 HH:mm
  const mode: "interval" | "daily" = body.mode === "daily" ? "daily" : "interval";
  let dailyAt = typeof body.dailyAt === "string" ? body.dailyAt : "03:00";
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(dailyAt)) {
    if (mode === "daily") {
      return c.json({ error: "dailyAt 必须是 HH:mm 24h 格式" }, 400);
    }
    dailyAt = "03:00";
  }

  // keepCount 范围 1~100。启用时缺省 15；停用时若旧客户端未传则保留当前值。
  let keepCount = Number(body.keepCount);
  if (!Number.isFinite(keepCount)) keepCount = 15;
  keepCount = Math.max(1, Math.min(100, Math.round(keepCount)));

  const emailOnSuccess = body.emailOnSuccess === true;
  const emailTo = (body.emailTo || "").trim();
  if (emailOnSuccess && (!emailTo || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailTo))) {
    return c.json({ error: "启用自动发邮件时收件人邮箱格式必须合法" }, 400);
  }

  if (body.enabled === false) {
    manager.stopAutoBackup({
      persist: true,
      config: {
        intervalHours: interval,
        ...(body.mode !== undefined ? { mode } : {}),
        ...(body.dailyAt !== undefined ? { dailyAt } : {}),
        ...(body.keepCount !== undefined ? { keepCount } : {}),
        ...(body.emailOnSuccess !== undefined ? { emailOnSuccess } : {}),
        ...(body.emailTo !== undefined ? { emailTo } : {}),
      },
    });
    const status = manager.getHealth();
    return c.json({
      success: true,
      message: "自动备份已停止，备份保留设置已保存",
      enabled: false,
      intervalHours: status.autoBackupIntervalHours,
      mode: status.autoBackupMode,
      dailyAt: status.autoBackupDailyAt,
      keepCount: status.autoBackupKeepCount,
      emailOnSuccess: status.autoBackupEmailOnSuccess,
      emailTo: status.autoBackupEmailTo,
    });
  }

  manager.startAutoBackup(
    {
      enabled: true,
      intervalHours: interval,
      mode,
      dailyAt,
      keepCount,
      emailOnSuccess,
      emailTo,
    },
    { persist: true },
  );
  return c.json({
    success: true,
    message:
      mode === "daily"
        ? `自动备份已启动，每天 ${dailyAt} 触发`
        : `自动备份已启动，每 ${interval} 小时触发`,
    enabled: true,
    intervalHours: interval,
    mode,
    dailyAt,
    keepCount,
    emailOnSuccess,
    emailTo,
  });
});

// ===== POST /api/backups/:filename/send-email =====
//
// body: {
//   to: string;
//   note?: string;
//   // 附件格式可选项：
//   //   - 不传 / "current"：直接发当前 :filename 备份本身；
//   //   - "full"   ：现场 createBackup({type:"full"})  产出新 .zip 再发送；
//   //   - "db-only"：现场 createBackup({type:"db-only"}) 产出新 .bak 再发送；
//   // 这样用户能在"发送邮箱"对话框选择附件形式——
//   //   · .zip  = 全量备份（数据库 + 附件 + 字体 + 插件 + JWT 密钥），体积大
//   //   · .bak  = SQLite 纯数据库快照，体积小、恢复快但丢附件
//   // 现场生成的备份会像普通备份一样留在备份列表中，形成"一次操作 = 一条归档 + 一封邮件"，
//   // 与"发送后就消失"相比更符合灾备语义。
//   createNew?: "current" | "full" | "db-only";
// }
//
// 安全与设计：
//  - 备份文件是全库 dump，**必须** admin + sudo；没有 sudo 就允许一键发信等同于
//    把整库甩给邮箱账号，与 create/delete 一致强度；
//  - 不允许自定义 subject / body 附带任意 HTML——避免管理员账号被劫持后，攻击者
//    把服务器当成钓鱼邮件跳板。正文走固定模板，管理员只能补一行可选 note；
//  - 附件硬上限 25 MB：这是多数邮箱服务商（Gmail/Outlook/QQ 邮箱）的附件上限，
//    更大只会被拒收并撑内存；前端文案会引导管理员"超限请下载后手动发送"；
//  - SMTP 必须先在 /api/email/smtp 配好并 enabled=true，否则直接 412 Precondition Failed。
backupsRouter.post("/:filename/send-email", async (c) => {
  const denied = requireBackupSudo(c);
  if (denied) return denied;

  const filenameParam = c.req.param("filename");
  const body = (await c.req.json().catch(() => ({}))) as {
    to?: string;
    note?: string;
    createNew?: "current" | "full" | "db-only";
  };
  const to = (body.to || "").trim();
  if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
    return c.json({ error: "收件人邮箱格式不合法" }, 400);
  }

  // 前置检查：SMTP 是否已启用且密码已填
  const smtp = readSmtpConfig();
  if (!smtp.enabled || !smtp.host || !smtp.username || !smtp.password) {
    return c.json(
      { error: "SMTP 未配置或未启用，请先在「备份 → 邮件通道」中完成配置", code: "SMTP_NOT_READY" },
      412,
    );
  }

  const manager = getBackupManager();

  // 决定实际要发送的备份文件：
  //   - createNew=full/db-only：现场生成一份新备份（会留在备份列表里，与手动点
  //     "创建备份"等效），然后发送它；
  //   - 其他情况：发送 URL 里指定的 :filename 备份。
  let filename = filenameParam;
  let generatedNew = false;
  if (body.createNew === "full" || body.createNew === "db-only") {
    try {
      const info = await manager.createBackup({
        type: body.createNew,
        description: `邮件发送：${to}`,
      });
      filename = info.filename;
      generatedNew = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: `生成备份失败: ${msg}` }, 500);
    }
  }

  const filePath = manager.getBackupPath(filename);
  if (!filePath || !fs.existsSync(filePath)) {
    return c.json({ error: "备份文件不存在" }, 404);
  }

  const stat = fs.statSync(filePath);
  if (stat.size > EMAIL_ATTACHMENT_LIMIT) {
    return c.json(
      {
        error: `备份文件 ${(stat.size / 1024 / 1024).toFixed(1)} MB 超过邮件附件 25MB 上限，请改用「下载」后手动发送`,
        code: "ATTACHMENT_TOO_LARGE",
      },
      413,
    );
  }

  const content = fs.readFileSync(filePath);
  const ext = path.extname(filename).toLowerCase();
  const contentType =
    ext === ".zip" ? "application/zip" : ext === ".bak" ? "application/octet-stream" : "application/octet-stream";

  const note = (body.note || "").toString().slice(0, 500); // 限制附加备注长度，防滥用
  const sizeMB = (stat.size / 1024 / 1024).toFixed(2);
  const lines = [
    `这是一封由 nowen-note 自动发送的数据备份邮件。`,
    ``,
    `备份文件：${filename}`,
    `大小：${sizeMB} MB`,
    `发送时间：${new Date().toLocaleString()}`,
  ];
  if (note) {
    lines.push(``, `管理员备注：`, note);
  }
  lines.push(
    ``,
    `安全提醒：`,
    `- 备份文件包含完整数据库快照，请妥善保管；`,
    `- 收到后建议立即将附件归档至离线存储介质；`,
    `- 如非本人操作请立即登录系统检查邮件配置及登录记录。`,
  );

  const result = await sendMail({
    to,
    subject: `[nowen-note] 数据备份 ${filename}`,
    text: lines.join("\n"),
    attachments: [{ filename, content, contentType }],
  });

  if (!result.success) {
    return c.json({ success: false, error: result.error }, 502);
  }
  return c.json({
    success: true,
    lastResponse: result.lastResponse,
    size: stat.size,
    // 当 createNew 请求时，前端需要知道"真正发送的是哪个文件"，用来展示
    // "已生成新备份 xxx 并发送到 xxx@xxx" 的反馈，并顺便让前端 refresh 备份列表。
    filename,
    generatedNew,
  });
});

export default backupsRouter;
