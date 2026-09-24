import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { BrainCircuit, Loader2, Plus, Search, X } from "lucide-react";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import type { MindMapListItem } from "@/types";

interface Props {
  open: boolean;
  onClose: () => void;
  onInsert: (id: string) => boolean;
}

export default function MindMapEmbedInsertDialog({ open, onClose, onInsert }: Props) {
  const [items, setItems] = useState<MindMapListItem[]>([]);
  const [query, setQuery] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setError("");
    setQuery("");
    setBusy(true);
    api.getMindMaps().then((maps) => {
      if (alive) setItems(maps);
    }).catch(() => {
      if (alive) setError("无法获取思维导图列表，请检查网络和访问权限");
    }).finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, [open, onClose]);

  const filtered = useMemo(() => items.filter((item) => item.title.toLowerCase().includes(query.trim().toLowerCase())), [items, query]);
  const insert = (id: string) => {
    if (onInsert(id)) { onClose(); return; }
    toast.error("当前编辑器暂不支持插入，请切换到常规编辑模式后重试");
  };

  const create = async () => {
    const name = title.trim() || "无标题导图";
    setBusy(true);
    setError("");
    try {
      const created = await api.createMindMap({ title: name });
      // If the editor became read-only while awaiting creation, the new map remains in the
      // library and is never silently deleted; the user can insert it later.
      insert(created.id);
    } catch {
      setError("创建思维导图失败，请检查权限后重试");
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[10001] flex items-center justify-center bg-black/50 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section role="dialog" aria-modal="true" aria-label="插入思维导图" className="flex max-h-[min(80dvh,600px)] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-app-border bg-app-surface shadow-2xl">
        <header className="flex items-center justify-between border-b border-app-border px-4 py-3">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-base font-semibold text-tx-primary"><BrainCircuit size={18} />插入思维导图</h2>
            <p className="mt-0.5 text-xs text-tx-tertiary">选择即可插入，无需复制 ID 或输入引用代码</p>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭" className="rounded p-2 hover:bg-app-hover"><X size={17} /></button>
        </header>
        <div className="space-y-3 p-4">
          <label className="flex items-center gap-2 rounded-lg border border-app-border px-3 py-2">
            <Search size={16} className="text-tx-tertiary" />
            <input aria-label="搜索已有脑图" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索已有脑图…" className="min-w-0 flex-1 bg-transparent text-sm outline-none" />
          </label>
          {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
        </div>
        <div className="min-h-24 flex-1 overflow-auto px-4 pb-4">
          {busy && !items.length ? <p className="flex items-center gap-2 text-sm text-tx-tertiary"><Loader2 size={14} className="animate-spin" />加载中…</p>
            : filtered.length ? filtered.map((item) => (
              <button type="button" key={item.id} disabled={busy} onClick={() => insert(item.id)} className="flex w-full min-w-0 items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-tx-primary hover:bg-app-hover disabled:opacity-50">
                <BrainCircuit size={16} className="shrink-0 text-accent-primary" />
                <span className="min-w-0 flex-1 truncate">{item.title}</span>
                <span className="shrink-0 rounded-md bg-accent-primary/10 px-2 py-1 text-xs font-medium text-accent-primary">插入</span>
              </button>
            )) : <p className="text-sm text-tx-tertiary">没有匹配的思维导图，可以在下方创建。</p>}
        </div>
        <footer className="flex flex-col gap-2 border-t border-app-border p-4 sm:flex-row">
          <input aria-label="新脑图名称" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={100} placeholder="新脑图名称" className="min-w-0 flex-1 rounded-lg border border-app-border bg-transparent px-3 py-2 text-sm outline-none" />
          <button type="button" disabled={busy} onClick={() => void create()} className="inline-flex items-center justify-center gap-2 rounded-lg bg-accent-primary px-4 py-2 text-sm text-white disabled:opacity-50">
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}新建并插入
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
