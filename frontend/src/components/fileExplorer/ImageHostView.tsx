import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Copy, Download, FileText, Globe, Image as ImageIcon, Loader2, Search } from "lucide-react";
import { api, resolveAttachmentUrl } from "@/lib/api";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { useSiteSettings } from "@/hooks/useSiteSettings";
import { resolvePublicAttachmentOrigin } from "@/lib/publicAttachmentUrl";
import { imageHostFormatLabel, type ImageHostFormat } from "@/lib/imageHostFormats";
import { humanFileSize } from "@/lib/fileExplorerModel";
import { IMAGE_HOST_PAGE_SIZE as PAGE_SIZE, imageHostListParams, publicLinkStatus, type ImageHostScope, type PublicLinkStatus } from "@/lib/filePageViews";
import type { FileItem, FileSortKey, FileStats } from "@/types";

const SCOPES: ImageHostScope[] = ["all", "image", "file", "myUploads", "unreferenced"];
const SORTS: FileSortKey[] = ["created_desc", "created_asc", "name_asc", "name_desc", "size_asc", "size_desc"];
const FORMATS: ImageHostFormat[] = ["url", "markdown", "html"];
const BADGE: Record<Exclude<PublicLinkStatus, "unknown">, string> = {
  public: "bg-emerald-600/90 text-white",
  private: "bg-black/55 text-white",
  disabled: "bg-amber-500/90 text-white",
};

function scopeCount(scope: ImageHostScope, stats: FileStats | null): number | undefined {
  if (!stats) return undefined;
  if (scope === "all") return stats.total;
  if (scope === "image") return stats.images?.count;
  if (scope === "file") return stats.files?.count;
  if (scope === "myUploads") return stats.myUploads?.total;
  return undefined; // The stats endpoint does not report a reliable unreferenced count.
}

