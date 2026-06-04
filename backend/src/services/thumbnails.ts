/**
 * 缩略图服务（v12）
 * ---------------------------------------------------------------------------
 * 背景：
 *   "文件管理 / 图床"网格视图一页 60+ 张图片，全部加载原图（手机截图常 3-5MB）
 *   会让浏览器一次解码上百兆，肉眼可感卡顿，且消耗 Wi-Fi 流量。
 *
 *   方案：在 /api/attachments/:id 上支持可选 `?w=<宽度>` 查询参数，按需生成
 *   webp 缩略图并落盘到 ATTACHMENTS_DIR/.thumbs/<id>_w<width>.webp。
 *   - 第一次请求生成（用 sharp，单张约 30~80ms）；
 *   - 之后命中磁盘缓存直接返回 buffer；
 *   - 原图文件被删除时，主流程 unlink 原图后顺手清理对应缩略图（best-effort）。
 *
 * 设计取舍：
 *   - 只接受**宽度**白名单（不允许任意尺寸），防止"用千万种尺寸打爆磁盘"的 DoS。
 *     当前白名单：240（卡片）/ 480（高分屏卡片）/ 960（DetailDrawer 中等预览）。
 *   - 输出格式统一 webp（兼容性 96%+，体积比 jpg 还小）。
 *   - 透明图（svg / png with alpha）也用 webp（webp 支持 alpha）。
 *   - SVG / GIF 特殊处理：
 *       * SVG：sharp 转 raster 体积反而大、容易丢字体，直接返回原图。
 *       * GIF：转静态首帧 webp（列表页用静态足够；播放动图请打开详情）。
 *   - sharp 不放在 ".thumbs/" 暴露目录里直接读，全部走 /api/attachments/:id 入口，
 *     避免目录穿越。
 *
 * 容错：
 *   - sharp 处理失败（图片损坏 / 不支持的格式 / OOM）→ 返回 null，
 *     调用方应当回退到原图。
 *   - 磁盘写失败也吞掉 → 下次请求会重试，不影响业务。
 */
import fs from "fs";
import path from "path";
// 使用动态 require，避免 sharp 安装失败时整个后端起不来——
// sharp 是 native 模块，少数平台/CI 没有预编译 binary 时会报错。
// 此处兜底：拿不到 sharp 时缩略图功能整体降级为"返回原图"。
let sharp: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  sharp = require("sharp");
} catch (err) {
  console.warn(
    "[thumbnails] sharp 未安装或加载失败，缩略图功能将降级为返回原图。",
    err,
  );
}

/** 允许的缩略图宽度白名单。任何不在此列表的 ?w= 都按"不缩略"处理。 */
const ALLOWED_WIDTHS = new Set<number>([240, 480, 960]);

/** 视为可处理图片的 MIME。注意 svg/gif 单独走分支。 */
const RASTER_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/bmp",
]);

const SKIP_MIMES = new Set([
  // SVG 转 raster 收益小（矢量本来就小），且 sharp 可能丢字体
  "image/svg+xml",
  // ico 用 raster 缩没意义，且 sharp 默认不支持 ico
  "image/x-icon",
  "image/vnd.microsoft.icon",
]);

/** 缩略图缓存子目录名（在 ATTACHMENTS_DIR 下） */
const THUMBS_SUBDIR = ".thumbs";

/**
 * 解析 url query 中的 width 参数。
 * - 不传 / 空 / 不在白名单 → 返回 null（调用方应返回原图）
 * - 合法 → 返回 number
 */
export function parseThumbnailWidth(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (!ALLOWED_WIDTHS.has(n)) return null;
  return n;
}

/** 缩略图缓存文件的绝对路径（不保证存在）。 */
function getThumbCachePath(attachmentsDir: string, id: string, width: number): string {
  return path.join(attachmentsDir, THUMBS_SUBDIR, `${id}_w${width}.webp`);
}

