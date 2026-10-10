import { useEffect, useId, useRef, useState } from "react";
import { api } from "@/lib/api";
import { getOfflineQueueStorageKey } from "@/lib/offlineQueue";
import { inspectBrowserConversionCopies, type BrowserConversionCopies, type EncryptionConversionPreflight } from "@/lib/encryptedNotes/conversionPreflight";
import { Button } from "./ui/button";

const labels: Record<string, string> = {
  history: "版本历史", blocks: "内容块与块历史", collaboration: "协作数据",
  search: "搜索索引", embeddings: "向量索引与任务", sync: "同步队列与冲突",
  attachments: "附件与引用", sharing: "分享、评论与授权", templates: "笔记模板",
  links: "双向链接与摘录", imports: "导入记录", folderSync: "文件夹同步",
  embeddedData: "嵌入表格", aiReferences: "AI 对话引用",
};
const blockers: Record<string, string> = {
  conversion_not_enabled: "既有笔记转换尚未开放，当前检查不会修改正文和历史。",
  unsupported_format: "当前笔记格式暂不支持转换。", shared_workspace: "工作空间笔记暂不支持转换。",
  note_unavailable: "笔记已锁定或在回收站中。", active_collaboration: "当前存在协作连接。",
  audit_incomplete: "部分存储未能完整检查，需要进一步审计。",
};
const presence = (value: boolean | null) => value === null ? "未能确认" : value ? "存在" : "未发现";

export default function EncryptedNoteConversionPreflight({ noteId, onClose }: { noteId: string; onClose: () => void }) {
  const headingId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose); close.current = onClose;
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState<{ noteId: string; scope: string; server: EncryptionConversionPreflight; browser: BrowserConversionCopies } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const scope = getOfflineQueueStorageKey();
    setLoading(true); setError(false); setResult(null);
    void Promise.all([api.getEncryptionConversionPreflight(noteId), api.getMe()])
      .then(async ([server, user]) => {
        if (cancelled || scope !== getOfflineQueueStorageKey() || server.noteId !== noteId) return;
        const browser = await inspectBrowserConversionCopies(noteId, user.id);
        if (!cancelled && scope === getOfflineQueueStorageKey()) setResult({ noteId, scope, server, browser });
      })
      .catch(() => { if (!cancelled) setError(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    const invalidate = () => { cancelled = true; setResult(null); close.current(); };
    const storageChanged = (event: StorageEvent) => {
      if (event.key === null || event.key === "nowen-token" || event.key === "nowen-server-url") invalidate();
    };
    window.addEventListener("nowen:token-changed", invalidate);
    window.addEventListener("nowen:server-url-changed", invalidate);
    window.addEventListener("storage", storageChanged);
    return () => {
      cancelled = true;
      window.removeEventListener("nowen:token-changed", invalidate);
      window.removeEventListener("nowen:server-url-changed", invalidate);
      window.removeEventListener("storage", storageChanged);
    };
  }, [noteId, revision]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    return () => { previous?.focus(); };
  }, []);
  const visible = result?.noteId === noteId && result.scope === getOfflineQueueStorageKey() ? result : null;

  return <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-3" onClick={(event) => { if (event.target === event.currentTarget) close.current(); }}>
    <div ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={headingId}
      className="w-full max-w-xl max-h-[85dvh] overflow-y-auto rounded-xl border border-app-border bg-app-elevated p-5 text-sm text-tx-primary shadow-xl"
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.stopPropagation(); close.current(); }
        if (event.key === "Tab") {
          const buttons = panel.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
          if (!buttons?.length) return;
          const first = buttons[0]; const last = buttons[buttons.length - 1];
          if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }
      }}>
      <h2 id={headingId} className="text-base font-semibold">加密转换前检查</h2>
      <p className="mt-2 text-tx-secondary">仅检查，不修改正文和历史。既有笔记转换尚未开放。</p>
      {loading && <p role="status" className="mt-4">正在检查…</p>}
      {error && <p role="alert" className="mt-4 text-red-500">检查失败，无法确认副本情况。请检查连接及笔记所有者权限后重试。</p>}
      {visible && <>
        <p className="mt-4 text-tx-secondary">服务器版本：{visible.server.version}。以下为相关记录数量，可能包含引用或任务，不代表同等数量的明文副本。</p>
        <dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">
          <dt>正文预览文本</dt><dd>{presence(visible.server.previewPresent)}</dd>
          {visible.server.copies.map((copy) => <span key={copy.kind} className="contents"><dt>{labels[copy.kind] || "其他存储"}</dt><dd>{copy.records}{!copy.complete && "（检查不完整）"}</dd></span>)}
          <dt>待审计存储</dt><dd>{visible.server.unreviewed.length} 类</dd>
          <dt>当前协作连接</dt><dd>{visible.server.activeCollaborators}</dd>
        </dl>
        <p className="mt-4 font-medium">当前浏览器</p>
        <dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">
          <dt>本机草稿（可能来自其他账号）</dt><dd>{presence(visible.browser.draft)}</dd>
          <dt>当前账号待同步记录</dt><dd>{visible.browser.queue ?? "未能确认"}</dd>
          <dt>当前账号离线笔记缓存</dt><dd>{presence(visible.browser.cache)}</dd>
          <dt>当前账号协作缓存数据库</dt><dd>{presence(visible.browser.collaboration)}</dd>
        </dl>
        <ul className="mt-4 list-disc space-y-1 pl-5 text-amber-600">
          {visible.server.blockers.map((blocker) => <li key={blocker}>{blockers[blocker] || (labels[blocker] ? `${labels[blocker]}需要另行处理。` : "存在待审计存储。")}</li>)}
        </ul>
      </>}
      <p className="mt-4 text-tx-secondary">检查不证明旧明文已删除。数据库残留、旧备份、导出文件和其他设备中的副本无法在此确认；无引用的摘录也可能遗漏。</p>
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <Button variant="outline" disabled={loading} onClick={() => setRevision((value) => value + 1)}>重新检查</Button>
        <Button disabled>转换尚未开放</Button>
        <Button variant="outline" onClick={() => close.current()}>关闭</Button>
      </div>
    </div>
  </div>;
}
