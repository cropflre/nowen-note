import crypto from "node:crypto";
import { getDb } from "../db/schema";
import { syncNoteBlocks } from "../lib/noteBlocks";
import { scanRemoteImages } from "../lib/remote-image-localization";
import {
    downloadRemoteImage,
    RemoteImageError,
    type DownloadedRemoteImage,
} from "./remote-image-import";
import {
    applyLocalizedContent,
    currentWriteState,
    rollbackLocalizedAttachments,
    saveLocalizedAttachment,
    type CreatedAttachment,
} from "./remote-image-localization-mutation";
import { readNote, type NoteRow } from "./remote-image-localization-core";
import { yDestroyDoc } from "./yjs";

interface ImportedNoteRef {
    id: string;
    title: string;
    version: number;
}

interface ImportedMarkdownNoteScan {
    note: ImportedNoteRef;
    remoteUrls: string[];
}

export interface SiyuanImportedRemoteImageResult {
    warnings: string[];
    noteVersions: Record<string, number>;
    uniqueRemoteUrls: number;
    localizedUrls: number;
    localizedReferences: number;
    deduplicatedAttachments: number;
    failedUrls: number;
    skippedUrls: number;
}

const DEFAULT_MAX_REMOTE_IMAGES = 5_000;
const DEFAULT_MAX_REMOTE_TOTAL_BYTES = 500 * 1024 * 1024;
const DEFAULT_DOWNLOAD_CONCURRENCY = 4;
const MAX_DETAIL_WARNINGS = 20;

function readPositiveEnv(name: string, fallback: number, max: number): number {
    const value = Number.parseInt(process.env[name] || "", 10);
    return Number.isFinite(value) && value > 0 ? Math.min(value, max) : fallback;
}

function getLimits() {
    return {
        maxImages: readPositiveEnv(
            "SIYUAN_IMPORT_MAX_REMOTE_IMAGES",
            DEFAULT_MAX_REMOTE_IMAGES,
            50_000,
        ),
        maxTotalBytes: readPositiveEnv(
            "SIYUAN_IMPORT_MAX_REMOTE_IMAGE_MB",
            DEFAULT_MAX_REMOTE_TOTAL_BYTES / 1024 / 1024,
            10_000,
        ) * 1024 * 1024,
        concurrency: readPositiveEnv(
            "SIYUAN_IMPORT_REMOTE_IMAGE_CONCURRENCY",
            DEFAULT_DOWNLOAD_CONCURRENCY,
            8,
        ),
    };
}

function safeUrlLabel(raw: string): string {
    try {
        const parsed = new URL(raw);
        return `${parsed.origin}${parsed.pathname}`.slice(0, 240);
    } catch {
        return raw.slice(0, 240);
    }
}

function errorMessage(error: unknown): string {
    if (error instanceof RemoteImageError) return `${error.code}: ${error.message}`;
    return error instanceof Error ? error.message : String(error);
}

async function runWithConcurrency<T>(
    values: T[],
    concurrency: number,
    worker: (value: T) => Promise<void>,
): Promise<void> {
    let nextIndex = 0;
    const workers = Array.from(
        { length: Math.min(Math.max(1, concurrency), values.length) },
        async () => {
            while (nextIndex < values.length) {
                const index = nextIndex;
                nextIndex += 1;
                await worker(values[index]);
            }
        },
    );
    await Promise.all(workers);
}

/**
 * Materialize Nowen's Markdown block identifiers before image localization.
 *
 * `syncNoteBlocks()` may add hidden block IDs and write the normalized Markdown
 * back to `notes.content`. The generic localization mutation later uses exact
 * content equality as an optimistic-lock guard, so it must start from this
 * normalized source rather than the pre-index import text.
 */
function normalizeImportedMarkdownNote(noteId: string): NoteRow | undefined {
    const current = readNote(noteId);
    if (!current || current.contentFormat !== "markdown") return current;
    syncNoteBlocks(getDb(), current.id, current.content || "", current.contentFormat);
    return readNote(noteId);
}

