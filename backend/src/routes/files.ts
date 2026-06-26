/**
 * 文件管理路由（/api/files）
 * ---------------------------------------------------------------------------
 * 定位：
 *   这是"文件管理"模块的后端聚合层——面向**当前用户可见**的所有附件（图片 +
 *   非图片文件），提供列表、搜索、筛选、分类统计、详情（含反向引用）、上传、
 *   删除等能力。
 *
 * 与现有 /api/attachments 的关系：
 *   - attachments.ts：定位是"单笔记附件的 CRUD + 孤儿扫描"，强依赖 noteId。
 *     已经承载了下载（handleDownloadAttachment）、上传、内联 base64 抽取、
 *     GC 扫描等所有**存量**逻辑，不能动——改它风险太高。
 *   - files.ts（本文件）：定位是"跨笔记的附件视图"，类似"相册 / 文件柜"。
 *     完全复用已落盘的 ATTACHMENTS_DIR + attachments 表，不新建字段、不新建
 *     目录、不改磁盘布局。查询时 JOIN notes/notebooks 获取反向引用信息。
 *   - 下载 URL 仍然是 /api/attachments/<id>（免 JWT、可被 <img> 直接用），
 *     本模块只管"查哪些文件、在哪些笔记里出现过"。
 *
 * 授权模型：
 *   - 所有接口都在 JWT 中间件之后（/api/files 挂载在受保护段）。
 *   - 列表只返回"当前用户自己的"附件（attachments.userId = X-User-Id）。
 *   - 详情 / 删除：除了 userId 校验，还要通过 resolveNotePermission 走一次
 *     对所属笔记的 write 权限（与 attachments.ts DELETE 保持一致），确保
 *     工作区场景下的 ACL 不被绕过。
 *
 * 反向关联（双向跳转）：
 *   attachments 表本身有 noteId 列，但在"一个附件被多条笔记引用（例如同一
 *   张图在两篇笔记里都粘贴了同一个 /api/attachments/<id> URL）"的场景下，
 *   不能只靠 attachments.noteId——那是"首次归属"的笔记。因此详情接口会：
 *     1) 返回 primaryNote（attachments.noteId 指向的那条，不存在时为 null）；
 *     2) 扫描 notes.content 找出所有 indexOf(`/api/attachments/<id>`) ≥ 0
 *        的笔记，聚合成 references[]，用于前端列出"引用此文件的笔记页面"。
 *   扫描是 O(N) 全表遍历，但 notes 数量量级可控，且 content 已经通过压缩
 *   中间件传输；一次详情查询可以接受。更大规模时再考虑建倒排索引。
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { v4 as uuid } from "uuid";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { getDb } from "../db/schema";
import {
  ensureAttachmentsDir,
  getAttachmentsDir,
  MIME_TO_EXT,
} from "./attachments";
import {
  deleteAttachmentObject,
  getAttachmentStorageInfo,
  getUploadMonthPath,
  readObjectStorageConfigPublic,
  writeAttachmentObject,
} from "../services/attachment-storage";
import {
  resolveNotePermission,
  hasPermission,
  getUserWorkspaceRole,
  requireWorkspaceFeature,
} from "../middleware/acl";

const app = new Hono();

// ---------------------------------------------------------------------------
// 共用工具
// ---------------------------------------------------------------------------

const IMAGE_MIME_PREFIX = "image/";

/** 判定一个 MIME 是否属于图片（供分类筛选用）。 */
function isImage(mime: string | null | undefined): boolean {
  return !!mime && mime.toLowerCase().startsWith(IMAGE_MIME_PREFIX);
}

// ---------------------------------------------------------------------------
// 调试开关：files-list query 解析详情打印
// ---------------------------------------------------------------------------
//
// 双源开关——env 与 system_settings.debug_files_query 任一为 true 即开启：
//   - env DEBUG_FILES_QUERY=1：运维侧旁路开关，进程启动后即生效，不依赖前端；
//   - system_settings 表 debug_files_query='true'：管理员在前端「设置 → 开发者」
//     面板上切换的运行时开关，进程不重启即可临时启用。
//
// 由于这条路径在每次列表请求里都会走一次，加 30s 内存缓存，避免给 SQLite
// 增加无谓压力。settings PUT 后最迟 30s 内对所有请求生效，肉眼不可感。
let debugFlagCache: { value: boolean; expiresAt: number } | null = null;
const DEBUG_FLAG_TTL_MS = 30_000;

function isFilesQueryDebugEnabled(db: ReturnType<typeof getDb>): boolean {
  if (process.env.DEBUG_FILES_QUERY === "1") return true;
  const now = Date.now();
  if (debugFlagCache && debugFlagCache.expiresAt > now) {
    return debugFlagCache.value;
  }
  let v = false;
  try {
    const row = db
      .prepare("SELECT value FROM system_settings WHERE key = 'debug_files_query'")
      .get() as { value: string } | undefined;
    v = row?.value === "true";
  } catch {
    // 老库或迁移异常时静默退回 false——调试开关不能反过来阻塞主路径
    v = false;
  }
  debugFlagCache = { value: v, expiresAt: now + DEBUG_FLAG_TTL_MS };
  return v;
}

/** 测试 / settings PUT 后立即生效场景使用：清掉缓存，下次读取强制查 DB。 */
export function invalidateFilesQueryDebugCache() {
  debugFlagCache = null;
}



/**
 * 把一条附件行 + 关联的 notebook 信息转成前端消费格式。
 *
 * url 字段始终是 `/api/attachments/<id>` 相对路径；前端用
 * resolveAttachmentUrl() 运行时补 origin，避免把变动端口写死到持久化数据里。
 */
interface FileRow {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  path: string;
  createdAt: string;
  noteId: string;
  noteTitle: string | null;
  notebookId: string | null;
  notebookName: string | null;
  notebookIcon: string | null;
  isTrashed: number | null;
  hash: string | null;
}

interface FileOut {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  createdAt: string;
  category: "image" | "file";
  url: string;
  /**
   * v12：图片缩略图 URL（可选）。
   * - 仅当 category === "image" 且 MIME 在 raster 白名单内（png/jpeg/webp/bmp/gif）时下发；
   * - 指向 `/api/attachments/<id>?w=240`，后端自动按需生成 webp 并落盘缓存；
   * - 前端 GridCard 列表用此 URL，避免拉原图（手机截图常 3-5MB × 60 张 = 几百 MB）；
   * - 详情大图、Markdown 复制时仍用 `url`（原图）。
   * - svg / ico 等不下发 thumbnailUrl，前端回退到原图（通常本身就小）。
   */
  thumbnailUrl?: string;
  /** SHA-256 hex；v11 之前的老附件可能为 null（懒迁移）。 */
  hash: string | null;
  /** 首次归属的笔记（attachments.noteId）。被删除或不存在时为 null。 */
  primaryNote: {
    id: string;
    title: string;
    notebookId: string | null;
    notebookName: string | null;
    notebookIcon: string | null;
    isTrashed: number;
  } | null;
}