export default function ImageHostView({ active, refreshKey, isCurrent, onUpload, onDropFiles, onOpen, onCopyLink, onDownload }: {
  active: boolean;
  refreshKey: string;
  isCurrent: () => boolean;
  onUpload: () => void;
  onDropFiles: (files: File[]) => void;
  onOpen: (id: string) => void;
  onCopyLink: (file: FileItem, format: ImageHostFormat) => Promise<boolean>;
  onDownload: (file: FileItem) => void;
}) {
  const { t } = useTranslation();
  const [scope, setScope] = useState<ImageHostScope>("all");
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<FileSortKey>("created_desc");
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<FileItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [stats, setStats] = useState<FileStats | null>(null);
  const [copying, setCopying] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ file: FileItem; x: number; y: number } | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => { setQuery(input.trim()); setPage(1); }, 250);
    return () => clearTimeout(timer);
  }, [input]);
  useEffect(() => {
    let stale = false;
    setLoading(true); setError("");
    api.files.list(imageHostListParams(scope, query, sort, page)).then((result) => {
      if (stale || !isCurrent()) return;
      setItems(result.items); setTotal(result.total);
      if (page > 1 && result.total <= (page - 1) * PAGE_SIZE) setPage(Math.max(1, Math.ceil(result.total / PAGE_SIZE)));
    }).catch((failure: unknown) => {
      if (!stale && isCurrent()) setError(failure instanceof Error ? failure.message : String(failure));
    }).finally(() => { if (!stale && isCurrent()) setLoading(false); });
    return () => { stale = true; };
  }, [scope, query, sort, page, refreshKey, retry, isCurrent]);
  useEffect(() => {
    let stale = false;
    api.files.stats().then((result) => { if (!stale && isCurrent()) setStats(result); }).catch(() => { if (!stale) setStats(null); });
    return () => { stale = true; };
  }, [refreshKey, isCurrent]);
  useEffect(() => { if (!active) setMenu(null); }, [active]);
  useEffect(() => {
    if (!menu) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setMenu(null); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [menu]);

  const copy = async (file: FileItem, format: ImageHostFormat) => {
    if (copying) return;
    setCopying(file.id);
    try {
      if (await onCopyLink(file, format) && isCurrent()) {
        setItems((previous) => previous.map((item) => item.id === file.id ? { ...item, publicLinkActive: true } : item));
      }
    } finally {
      if (isCurrent()) setCopying(null);
    }
  };
  const showFormats = (event: React.MouseEvent, file: FileItem) => {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({ file, x: Math.min(rect.right - 176, window.innerWidth - 180), y: Math.min(rect.bottom + 4, window.innerHeight - 140) });
  };
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="shrink-0 space-y-2 border-b border-app-border px-3 py-2 md:px-4 md:py-3">
      <PublicOriginBar />
      <div role="group" aria-label={t("assetOrganization.filters")} className="no-scrollbar flex gap-1 overflow-x-auto text-xs">
        {SCOPES.map((value) => {
          const count = scopeCount(value, stats);
          return <button key={value} type="button" aria-pressed={scope === value} onClick={() => { setScope(value); setPage(1); }}
            className={cn("flex min-h-8 shrink-0 items-center gap-1 rounded-md px-2.5", scope === value ? "bg-accent-primary/10 text-accent-primary" : "text-tx-secondary hover:bg-app-hover")}>
            {t(`fileExplorer.imageHost.scopes.${value}`)}{count !== undefined && <span className="text-[10px] text-tx-tertiary">{count}</span>}
          </button>;
        })}
      </div>
      <div className="flex items-center gap-2">
        <label className="relative min-w-0 flex-1"><Search size={15} className="absolute left-2.5 top-2.5 text-tx-tertiary" />
          <input aria-label={t("fileExplorer.imageHost.search")} value={input} onChange={(event) => setInput(event.target.value)} placeholder={t("fileExplorer.imageHost.search")}
            className="h-9 w-full rounded-lg border border-app-border bg-app-surface pl-8 pr-3 text-sm outline-none focus:border-accent-primary" />
        </label>
        <select aria-label={t("fileExplorer.sort")} value={sort} onChange={(event) => { setSort(event.target.value as FileSortKey); setPage(1); }}
          className="h-9 min-w-0 max-w-36 rounded-lg border border-app-border bg-app-surface px-2 text-xs">
          {SORTS.map((value) => <option key={value} value={value}>{t(`fileExplorer.sortKeys.${value}`)}</option>)}
        </select>
      </div>
      <p className="text-[11px] leading-4 text-tx-tertiary">{t("fileExplorer.imageHost.hint")}</p>
    </div>
    <div className="min-h-0 flex-1 overflow-auto p-3 md:p-4"
      onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
      onDrop={(event) => { if (!event.dataTransfer.types.includes("Files")) return; event.preventDefault(); onDropFiles(Array.from(event.dataTransfer.files)); }}>
      {error ? <div role="alert" className="rounded-lg border border-red-500/30 p-4 text-sm text-red-500">{error}<button className="ml-3 underline" onClick={() => setRetry((value) => value + 1)}>{t("fileExplorer.retry")}</button></div>
        : loading && !items.length ? <div role="status" className="flex items-center justify-center gap-2 py-16 text-sm text-tx-secondary"><Loader2 size={18} className="animate-spin" />{t("fileExplorer.loading")}</div>
        : !items.length ? <div className="py-16 text-center text-sm text-tx-secondary">
            <ImageIcon size={36} className="mx-auto mb-3 text-tx-tertiary" />
            <p>{t(query || scope !== "all" ? "fileExplorer.noResults" : "fileExplorer.imageHost.empty")}</p>
            <button className="mt-3 text-accent-primary" onClick={onUpload}>{t("fileManager.uploadFiles")}</button>
          </div>
        : <div className="grid grid-cols-2 gap-2 md:grid-cols-[repeat(auto-fill,minmax(180px,1fr))] md:gap-3">
            {items.map((file) => <HostCard key={file.id} file={file} busy={copying === file.id} onOpen={() => onOpen(file.id)}
              onCopy={() => void copy(file, "url")} onFormats={(event) => showFormats(event, file)} onDownload={() => onDownload(file)} />)}
          </div>}
    </div>
    <footer className="flex shrink-0 flex-wrap items-center justify-between gap-1 border-t border-app-border px-3 py-1 text-xs text-tx-secondary md:px-4 md:py-2">
      <span className="flex items-center gap-1.5">{t("fileExplorer.fileCount", { count: total })} · {t("fileExplorer.page", { page, total: pages })}{loading && !!items.length && <Loader2 size={12} className="animate-spin" />}</span>
      <div className="flex gap-3">
        <button disabled={page === 1 || loading} className="disabled:opacity-30" onClick={() => setPage((value) => value - 1)}>{t("fileExplorer.previous")}</button>
        <button disabled={page >= pages || loading} className="disabled:opacity-30" onClick={() => setPage((value) => value + 1)}>{t("fileExplorer.next")}</button>
      </div>
    </footer>
    {menu && <>
      <button className="fixed inset-0 z-[110] cursor-default" aria-label={t("common.close")} onClick={() => setMenu(null)} />
      <div role="menu" aria-label={t("fileExplorer.imageHost.copyFormats")} className="fixed z-[111] w-44 rounded-lg border border-app-border bg-app-elevated p-1 text-sm shadow-xl"
        style={{ left: Math.max(4, menu.x), top: Math.max(4, menu.y) }}>
        {FORMATS.map((format) => <button key={format} role="menuitem" className="flex w-full items-center gap-2 rounded px-3 py-2 text-left hover:bg-app-hover"
          onClick={() => { const file = menu.file; setMenu(null); void copy(file, format); }}>
          <Copy size={13} className="text-tx-tertiary" />{t("attachmentDetail.copyFormat", { format: imageHostFormatLabel(format) })}
        </button>)}
      </div>
    </>}
  </div>;
}

