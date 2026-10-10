import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { getDb } from "../db/schema";
import { analyzeModernMedia, type MediaAnalysis } from "../lib/modern-media";
import { getAttachmentsDir, readAttachmentObject } from "./attachment-storage";

interface SourceRow {
  id: string; noteId: string; userId: string; workspaceId: string | null;
  mimeType: string; filename: string; path: string;
}
type ReadSource = () => Promise<Buffer | null>;
const pending = new Map<string, Promise<Buffer>>();
let conversionQueue: Promise<unknown> = Promise.resolve();

export function recordMediaAnalysis(id: string, bytes: Buffer, mimeType: string): MediaAnalysis {
  const analysis = analyzeModernMedia(bytes, mimeType);
  getDb().prepare(`INSERT INTO attachment_media_variants (sourceAttachmentId, kind, mimeType, metadata)
    VALUES (?, 'analysis', ?, ?) ON CONFLICT(sourceAttachmentId, kind)
    DO UPDATE SET mimeType = excluded.mimeType, metadata = excluded.metadata`)
    .run(id, analysis.mimeType, JSON.stringify(analysis));
  if (analysis.assetIdentifier) {
    const pairs = getDb().prepare(`SELECT photo.id AS photoId, video.id AS videoId, video.mimeType FROM attachments photo
      JOIN attachment_media_variants pa ON pa.sourceAttachmentId = photo.id AND pa.kind = 'analysis'
      JOIN attachments video ON video.noteId = photo.noteId AND video.userId = photo.userId AND video.workspaceId IS photo.workspaceId
      JOIN attachment_media_variants va ON va.sourceAttachmentId = video.id AND va.kind = 'analysis'
      WHERE json_extract(pa.metadata, '$.kind') = 'live-photo' AND json_extract(va.metadata, '$.kind') = 'video'
        AND json_extract(pa.metadata, '$.assetIdentifier') = ? AND json_extract(va.metadata, '$.assetIdentifier') = ?
        AND (photo.id = ? OR video.id = ?)`).all(analysis.assetIdentifier, analysis.assetIdentifier, id, id) as Array<{ photoId: string; videoId: string; mimeType: string }>;
    const insert = getDb().prepare(`INSERT OR REPLACE INTO attachment_media_variants
      (sourceAttachmentId, kind, variantAttachmentId, mimeType) VALUES (?, 'original-motion', ?, ?)`);
    for (const pair of pairs) insert.run(pair.photoId, pair.videoId, pair.mimeType);
  }
  return analysis;
}

async function loadAnalysis(row: SourceRow, read: ReadSource): Promise<MediaAnalysis> {
  const cached = getDb().prepare("SELECT metadata FROM attachment_media_variants WHERE sourceAttachmentId = ? AND kind = 'analysis'")
    .get(row.id) as { metadata: string } | undefined;
  if (cached) {
    try {
      const analysis = JSON.parse(cached.metadata) as MediaAnalysis;
      if (analysis.version === 1) return analysis;
    } catch { /* 旧缓存损坏时从原件重建。 */ }
  }
  const bytes = await read();
  if (!bytes) throw new Error("MEDIA_SOURCE_MISSING");
  const analysis = recordMediaAnalysis(row.id, bytes, row.mimeType);
  if (analysis.mimeType !== row.mimeType) {
    getDb().prepare("UPDATE attachments SET mimeType = ? WHERE id = ?").run(analysis.mimeType, row.id);
  }
  return analysis;
}

async function findLiveCompanion(row: SourceRow, identifier: string): Promise<SourceRow | undefined> {
  // 只关联同一笔记、上传者和空间的原件，照片的分享凭证不能打开其它笔记的视频。
  const candidates = getDb().prepare(`SELECT id, noteId, userId, workspaceId, mimeType, filename, path FROM attachments
    WHERE noteId = ? AND userId = ? AND workspaceId IS ? AND id != ?
    AND (mimeType LIKE 'video/%' OR lower(filename) LIKE '%.mov' OR lower(filename) LIKE '%.mp4')`)
    .all(row.noteId, row.userId, row.workspaceId, row.id) as SourceRow[];
  for (const candidate of candidates) {
    let analysis: MediaAnalysis;
    try { analysis = await loadAnalysis(candidate, () => readAttachmentObject(candidate.path)); }
    catch { continue; }
    if (analysis.kind !== "video" || analysis.assetIdentifier !== identifier) continue;
    getDb().prepare(`INSERT INTO attachment_media_variants (sourceAttachmentId, kind, variantAttachmentId, mimeType)
      VALUES (?, 'original-motion', ?, ?) ON CONFLICT(sourceAttachmentId, kind)
      DO UPDATE SET variantAttachmentId = excluded.variantAttachmentId, mimeType = excluded.mimeType`)
      .run(row.id, candidate.id, analysis.mimeType);
    return candidate;
  }
}