/** 生成 thumbnailUrl 时使用的默认宽度。
 *  与前端 FileManager 卡片视觉宽度（auto-fill minmax 140px）+ 2x 高分屏匹配。 */
const DEFAULT_THUMBNAIL_WIDTH = 240;

/** raster 缩略图候选 MIME（与 services/thumbnails.ts 的 isThumbnailable 对齐）。
 *  这里独立维护一份是为了避免 toFileOut 走到 sharp 加载分支——
 *  toFileOut 是高频纯数据转换函数，不引入 native 模块。 */
const THUMBNAILABLE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/bmp",
  "image/gif",
]);

function toFileOut(row: FileRow): FileOut {
  const mimeLower = (row.mimeType || "").toLowerCase();
  const isImg = isImage(row.mimeType);
  const out: FileOut = {
    id: row.id,
    filename: row.filename,
    mimeType: row.mimeType,
    size: row.size,
    createdAt: row.createdAt,
    category: isImg ? "image" : "file",
    url: `/api/attachments/${row.id}`,
    hash: row.hash ?? null,
    primaryNote: row.noteId
      ? {
          id: row.noteId,
          title: row.noteTitle ?? "",
          notebookId: row.notebookId,
          notebookName: row.notebookName,
          notebookIcon: row.notebookIcon,
          isTrashed: row.isTrashed ?? 0,
        }
      : null,
  };
  if (isImg && THUMBNAILABLE_MIMES.has(mimeLower)) {
    out.thumbnailUrl = `/api/attachments/${row.id}?w=${DEFAULT_THUMBNAIL_WIDTH}`;
  }
  return out;
}

/**
 * 把前端传来的 sort 参数归一化为 SQL ORDER BY 片段。
 * 只接受白名单字段，避免 SQL 注入；未知值落回默认。
 */
function resolveOrderBy(sort: string | undefined): string {
  switch ((sort || "").toLowerCase()) {
    case "name_asc":
      return "a.filename COLLATE NOCASE ASC";
    case "name_desc":
      return "a.filename COLLATE NOCASE DESC";
    case "size_asc":
      return "a.size ASC";
    case "size_desc":
      return "a.size DESC";
    case "created_asc":
      return "a.createdAt ASC";
    case "created_desc":
    default:
      return "a.createdAt DESC";
  }
}

/**
 * 解析 list/stats 的 scope：personal / workspace。
 *   - 没传 workspaceId ⇒ 个人空间：仅当前用户自己上传的附件
 *     （attachments.userId = ? AND attachments.workspaceId IS NULL）
 *   - 传了 workspaceId ⇒ 工作区：必须是成员；按 attachments.workspaceId 过滤，
 *     所有成员可见全部附件（与 diary/tasks 的集合接口语义一致）
 */
function resolveFilesScope(
  workspaceIdRaw: string,
  userId: string,
): { scope: "personal" | "workspace"; workspaceId: string | null; error?: string } {
  const workspaceId = workspaceIdRaw?.trim() || "";
  if (!workspaceId) return { scope: "personal", workspaceId: null };
  const role = getUserWorkspaceRole(workspaceId, userId);
  if (!role) return { scope: "workspace", workspaceId, error: "无权访问该工作区" };
  return { scope: "workspace", workspaceId };
}

/**
 * 计算"无引用"（unreferenced / 孤儿）附件 id 集合。
 *
 * 定义：attachments 行存在、noteId 对应的 note 也存在，但 `/api/attachments/<id>`
 * 这个 URL 在 scope 内**所有 notes.content** 里都扫不到。
 *
 * 与 `/api/data-file/cleanup-orphans` 的"内容孤儿"定义保持一致（包含 24h 宽限期），
 * 这样用户在"文件管理 → 孤儿"tab 里看到的集合 ≈ "清理孤儿"按钮会回收的那批。
 *
 * 性能：一次性把 scope 内的 notes.content 拼成单个 haystack 字符串，再对每个
 * 附件 id 做 `indexOf`。attachments id 是 uuid 不会误匹配。O(M + N*L) 但 L 是
 * 常数级（uuid 长度），大库仍可接受；比每个 id 单独跑一次 LIKE '%..%' 快数百倍。
 */
function buildUnreferencedSet(
  db: ReturnType<typeof getDb>,
  scope: { scope: "personal" | "workspace"; workspaceId: string | null },
  userId: string,
): Set<string> {
  // 宽限期：createdAt 距今不足 24h 的附件不算孤儿（刚上传还没 save content 也会先进 holder note）
  const GRACE_MS = 24 * 3600 * 1000;
  const cutoffMs = Date.now() - GRACE_MS;

  // 1) 拉 scope 内的 haystack（仅 content 非空的 note，减少 join 字符串开销）
  const contentRows = (scope.scope === "workspace"
    ? db
        .prepare(
          `SELECT content FROM notes
            WHERE workspaceId = ? AND content IS NOT NULL AND content <> ''`,
        )
        .all(scope.workspaceId!)
    : db
        .prepare(
          `SELECT content FROM notes
            WHERE userId = ? AND workspaceId IS NULL
              AND content IS NOT NULL AND content <> ''`,
        )
        .all(userId)) as { content: string }[];
  const haystack = contentRows.map((r) => r.content).join("\n");

  // 2) 拉 scope 内的候选附件（只要 noteId 对应 note 还在）
  const candidates = (scope.scope === "workspace"
    ? db
        .prepare(
          `SELECT a.id, a.createdAt FROM attachments a
            INNER JOIN notes n ON n.id = a.noteId
            WHERE a.workspaceId = ?`,
        )
        .all(scope.workspaceId!)
    : db
        .prepare(
          `SELECT a.id, a.createdAt FROM attachments a
            INNER JOIN notes n ON n.id = a.noteId
            WHERE a.userId = ? AND a.workspaceId IS NULL`,
        )
        .all(userId)) as { id: string; createdAt: string }[];

  // 3) 扫描
  const orphanIds = new Set<string>();
  for (const r of candidates) {
    const created = new Date(
      r.createdAt && r.createdAt.includes("T")
        ? r.createdAt
        : (r.createdAt || "").replace(" ", "T") + "Z",
    ).getTime();
    if (Number.isFinite(created) && created > cutoffMs) continue;
    if (haystack.indexOf(`/api/attachments/${r.id}`) >= 0) continue;
    orphanIds.add(r.id);
  }
  return orphanIds;
}