function HostCard({ file, busy, onOpen, onCopy, onFormats, onDownload }: {
  file: FileItem; busy: boolean; onOpen: () => void; onCopy: () => void;
  onFormats: (event: React.MouseEvent) => void; onDownload: () => void;
}) {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);
  const status = publicLinkStatus(file);
  const image = file.category === "image";
  const thumbnail = image && !failed ? file.thumbnailUrl || file.url : "";
  const disabled = status === "disabled" || busy;
  return <div role="button" tabIndex={0} aria-label={file.filename} onClick={onOpen}
    onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onOpen(); } }}
    className="min-w-0 cursor-pointer overflow-hidden rounded-lg border border-app-border bg-app-surface text-sm outline-none hover:bg-app-hover focus-visible:ring-2 focus-visible:ring-accent-primary">
    <div className="relative flex h-28 items-center justify-center bg-app-elevated md:h-36">
      {thumbnail ? <img src={resolveAttachmentUrl(thumbnail)} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} className="h-full w-full object-cover" />
        : image ? <ImageIcon size={36} className="text-tx-tertiary" /> : <FileText size={36} className="text-tx-tertiary" />}
      {status !== "unknown" && <span data-link-status={status} title={t(`fileExplorer.imageHost.statusHint.${status}`)}
        className={cn("absolute bottom-1.5 left-1.5 rounded px-1.5 py-0.5 text-[10px] font-medium", BADGE[status])}>{t(`fileExplorer.imageHost.status.${status}`)}</span>}
    </div>
    <div className="p-2 md:p-3">
      <p className="truncate text-xs text-tx-primary md:text-sm" title={file.filename}>{file.filename}</p>
      <p className="mt-0.5 text-xs text-tx-tertiary">{humanFileSize(file.size)}</p>
      <div className="mt-2 flex gap-1">
        <div className="flex min-w-0 flex-1 overflow-hidden rounded-md border border-app-border">
          <button type="button" disabled={disabled} title={status === "disabled" ? t("fileExplorer.imageHost.statusHint.disabled") : undefined}
            onClick={(event) => { event.stopPropagation(); onCopy(); }}
            className="flex min-h-9 min-w-0 flex-1 items-center justify-center gap-1 px-2 text-xs text-accent-primary hover:bg-accent-primary/10 disabled:opacity-40">
            {busy ? <Loader2 size={14} className="shrink-0 animate-spin" /> : <Copy size={14} className="shrink-0" />}<span className="truncate">{t("fileExplorer.imageHost.copyLink")}</span>
          </button>
          <button type="button" aria-label={t("fileExplorer.imageHost.copyFormats")} aria-haspopup="menu" disabled={disabled}
            onClick={(event) => { event.stopPropagation(); onFormats(event); }}
            className="flex min-h-9 w-8 shrink-0 items-center justify-center border-l border-app-border text-tx-secondary hover:bg-app-hover disabled:opacity-40"><ChevronDown size={14} /></button>
        </div>
        <button type="button" aria-label={t("attachmentDetail.downloadFile")} title={t("attachmentDetail.downloadFile")} disabled={!file.url}
          onClick={(event) => { event.stopPropagation(); onDownload(); }}
          className="flex min-h-9 w-9 shrink-0 items-center justify-center rounded-md border border-app-border text-tx-secondary hover:bg-app-hover disabled:opacity-40"><Download size={14} /></button>
      </div>
    </div>
  </div>;
}