/**
 * Localize HTTP(S) image references created by a SiYuan Markdown import.
 *
 * ZIP-local assets are already handled by the transaction-oriented importer. This
 * post-import pass covers image-bed URLs that intentionally remain remote during
 * `.sy` conversion. Failures are isolated per URL: the note keeps its original URL
 * and the successful part of the import is still returned to the user.
 */
export async function localizeSiyuanImportedMarkdownImages(args: {
    userId: string;
    notes: ImportedNoteRef[];
}): Promise<SiyuanImportedRemoteImageResult> {
    const limits = getLimits();
    const scans: ImportedMarkdownNoteScan[] = [];
    const orderedUniqueUrls: string[] = [];
    const seenUrls = new Set<string>();
    const warnings: string[] = [];

    for (const note of args.notes) {
        const current = normalizeImportedMarkdownNote(note.id);
        if (!current || current.contentFormat !== "markdown") continue;
        const scan = scanRemoteImages(current.content || "", current.contentFormat);
        if (scan.parseError) {
            warnings.push(`思源 Markdown：${note.title} 的网络图片扫描失败，已保留原地址。`);
            continue;
        }
        if (scan.remoteUrls.length === 0) continue;
        scans.push({ note, remoteUrls: scan.remoteUrls });
        for (const url of scan.remoteUrls) {
            if (seenUrls.has(url)) continue;
            seenUrls.add(url);
            orderedUniqueUrls.push(url);
        }
    }

    const allowedUrls = new Set(orderedUniqueUrls.slice(0, limits.maxImages));
    const skippedByLimit = Math.max(0, orderedUniqueUrls.length - allowedUrls.size);
    if (skippedByLimit > 0) {
        warnings.push(
            `思源 Markdown：网络图片唯一地址超过 ${limits.maxImages} 个，本次跳过 ${skippedByLimit} 个并保留原地址。`,
        );
    }

    const remainingUses = new Map<string, number>();
    for (const scan of scans) {
        for (const url of scan.remoteUrls) {
            if (!allowedUrls.has(url)) continue;
            remainingUses.set(url, (remainingUses.get(url) || 0) + 1);
        }
    }

    const downloadCache = new Map<string, Promise<DownloadedRemoteImage>>();
    let downloadedBytes = 0;
    let localizedUrls = 0;
    let localizedReferences = 0;
    let deduplicatedAttachments = 0;
    let failedUrls = 0;
    let skippedUrls = skippedByLimit;
    let detailWarningCount = 0;
    const noteVersions: Record<string, number> = {};
    const importJobId = `siyuan-${crypto.randomUUID()}`;

    const getDownloaded = (url: string): Promise<DownloadedRemoteImage> => {
        const cached = downloadCache.get(url);
        if (cached) return cached;
        const promise = downloadRemoteImage(url).then((downloaded) => {
            const nextBytes = downloadedBytes + downloaded.buffer.byteLength;
            if (nextBytes > limits.maxTotalBytes) {
                throw new Error(
                    `思源网络图片下载总量超过 ${Math.round(limits.maxTotalBytes / 1024 / 1024)}MB 限制`,
                );
            }
            downloadedBytes = nextBytes;
            return downloaded;
        });
        downloadCache.set(url, promise);
        return promise;
    };

    const releaseDownload = (url: string) => {
        const remaining = (remainingUses.get(url) || 1) - 1;
        if (remaining <= 0) {
            remainingUses.delete(url);
            downloadCache.delete(url);
        } else {
            remainingUses.set(url, remaining);
        }
    };

    for (const scan of scans) {
        const current = readNote(scan.note.id);
        if (!current || current.contentFormat !== "markdown") {
            skippedUrls += scan.remoteUrls.filter((url) => allowedUrls.has(url)).length;
            for (const url of scan.remoteUrls) if (allowedUrls.has(url)) releaseDownload(url);
            continue;
        }

        const urls = scan.remoteUrls.filter((url) => allowedUrls.has(url));
        const replacements = new Map<string, string>();
        const createdAttachments: CreatedAttachment[] = [];
        let savedUrls = 0;
        let savedDeduplicated = 0;

        await runWithConcurrency(urls, limits.concurrency, async (url) => {
            try {
                const downloaded = await getDownloaded(url);
                const state = currentWriteState(args.userId, current.id, current.version, current.content);
                if (!state) throw new Error("下载期间笔记内容、版本或权限已变化");
                const saved = await saveLocalizedAttachment({
                    jobId: importJobId,
                    userId: args.userId,
                    noteId: current.id,
                    workspaceId: state.workspaceId,
                    sourceUrl: url,
                    downloaded,
                });
                replacements.set(url, saved.imported.url);
                if (saved.created) createdAttachments.push(saved.created);
                savedUrls += 1;
                if (saved.imported.deduplicated) savedDeduplicated += 1;
            } catch (error) {
                failedUrls += 1;
                if (detailWarningCount < MAX_DETAIL_WARNINGS) {
                    warnings.push(
                        `思源 Markdown：网络图片本地化失败（${safeUrlLabel(url)}）：${errorMessage(error)}`,
                    );
                    detailWarningCount += 1;
                }
            } finally {
                releaseDownload(url);
            }
        });

        if (replacements.size === 0) continue;

        try {
            const latest = readNote(current.id);
            if (!latest || latest.contentFormat !== "markdown") {
                await rollbackLocalizedAttachments(createdAttachments);
                skippedUrls += savedUrls;
                warnings.push(`思源 Markdown：${current.title} 在写回前已不可用，已保留原地址。`);
                continue;
            }

            const applied = applyLocalizedContent({
                userId: args.userId,
                noteId: latest.id,
                scannedVersion: latest.version,
                scannedContent: latest.content,
                contentFormat: latest.contentFormat,
                replacements,
            });
            if (applied.conflict) {
                await rollbackLocalizedAttachments(createdAttachments);
                skippedUrls += savedUrls;
                warnings.push(`思源 Markdown：${latest.title} 在写回网络图片时发生冲突，已保留原地址。`);
                continue;
            }
            if (!applied.updated) {
                await rollbackLocalizedAttachments(createdAttachments);
                skippedUrls += savedUrls;
                warnings.push(`思源 Markdown：${latest.title} 未找到可替换的网络图片引用，已保留原地址。`);
                continue;
            }
            localizedUrls += savedUrls;
            localizedReferences += applied.replacedCount;
            deduplicatedAttachments += savedDeduplicated;
            noteVersions[latest.id] = applied.finalVersion || latest.version;
            warnings.push(...applied.warnings);
            // yReplaceContentAsUpdate persists the canonical update before returning.
            // This imported note has not been exposed to clients yet, so release the
            // temporary room immediately instead of retaining its 5-minute idle timer.
            try { yDestroyDoc(latest.id); } catch {}
        } catch (error) {
            await rollbackLocalizedAttachments(createdAttachments);
            skippedUrls += savedUrls;
            warnings.push(`思源 Markdown：${current.title} 的网络图片写回失败，已保留原地址：${errorMessage(error)}`);
        }
    }

    if (localizedUrls > 0) {
        warnings.push(
            `思源 Markdown：已将 ${localizedReferences} 个网络图片引用下载到文件管理（${localizedUrls} 个唯一地址，复用 ${deduplicatedAttachments} 个附件）。`,
        );
    }
    if (failedUrls > 0) {
        const omitted = Math.max(0, failedUrls - detailWarningCount);
        warnings.push(
            `思源 Markdown：${failedUrls} 个网络图片下载失败，已保留原地址${omitted > 0 ? `；另有 ${omitted} 条详情未展开` : ""}。`,
        );
    }

    return {
        warnings,
        noteVersions,
        uniqueRemoteUrls: orderedUniqueUrls.length,
        localizedUrls,
        localizedReferences,
        deduplicatedAttachments,
        failedUrls,
        skippedUrls,
    };
}
