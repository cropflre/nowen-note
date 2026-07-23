import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  DatabaseBackup,
  ImageOff,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { api, getCurrentWorkspace } from "@/lib/api";
import { toast } from "@/lib/toast";

interface LegacyImageHostingConfig {
  retired?: boolean;
  configured?: boolean;
  enabled?: boolean;
  legacyEnabled?: boolean;
  endpoint?: string;
  bucket?: string;
  publicBaseUrl?: string;
  pathPrefix?: string;
  usePathStyle?: boolean;
  updatedAt?: string | null;
}

interface ScanNote {
  id: string;
  title: string;
  urls: string[];
}

interface MigrationSummary {
  scannedNotes: number;
  affectedNotes: number;
  discoveredImages: number;
  migratedImages: number;
  failedImages: number;
  updatedNotes: number;
  failedNotes: number;
  cancelled: boolean;
}

function normalizePrefix(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function joinUrlParts(...parts: Array<string | undefined>): string {
  return parts
    .map((part) => String(part || "").trim().replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
}

function inferLegacyPrefix(config: LegacyImageHostingConfig | null): string {
  if (!config) return "";
  const publicBase = normalizePrefix(config.publicBaseUrl || "");
  const endpoint = normalizePrefix(config.endpoint || "");
  const bucket = String(config.bucket || "").trim();
  const pathPrefix = String(config.pathPrefix || "").trim();

  let base = publicBase;
  if (!base && endpoint) {
    base = config.usePathStyle === false || !bucket
      ? endpoint
      : `${endpoint}/${bucket}`;
  }
  if (!base) return "";

  const normalizedPath = pathPrefix.replace(/^\/+|\/+$/g, "");
  if (!normalizedPath) return base;
  if (base.toLowerCase().endsWith(`/${normalizedPath.toLowerCase()}`)) return base;
  return `${base}/${normalizedPath}`;
}

function collectLegacyUrls(content: string, prefix: string): string[] {
  if (!content || !prefix) return [];
  const normalizedPrefix = normalizePrefix(prefix).toLowerCase();
  if (!normalizedPrefix) return [];

  const matches = content.match(/https?:\/\/[^\s"'<>\\)]+/gi) || [];
  const unique = new Set<string>();
  for (const raw of matches) {
    const candidate = raw
      .replace(/&amp;/g, "&")
      .replace(/[\],.;}]+$/g, "");
    if (candidate.toLowerCase().startsWith(normalizedPrefix)) unique.add(candidate);
  }
  return Array.from(unique);
}

function replaceUrls(content: string, replacements: Map<string, string>): string {
  let next = content;
  for (const [source, target] of replacements) {
    next = next.split(source).join(target);
  }
  return next;
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const run = async () => {
    while (true) {
      const index = cursor++;
      if (index >= values.length) return;
      results[index] = await worker(values[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, run));
  return results;
}

export default function ImageHostingSettings() {
  const workspaceId = getCurrentWorkspace();
  const cancelRef = useRef(false);
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [config, setConfig] = useState<LegacyImageHostingConfig | null>(null);
  const [prefix, setPrefix] = useState("");
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [migrating, setMigrating] = useState(false);
  const [scanProgress, setScanProgress] = useState({ completed: 0, total: 0 });
  const [migrationProgress, setMigrationProgress] = useState({ completed: 0, total: 0, title: "" });
  const [scanNotes, setScanNotes] = useState<ScanNote[]>([]);
  const [scannedTotal, setScannedTotal] = useState(0);
  const [summary, setSummary] = useState<MigrationSummary | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const me = await api.getMe();
      const admin = (me as any)?.role === "admin";
      setIsAdmin(admin);
      if (!admin) return;
      const legacy = await api.imageHosting.getConfig() as LegacyImageHostingConfig;
      setConfig(legacy);
      setPrefix((current) => current || inferLegacyPrefix(legacy));
    } catch (error: any) {
      setIsAdmin(false);
      console.warn("[LegacyImageMigration] load failed", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const imageCount = useMemo(
    () => scanNotes.reduce((sum, note) => sum + note.urls.length, 0),
    [scanNotes],
  );

  const configured = Boolean(config?.configured);
  const normalizedPrefix = normalizePrefix(prefix);

  const scan = async () => {
    if (!normalizedPrefix) {
      toast.error("请先填写旧图床图片 URL 前缀");
      return;
    }
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      toast.error("历史图片迁移需要联网下载原图");
      return;
    }

    setScanning(true);
    setSummary(null);
    setScanNotes([]);
    setScannedTotal(0);
    try {
      const [activeNotes, trashedNotes] = await Promise.all([
        api.getNotes(),
        api.getNotes({ isTrashed: "1" }),
      ]);
      const uniqueRows = Array.from(
        new Map([...activeNotes, ...trashedNotes].map((note: any) => [note.id, note])).values(),
      ) as any[];
      setScanProgress({ completed: 0, total: uniqueRows.length });

      let completed = 0;
      const rows = await mapWithConcurrency(uniqueRows, 4, async (row) => {
        try {
          const note = await api.getNote(row.id);
          return {
            id: note.id,
            title: note.title || "无标题笔记",
            urls: collectLegacyUrls(String(note.content || ""), normalizedPrefix),
          } satisfies ScanNote;
        } catch (error) {
          console.warn("[LegacyImageMigration] scan note failed", row.id, error);
          return { id: row.id, title: row.title || "无法读取的笔记", urls: [] } satisfies ScanNote;
        } finally {
          completed += 1;
          setScanProgress({ completed, total: uniqueRows.length });
        }
      });

      const affected = rows.filter((row) => row.urls.length > 0);
      setScannedTotal(uniqueRows.length);
      setScanNotes(affected);
      if (affected.length === 0) toast.success("当前空间没有发现匹配的旧图床图片");
      else toast.info(`发现 ${affected.length} 篇笔记、${affected.reduce((sum, row) => sum + row.urls.length, 0)} 张历史图片`);
    } catch (error: any) {
      toast.error(error?.message || "扫描失败");
    } finally {
      setScanning(false);
    }
  };

  const updateNoteWithRetry = async (
    noteId: string,
    replacements: Map<string, string>,
  ): Promise<boolean> => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const latest = await api.getNote(noteId);
      const currentContent = String(latest.content || "");
      const nextContent = replaceUrls(currentContent, replacements);
      if (nextContent === currentContent) return true;
      try {
        await api.updateNote(noteId, {
          content: nextContent,
          version: latest.version,
        });
        return true;
      } catch (error: any) {
        if (error?.code !== "VERSION_CONFLICT" || attempt === 1) throw error;
      }
    }
    return false;
  };

  const migrate = async () => {
    if (scanNotes.length === 0 || imageCount === 0) return;
    const accepted = window.confirm(
      `确认把当前空间的 ${imageCount} 张历史图床图片迁移为 Nowen 附件？\n\n` +
      "迁移会逐张下载、校验、写入附件存储并替换笔记正文链接。" +
      "不会删除第三方 Bucket 中的原文件，失败的链接会原样保留。",
    );
    if (!accepted) return;

    cancelRef.current = false;
    setMigrating(true);
    setSummary(null);
    const result: MigrationSummary = {
      scannedNotes: scannedTotal,
      affectedNotes: scanNotes.length,
      discoveredImages: imageCount,
      migratedImages: 0,
      failedImages: 0,
      updatedNotes: 0,
      failedNotes: 0,
      cancelled: false,
    };

    try {
      for (let index = 0; index < scanNotes.length; index += 1) {
        if (cancelRef.current) {
          result.cancelled = true;
          break;
        }

        const scanned = scanNotes[index];
        setMigrationProgress({ completed: index, total: scanNotes.length, title: scanned.title });
        try {
          const latest = await api.getNote(scanned.id);
          const urls = collectLegacyUrls(String(latest.content || ""), normalizedPrefix);
          if (urls.length === 0) continue;

          const replacements = new Map<string, string>();
          for (const url of urls) {
            if (cancelRef.current) {
              result.cancelled = true;
              break;
            }
            try {
              const imported = await api.attachments.importRemoteImage(
                scanned.id,
                url,
                "legacy-image-hosting-migration",
              );
              replacements.set(url, imported.url);
            } catch (error) {
              result.failedImages += 1;
              console.warn("[LegacyImageMigration] image import failed", url, error);
            }
          }

          if (replacements.size > 0) {
            const updated = await updateNoteWithRetry(scanned.id, replacements);
            if (updated) {
              result.updatedNotes += 1;
              result.migratedImages += replacements.size;
            } else {
              result.failedNotes += 1;
              result.failedImages += replacements.size;
            }
          }
        } catch (error) {
          result.failedNotes += 1;
          console.warn("[LegacyImageMigration] note migration failed", scanned.id, error);
        }
        setMigrationProgress({ completed: index + 1, total: scanNotes.length, title: scanned.title });
      }

      setSummary({ ...result });
      if (result.cancelled) toast.info("迁移已停止，已完成的笔记不会回滚");
      else if (result.failedImages === 0 && result.failedNotes === 0) toast.success("历史图床图片已迁移为 Nowen 附件");
      else toast.warning("迁移已完成，但仍有部分图片或笔记需要重试");
      await scan();
    } finally {
      setMigrating(false);
    }
  };

  const deleteLegacyConfig = async () => {
    const accepted = window.confirm(
      "删除本机保存的旧图床配置？\n\n" +
      "这不会删除第三方 Bucket 中的任何图片，但删除后 Nowen 将无法自动推断旧图片 URL 前缀。",
    );
    if (!accepted) return;
    try {
      const next = await api.imageHosting.deleteConfig() as LegacyImageHostingConfig;
      setConfig(next);
      toast.success("旧图床配置已删除");
    } catch (error: any) {
      toast.error(error?.message || "删除旧配置失败");
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-tx-tertiary text-sm">
        <Loader2 size={15} className="animate-spin" /> 正在读取历史配置…
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <ImageOff className="w-5 h-5 text-amber-500" />
          <h3 className="text-lg font-bold text-tx-primary">第三方图床已退役</h3>
        </div>
        <p className="text-sm text-tx-tertiary leading-relaxed">
          所有新图片现在都会成为 Nowen 附件，再由附件存储驱动写入本地磁盘、S3、R2 或 MinIO。
          历史外链仍会正常渲染，本页只用于把它们安全收回 Nowen 数据体系。
        </p>
      </div>

      <div className="grid md:grid-cols-2 gap-3">
        <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-4 flex gap-3">
          <ShieldCheck size={19} className="text-emerald-500 shrink-0 mt-0.5" />
          <div>
            <div className="text-sm font-medium text-tx-primary">新图片已统一为附件</div>
            <p className="text-xs text-tx-tertiary mt-1">拥有附件 ID、权限、哈希、备份、导出和迁移关系。</p>
          </div>
        </div>
        <div className="rounded-xl border border-blue-500/25 bg-blue-500/5 p-4 flex gap-3">
          <DatabaseBackup size={19} className="text-blue-500 shrink-0 mt-0.5" />
          <div>
            <div className="text-sm font-medium text-tx-primary">第三方原文件不会被删除</div>
            <p className="text-xs text-tx-tertiary mt-1">迁移成功后仍建议保留 Bucket 备份一段时间，再自行清理。</p>
          </div>
        </div>
      </div>

      {isAdmin === false ? (
        <div className="rounded-xl border border-amber-500/25 bg-amber-500/5 p-4 text-sm text-amber-700 dark:text-amber-300 flex gap-2">
          <AlertTriangle size={18} className="shrink-0" />
          历史图片迁移与旧配置清理仅允许系统管理员操作。
        </div>
      ) : (
        <>
          <div className="rounded-xl border border-app-border bg-app-bg p-4 space-y-3">
            <div>
              <div className="text-sm font-medium text-tx-primary">迁移范围</div>
              <p className="text-xs text-tx-tertiary mt-1">
                当前空间：{workspaceId === "personal" ? "个人空间" : workspaceId}。切换工作区后可分别扫描和迁移。
              </p>
            </div>

            <label className="block">
              <span className="text-xs text-tx-tertiary">旧图床图片 URL 前缀</span>
              <input
                value={prefix}
                onChange={(event) => {
                  setPrefix(event.target.value);
                  setScanNotes([]);
                  setSummary(null);
                }}
                placeholder="https://cdn.example.com/images"
                className="mt-1.5 w-full rounded-lg border border-app-border bg-app-elevated text-tx-primary px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-accent-primary/30"
              />
              <p className="text-[11px] text-tx-tertiary mt-1">
                只迁移以该前缀开头的图片，不会批量抓取笔记中的其他网络图片。
              </p>
            </label>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={scan}
                disabled={scanning || migrating || !normalizedPrefix}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 text-sm disabled:opacity-50"
              >
                {scanning ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
                扫描当前空间
              </button>
              {scanNotes.length > 0 && (
                <button
                  type="button"
                  onClick={migrate}
                  disabled={migrating || scanning}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-accent-primary text-white text-sm disabled:opacity-50"
                >
                  {migrating ? <Loader2 size={15} className="animate-spin" /> : <DatabaseBackup size={15} />}
                  迁移 {imageCount} 张图片
                </button>
              )}
              {migrating && (
                <button
                  type="button"
                  onClick={() => { cancelRef.current = true; }}
                  className="px-3 py-2 rounded-lg border border-app-border text-sm text-tx-secondary"
                >
                  完成本张后停止
                </button>
              )}
            </div>

            {scanning && scanProgress.total > 0 && (
              <div className="text-xs text-tx-tertiary">
                正在扫描 {scanProgress.completed}/{scanProgress.total} 篇笔记…
              </div>
            )}

            {!scanning && scannedTotal > 0 && (
              <div className="rounded-lg bg-app-hover px-3 py-2 text-sm text-tx-secondary">
                已扫描 {scannedTotal} 篇笔记；发现 {scanNotes.length} 篇受影响笔记、{imageCount} 张历史图片。
              </div>
            )}

            {migrating && migrationProgress.total > 0 && (
              <div className="space-y-2">
                <div className="flex justify-between gap-3 text-xs text-tx-tertiary">
                  <span className="truncate">{migrationProgress.title}</span>
                  <span>{migrationProgress.completed}/{migrationProgress.total}</span>
                </div>
                <div className="h-2 rounded-full bg-app-hover overflow-hidden">
                  <div
                    className="h-full bg-accent-primary transition-all"
                    style={{ width: `${Math.round((migrationProgress.completed / migrationProgress.total) * 100)}%` }}
                  />
                </div>
              </div>
            )}
          </div>

          {summary && (
            <div className={`rounded-xl border p-4 ${summary.failedImages || summary.failedNotes ? "border-amber-500/30 bg-amber-500/5" : "border-emerald-500/30 bg-emerald-500/5"}`}>
              <div className="flex items-center gap-2 text-sm font-medium text-tx-primary">
                <CheckCircle2 size={17} /> 迁移结果
              </div>
              <div className="mt-2 grid grid-cols-2 md:grid-cols-4 gap-2 text-xs text-tx-secondary">
                <span>已迁移图片：{summary.migratedImages}</span>
                <span>失败图片：{summary.failedImages}</span>
                <span>已更新笔记：{summary.updatedNotes}</span>
                <span>失败笔记：{summary.failedNotes}</span>
              </div>
            </div>
          )}

          <div className="rounded-xl border border-app-border p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-sm font-medium text-tx-primary">旧配置</div>
                <p className="text-xs text-tx-tertiary mt-1">
                  {configured
                    ? `检测到历史配置${config?.updatedAt ? `，最后更新于 ${config.updatedAt}` : ""}。删除只会清理 Nowen 数据库中的配置。`
                    : "没有检测到已保存的旧图床配置。仍可手动填写 URL 前缀迁移历史链接。"}
                </p>
              </div>
              {configured && (
                <button
                  type="button"
                  onClick={deleteLegacyConfig}
                  disabled={migrating || scanning}
                  className="shrink-0 inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-rose-500/30 text-rose-600 dark:text-rose-400 text-sm disabled:opacity-50"
                >
                  <Trash2 size={14} /> 删除旧配置
                </button>
              )}
            </div>
          </div>

          <div className="text-xs text-tx-tertiary leading-relaxed">
            后续图片存储请使用「设置 → 数据管理 → 附件存储」。附件存储可继续使用 S3、R2 或 MinIO，
            但正文中保存的是 Nowen 附件地址，而不是绕过权限和备份体系的公开图床 URL。
          </div>
        </>
      )}
    </div>
  );
}