// ---------------------------------------------------------------------------
// "我的上传" 识别口径（v12 起）
// ---------------------------------------------------------------------------
// 文件管理上传入口（POST /api/files/upload）会在 INSERT attachments 时写
// `uploadSource = 'file_manager'`。"我的上传"筛选 / 统计直接按这个字段查。
//
// 与 holder note（"未归档文件"）关系：holder 只是 attachments.noteId 外键
// 的承载笔记（保证外键 NOT NULL 约束），不再用作"我的上传"的判定依据。
// 这样：
//   - 编辑器粘贴 / Tiptap 内联抽取 / API 直接调用 attachments 上传等任何
//     非"文件管理直传"路径都不会进"我的上传"——uploadSource 留 NULL；
//   - v12 之前堆积在 holder 下的历史脏数据（含浏览器粘贴的 favicon、
//     测试上传等）uploadSource=NULL，自动从"我的上传"中清出。
//
// 历史口径（v11 之前）：靠 `attachments.noteId == holderNoteId` 判定，
// 已废弃；相关 lookupHolderNoteId 函数随之删除。需要回看请查 v11 之前版本。



// ---------------------------------------------------------------------------
// GET /api/files
// 列表 + 搜索 + 筛选 + 分页
//
// Query 参数：
//   category   "all" | "image" | "file"                    —— 大类筛选
//   filter     "unreferenced" | "myUploads"                —— 视图筛选
//   myUploadsRef "referenced" | "unreferenced"             —— 仅 filter=myUploads 时生效，
//                                                            子筛选"已被任意笔记引用 / 还没被引用"
//   mime       精确 MIME（如 image/png）                    —— 细分筛选
//   notebookId 所属笔记本 id                                —— 按笔记本筛
//   q          文件名关键字（ILIKE）                         —— 搜索
//   sort       name_asc | name_desc | size_asc | size_desc | created_asc | created_desc
//   page       1 起，默认 1
//   pageSize   默认 50，最大 200
//
// filter=unreferenced 语义：
//   返回 scope 内所有"没有任何 notes.content 引用"的附件（含 24h 宽限期）。
//   与 category 正交——可以同时 filter=unreferenced + category=image 得到"孤儿图片"。
//   实现：一次性构建 scope 内 haystack，计算 orphan id 集合，再用 `a.id IN (...)`
//   注入 WHERE。大库场景请配合 page/pageSize 分页，避免 IN 列表过长。
//
// 响应：
//   { items: FileOut[], total: number, page, pageSize }
// ---------------------------------------------------------------------------
app.get("/", requireWorkspaceFeature("files"), (c) => {
  const userId = c.req.header("X-User-Id") || "";
  if (!userId) return c.json({ error: "未授权" }, 401);
  const db = getDb();

  const scope = resolveFilesScope(c.req.query("workspaceId") || "", userId);
  if (scope.error) return c.json({ error: scope.error, code: "FORBIDDEN" }, 403);

  const category = (c.req.query("category") || "all").toLowerCase();
  const filter = (c.req.query("filter") || "").toLowerCase();
  const mime = c.req.query("mime") || "";
  const notebookId = c.req.query("notebookId") || "";
  // ?noteId=xxx —— 仅返回"被该笔记引用过"的附件。
  // 实现：EXISTS attachment_references 倒排表（v11 起维护），覆盖以下三种归属：
  //   1) 该笔记自己上传的（attachments.noteId === noteId）；
  //   2) 别的笔记上传、被本笔记 paste/import 引用的；
  //   3) 文件管理直传后又被本笔记引用的。
  // 与 filter / category / mime / q 全部正交，可叠加（例如"本笔记里的图片"）。
  const noteIdFilter = c.req.query("noteId") || "";
  const q = (c.req.query("q") || "").trim();
  const sort = c.req.query("sort") || "created_desc";
  const page = Math.max(1, Number(c.req.query("page") || 1));
  const pageSize = Math.min(
    200,
    Math.max(1, Number(c.req.query("pageSize") || 50)),
  );

  // scope 决定可见范围：
  //   personal  → 自己的附件 AND workspaceId IS NULL
  //   workspace → 该工作区的全部附件（不论上传者），成员资格已在上方 scope 校验
  const whereParts: string[] = [];
  const params: (string | number)[] = [];
  if (scope.scope === "workspace") {
    whereParts.push("a.workspaceId = ?");
    params.push(scope.workspaceId!);
  } else {
    whereParts.push("a.userId = ?");
    whereParts.push("a.workspaceId IS NULL");
    params.push(userId);
  }

  if (category === "image") {
    whereParts.push("a.mimeType LIKE 'image/%'");
  } else if (category === "file") {
    // 与 "image" 互斥；NULL mimeType 理论上不出现，仍兜底归为非图片
    whereParts.push("(a.mimeType IS NULL OR a.mimeType NOT LIKE 'image/%')");
  }

  if (mime) {
    whereParts.push("a.mimeType = ?");
    params.push(mime.toLowerCase());
  }

  if (notebookId) {
    whereParts.push("n.notebookId = ?");
    params.push(notebookId);
  }

  if (q) {
    whereParts.push("a.filename LIKE ? COLLATE NOCASE");
    params.push(`%${q}%`);
  }

  // noteId：本笔记引用过的附件（含自己上传 + 引用别处的）
  if (noteIdFilter) {
    whereParts.push(
      "EXISTS(SELECT 1 FROM attachment_references ar WHERE ar.attachmentId = a.id AND ar.noteId = ?)",
    );
    params.push(noteIdFilter);
  }

  // filter=unreferenced：把 orphan id 集合注入 WHERE
  // 空集也要落成 `1=0` 而不是省略条件，避免返回全部附件
  if (filter === "unreferenced") {
    const orphanIds = Array.from(buildUnreferencedSet(db, scope, userId));
    if (orphanIds.length === 0) {
      whereParts.push("1 = 0");
    } else {
      const placeholders = orphanIds.map(() => "?").join(",");
      whereParts.push(`a.id IN (${placeholders})`);
      for (const id of orphanIds) params.push(id);
    }
  }

  // filter=myUploads：仅返回"用户在文件管理页主动上传"的附件——
  // v12 起改用 attachments.uploadSource = 'file_manager' 字段判定，与 holder note 解耦。
  //
  // 历史背景（v12 之前）：
  //   旧实现是 `a.noteId = holderNoteId`——即"挂在 holder note 下的"都算我的上传。
  //   但这个口径会把以下脏数据一并算上：
  //     - 用户在 FileManager 页面被全局 paste 监听器抓到的浏览器图标 / 截图；
  //     - 任何代码路径走过 POST /api/files/upload 的测试数据；
  //   实际线上数据里 89 张"我的上传"中绝大多数都不是用户预期。
  //
  // v12 之后：
  //   - POST /api/files/upload 在 INSERT 时写 uploadSource='file_manager'；
  //   - 老附件 uploadSource 留 NULL，自动从"我的上传"中排除（历史脏数据干净下线）；
  //   - 不再调 lookupHolderNoteId，holder note 仅作为 attachments.noteId 外键容器存在。
  //
  // myUploadsRef 子筛选语义不变：
  //   referenced   → attachment_references 里有至少一行；
  //   unreferenced → attachment_references 里无任何行（"上传了但还没用过"）。
  // 注意：filter 已在上方 .toLowerCase()，所以这里**必须**用小写字面量。
  // 历史血泪：之前写成 "myUploads" 永远 false，导致整个分支 dead code，
  // 列表退化为返回 scope 全集 → 用户看到「我的上传」展示了所有附件。
  if (filter === "myuploads") {
    whereParts.push("a.uploadSource = ?");
    params.push("file_manager");

    const refSub = (c.req.query("myUploadsRef") || "").toLowerCase();
    if (refSub === "referenced") {
      whereParts.push(
        "EXISTS(SELECT 1 FROM attachment_references ar WHERE ar.attachmentId = a.id)",
      );
    } else if (refSub === "unreferenced") {
      whereParts.push(
        "NOT EXISTS(SELECT 1 FROM attachment_references ar WHERE ar.attachmentId = a.id)",
      );
    }
  }

  const whereSql = whereParts.join(" AND ");
  const orderSql = resolveOrderBy(sort);

  // 调试开关：env DEBUG_FILES_QUERY=1 或 system_settings.debug_files_query='true'
  // 任一启用时，打印**实际进入 SQL** 的解析后参数 + 拼好的 WHERE 子句。专为
  // 排查 query 大小写 / 拼写陷阱（参考 v12 myUploads 字面量血泪）设计——下次
  // 再出现"前端传了 filter 但后端像没收到"的现象，开开关看一眼即可。
  // 注意只 dump 解析后的标量，不打 params 里可能出现的用户输入字符串（q），避免日志泄露。
  if (isFilesQueryDebugEnabled(db)) {
    console.log("[files.list]", {
      userId,
      scope: scope.scope,
      workspaceId: scope.workspaceId ?? null,
      raw: {
        category: c.req.query("category") ?? null,
        filter: c.req.query("filter") ?? null,
        myUploadsRef: c.req.query("myUploadsRef") ?? null,
      },
      parsed: { category, filter, mime, notebookId, sort, page, pageSize },
      whereSql,
      paramCount: params.length,
    });
  }

  // LEFT JOIN：允许 attachment 对应的 note 已被真删（极端场景，DB 外键 CASCADE
  // 下这不会发生，但保留健壮性）；notebook 也 LEFT JOIN，保持列表可渲染。
  const totalRow = db
    .prepare(
      `SELECT COUNT(*) AS c
         FROM attachments a
         LEFT JOIN notes n ON n.id = a.noteId
         LEFT JOIN notebooks nb ON nb.id = n.notebookId
        WHERE ${whereSql}`,
    )
    .get(...params) as { c: number };

  const rows = db
    .prepare(
      `SELECT a.id, a.filename, a.mimeType, a.size, a.path, a.createdAt, a.hash,
              a.noteId,
              n.title AS noteTitle, n.notebookId, n.isTrashed,
              nb.name AS notebookName, nb.icon AS notebookIcon
         FROM attachments a
         LEFT JOIN notes n ON n.id = a.noteId
         LEFT JOIN notebooks nb ON nb.id = n.notebookId
        WHERE ${whereSql}
        ORDER BY ${orderSql}
        LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, (page - 1) * pageSize) as FileRow[];

  return c.json({
    items: rows.map(toFileOut),
    total: totalRow.c,
    page,
    pageSize,
  });
});

// ---------------------------------------------------------------------------
// GET /api/files/stats
// 按分类汇总（首屏 + 分类筛选器徽标用）：
//   { total, totalBytes,
//     images: { count, bytes },
//     files:  { count, bytes },
//     unreferenced: { count, bytes },   —— 孤儿视图徽标（含 24h 宽限期）
//     storage: { mode, driver, source, bucket?, endpoint?, prefix? },
//     byMime: [{ mime, count, bytes }] }
// ---------------------------------------------------------------------------
app.get("/stats", requireWorkspaceFeature("files"), (c) => {
  const userId = c.req.header("X-User-Id") || "";
  if (!userId) return c.json({ error: "未授权" }, 401);
  const db = getDb();

  const scope = resolveFilesScope(c.req.query("workspaceId") || "", userId);
  if (scope.error) return c.json({ error: scope.error, code: "FORBIDDEN" }, 403);

  // 一次性聚合：按 mimeType 分组，再在 JS 侧拆图片 / 文件大类。
  // scope: personal → 当前用户自己的非工作区附件；workspace → 整个工作区。
  const { sql, param } =
    scope.scope === "workspace"
      ? {
          sql: `SELECT mimeType AS mime, COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes
                  FROM attachments
                 WHERE workspaceId = ?
                 GROUP BY mimeType
                 ORDER BY count DESC`,
          param: scope.workspaceId!,
        }
      : {
          sql: `SELECT mimeType AS mime, COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes
                  FROM attachments
                 WHERE userId = ? AND workspaceId IS NULL
                 GROUP BY mimeType
                 ORDER BY count DESC`,
          param: userId,
        };
  const rows = db.prepare(sql).all(param) as {
    mime: string;
    count: number;
    bytes: number;
  }[];

  let total = 0;
  let totalBytes = 0;
  let imageCount = 0;
  let imageBytes = 0;
  let fileCount = 0;
  let fileBytes = 0;
  for (const r of rows) {
    total += r.count;
    totalBytes += r.bytes;
    if (isImage(r.mime)) {
      imageCount += r.count;
      imageBytes += r.bytes;
    } else {
      fileCount += r.count;
      fileBytes += r.bytes;
    }
  }

  // 无引用（孤儿）视图徽标：与 filter=unreferenced 用同一份判定
  // 大库上这会额外扫一遍 notes.content；如果性能成为瓶颈可按需做短 TTL 缓存。
  const orphanIds = buildUnreferencedSet(db, scope, userId);
  let unreferencedCount = 0;
  let unreferencedBytes = 0;
  if (orphanIds.size > 0) {
    const ids = Array.from(orphanIds);
    const placeholders = ids.map(() => "?").join(",");
    const sumRow = db
      .prepare(
        `SELECT COUNT(*) AS c, COALESCE(SUM(size), 0) AS b
           FROM attachments WHERE id IN (${placeholders})`,
      )
      .get(...ids) as { c: number; b: number } | undefined;
    unreferencedCount = sumRow?.c ?? 0;
    unreferencedBytes = sumRow?.b ?? 0;
  }

  // "我的上传" 徽标（v12 起）：scope 内 uploadSource='file_manager' 的附件，
  // 按是否被任意笔记引用拆两档。走 attachment_references 倒排表——索引覆盖
  // attachmentId 列，不会扫全表。
  // 老附件 uploadSource=NULL 不计入；用户从未走过文件管理上传时三个值都为 0。
  let myUploadsTotal = 0;
  let myUploadsReferenced = 0;
  let myUploadsUnreferenced = 0;
  {
    const { sql: muSql, args: muArgs } =
      scope.scope === "workspace"
        ? {
            sql: `SELECT
                    COUNT(*) AS total,
                    SUM(CASE WHEN EXISTS(
                      SELECT 1 FROM attachment_references ar WHERE ar.attachmentId = a.id
                    ) THEN 1 ELSE 0 END) AS referenced
                  FROM attachments a
                  WHERE a.workspaceId = ? AND a.uploadSource = 'file_manager'`,
            args: [scope.workspaceId!] as (string | number)[],
          }
        : {
            sql: `SELECT
                    COUNT(*) AS total,
                    SUM(CASE WHEN EXISTS(
                      SELECT 1 FROM attachment_references ar WHERE ar.attachmentId = a.id
                    ) THEN 1 ELSE 0 END) AS referenced
                  FROM attachments a
                  WHERE a.userId = ? AND a.workspaceId IS NULL AND a.uploadSource = 'file_manager'`,
            args: [userId] as (string | number)[],
          };
    const sumRow = db.prepare(muSql).get(...muArgs) as
      | { total: number; referenced: number }
      | undefined;
    myUploadsTotal = sumRow?.total ?? 0;
    myUploadsReferenced = sumRow?.referenced ?? 0;
    myUploadsUnreferenced = myUploadsTotal - myUploadsReferenced;
  }

  const storageInfo = getAttachmentStorageInfo();
  const storageConfig = readObjectStorageConfigPublic();
  const storageMode =
    storageInfo.driver === "s3"
      ? "object"
      : storageConfig.enabled
        ? "fallback"
        : "local";
  const storage =
    storageMode === "local"
      ? {
          mode: storageMode,
          driver: storageInfo.driver,
          source: storageConfig.source,
        }
      : {
          mode: storageMode,
          driver: storageInfo.driver,
          source: storageConfig.source,
          bucket: storageInfo.bucket || storageConfig.bucket || undefined,
          endpoint: storageInfo.endpoint || storageConfig.endpoint || undefined,
          prefix: storageInfo.prefix || storageConfig.prefix || undefined,
        };

  return c.json({
    total,
    totalBytes,
    images: { count: imageCount, bytes: imageBytes },
    files: { count: fileCount, bytes: fileBytes },
    unreferenced: { count: unreferencedCount, bytes: unreferencedBytes },
    myUploads: {
      total: myUploadsTotal,
      referenced: myUploadsReferenced,
      unreferenced: myUploadsUnreferenced,
    },
    storage,
    byMime: rows,
  });
});

// ---------------------------------------------------------------------------
// GET /api/files/:id
// 文件详情 + 反向引用（引用该附件的所有笔记）
//
// 响应：
//   {
//     ...FileOut,
//     references: [
//       { id, title, notebookId, notebookName, notebookIcon, isTrashed,
//         updatedAt, isPrimary }
//     ]
//   }
//
// 可见性（Y4）：
//   - attachments.workspaceId IS NULL → 仅上传者本人可见；
//   - attachments.workspaceId = X     → X 的成员可见。
//   反向引用扫描按同一 scope 限定：个人附件只扫本人笔记；工作区附件扫同工作区
//   的全部笔记（不限于上传者）。扫描用 `LIKE '%/api/attachments/<id>%'`，附件 id
//   是 uuid，不会误匹配。
// ---------------------------------------------------------------------------
app.get("/:id", (c) => {
  const userId = c.req.header("X-User-Id") || "";
  if (!userId) return c.json({ error: "未授权" }, 401);
  const id = c.req.param("id");
  const db = getDb();

  const base = db
    .prepare(
      `SELECT a.id, a.filename, a.mimeType, a.size, a.path, a.createdAt, a.hash,
              a.noteId, a.userId, a.workspaceId,
              n.title AS noteTitle, n.notebookId, n.isTrashed,
              nb.name AS notebookName, nb.icon AS notebookIcon
         FROM attachments a
         LEFT JOIN notes n ON n.id = a.noteId
         LEFT JOIN notebooks nb ON nb.id = n.notebookId
        WHERE a.id = ?`,
    )
    .get(id) as (FileRow & { userId: string; workspaceId: string | null }) | undefined;

  if (!base) return c.json({ error: "文件不存在" }, 404);

  // 可见性判定：个人附件仅本人；工作区附件要求该工作区成员资格。
  if (!base.workspaceId) {
    if (base.userId !== userId) {
      return c.json({ error: "文件不存在" }, 404);
    }
  } else {
    if (!getUserWorkspaceRole(base.workspaceId, userId)) {
      return c.json({ error: "文件不存在" }, 404);
    }
  }

  // v11：反向引用从倒排索引 attachment_references 查询，告别全表 LIKE 扫描。
  // 表语义：每条 (attachmentId, noteId) 行表示"这个附件曾被这条笔记引用"，
  //   - 写时维护：notes.POST/PUT/import 三处入口在事务内调 syncReferences；
  //   - 自动收尾：noteId / attachmentId 任一被删，FK CASCADE 清理对应行；
  //   - 回收站语义：isTrashed=1 的笔记保留行，前端按 isTrashed 字段决定如何标记。
  // 因此 INNER JOIN attachment_references 即可拿到所有引用关系。
  // scope 仍按附件可见性收口，避免跨工作区/跨用户泄露 noteId。
  const refRows = db
    .prepare(
      base.workspaceId
        ? `SELECT n.id, n.title, n.notebookId, n.isTrashed, n.updatedAt,
                  nb.name AS notebookName, nb.icon AS notebookIcon
             FROM attachment_references ar
             INNER JOIN notes n ON n.id = ar.noteId
             LEFT JOIN notebooks nb ON nb.id = n.notebookId
            WHERE ar.attachmentId = ?
              AND n.workspaceId = ?
            ORDER BY n.updatedAt DESC`
        : `SELECT n.id, n.title, n.notebookId, n.isTrashed, n.updatedAt,
                  nb.name AS notebookName, nb.icon AS notebookIcon
             FROM attachment_references ar
             INNER JOIN notes n ON n.id = ar.noteId
             LEFT JOIN notebooks nb ON nb.id = n.notebookId
            WHERE ar.attachmentId = ?
              AND n.userId = ? AND n.workspaceId IS NULL
            ORDER BY n.updatedAt DESC`,
    )
    .all(id, base.workspaceId ?? userId) as {
      id: string;
      title: string;
      notebookId: string | null;
      isTrashed: number;
      updatedAt: string;
      notebookName: string | null;
      notebookIcon: string | null;
    }[];

  const references = refRows.map((r) => ({
    id: r.id,
    title: r.title,
    notebookId: r.notebookId,
    notebookName: r.notebookName,
    notebookIcon: r.notebookIcon,
    isTrashed: r.isTrashed,
    updatedAt: r.updatedAt,
    isPrimary: r.id === base.noteId,
  }));

  return c.json({
    ...toFileOut(base),
    references,
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/files/:id
// 删除文件（DB 行 + 磁盘文件）。
//
// 权限：
//   需对 attachments.noteId 所指笔记有 write 权限；attachments.ts 的 DELETE
//   保持同款逻辑，这里只是做"文件管理"视角下的同义入口。
//
// 注意：
//   - 如果还有其他笔记正在引用该附件（references 非空 & 非本 primary），
//     删除后那些笔记里的 <img> 将显示为破图。返回体会带 remainingReferences
//     让前端按需二次确认或提示。
//   - 物理文件删不掉不阻塞（权限 / 已不存在），DB 行一定删掉——保持与
//     attachments.ts 的语义一致。
// ---------------------------------------------------------------------------
app.delete("/:id", async (c) => {
  const userId = c.req.header("X-User-Id") || "";
  if (!userId) return c.json({ error: "未授权" }, 401);
  const id = c.req.param("id");
  const db = getDb();

  const row = db
    .prepare(
      "SELECT id, noteId, userId, path FROM attachments WHERE id = ?",
    )
    .get(id) as
    | { id: string; noteId: string; userId: string; path: string }
    | undefined;
  if (!row) return c.json({ error: "文件不存在" }, 404);

  // 只允许本人操作自己的附件行
  if (row.userId !== userId) {
    return c.json({ error: "无权删除他人文件", code: "FORBIDDEN" }, 403);
  }

  // 同时走笔记 ACL：若笔记在工作区内，只有 write+ 可删
  const { permission } = resolveNotePermission(row.noteId, userId);
  if (!hasPermission(permission, "write")) {
    return c.json({ error: "无权删除该文件", code: "FORBIDDEN" }, 403);
  }

  // v11 引用计数：若同一物理文件还有别的 attachments 行指向，仅删本行不动磁盘
  // （理论上 hash dedup 后不会产生这种共享，但老数据 / 并发竞态可能出现）
  const sameFileCount = db
    .prepare("SELECT COUNT(*) AS c FROM attachments WHERE path = ? AND id <> ?")
    .get(row.path, id) as { c: number };
  if (sameFileCount.c === 0) {
    try {
      await deleteAttachmentObject(row.path);
    } catch {
      /* 文件删不掉不阻塞，DB 记录一致性优先 */
    }
  }
  db.prepare("DELETE FROM attachments WHERE id = ?").run(id);

  return c.json({ success: true });
});

// ---------------------------------------------------------------------------
// PATCH /api/files/:id
// 重命名（仅改 attachments.filename 字段，不动磁盘上的 <uuid>.<ext> 文件）。
//
// 背景：
//   磁盘文件名是 `<uuid>.<ext>` 形态（不可变），用户看到的"文件名"来自
//   attachments.filename 列——上传时记录原始文件名 / 编辑器粘贴时由前端拼一个。
//   重命名只是修改显示名 + 下载时 Content-Disposition 用的名字，不需要碰盘。
//
// 请求：PATCH /api/files/:id  body: { filename: string }
//
// 校验：
//   - 必须是非空字符串，长度 ≤ 255；
//   - 拒绝路径分隔符 / 反斜杠 / 控制字符（防御性，filename 不会被当成路径）；
//   - 保留原扩展名：若新名不含点，自动接上老名的扩展名（避免下载时丢类型）；
//     若新名带的扩展名与老名不一致，**尊重用户**——可能是有意修正错误的扩展。
//
// 权限：与 DELETE /:id 同款：本人 + 笔记 write。
// ---------------------------------------------------------------------------
app.patch("/:id", async (c) => {
  const userId = c.req.header("X-User-Id") || "";
  if (!userId) return c.json({ error: "未授权" }, 401);
  const id = c.req.param("id");
  const db = getDb();

  let body: { filename?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid json body" }, 400);
  }
  const rawName = typeof body.filename === "string" ? body.filename.trim() : "";
  if (!rawName) {
    return c.json({ error: "filename 不能为空" }, 400);
  }
  if (rawName.length > 255) {
    return c.json({ error: "filename 过长（≤ 255）" }, 400);
  }
  // 拒绝路径分隔符 / 控制字符（filename 仅用于显示与 Content-Disposition，
  // 永远不会被拼成磁盘路径，但严格点更安全）
  // eslint-disable-next-line no-control-regex
  if (/[\\/\x00-\x1f]/.test(rawName)) {
    return c.json({ error: "filename 包含非法字符" }, 400);
  }

  const row = db
    .prepare("SELECT id, noteId, userId, filename FROM attachments WHERE id = ?")
    .get(id) as
    | { id: string; noteId: string; userId: string; filename: string }
    | undefined;
  if (!row) return c.json({ error: "文件不存在" }, 404);

  // 权限：本人 + 笔记 write
  if (row.userId !== userId) {
    return c.json({ error: "无权重命名他人文件", code: "FORBIDDEN" }, 403);
  }
  const { permission } = resolveNotePermission(row.noteId, userId);
  if (!hasPermission(permission, "write")) {
    return c.json({ error: "无权重命名该文件", code: "FORBIDDEN" }, 403);
  }

  // 自动补扩展名：新名不含点，且老名有点，则补上老的扩展。
  let finalName = rawName;
  if (!finalName.includes(".")) {
    const oldDot = row.filename.lastIndexOf(".");
    if (oldDot > 0 && oldDot < row.filename.length - 1) {
      finalName = `${finalName}.${row.filename.slice(oldDot + 1)}`;
    }
  }

  if (finalName === row.filename) {
    return c.json({ success: true, filename: finalName, unchanged: true });
  }

  db.prepare("UPDATE attachments SET filename = ? WHERE id = ?").run(finalName, id);
  return c.json({ success: true, filename: finalName });
});


// 批量删除文件（DB 行 + 磁盘文件）。
//
// 请求体：{ ids: string[] }   —— 不超过 200 个 / 次（避免单事务锁太久）
//
// 响应：
//   {
//     success: true,
//     deleted: number,                          —— 实际删除条数
//     failed:  Array<{ id: string; reason: string }>   —— 跳过的明细
//   }
//
// 设计要点：
//   - 整个删除过程放在单事务里（先把可删的 id 收集出来，再一次性 DELETE），
//     即便后面磁盘 unlink 报错也不影响 DB 一致性。
//   - 与单删 DELETE /:id 完全同款的两层鉴权（attachments.userId == 当前用户
//     + resolveNotePermission(noteId).write）；任何一项不通过则该 id 进入
//     failed[]，不阻塞其它 id 继续删。
//   - 物理文件 unlink 失败也只记一条 reason，不回滚——与单删保持一致：DB
//     一致性优先。
// ---------------------------------------------------------------------------
app.post("/batch-delete", async (c) => {
  const userId = c.req.header("X-User-Id") || "";
  if (!userId) return c.json({ error: "未授权" }, 401);

  let body: { ids?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid json body" }, 400);
  }
  const rawIds = Array.isArray(body.ids) ? body.ids : [];
  // 去重 + 过滤掉非字符串项
  const ids = Array.from(
    new Set(
      rawIds.filter((x): x is string => typeof x === "string" && x.length > 0),
    ),
  );
  if (ids.length === 0) {
    return c.json({ error: "ids 不能为空" }, 400);
  }
  if (ids.length > 200) {
    return c.json({ error: "单次最多删除 200 个文件" }, 400);
  }

  const db = getDb();
  const failed: Array<{ id: string; reason: string }> = [];

  // 第一步：把全部 id 拉出来，做权限筛选，得到"可删除集合"+ 物理路径列表
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT id, noteId, userId, path FROM attachments WHERE id IN (${placeholders})`,
    )
    .all(...ids) as Array<{
      id: string;
      noteId: string;
      userId: string;
      path: string;
    }>;

  const foundIds = new Set(rows.map((r) => r.id));
  for (const id of ids) {
    if (!foundIds.has(id)) {
      failed.push({ id, reason: "文件不存在" });
    }
  }

  const deletable: typeof rows = [];
  for (const row of rows) {
    if (row.userId !== userId) {
      failed.push({ id: row.id, reason: "无权删除他人文件" });
      continue;
    }
    const { permission } = resolveNotePermission(row.noteId, userId);
    if (!hasPermission(permission, "write")) {
      failed.push({ id: row.id, reason: "无权删除该文件" });
      continue;
    }
    deletable.push(row);
  }

  // 第二步：单事务批量删 DB 行
  let deletedCount = 0;
  if (deletable.length > 0) {
    const delIds = deletable.map((r) => r.id);
    const delPlaceholders = delIds.map(() => "?").join(",");
    const tx = db.transaction((arr: string[]) => {
      const info = db
        .prepare(`DELETE FROM attachments WHERE id IN (${delPlaceholders})`)
        .run(...arr);
      return Number(info.changes || 0);
    });
    deletedCount = tx(delIds);

    // 第三步：删磁盘文件（DB 已经一致；磁盘层错误降级为 failed 项，
    // 但不会让用户误以为 DB 没删——文件已经从列表里消失了）
    //
    // v11 引用计数：本批 DELETE 之后再查一次同 path 是否还有其它 attachments
    // 行存在（来自本批之外的笔记/用户）。只有 0 引用才真正 unlink；否则
    // 只删 DB 行不动磁盘，避免误清掉别处仍在用的文件。
    const stillReferencedStmt = db.prepare(
      "SELECT 1 FROM attachments WHERE path = ? LIMIT 1",
    );
    for (const row of deletable) {
      const stillReferenced = stillReferencedStmt.get(row.path);
      if (stillReferenced) continue;
      try {
        await deleteAttachmentObject(row.path);
      } catch (err) {
        failed.push({
          id: row.id,
          reason: `磁盘文件清理失败: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }

  return c.json({
    success: true,
    deleted: deletedCount,
    failed,
  });
});

// ---------------------------------------------------------------------------
// POST /api/files/upload
// "无绑定笔记"上传入口：从文件管理界面直接上传文件。
//
// 背景：
//   attachments.ts 的上传强制要求 noteId（"上传附件即修改笔记"的语义）。
//   文件管理是**跨笔记**视角，用户希望"先把文件放进我的文件柜，稍后再决定
//   插入哪篇笔记"。为此我们创建一个用户私有的"未归档"笔记本 + 空笔记作为
//   占位容器：
//     - Notebook："📁 文件管理（自动）"；由 SQL 按用户 + 名字查找，不存在则建。
//     - Note：    "未归档文件"（isArchived=1）；同上。
//   这样 attachments.noteId 外键依然成立，且不污染用户真实笔记列表
//   （isArchived=1 的笔记默认不出现在"所有笔记"）。
//
// 这个占位 note 在用户真正把文件插入到某篇笔记时仍然保留（附件 id 不变、
// URL 不变、已有引用照常工作）；只是"首次归属"记在这条 holder note 下。
// ---------------------------------------------------------------------------

/** 1GB —— 与 attachments.ts 上传上限对齐。 */
const MAX_UPLOAD_SIZE = 1024 * 1024 * 1024;

/** 与 attachments.ts 同款黑名单；其余任意 MIME 放行。 */
const BLOCKED_MIMES = new Set([
  "application/x-msdownload",
  "application/x-ms-installer",
  "application/x-ms-shortcut",
  "application/x-bat",
  "application/x-sh",
  "application/hta",
]);

/** 从文件名兜底推断扩展名（与 attachments.ts 的 pickExt 同款，避免跨模块依赖）。 */
function pickExt(filename: string | undefined, mime: string): string {
  const name = filename || "";
  const idx = name.lastIndexOf(".");
  if (idx >= 0 && idx < name.length - 1) {
    const ext = name.slice(idx + 1).toLowerCase().replace(/[^a-z0-9]/g, "");
    if (ext && ext.length <= 8) return ext;
  }
  return MIME_TO_EXT[mime.toLowerCase()] || "bin";
}

/**
 * 获取（或懒创建）某 scope 的"未归档文件" holder note。
 *
 * scope：
 *   - workspaceId = null  → 个人空间版本（老语义）
 *   - workspaceId = X     → 工作区 X 版本；notebook/note 同样挂在当前用户名下
 *     （ownership = 上传者），但 workspaceId 填 X；这样工作区关闭/迁移时数据
 *     归属与其它工作区资源一致。
 *
 * 约定：同一 scope 下只会有一个 holder（userId + workspaceId + name 三元组唯一）。
 * 所有写入都在单 transaction 里，保证并发安全。
 */
function ensureHolderNote(
  userId: string,
  workspaceId: string | null,
): { notebookId: string; noteId: string } {
  const db = getDb();

  const HOLDER_NOTEBOOK_NAME = "文件管理（自动）";
  const HOLDER_NOTE_TITLE = "未归档文件";

  let notebookId = "";
  let noteId = "";

  const tx = db.transaction(() => {
    // 个人空间 workspaceId IS NULL；工作区按 workspaceId 精确匹配
    const nbRow = (workspaceId
      ? db
          .prepare(
            "SELECT id FROM notebooks WHERE userId = ? AND name = ? AND workspaceId = ? LIMIT 1",
          )
          .get(userId, HOLDER_NOTEBOOK_NAME, workspaceId)
      : db
          .prepare(
            "SELECT id FROM notebooks WHERE userId = ? AND name = ? AND workspaceId IS NULL LIMIT 1",
          )
          .get(userId, HOLDER_NOTEBOOK_NAME)) as { id: string } | undefined;
    if (nbRow) {
      notebookId = nbRow.id;
    } else {
      notebookId = uuid();
      db.prepare(
        `INSERT INTO notebooks (id, userId, parentId, name, description, icon, sortOrder, isExpanded, workspaceId)
         VALUES (?, ?, NULL, ?, '', '📁', 9999, 0, ?)`,
      ).run(notebookId, userId, HOLDER_NOTEBOOK_NAME, workspaceId);
    }

    const noteRow = db
      .prepare(
        `SELECT id FROM notes
          WHERE userId = ? AND notebookId = ? AND title = ? AND isArchived = 1
          LIMIT 1`,
      )
      .get(userId, notebookId, HOLDER_NOTE_TITLE) as { id: string } | undefined;
    if (noteRow) {
      noteId = noteRow.id;
    } else {
      noteId = uuid();
      db.prepare(
        `INSERT INTO notes (id, userId, notebookId, title, content, contentText, isArchived, workspaceId)
         VALUES (?, ?, ?, ?, '{}', '', 1, ?)`,
      ).run(noteId, userId, notebookId, HOLDER_NOTE_TITLE, workspaceId);
    }
  });
  tx();

  return { notebookId, noteId };
}

app.post("/upload", requireWorkspaceFeature("files"), async (c) => {
  const userId = c.req.header("X-User-Id") || "";
  if (!userId) return c.json({ error: "未授权" }, 401);

  const scope = resolveFilesScope(c.req.query("workspaceId") || "", userId);
  if (scope.error) return c.json({ error: scope.error, code: "FORBIDDEN" }, 403);

  let body: Record<string, unknown>;
  try {
    body = await c.req.parseBody();
  } catch {
    return c.json({ error: "invalid multipart body" }, 400);
  }
  const file = body.file;
  if (!(file instanceof File)) {
    return c.json({ error: "file 字段缺失或非文件" }, 400);
  }
  // folderId：可选，上传到指定文件夹
  const folderId = typeof body.folderId === "string" && body.folderId ? body.folderId : null;
  if (file.size > MAX_UPLOAD_SIZE) {
    return c.json(
      { error: `文件过大（最大 ${MAX_UPLOAD_SIZE / 1024 / 1024}MB）` },
      413,
    );
  }
  const mime = (file.type || "application/octet-stream").toLowerCase();
  if (BLOCKED_MIMES.has(mime)) {
    return c.json({ error: `出于安全考虑，不支持该类型: ${mime}` }, 415);
  }

  const { noteId } = ensureHolderNote(userId, scope.workspaceId);

  ensureAttachmentsDir();
  const id = uuid();
  const ext = pickExt(file.name, mime);
  const monthPath = getUploadMonthPath();
  const storagePath = `${monthPath}/${id}.${ext}`;

  let buffer: Buffer;
  try {
    buffer = Buffer.from(await file.arrayBuffer());
  } catch (err) {
    return c.json(
      { error: `读取上传内容失败: ${err instanceof Error ? err.message : String(err)}` },
      500,
    );
  }

  // v11 hash dedup：同 user + 同 workspace 内查命中。命中 → 复用老 id 不写盘不写 DB。
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  const db = getDb();

  // 校验 folderId（如果提供）
  if (folderId) {
    const folder = db
      .prepare("SELECT id FROM attachment_folders WHERE id = ? AND userId = ?")
      .get(folderId, userId) as { id: string } | undefined;
    if (!folder) return c.json({ error: "目标文件夹不存在" }, 404);
  }

  const dedupRow = db
    .prepare(
      scope.workspaceId
        ? `SELECT id, mimeType, size, filename FROM attachments
            WHERE userId = ? AND workspaceId = ? AND hash = ? LIMIT 1`
        : `SELECT id, mimeType, size, filename FROM attachments
            WHERE userId = ? AND workspaceId IS NULL AND hash = ? LIMIT 1`,
    )
    .get(
      ...(scope.workspaceId
        ? [userId, scope.workspaceId, sha256]
        : [userId, sha256]),
    ) as { id: string; mimeType: string; size: number; filename: string } | undefined;

  if (dedupRow) {
    // v12：dedup 命中老行时把 uploadSource 升级到 'file_manager'——
    // 用户这次是从文件管理页主动上传同一份内容，理应进入"我的上传"。
    // 用 COALESCE 语义：仅当老行还没标过来源时才写，避免把已有的 'file_manager'
    // 反复 UPDATE（无害但浪费写）；老行已是 'file_manager' 则保持。
    db.prepare(
      `UPDATE attachments
          SET uploadSource = 'file_manager'
        WHERE id = ? AND (uploadSource IS NULL OR uploadSource = '')`,
    ).run(dedupRow.id);

    return c.json(
      {
        id: dedupRow.id,
        url: `/api/attachments/${dedupRow.id}`,
        mimeType: dedupRow.mimeType,
        size: dedupRow.size,
        filename: dedupRow.filename,
        category: isImage(dedupRow.mimeType) ? "image" : "file",
        createdAt: new Date().toISOString(),
        deduplicated: true,
      },
      200,
    );
  }

  try {
    await writeAttachmentObject(storagePath, buffer, mime);
  } catch (err) {
    return c.json(
      { error: `写入文件失败: ${err instanceof Error ? err.message : String(err)}` },
      500,
    );
  }

  try {
    db.prepare(
      `INSERT INTO attachments (id, noteId, userId, filename, mimeType, size, path, workspaceId, hash, uploadSource, folderId)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      noteId,
      userId,
      file.name || `${id}.${ext}`,
      mime,
      file.size,
      storagePath,
      scope.workspaceId,
      sha256,
      "file_manager",
      folderId,
    );
  } catch (err) {
    // DB 写失败时把已落盘文件清掉，避免孤儿
    try { await deleteAttachmentObject(storagePath); } catch { /* ignore */ }
    return c.json(
      { error: `写入数据库失败: ${err instanceof Error ? err.message : String(err)}` },
      500,
    );
  }

  return c.json(
    {
      id,
      url: `/api/attachments/${id}`,
      mimeType: mime,
      size: file.size,
      filename: file.name || `${id}.${ext}`,
      category: isImage(mime) ? "image" : "file",
      createdAt: new Date().toISOString(),
    },
    201,
  );
});

export default app;
