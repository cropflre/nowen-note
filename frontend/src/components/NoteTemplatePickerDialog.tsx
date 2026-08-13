import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { FileCode, FileText, LayoutTemplate, Loader2, Paperclip, RefreshCw, Trash2, X } from "lucide-react";

import { confirm } from "@/components/ui/confirm";
import { noteTemplatesApi, type NoteTemplateSummary } from "@/lib/noteTemplatesApi";
import { cn } from "@/lib/utils";

export interface NoteTemplatePickerDialogProps {
  open: boolean;
  onClose: () => void;
  onCreate: (templateId: string) => Promise<void>;
}

function formatUpdatedAt(value: string): string {
  const time = new Date(value && value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  if (!Number.isFinite(time.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(time);
}

export default function NoteTemplatePickerDialog({
  open,
  onClose,
  onCreate,
}: NoteTemplatePickerDialogProps) {
  const [templates, setTemplates] = useState<NoteTemplateSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creatingId, setCreatingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await noteTemplatesApi.list();
      setTemplates(result.templates);
    } catch (requestError: any) {
      setError(requestError?.message || "模板加载失败，请重试");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setCreatingId(null);
    void load();
  }, [load, open]);

  useEffect(() => {
    if (!open) return;
    const closeFromKeyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !creatingId && !deletingId) onClose();
    };
    window.addEventListener("keydown", closeFromKeyboard, true);
    return () => window.removeEventListener("keydown", closeFromKeyboard, true);
  }, [creatingId, deletingId, onClose, open]);

  if (!open || typeof document === "undefined") return null;

  const create = async (templateId: string) => {
    if (creatingId || deletingId) return;
    setCreatingId(templateId);
    setError(null);
    try {
      await onCreate(templateId);
      onClose();
    } catch (requestError: any) {
      setError(requestError?.message || "从模板创建失败，请重试");
    } finally {
      setCreatingId(null);
    }
  };

  const remove = async (template: NoteTemplateSummary) => {
    if (!template.canDelete || creatingId || deletingId) return;
    const accepted = await confirm({
      title: "删除模板？",
      description: `“${template.name}”及其独立附件快照将被删除，已创建的笔记不受影响。`,
      confirmText: "删除",
      danger: true,
    });
    if (!accepted) return;
    setDeletingId(template.id);
    setError(null);
    try {
      await noteTemplatesApi.remove(template.id);
      setTemplates((current) => current.filter((item) => item.id !== template.id));
    } catch (requestError: any) {
      setError(requestError?.message || "模板删除失败，请重试");
    } finally {
      setDeletingId(null);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 px-3 py-4 backdrop-blur-[2px]"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !creatingId && !deletingId) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="note-template-picker-title"
        className="flex max-h-[min(82vh,40rem)] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-app-border bg-app-surface shadow-2xl"
      >
        <header className="flex shrink-0 items-center gap-3 border-b border-app-border px-4 py-3.5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-primary/10 text-accent-primary">
            <LayoutTemplate size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="note-template-picker-title" className="font-semibold text-tx-primary">从模板新建</h2>
            <p className="mt-0.5 text-xs text-tx-tertiary">选择当前空间中的模板，新笔记会创建在刚才指定的位置</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={Boolean(creatingId || deletingId)}
            className="rounded-md p-1.5 text-tx-tertiary transition-colors hover:bg-app-hover hover:text-tx-primary disabled:opacity-40"
            aria-label="关闭模板选择"
          >
            <X size={17} />
          </button>
        </header>

        {error && (
          <div className="mx-4 mt-3 flex shrink-0 items-center justify-between gap-3 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs text-red-500">
            <span>{error}</span>
            <button type="button" onClick={() => void load()} className="shrink-0 rounded p-1 hover:bg-red-500/10" aria-label="重新加载模板">
              <RefreshCw size={14} />
            </button>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto p-3 overscroll-contain">
          {loading ? (
            <div className="flex min-h-44 items-center justify-center gap-2 text-sm text-tx-tertiary">
              <Loader2 size={17} className="animate-spin" />正在加载模板…
            </div>
          ) : templates.length === 0 ? (
            <div className="flex min-h-44 flex-col items-center justify-center px-6 text-center">
              <LayoutTemplate size={28} className="mb-3 text-tx-tertiary" />
              <p className="text-sm font-medium text-tx-secondary">暂无模板</p>
              <p className="mt-1.5 text-xs leading-5 text-tx-tertiary">可在笔记的 ... 菜单中保存为模板</p>
            </div>
          ) : (
            <div className="space-y-2">
              {templates.map((template) => {
                const isMarkdown = template.contentFormat === "markdown";
                const busy = creatingId === template.id || deletingId === template.id;
                const Icon = isMarkdown ? FileCode : FileText;
                return (
                  <div
                    key={template.id}
                    className={cn(
                      "group flex items-center gap-3 rounded-lg border border-app-border bg-app-bg/35 p-2 transition-colors",
                      !creatingId && !deletingId && "hover:border-accent-primary/35 hover:bg-app-hover",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => void create(template.id)}
                      disabled={Boolean(creatingId || deletingId)}
                      className="flex min-w-0 flex-1 items-center gap-3 rounded-md p-1 text-left disabled:cursor-wait"
                    >
                      <span className={cn(
                        "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
                        isMarkdown ? "bg-emerald-500/10 text-emerald-500" : "bg-accent-primary/10 text-accent-primary",
                      )}>
                        {creatingId === template.id ? <Loader2 size={17} className="animate-spin" /> : <Icon size={17} />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-tx-primary">{template.name}</span>
                        <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-tx-tertiary">
                          <span>{isMarkdown ? "Markdown" : "富文本"}</span>
                          <span>更新于 {formatUpdatedAt(template.updatedAt)}</span>
                          {template.attachmentCount > 0 && (
                            <span className="inline-flex items-center gap-1"><Paperclip size={11} />{template.attachmentCount}</span>
                          )}
                        </span>
                      </span>
                    </button>
                    {template.canDelete && (
                      <button
                        type="button"
                        onClick={() => void remove(template)}
                        disabled={Boolean(creatingId || deletingId)}
                        className="shrink-0 rounded-md p-2 text-tx-tertiary transition-colors hover:bg-red-500/10 hover:text-red-500 disabled:opacity-40"
                        aria-label={`删除模板“${template.name}”`}
                      >
                        {deletingId === template.id ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
                      </button>
                    )}
                    {busy && <span className="sr-only">处理中</span>}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>
    </div>,
    document.body,
  );
}
