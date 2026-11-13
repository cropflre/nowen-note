import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, Copy, Loader2, PlugZap } from "lucide-react";
import type { EmbeddedMcpStatus } from "@/lib/api";
import { getOfflineQueueStorageKey } from "@/lib/offlineScope";
import { toast } from "@/lib/toast";
import {
  buildMcpInstallLink, buildMcpAgentInstructions, createMcpConnectionSession,
  MCP_CLIENT_NAMES, MCP_CLIENT_GROUPS, isValidMcpExpiryDays, type McpClient, type McpConnection, type McpNotebookOption, type SavedMcpConnection,
} from "@/lib/mcpConnections";

const control = "min-h-11 rounded-xl border border-[var(--color-border)] px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-accent-primary)] disabled:opacity-50";

export default function McpQuickConnect({ service, defaultUrl, onServiceChange, loadError, onRetry }: {
  service: EmbeddedMcpStatus | null; defaultUrl: string; onServiceChange: (status: EmbeddedMcpStatus) => void;
  loadError?: boolean; onRetry?: () => void;
}) {
  const scope = getOfflineQueueStorageKey();
  const session = useMemo(() => createMcpConnectionSession(), [scope, defaultUrl]);
  const [client, setClient] = useState<McpClient>("claude-code");
  const [books, setBooks] = useState<McpNotebookOption[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [expiryInput, setExpiryInput] = useState("");
  const expiresInDays = expiryInput === "" ? undefined : Number(expiryInput);
  const validExpiry = expiryInput === "" || (/^\d+$/.test(expiryInput) && isValidMcpExpiryDays(expiresInDays));
  const [saved, setSaved] = useState<SavedMcpConnection[]>([]);
  const [connection, setConnection] = useState<McpConnection | null>(null);
  const [busy, setBusy] = useState("");
  const [verified, setVerified] = useState(false);
  const [error, setError] = useState("");
  const operation = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const active = () => mounted.current && session.current();
  useEffect(() => {
    if (!service?.enabled) setVerified(false);
    if (connection && service?.publicUrl && service.publicUrl !== connection.url) {
      setConnection(value => value ? { ...value, url: service.publicUrl } : null);
      setVerified(false);
    }
  }, [service?.enabled, service?.publicUrl, connection?.url]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; operation.current?.abort(); };
  }, []);
  const loadOptions = useCallback(async (signal: AbortSignal) => {
    try {
      const [result, existing] = await Promise.all([session.notebooks(signal), session.list(signal)]);
      if (!signal.aborted && session.current()) {
        setBooks(result.notebooks); setSelected(result.notebooks.map(book => book.id)); setSaved(existing);
      }
    } catch {
      if (!signal.aborted && session.current()) setError("笔记本加载失败，请重新打开设置重试");
    }
  }, [session]);
  useEffect(() => {
    if (!service?.available) return;
    const controller = new AbortController();
    void loadOptions(controller.signal);
    return () => controller.abort();
  }, [loadOptions, service?.available]);

  const checkConnection = async (value: McpConnection, signal: AbortSignal) => {
    if (active()) { setBusy("正在连接…"); setVerified(false); }
    await session.probe(value, signal);
    if (active() && !signal.aborted) setVerified(true);
  };
  const run = async (action: (signal: AbortSignal) => Promise<void>) => {
    if (operation.current || !active()) return;
    const controller = new AbortController();
    operation.current = controller;
    setError(""); setBusy("正在连接…");
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try { await action(controller.signal); }
    catch (caught) {
      if (active()) setError(controller.signal.aborted ? "连接超时，请重试" : caught instanceof Error && /^[\u4e00-\u9fff]/u.test(caught.message) ? caught.message : "连接失败，请重试");
    } finally {
      clearTimeout(timeout);
      operation.current = null;
      if (active()) setBusy("");
    }
  };
  const create = () => run(async signal => {
    if (!service?.available || !books || !selected.length || !validExpiry) return;
    let status = service;
    if (!status.enabled || !status.allowWrite) {
      if (!status.canManage) throw new Error("请联系管理员开启 AI 连接和编辑功能");
      status = await session.enable({ enabled: true, allowWrite: true, publicUrl: status.publicUrl || defaultUrl }, signal);
      if (!active()) return;
      onServiceChange(status);
      if (!status.enabled || !status.allowWrite) throw new Error("AI 连接和编辑功能尚未开启，请重试");
    }
    const value = await session.create({ client, notebooks: books.filter(book => selected.includes(book.id)).map(({ id, canWrite }) => ({ id, canWrite })), writable: true, url: status.publicUrl || defaultUrl,
      ...(expiresInDays === undefined ? {} : { expiresInDays }) }, signal);
    if (!active() || signal.aborted) return;
    setConnection(value);
    setSaved(values => [...values, { id: value.id, name: `MCP · ${MCP_CLIENT_NAMES[value.client]}`, expiresAt: value.expiresAt, revokedAt: null }]);
    await checkConnection(value, signal);
  });
  const copy = async () => {
    if (!connection || !verified || !active()) return;
    try {
      await navigator.clipboard.writeText(buildMcpAgentInstructions(connection));
      if (active()) toast.success(`已复制，粘贴给 ${MCP_CLIENT_NAMES[connection.client]} 即可`);
    } catch { if (active()) toast.error("复制失败，请允许浏览器使用剪贴板后重试"); }
  };
  const disconnect = (id: string) => run(async signal => {
    setBusy("正在断开…");
    await session.revoke(id, signal);
    if (active()) {
      setSaved(values => values.filter(value => value.id !== id));
      if (connection?.id === id) { setConnection(null); setVerified(false); }
      toast.success("已断开");
    }
  });
  const unavailable = !service?.available || ((!service.enabled || !service.allowWrite) && !service.canManage);
  const installLink = connection ? buildMcpInstallLink(connection) : null;
  return (
    <section aria-label="快速连接 AI 助手" className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-[var(--color-text-primary)] sm:p-5">
      <div className="flex items-start gap-3">
        <div className="rounded-xl bg-[var(--color-active)] p-2.5 text-[var(--color-accent-primary)]"><PlugZap className="h-5 w-5" /></div>
        <div><h3 className="text-base font-semibold">连接 AI 助手</h3>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">让 AI 帮你查找、整理和编辑笔记。</p></div>
      </div>
      {!service ? <div role="status" className="mt-4 text-sm text-[var(--color-text-secondary)]">{loadError ? <>连接服务检查失败。<button type="button" onClick={onRetry} className={`${control} ml-2`}>重新检查</button></> : "正在检查连接服务…"}</div> :
        !service.available ? <p role="status" className="mt-4 text-sm text-[var(--color-text-secondary)]">当前版本暂不支持连接，请先升级 Docker 镜像。</p> :
          (!service.enabled || !service.allowWrite) && !service.canManage ? <p role="status" className="mt-4 text-sm text-[var(--color-text-secondary)]">请联系管理员开启 AI 连接和编辑功能，开启后即可为自己创建连接。</p> : null}
      {!connection ? <div className="mt-5 space-y-5">
        <fieldset disabled={Boolean(busy) || unavailable}>
          <legend className="mb-2 text-sm font-medium">选择助手</legend>
          <select aria-label="选择助手" value={client} onChange={event => setClient(event.target.value as McpClient)}
            className={`${control} w-full bg-[var(--color-bg)]`}>
            {MCP_CLIENT_GROUPS.map(group => <optgroup key={group.label} label={group.label}>
              {group.clients.map(id => <option key={id} value={id}>{MCP_CLIENT_NAMES[id]}</option>)}
            </optgroup>)}
          </select>
        </fieldset>
        <fieldset disabled={Boolean(busy) || unavailable}>
          <legend className="text-sm font-medium">选择笔记本</legend>
          <p id="mcp-scope-help" className="mt-1 text-xs text-[var(--color-text-secondary)]">AI 可查看、新建、修改所选笔记本中的笔记；删除会移入回收站，共享只读笔记不可修改。</p>
          <div aria-describedby="mcp-scope-help" className="mt-2 max-h-48 overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-2">
            {books && books.length > 0 && <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg px-2 text-sm font-medium hover:bg-[var(--color-hover)]">
              <input type="checkbox" checked={selected.length === books.length}
                ref={element => { if (element) element.indeterminate = selected.length > 0 && selected.length < books.length; }}
                onChange={event => setSelected(event.target.checked ? books.map(book => book.id) : [])} />
              <span>全部笔记</span>
            </label>}
            {!books ? <p className="p-2 text-xs text-[var(--color-text-secondary)]">{service?.available ? "正在读取笔记本…" : "服务就绪后显示笔记本"}</p> :
              !books.length ? <p className="p-2 text-xs text-[var(--color-text-secondary)]">还没有可授权的笔记本，请先创建一个。</p> :
                books.map(book => <label key={book.id} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg px-2 text-sm hover:bg-[var(--color-hover)]">
                  <input type="checkbox" checked={selected.includes(book.id)} onChange={event => setSelected(ids => event.target.checked ? [...ids, book.id] : ids.filter(id => id !== book.id))} />
                  <span className="min-w-0 truncate" title={book.name}>{book.name}</span>
                  {!book.canWrite && <span className="shrink-0 text-xs text-[var(--color-text-secondary)]">只读</span>}
                </label>)}
          </div>
        </fieldset>
        <label className="flex flex-wrap items-center gap-2 text-sm">
          <span>有效期（天）</span>
          <input type="text" inputMode="numeric" placeholder="永久" value={expiryInput}
            disabled={Boolean(busy) || unavailable} aria-invalid={!validExpiry} aria-describedby="mcp-expiry-help"
            onChange={event => setExpiryInput(event.target.value)} className={`${control} w-28 bg-[var(--color-bg)]`} />
          <span id="mcp-expiry-help" className="text-xs text-[var(--color-text-secondary)]">{validExpiry ? "留空为永久" : "请输入正整数天数"}</span>
        </label>
        <button type="button" disabled={Boolean(busy) || unavailable || !selected.length || !validExpiry} onClick={() => void create()}
          className={`${control} inline-flex items-center gap-2 border-transparent bg-[var(--color-accent-primary)] text-[var(--color-text-inverse)]`}>
          {busy && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />}
          {busy || "连接"}
        </button>
      </div> : <div className="mt-5 space-y-3">
        <p role="status" className="flex items-center gap-2 text-sm font-medium">
          {verified ? <CheckCircle2 className="h-4 w-4 text-green-600" /> : <Loader2 className={`h-4 w-4 ${busy ? "animate-spin motion-reduce:animate-none" : ""}`} />}
          {busy || (verified ? "准备好了" : "还没连通，请重试")}
        </p>
        <p className="text-sm text-[var(--color-text-secondary)]">{installLink ? `点击下方按钮，在 ${MCP_CLIENT_NAMES[connection.client]} 中确认即可。` : `复制后粘贴给 ${MCP_CLIENT_NAMES[connection.client]}，让它完成接入。`}</p>
        <div className="flex flex-wrap gap-2">
          {installLink && verified && <a href={installLink} aria-disabled={Boolean(busy)} onClick={event => { if (busy) event.preventDefault(); }} className={`${control} inline-flex items-center bg-[var(--color-accent-primary)] text-[var(--color-text-inverse)]`}>一键添加到 {MCP_CLIENT_NAMES[connection.client]}</a>}
          {!installLink && <button type="button" disabled={Boolean(busy) || !verified} onClick={() => void copy()}
            className={`${control} inline-flex items-center gap-2 bg-[var(--color-accent-primary)] text-[var(--color-text-inverse)]`}><Copy className="h-4 w-4" />复制给 {MCP_CLIENT_NAMES[connection.client]}</button>}
          {!verified && <button type="button" disabled={Boolean(busy)} onClick={() => void run(signal => checkConnection(connection, signal))} className={control}>重试</button>}
          <button type="button" disabled={Boolean(busy)} onClick={() => void disconnect(connection.id)} className={control}>断开</button>
        </div>
        <p className="text-xs text-[var(--color-text-secondary)]">接入信息含访问授权，请勿公开分享。{connection.expiresAt ? `有效期至 ${new Date(connection.expiresAt).toLocaleDateString()}。` : "永久有效。"}</p>
      </div>}
      {error && <p role="alert" className="mt-3 text-sm text-[var(--color-accent-danger)]">{error}</p>}
      {saved.some(value => value.id !== connection?.id) && <div className="mt-5 border-t border-[var(--color-border)] pt-3">
        <p className="mb-1 text-xs text-[var(--color-text-secondary)]">你的助手</p>
        {saved.filter(value => value.id !== connection?.id).map(value => <div key={value.id} className="flex min-h-11 items-center justify-between gap-3">
          <span className="text-sm">{value.name.slice("MCP · ".length)}</span>
          <button type="button" disabled={Boolean(busy)} onClick={() => void disconnect(value.id)} aria-label={`断开 ${value.name.slice("MCP · ".length)}`} className={control}>断开</button>
        </div>)}
      </div>}
    </section>
  );
}
