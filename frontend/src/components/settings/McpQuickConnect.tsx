import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Copy, Eye, Loader2, PlugZap } from "lucide-react";
import type { EmbeddedMcpStatus } from "@/lib/api";
import { getOfflineQueueStorageKey } from "@/lib/offlineScope";
import { toast } from "@/lib/toast";
import {
  buildMcpInstallLink, buildMcpAgentInstructions, createMcpConnectionSession, defaultMcpNotebookSelection, groupMcpNotebookOptions,
  MCP_CLIENT_NAMES, MCP_CLIENT_GROUPS, McpConnectionError, isValidMcpExpiryDays,
  type McpClient, type McpConnection, type McpNotebookOption, type McpNotebookSpace, type SavedMcpConnection,
} from "@/lib/mcpConnections";

const control = "min-h-11 rounded-xl border border-[var(--color-border)] px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-accent-primary)] disabled:opacity-50";

/** 组件内部的失败原因，与连接库的错误码一样按多语言文案展示。 */
class McpQuickConnectError extends Error {
  constructor(readonly code: "contactAdmin" | "serviceNotReady") {
    super(code);
  }
}

export default function McpQuickConnect({ service, defaultUrl, onServiceChange, loadError, onRetry }: {
  service: EmbeddedMcpStatus | null; defaultUrl: string; onServiceChange: (status: EmbeddedMcpStatus) => void;
  loadError?: boolean; onRetry?: () => void;
}) {
  const { t } = useTranslation();
  const clientName = (id: McpClient) => t(`mcpConnect.clients.${id}`, { defaultValue: MCP_CLIENT_NAMES[id] });
  const scope = getOfflineQueueStorageKey();
  const session = useMemo(() => createMcpConnectionSession(), [scope, defaultUrl]);
  const [client, setClient] = useState<McpClient>("claude-code");
  const [books, setBooks] = useState<McpNotebookOption[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [expiryInput, setExpiryInput] = useState("");
  const expiryInputId = useId();
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
  const spaces = useMemo(() => groupMcpNotebookOptions(books || []), [books]);
  const selectedBooks = useMemo(() => (books || []).filter(book => selected.includes(book.id)), [books, selected]);
  // 只要所选笔记本都只能查看，就创建只读连接，不申请写入范围，也不提示可以编辑。
  const writable = selectedBooks.some(book => book.canWrite);
  const teamSelected = selectedBooks.some(book => Boolean(book.workspaceId));
  const ready = (status: EmbeddedMcpStatus) => status.enabled && (!writable || status.allowWrite);
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
        setBooks(result.notebooks);
        setSelected(defaultMcpNotebookSelection(result.notebooks));
        // 团队空间默认收起且不勾选，需要用户主动展开或勾选。
        setCollapsed(new Set(groupMcpNotebookOptions(result.notebooks).filter(space => space.kind === "workspace").map(space => space.key)));
        setSaved(existing);
      }
    } catch {
      if (!signal.aborted && session.current()) setError(t("mcpConnect.errors.loadNotebooks"));
    }
  }, [session, t]);
  useEffect(() => {
    if (!service?.available) return;
    const controller = new AbortController();
    void loadOptions(controller.signal);
    return () => controller.abort();
  }, [loadOptions, service?.available]);

  const checkConnection = async (value: McpConnection, signal: AbortSignal) => {
    if (active()) { setBusy(t("mcpConnect.connecting")); setVerified(false); }
    await session.probe(value, signal);
    if (active() && !signal.aborted) setVerified(true);
  };
  const run = async (action: (signal: AbortSignal) => Promise<void>) => {
    if (operation.current || !active()) return;
    const controller = new AbortController();
    operation.current = controller;
    setError(""); setBusy(t("mcpConnect.connecting"));
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try { await action(controller.signal); }
    catch (caught) {
      if (active()) {
        setError(controller.signal.aborted ? t("mcpConnect.errors.timeout")
          : caught instanceof McpConnectionError || caught instanceof McpQuickConnectError
            ? t(`mcpConnect.errors.${caught.code}`) : t("mcpConnect.errors.failed"));
      }
    } finally {
      clearTimeout(timeout);
      operation.current = null;
      if (active()) setBusy("");
    }
  };
  const create = () => run(async signal => {
    if (!service?.available || !books || !selectedBooks.length || !validExpiry) return;
    let status = service;
    if (!ready(status)) {
      if (!status.canManage) throw new McpQuickConnectError("contactAdmin");
      status = await session.enable({ enabled: true, allowWrite: status.allowWrite || writable, publicUrl: status.publicUrl || defaultUrl }, signal);
      if (!active()) return;
      onServiceChange(status);
      if (!ready(status)) throw new McpQuickConnectError("serviceNotReady");
    }
    const value = await session.create({ client, notebooks: selectedBooks.map(({ id, canWrite }) => ({ id, canWrite })), writable, url: status.publicUrl || defaultUrl,
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
      if (active()) toast.success(t("mcpConnect.copied", { client: clientName(connection.client) }));
    } catch { if (active()) toast.error(t("mcpConnect.copyFailed")); }
  };
  const disconnect = (id: string) => run(async signal => {
    setBusy(t("mcpConnect.disconnecting"));
    await session.revoke(id, signal);
    if (active()) {
      setSaved(values => values.filter(value => value.id !== id));
      if (connection?.id === id) { setConnection(null); setVerified(false); }
      toast.success(t("mcpConnect.disconnected"));
    }
  });
  const spaceName = (space: McpNotebookSpace) => space.kind === "workspace"
    ? space.workspaceName || space.key : t(`mcpConnect.spaces.${space.kind}`);
  const toggleGroup = (space: McpNotebookSpace, checked: boolean) => {
    const ids = new Set(space.notebooks.map(book => book.id));
    setSelected(values => checked ? Array.from(new Set([...values, ...ids])) : values.filter(id => !ids.has(id)));
  };
  const toggleCollapsed = (key: string) => setCollapsed(values => {
    const next = new Set(values);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  // 服务未提供或未开启（且无法自行开启）时整块不可用；服务已开启但未允许编辑时，
  // 仍可改选只读笔记本创建只读连接，只有需要编辑的选择才等待管理员。
  const serviceBlocked = !service?.available || (!service.enabled && !service.canManage);
  const unavailable = serviceBlocked || (!ready(service) && !service.canManage);
  const installLink = connection ? buildMcpInstallLink(connection) : null;
  const renderSpace = (space: McpNotebookSpace) => {
    const name = spaceName(space);
    const count = space.notebooks.filter(book => selected.includes(book.id)).length;
    const isCollapsed = collapsed.has(space.key);
    const readOnly = space.notebooks.every(book => !book.canWrite);
    return <div key={space.key} role="group" aria-label={name} className="py-1">
      <div className="flex items-center gap-1">
        <button type="button" aria-expanded={!isCollapsed} aria-label={t(isCollapsed ? "mcpConnect.expandGroup" : "mcpConnect.collapseGroup", { name })}
          onClick={() => toggleCollapsed(space.key)} className="flex h-11 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--color-text-secondary)] hover:bg-[var(--color-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-accent-primary)]">
          {isCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
        <label className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg px-2 text-sm font-medium hover:bg-[var(--color-hover)]">
          <input type="checkbox" checked={count === space.notebooks.length} aria-label={t("mcpConnect.selectGroup", { name })}
            ref={element => { if (element) element.indeterminate = count > 0 && count < space.notebooks.length; }}
            onChange={event => toggleGroup(space, event.target.checked)} />
          <span className="min-w-0 truncate" title={name}>{name}</span>
          <span className="shrink-0 text-xs font-normal text-[var(--color-text-secondary)]">{t("mcpConnect.selectedCount", { selected: count, total: space.notebooks.length })}</span>
          {readOnly && <span className="shrink-0 text-xs font-normal text-[var(--color-text-secondary)]">{t("mcpConnect.permission.read")}</span>}
        </label>
      </div>
      {!isCollapsed && space.notebooks.map(book => <label key={book.id} style={{ paddingLeft: `${2.75 + book.depth * 1.25}rem` }}
        className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg pr-2 text-sm hover:bg-[var(--color-hover)]">
        <input type="checkbox" checked={selected.includes(book.id)} onChange={event => setSelected(ids => event.target.checked ? [...ids, book.id] : ids.filter(id => id !== book.id))} />
        <span className="min-w-0 truncate" title={book.name}>{book.name}</span>
        <span className="ml-auto shrink-0 text-xs text-[var(--color-text-secondary)]">{t(book.canWrite ? "mcpConnect.permission.write" : "mcpConnect.permission.read")}</span>
      </label>)}
    </div>;
  };
  const personalSpaces = spaces.filter(space => space.kind !== "workspace");
  const teamSpaces = spaces.filter(space => space.kind === "workspace");
  return (
    <section aria-label={t("mcpConnect.sectionLabel")} className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-[var(--color-text-primary)] sm:p-5">
      <div className="flex items-start gap-3">
        <div className="rounded-xl bg-[var(--color-active)] p-2.5 text-[var(--color-accent-primary)]"><PlugZap className="h-5 w-5" /></div>
        <div><h3 className="text-base font-semibold">{t("mcpConnect.title")}</h3>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">{t("mcpConnect.description")}</p></div>
      </div>
      {!service ? <div role="status" className="mt-4 text-sm text-[var(--color-text-secondary)]">{loadError ? <>{t("mcpConnect.checkFailed")}<button type="button" onClick={onRetry} className={`${control} ml-2`}>{t("mcpConnect.recheck")}</button></> : t("mcpConnect.checking")}</div> :
        !service.available ? <p role="status" className="mt-4 text-sm text-[var(--color-text-secondary)]">{t("mcpConnect.upgradeRequired")}</p> :
          !ready(service) && !service.canManage ? <p role="status" className="mt-4 text-sm text-[var(--color-text-secondary)]">{t("mcpConnect.contactAdmin")}</p> : null}
      {!connection ? <div className="mt-5 space-y-5">
        <fieldset disabled={Boolean(busy) || serviceBlocked}>
          <legend className="mb-2 text-sm font-medium">{t("mcpConnect.chooseAssistant")}</legend>
          <select aria-label={t("mcpConnect.chooseAssistant")} value={client} onChange={event => setClient(event.target.value as McpClient)}
            className={`${control} w-full bg-[var(--color-bg)]`}>
            {MCP_CLIENT_GROUPS.map(group => <optgroup key={group.id} label={t(`mcpConnect.clientGroups.${group.id}`)}>
              {group.clients.map(id => <option key={id} value={id}>{clientName(id)}</option>)}
            </optgroup>)}
          </select>
        </fieldset>
        <fieldset disabled={Boolean(busy) || serviceBlocked}>
          <legend className="text-sm font-medium">{t("mcpConnect.notebooksLegend")}</legend>
          <p id="mcp-scope-help" className="mt-1 text-xs text-[var(--color-text-secondary)]">{t("mcpConnect.scopeHelp")}</p>
          <div aria-describedby="mcp-scope-help" className="mt-2 max-h-72 overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-2">
            {!books ? <p className="p-2 text-xs text-[var(--color-text-secondary)]">{t(service?.available ? "mcpConnect.loadingNotebooks" : "mcpConnect.waitingService")}</p> :
              !books.length ? <p className="p-2 text-xs text-[var(--color-text-secondary)]">{t("mcpConnect.noNotebooks")}</p> : <>
                {personalSpaces.map(renderSpace)}
                {teamSpaces.length > 0 && <p className="px-2 pt-2 text-xs font-medium text-[var(--color-text-secondary)]">{t("mcpConnect.spaces.teams")}</p>}
                {teamSpaces.map(renderSpace)}
              </>}
          </div>
          {teamSelected && <p role="note" className="mt-2 flex items-start gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-active)] p-2.5 text-xs">
            <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-accent-primary)]" />{t("mcpConnect.teamWarning")}
          </p>}
          {selectedBooks.length > 0 && !writable && <p role="note" className="mt-2 flex items-start gap-2 text-xs text-[var(--color-text-secondary)]">
            <Eye aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />{t("mcpConnect.readOnlyConnection")}
          </p>}
        </fieldset>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <label htmlFor={expiryInputId}>{t("mcpConnect.expiryLabel")}</label>
          <input id={expiryInputId} type="text" inputMode="numeric" placeholder={t("mcpConnect.expiryPlaceholder")} value={expiryInput}
            disabled={Boolean(busy) || serviceBlocked} aria-invalid={!validExpiry} aria-describedby="mcp-expiry-help"
            onChange={event => setExpiryInput(event.target.value)} className={`${control} w-28 bg-[var(--color-bg)]`} />
          <span id="mcp-expiry-help" className="text-xs text-[var(--color-text-secondary)]">{t(validExpiry ? "mcpConnect.expiryHelp" : "mcpConnect.expiryInvalid")}</span>
        </div>
        <button type="button" disabled={Boolean(busy) || unavailable || !selectedBooks.length || !validExpiry} onClick={() => void create()}
          className={`${control} inline-flex items-center gap-2 border-transparent bg-[var(--color-accent-primary)] text-[var(--color-text-inverse)]`}>
          {busy && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />}
          {busy || t("mcpConnect.connect")}
        </button>
      </div> : <div className="mt-5 space-y-3">
        <p role="status" className="flex flex-wrap items-center gap-2 text-sm font-medium">
          {verified ? <CheckCircle2 className="h-4 w-4 text-green-600" /> : <Loader2 className={`h-4 w-4 ${busy ? "animate-spin motion-reduce:animate-none" : ""}`} />}
          {busy || t(verified ? "mcpConnect.ready" : "mcpConnect.notReady")}
          {!connection.writable && <span className="rounded-full border border-[var(--color-border)] px-2 py-0.5 text-xs font-normal text-[var(--color-text-secondary)]">{t("mcpConnect.readOnlyBadge")}</span>}
        </p>
        <p className="text-sm text-[var(--color-text-secondary)]">{t(installLink ? "mcpConnect.installHint" : "mcpConnect.copyHint", { client: clientName(connection.client) })}</p>
        <div className="flex flex-wrap gap-2">
          {installLink && verified && <a href={installLink} aria-disabled={Boolean(busy)} onClick={event => { if (busy) event.preventDefault(); }} className={`${control} inline-flex items-center bg-[var(--color-accent-primary)] text-[var(--color-text-inverse)]`}>{t("mcpConnect.installButton", { client: clientName(connection.client) })}</a>}
          {!installLink && <button type="button" disabled={Boolean(busy) || !verified} onClick={() => void copy()}
            className={`${control} inline-flex items-center gap-2 bg-[var(--color-accent-primary)] text-[var(--color-text-inverse)]`}><Copy className="h-4 w-4" />{t("mcpConnect.copyButton", { client: clientName(connection.client) })}</button>}
          {!verified && <button type="button" disabled={Boolean(busy)} onClick={() => void run(signal => checkConnection(connection, signal))} className={control}>{t("mcpConnect.retry")}</button>}
          <button type="button" disabled={Boolean(busy)} onClick={() => void disconnect(connection.id)} className={control}>{t("mcpConnect.disconnect")}</button>
        </div>
        <p className="text-xs text-[var(--color-text-secondary)]">{t("mcpConnect.secretNotice")}{connection.expiresAt ? t("mcpConnect.expiresOn", { date: new Date(connection.expiresAt).toLocaleDateString() }) : t("mcpConnect.permanent")}</p>
      </div>}
      {error && <p role="alert" className="mt-3 text-sm text-[var(--color-accent-danger)]">{error}</p>}
      {saved.some(value => value.id !== connection?.id) && <div className="mt-5 border-t border-[var(--color-border)] pt-3">
        <p className="mb-1 text-xs text-[var(--color-text-secondary)]">{t("mcpConnect.yourAssistants")}</p>
        {saved.filter(value => value.id !== connection?.id).map(value => <div key={value.id} className="flex min-h-11 items-center justify-between gap-3">
          <span className="text-sm">{value.name.slice("MCP · ".length)}</span>
          <button type="button" disabled={Boolean(busy)} onClick={() => void disconnect(value.id)} aria-label={t("mcpConnect.disconnectNamed", { client: value.name.slice("MCP · ".length) })} className={control}>{t("mcpConnect.disconnect")}</button>
        </div>)}
      </div>}
    </section>
  );
}
