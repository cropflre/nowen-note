import React, { useState, useRef, useCallback } from "react";
import { Plus, X, ImagePlus, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";

/** 素朴的 URL 检测：用于 onPaste 时判断是否要转 markdown 链接。 */
function isHttpUrl(s: string): boolean {
  return /^https?:\/\/\S+$/i.test(s.trim());
}

/** 把 URL 截成 hostname；解析失败时返回截短的原串，避免抛异常打破 UI。 */
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url.length > 24 ? url.slice(0, 24) + "…" : url;
  }
}

/* ===========================================================================
 * 新建任务输入区组件
 * ---------------------------------------------------------------------------
 * - 单行 <input> + 上传按钮 + 已上传图片缩略图条
 * - 粘贴：
 *     * clipboard 中含 image/* → 自动调用 task-attachments.upload，把
 *       返回的 url 拼成 `![filename](url)` 追加到 title。
 *     * clipboard 中是 http(s) URL 文本 → 自动包成 `[hostname](url)`
 *       插入到光标处，让标题保持紧凑。
 * - 上传按钮：触发隐藏的 <input type=file>，多选支持。
 * ========================================================================= */
export function TaskQuickAdd({
  value,
  onChange,
  onSubmit,
  inputRef,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (orphanIds: string[]) => Promise<boolean>;
  inputRef: React.RefObject<HTMLInputElement>;
}) {
  const { t } = useTranslation();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  // 拖拽态：把整条输入框做成 dropzone，与 onPaste 粘贴图片体验对齐。
  // 用 counter 处理 enter/leave 的子节点冒泡（缩略图、按钮等）抖动问题。
  const [dragOver, setDragOver] = useState(false);
  const dragCounter = useRef(0);
  // 已上传但还未与任务绑定的"孤儿附件 id" — 用于：
  //   1) 在输入框旁渲染缩略图供用户预览/移除；
  //   2) 提交任务后调用 bind 把它们绑回新创建的 task。
  const [orphans, setOrphans] = useState<{ id: string; url: string; filename: string }[]>([]);

  // 把附件 markdown 插入到 input 当前光标处；如果焦点不在 input，就追加到末尾。
  const insertAtCaret = (snippet: string) => {
    const el = inputRef.current;
    if (!el || document.activeElement !== el) {
      onChange((value ? value + " " : "") + snippet);
      return;
    }
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    const next = value.slice(0, start) + snippet + value.slice(end);
    onChange(next);
    // 光标移到插入片段之后
    requestAnimationFrame(() => {
      const pos = start + snippet.length;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

  const uploadFiles = useCallback(async (files: File[]) => {
    if (!files.length) return;
    setUploading(true);
    try {
      for (const f of files) {
        if (!f.type.startsWith("image/")) {
          toast.error(t('tasks.imageInvalidType'));
          continue;
        }
        if (f.size > 50 * 1024 * 1024) {
          toast.error(t('tasks.imageTooLarge'));
          continue;
        }
        try {
          const res = await api.taskAttachments.upload(f);
          insertAtCaret(`![${res.filename}](${res.url})`);
          setOrphans((prev) => [...prev, { id: res.id, url: res.url, filename: res.filename }]);
        } catch (e: any) {
          toast.error(e?.message || t('tasks.uploadFailed'));
        }
      }
    } finally {
      setUploading(false);
    }
  }, [t, value]);

  // 提交：交还给父组件创建任务（附带 orphan ids），父组件创建成功后绑定附件
  const handleSubmit = () => {
    if (!value.trim()) return;
    const orphanIds = orphans.map((o) => o.id);
    onSubmit(orphanIds);
    // 注意：不要在这里清空 orphans，等父组件创建成功后通过回调清除
    // 创建失败时保留预览，避免用户上传的图片丢失
  };

  const handlePaste = async (e: React.ClipboardEvent<HTMLInputElement>) => {
    // 1) 优先处理图片
    const imgFiles: File[] = [];
    for (const item of Array.from(e.clipboardData.items)) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const f = item.getAsFile();
        if (f) imgFiles.push(f);
      }
    }
    if (imgFiles.length) {
      e.preventDefault();
      await uploadFiles(imgFiles);
      return;
    }
    // 2) 没有图片时检查纯文本是否是 URL — 是就转成 markdown 链接，
    //    避免长 URL 撑破列表。
    const text = e.clipboardData.getData("text/plain");
    if (text && isHttpUrl(text)) {
      e.preventDefault();
      insertAtCaret(`[${hostnameOf(text.trim())}](${text.trim()})`);
    }
  };

  const removeOrphan = async (id: string) => {
    // 同步删后端文件 + 行；同时把 title 里的对应 markdown 移除。
    try {
      await api.taskAttachments.remove(id);
    } catch {
      /* 删失败不阻塞 UI；后台清理脚本会兜底 */
    }
    setOrphans((prev) => prev.filter((o) => o.id !== id));
    // 移除 title 里 ![...](url-with-id)
    const re = new RegExp(`!\\[[^\\]]*\\]\\(/api/task-attachments/${id}\\)\\s?`, "g");
    onChange(value.replace(re, ""));
  };

  return (
    <div
      className={cn(
        "px-4 py-2.5 rounded-lg border border-dashed bg-app-elevated/50 transition-colors",
        dragOver
          ? "border-accent-primary bg-accent-primary/5 ring-2 ring-accent-primary/30"
          : "border-app-border hover:border-accent-primary/40",
      )}
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        dragCounter.current++;
        setDragOver(true);
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }
      }}
      onDragLeave={() => {
        dragCounter.current--;
        if (dragCounter.current <= 0) {
          dragCounter.current = 0;
          setDragOver(false);
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        dragCounter.current = 0;
        setDragOver(false);
        const files = Array.from(e.dataTransfer.files || []).filter(
          (f) => f.type.startsWith("image/"),
        );
        if (files.length > 0) void uploadFiles(files);
      }}
    >
      <div className="flex items-center gap-3">
        <Plus size={16} className="text-tx-tertiary flex-shrink-0" />
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
          onPaste={handlePaste}
          placeholder={t('tasks.addTaskPlaceholder')}
          className="flex-1 min-w-0 bg-transparent text-sm text-tx-primary placeholder:text-tx-tertiary focus:outline-none"
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          title={t('tasks.insertImage')}
          className="flex-shrink-0 p-1 rounded hover:bg-app-hover text-tx-tertiary hover:text-accent-primary transition-colors disabled:opacity-50"
        >
          {uploading
            ? <Loader2 size={16} className="animate-spin" />
            : <ImagePlus size={16} />}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files || []);
            uploadFiles(files);
            e.target.value = ""; // 允许重选同一文件
          }}
        />
      </div>

      {/* 已上传图片缩略图条 — 仅在有孤儿时渲染，不占位 */}
      {orphans.length > 0 && (
        <div className="mt-2 flex items-center gap-2 flex-wrap">
          {orphans.map((o) => (
            <div key={o.id} className="relative group">
              <img
                src={o.url}
                alt={o.filename}
                className="w-12 h-12 rounded object-cover border border-app-border"
              />
              <button
                type="button"
                onClick={() => removeOrphan(o.id)}
                className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-app-bg border border-app-border text-tx-secondary hover:text-accent-danger hover:border-accent-danger flex items-center justify-center transition-colors"
                title={t('common.delete') || 'Remove'}
              >
                <X size={10} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