/** 确保 .thumbs 目录存在。 */
function ensureThumbsDir(attachmentsDir: string): string {
  const dir = path.join(attachmentsDir, THUMBS_SUBDIR);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * 判定一个 MIME 是否能走缩略图分支。
 * - true：raster 图片，可生成 webp 缩略图
 * - false：调用方应当直接返回原图（svg / 非图片 / 已禁用）
 */
export function isThumbnailable(mime: string | null | undefined): boolean {
  if (!sharp) return false;
  const m = (mime || "").toLowerCase();
  if (SKIP_MIMES.has(m)) return false;
  if (m === "image/gif") return true; // gif 也允许，但只取首帧
  return RASTER_MIMES.has(m);
}

interface ThumbnailResult {
  /** 缩略图字节内容 */
  buffer: Buffer;
  /** 输出 MIME（始终是 "image/webp"） */
  mimeType: string;
  /** 是否本次新生成（false = 命中磁盘缓存）；仅日志用 */
  fromCache: boolean;
}

/**
 * 获取（或生成）指定附件的缩略图。
 *
 * @param attachmentsDir ATTACHMENTS_DIR 绝对路径
 * @param attachmentId   附件 id
 * @param sourcePath     原图绝对路径（已由调用方 stat 过存在）
 * @param sourceMime     原图 MIME
 * @param width          目标宽度（已通过 parseThumbnailWidth 校验在白名单内）
 *
 * @returns 成功返回 { buffer, mimeType: "image/webp", fromCache }；
 *          sharp 不可用 / 处理失败 / MIME 不支持 → 返回 null（调用方回退原图）。
 */
async function getOrCreateThumbnailFromInputAsync(
  attachmentsDir: string,
  attachmentId: string,
  input: string | Buffer,
  sourceMime: string,
  width: number,
): Promise<ThumbnailResult | null> {
  if (!sharp) return null;
  if (!isThumbnailable(sourceMime)) return null;

  const cachePath = getThumbCachePath(attachmentsDir, attachmentId, width);

  // 命中缓存
  try {
    if (fs.existsSync(cachePath)) {
      const buffer = fs.readFileSync(cachePath);
      return { buffer, mimeType: "image/webp", fromCache: true };
    }
  } catch {
    /* 读缓存失败：当作 miss 重新生成 */
  }

  // 未命中：生成
  try {
    ensureThumbsDir(attachmentsDir);
    const buffer: Buffer = await sharp(input, {
      animated: false, // GIF 只取首帧（列表页用静态首帧足矣）
      limitInputPixels: 268_402_689, // sharp 默认值，显式声明：防 50000×50000 撑爆内存
    })
      .rotate() // 自动按 EXIF Orientation 摆正
      .resize({
        width,
        // 按宽度缩放，高度自适应；不裁剪、不放大
        withoutEnlargement: true,
        fit: "inside",
      })
      .webp({
        quality: 78, // 视觉无损边界，体积友好
        effort: 4,   // 0-6，4 是速度/体积的甜点
      })
      .toBuffer();

    // 落盘缓存（best-effort：写失败不影响本次响应）
    try {
      fs.writeFileSync(cachePath, buffer);
    } catch (err) {
      console.warn(`[thumbnails] 写缓存失败 ${cachePath}:`, err);
    }
    return { buffer, mimeType: "image/webp", fromCache: false };
  } catch (err) {
    console.warn(
      `[thumbnails] 生成缩略图失败 attachment=${attachmentId} w=${width}:`,
      err,
    );
    return null;
  }
}

export async function getOrCreateThumbnailAsync(
  attachmentsDir: string,
  attachmentId: string,
  sourcePath: string,
  sourceMime: string,
  width: number,
): Promise<ThumbnailResult | null> {
  return getOrCreateThumbnailFromInputAsync(attachmentsDir, attachmentId, sourcePath, sourceMime, width);
}

export async function getOrCreateThumbnailFromBufferAsync(
  attachmentsDir: string,
  attachmentId: string,
  sourceBuffer: Buffer,
  sourceMime: string,
  width: number,
): Promise<ThumbnailResult | null> {
  return getOrCreateThumbnailFromInputAsync(attachmentsDir, attachmentId, sourceBuffer, sourceMime, width);
}

/**
 * 删除某个附件对应的所有缩略图缓存（best-effort）。
 * 调用时机：附件原图被 unlink 时（在 attachments DELETE / 孤儿 GC 中）。
 * 不影响主流程：任何失败都吞掉。
 */
export function deleteThumbnailsFor(attachmentsDir: string, attachmentId: string): void {
  const dir = path.join(attachmentsDir, THUMBS_SUBDIR);
  if (!fs.existsSync(dir)) return;
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return;
  }
  const prefix = `${attachmentId}_w`;
  for (const f of files) {
    if (!f.startsWith(prefix)) continue;
    try {
      fs.unlinkSync(path.join(dir, f));
    } catch {
      /* ignore */
    }
  }
}

/** 暴露给路由层：当前是否启用缩略图能力（sharp 是否可用）。 */
export function isThumbnailEnabled(): boolean {
  return !!sharp;
}