export async function inspectPhotoMedia(id: string, read?: ReadSource) {
  const row = getDb().prepare("SELECT id, noteId, userId, workspaceId, mimeType, filename, path FROM attachments WHERE id = ?")
    .get(id) as SourceRow | undefined;
  if (!row) throw new Error("MEDIA_SOURCE_MISSING");
  const analysis = await loadAnalysis(row, read || (() => readAttachmentObject(row.path)));
  const companion = analysis.kind === "live-photo" && analysis.assetIdentifier
    ? await findLiveCompanion(row, analysis.assetIdentifier) : undefined;
  return { row, analysis, companion };
}

export function recordHeifVariant(id: string): void {
  getDb().prepare(`INSERT OR REPLACE INTO attachment_media_variants
    (sourceAttachmentId, kind, storagePath, mimeType) VALUES (?, 'preview-webp', ?, 'image/webp')`)
    .run(id, `.thumbs/${id}_preview.webp`);
}

export function getMediaFfmpegPath(): string {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  const require = createRequire(__filename);
  return require("ffmpeg-static") || "ffmpeg";
}

function convertMotion(input: string, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(getMediaFfmpegPath(), [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-protocol_whitelist", "file,pipe",
      "-i", input, "-map", "0:v:0", "-map", "0:a:0?", "-t", "15", "-threads", "2",
      "-vf", "scale=trunc(min(1920\\,iw)/2)*2:-2,format=yuv420p", "-c:v", "libx264",
      "-preset", "veryfast", "-crf", "22", "-c:a", "aac", "-b:a", "128k",
      "-movflags", "+faststart", "-fs", "52428800", output,
    ], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let error = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("MOTION_CONVERSION_TIMEOUT")); }, 90000);
    child.stderr.on("data", (data: Buffer) => { error = (error + data.toString("utf8")).slice(-2048); });
    child.on("error", (failure) => { clearTimeout(timer); reject(failure); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`MOTION_CONVERSION_FAILED: ${error}`));
    });
  });
}

export async function getOrCreateMotionPreview(id: string, read?: ReadSource): Promise<Buffer> {
  const active = pending.get(id);
  if (active) return active;
  const task = conversionQueue.catch(() => {}).then(async () => {
    const { row, analysis, companion } = await inspectPhotoMedia(id, read);
    if (!analysis.motion && !companion) throw new Error("MOTION_NOT_AVAILABLE");
    const cacheDir = path.join(getAttachmentsDir(), ".thumbs");
    const cacheName = `${id}_motion_${companion?.id || "embedded"}.mp4`;
    const cachePath = path.join(cacheDir, cacheName);
    try { return await fs.promises.readFile(cachePath); } catch { /* 缓存丢失时懒生成。 */ }
    const source = companion ? await readAttachmentObject(companion.path) : await (read || (() => readAttachmentObject(row.path)))();
    if (!source) throw new Error("MEDIA_SOURCE_MISSING");
    const motion = companion ? source : source.subarray(analysis.motion!.offset, analysis.motion!.offset + analysis.motion!.length);
    await fs.promises.mkdir(cacheDir, { recursive: true });
    const temporary = await fs.promises.mkdtemp(path.join(cacheDir, `${id}_work_`));
    try {
      const input = path.join(temporary, "source.mov");
      const output = path.join(temporary, "motion.mp4");
      await fs.promises.writeFile(input, motion);
      await convertMotion(input, output);
      const result = await fs.promises.readFile(output);
      // 删除与转码可能并发；源记录已消失时不重新留下派生文件。
      if (!getDb().prepare("SELECT id FROM attachments WHERE id = ?").get(id)) throw new Error("MEDIA_SOURCE_MISSING");
      await fs.promises.rename(output, cachePath);
      getDb().prepare(`INSERT OR REPLACE INTO attachment_media_variants
        (sourceAttachmentId, kind, variantAttachmentId, storagePath, mimeType, metadata)
        VALUES (?, 'motion-mp4', ?, ?, 'video/mp4', ?)`)
        .run(id, companion?.id || null, `.thumbs/${cacheName}`, JSON.stringify({ version: 1, codecs: "avc1,mp4a", maxDurationSeconds: 15 }));
      return result;
    } finally {
      await fs.promises.rm(temporary, { recursive: true, force: true });
    }
  });
  conversionQueue = task;
  pending.set(id, task);
  try { return await task; } finally { pending.delete(id); }
}