/** Moved from the former image-host page: shows where public links point, admins may change it. */
function PublicOriginBar() {
  const { t } = useTranslation();
  const { siteConfig, updateFilePublicOrigin } = useSiteSettings();
  const [canConfigure, setCanConfigure] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let cancelled = false;
    api.getMe().then((user) => { if (!cancelled) setCanConfigure(user?.role === "admin"); }).catch(() => { if (!cancelled) setCanConfigure(false); });
    return () => { cancelled = true; };
  }, []);
  const origin = resolvePublicAttachmentOrigin({ filePublicOrigin: siteConfig.filePublicOrigin, publicWebOrigin: siteConfig.publicWebOrigin });
  const source = origin.source === "file"
    ? siteConfig.filePublicOriginSource === "environment" ? "env" : "file"
    : origin.source === "public-web" ? "inherit" : "current";
  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await updateFilePublicOrigin(draft.trim());
      toast.success(t(draft.trim() ? "fileExplorer.imageHost.originSaved" : "fileExplorer.imageHost.originInherited"));
      setEditing(false);
    } catch (failure: unknown) {
      toast.error(failure instanceof Error && failure.message ? failure.message : t("fileExplorer.imageHost.originFailed"));
    } finally {
      setSaving(false);
    }
  };
  return <div data-file-public-origin className="rounded-lg border border-app-border bg-app-surface px-3 py-2 text-xs">
    <div className="flex items-center gap-2">
      <Globe size={14} className="shrink-0 text-accent-primary" />
      <span className="shrink-0 font-medium text-tx-secondary">{t("fileExplorer.imageHost.origin")}</span>
      <code className="min-w-0 flex-1 truncate text-tx-primary">{origin.origin || t("fileExplorer.imageHost.originCurrent")}</code>
      <span className="hidden shrink-0 rounded-full bg-app-hover px-2 py-0.5 text-[10px] text-tx-tertiary sm:inline">{t(`fileExplorer.imageHost.originSource.${source}`)}</span>
      {canConfigure && <button type="button" className="shrink-0 rounded-md border border-app-border px-2 py-1 hover:bg-app-hover"
        onClick={() => { setDraft(siteConfig.filePublicOrigin || ""); setEditing(true); }}>{t("fileExplorer.imageHost.configure")}</button>}
    </div>
    {editing && canConfigure && <div className="mt-2 space-y-2">
      <label className="block text-tx-secondary">{t("fileExplorer.imageHost.originLabel")}
        <input autoFocus value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="https://file.example.com"
          onKeyDown={(event) => { if (event.key === "Enter") void save(); if (event.key === "Escape") setEditing(false); }}
          className="mt-1 h-8 w-full rounded-md border border-app-border bg-app-bg px-2 font-mono text-xs text-tx-primary outline-none focus:border-accent-primary" />
      </label>
      <div className="flex gap-3">
        <button type="button" disabled={saving} onClick={() => void save()} className="rounded-md bg-accent-primary px-3 py-1.5 text-white disabled:opacity-50">
          {saving ? <Loader2 size={12} className="animate-spin" /> : t("attachmentDetail.save")}
        </button>
        <button type="button" disabled={saving} onClick={() => setEditing(false)}>{t("common.cancel")}</button>
      </div>
      <p className="text-[11px] leading-4 text-tx-tertiary">{t("fileExplorer.imageHost.originHelp")}</p>
    </div>}
  </div>;
}
