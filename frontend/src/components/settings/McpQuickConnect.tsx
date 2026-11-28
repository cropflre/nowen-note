import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { motion } from "framer-motion";
import { formatAppDate } from "@/lib/dateTime";
import { AlertTriangle, Check, CheckCircle2, ChevronDown, ChevronRight, Copy, Eye, Loader2, PlugZap, Sparkles } from "lucide-react";
import type { EmbeddedMcpStatus } from "@/lib/api";
import { getOfflineQueueStorageKey } from "@/lib/offlineScope";
import { toast } from "@/lib/toast";
import {
  buildMcpInstallLink, buildMcpAgentInstructions, createMcpConnectionSession, defaultMcpNotebookSelection, groupMcpNotebookOptions,
  MCP_CLIENT_NAMES, MCP_CLIENT_GROUPS, McpConnectionError, isValidMcpExpiryDays,
  type McpClient, type McpConnection, type McpNotebookOption, type McpNotebookSpace, type SavedMcpConnection,
} from "@/lib/mcpConnections";

const control = "min-h-10 rounded-xl border border-app-border/80 px-3.5 py-2 text-sm transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary disabled:opacity-50";

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
  const [copiedFlash, setCopiedFlash] = useState(false);
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
    const value = await session.create({
      client, notebooks: selectedBooks.map(({ id, canWrite }) => ({ id, canWrite })), writable, url: status.publicUrl || defaultUrl,
      ...(expiresInDays === undefined ? {} : { expiresInDays }),
    }, signal);
    if (!active() || signal.aborted) return;
    setConnection(value);
    setSaved(values => [...values, { id: value.id, name: `MCP · ${MCP_CLIENT_NAMES[value.client]}`, expiresAt: value.expiresAt, revokedAt: null }]);
    await checkConnection(value, signal);
  });
  const copy = async () => {
    if (!connection || !verified || !active()) return;
    try {
      await navigator.clipboard.writeText(buildMcpAgentInstructions(connection));
      if (active()) {
        setCopiedFlash(true);
        window.setTimeout(() => { if (mounted.current) setCopiedFlash(false); }, 1600);
        toast.success(t("mcpConnect.copied", { client: clientName(connection.client) }));
      }
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
    return (
      <div key={space.key} role="group" aria-label={name} className="py-1">
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-expanded={!isCollapsed}
            aria-label={t(isCollapsed ? "mcpConnect.expandGroup" : "mcpConnect.collapseGroup", { name })}
            onClick={() => toggleCollapsed(space.key)}
            className="flex h-10 w-8 shrink-0 items-center justify-center rounded-xl text-tx-secondary transition-colors hover:bg-app-hover hover:text-tx-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
          >
            {isCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>
          <label className="flex min-h-10 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-xl px-2.5 text-sm font-semibold transition-colors hover:bg-app-hover/75">
            <input
              type="checkbox"
              className="accent-cyan-600"
              checked={count === space.notebooks.length}
              aria-label={t("mcpConnect.selectGroup", { name })}
              ref={element => { if (element) element.indeterminate = count > 0 && count < space.notebooks.length; }}
              onChange={event => toggleGroup(space, event.target.checked)}
            />
            <span className="min-w-0 truncate" title={name}>{name}</span>
            <span className="shrink-0 rounded-full bg-cyan-500/10 px-2 py-0.5 text-[11px] font-medium tabular-nums text-cyan-700 dark:text-cyan-300">
              {t("mcpConnect.selectedCount", { selected: count, total: space.notebooks.length })}
            </span>
            {readOnly && (
              <span className="shrink-0 rounded-full bg-app-hover px-2 py-0.5 text-[11px] font-normal text-tx-secondary">
                {t("mcpConnect.permission.read")}
              </span>
            )}
          </label>
        </div>
        {!isCollapsed && space.notebooks.map(book => (
          <label
            key={book.id}
            style={{ paddingLeft: `${2.75 + book.depth * 1.25}rem` }}
            className="flex min-h-10 cursor-pointer items-center gap-2 rounded-xl pr-2.5 text-sm transition-colors hover:bg-app-hover/65"
          >
            <input
              type="checkbox"
              className="accent-cyan-600"
              checked={selected.includes(book.id)}
              onChange={event => setSelected(ids => event.target.checked ? [...ids, book.id] : ids.filter(id => id !== book.id))}
            />
            <span className="min-w-0 truncate text-tx-primary" title={book.name}>{book.name}</span>
            <span className={`ml-auto shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${
              book.canWrite
                ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300"
                : "bg-app-hover text-tx-tertiary"
            }`}>
              {t(book.canWrite ? "mcpConnect.permission.write" : "mcpConnect.permission.read")}
            </span>
          </label>
        ))}
      </div>
    );
  };

  const personalSpaces = spaces.filter(space => space.kind !== "workspace");
  const teamSpaces = spaces.filter(space => space.kind === "workspace");

  return (
    <section
      aria-label={t("mcpConnect.sectionLabel")}
      className="relative max-w-2xl overflow-hidden rounded-2xl border border-cyan-500/20 bg-gradient-to-br from-cyan-500/[0.05] via-app-elevated/92 to-teal-500/[0.05] p-5 text-tx-primary shadow-xs backdrop-blur-md"
    >
      <div aria-hidden="true" className="pointer-events-none absolute -right-10 -top-10 h-32 w-32 rounded-full bg-cyan-400/12 blur-2xl" />

      <div className="relative flex items-start gap-3.5">
        <motion.div
          whileHover={{ rotate: [0, -10, 10, 0], scale: 1.08 }}
          transition={{ duration: 0.4 }}
          className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-cyan-500 via-teal-500 to-emerald-500 text-white shadow-md shadow-cyan-500/20"
        >
          <PlugZap className="h-5 w-5" />
          <span className="absolute -right-0.5 -top-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-amber-300 text-amber-800 shadow-xs">
            <Sparkles size={8} />
          </span>
        </motion.div>
        <div>
          <h3 className="text-base font-bold tracking-tight text-tx-primary">{t("mcpConnect.title")}</h3>
          <p className="mt-0.5 text-xs leading-5 text-tx-secondary">{t("mcpConnect.description")}</p>
        </div>
      </div>

      {!service ? (
        <div role="status" className="mt-4 flex items-center gap-2 rounded-xl border border-app-border/75 bg-app-surface/85 px-3.5 py-3 text-xs text-tx-secondary">
          {loadError ? (
            <>
              <span>{t("mcpConnect.checkFailed")}</span>
              <button type="button" onClick={onRetry} className={`${control} ml-auto bg-app-elevated hover:bg-app-hover`}>
                {t("mcpConnect.recheck")}
              </button>
            </>
          ) : (
            <>
              <Loader2 className="h-4 w-4 animate-spin text-cyan-500" />
              <span>{t("mcpConnect.checking")}</span>
            </>
          )}
        </div>
      ) : !service.available ? (
        <p role="status" className="mt-4 rounded-xl border border-amber-400/35 bg-amber-500/[0.08] px-3.5 py-3 text-xs text-amber-800 dark:text-amber-200">
          {t("mcpConnect.upgradeRequired")}
        </p>
      ) : !ready(service) && !service.canManage ? (
        <p role="status" className="mt-4 rounded-xl border border-amber-400/35 bg-amber-500/[0.08] px-3.5 py-3 text-xs text-amber-800 dark:text-amber-200">
          {t("mcpConnect.contactAdmin")}
        </p>
      ) : null}

      {!connection ? (
        <div className="relative mt-5 space-y-4">
          <fieldset disabled={Boolean(busy) || serviceBlocked} className="rounded-xl border border-app-border/75 bg-app-surface/90 p-3.5">
            <legend className="mb-2 text-xs font-semibold text-tx-primary">{t("mcpConnect.chooseAssistant")}</legend>
            <select
              aria-label={t("mcpConnect.chooseAssistant")}
              value={client}
              onChange={event => setClient(event.target.value as McpClient)}
              className={`${control} w-full cursor-pointer bg-app-bg hover:border-cyan-400/50`}
            >
              {MCP_CLIENT_GROUPS.map(group => (
                <optgroup key={group.id} label={t(`mcpConnect.clientGroups.${group.id}`)}>
                  {group.clients.map(id => <option key={id} value={id}>{clientName(id)}</option>)}
                </optgroup>
              ))}
            </select>
          </fieldset>

          <fieldset disabled={Boolean(busy) || serviceBlocked} className="rounded-xl border border-app-border/75 bg-app-surface/90 p-3.5">
            <legend className="text-xs font-semibold text-tx-primary">{t("mcpConnect.notebooksLegend")}</legend>
            <p id="mcp-scope-help" className="mt-1 text-xs text-tx-secondary">{t("mcpConnect.scopeHelp")}</p>
            <div aria-describedby="mcp-scope-help" className="mt-2.5 max-h-72 overflow-y-auto rounded-xl border border-app-border/75 bg-app-bg/85 p-2">
              {!books ? (
                <p className="p-2 text-xs text-tx-secondary">{t(service?.available ? "mcpConnect.loadingNotebooks" : "mcpConnect.waitingService")}</p>
              ) : !books.length ? (
                <p className="p-2 text-xs text-tx-secondary">{t("mcpConnect.noNotebooks")}</p>
              ) : (
                <>
                  {personalSpaces.map(renderSpace)}
                  {teamSpaces.length > 0 && <p className="px-2 pt-2 text-xs font-semibold text-tx-secondary">{t("mcpConnect.spaces.teams")}</p>}
                  {teamSpaces.map(renderSpace)}
                </>
              )}
            </div>
            {teamSelected && (
              <p role="note" className="mt-2.5 flex items-start gap-2 rounded-xl border border-amber-400/35 bg-amber-500/[0.08] p-2.5 text-xs text-amber-800 dark:text-amber-200">
                <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                {t("mcpConnect.teamWarning")}
              </p>
            )}
            {selectedBooks.length > 0 && !writable && (
              <p role="note" className="mt-2 flex items-start gap-2 text-xs text-tx-secondary">
                <Eye aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-cyan-500" />
                {t("mcpConnect.readOnlyConnection")}
              </p>
            )}
          </fieldset>

          <div className="flex flex-wrap items-center gap-2.5 rounded-xl border border-app-border/75 bg-app-surface/90 p-3.5 text-xs">
            <label htmlFor={expiryInputId} className="font-semibold text-tx-primary">{t("mcpConnect.expiryLabel")}</label>
            <input
              id={expiryInputId}
              type="text"
              inputMode="numeric"
              placeholder={t("mcpConnect.expiryPlaceholder")}
              value={expiryInput}
              disabled={Boolean(busy) || serviceBlocked}
              aria-invalid={!validExpiry}
              aria-describedby="mcp-expiry-help"
              onChange={event => setExpiryInput(event.target.value)}
              className={`${control} w-28 bg-app-bg`}
            />
            <span id="mcp-expiry-help" className={validExpiry ? "text-xs text-tx-secondary" : "text-xs font-medium text-rose-500"}>
              {t(validExpiry ? "mcpConnect.expiryHelp" : "mcpConnect.expiryInvalid")}
            </span>
          </div>

          <button
            type="button"
            disabled={Boolean(busy) || unavailable || !selectedBooks.length || !validExpiry}
            onClick={() => void create()}
            className={`${control} inline-flex items-center gap-2 border-transparent bg-gradient-to-r from-cyan-500 via-teal-500 to-emerald-500 font-semibold text-white shadow-sm shadow-cyan-500/20 hover:brightness-105 active:scale-95`}
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />}
            {busy || t("mcpConnect.connect")}
          </button>
        </div>
      ) : (
        <div className="relative mt-5 space-y-3 rounded-2xl border border-emerald-500/25 bg-emerald-500/[0.06] p-4">
          <p role="status" className="flex flex-wrap items-center gap-2 text-sm font-semibold text-tx-primary">
            {verified ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <Loader2 className={`h-4 w-4 text-cyan-500 ${busy ? "animate-spin motion-reduce:animate-none" : ""}`} />}
            {busy || t(verified ? "mcpConnect.ready" : "mcpConnect.notReady")}
            {!connection.writable && (
              <span className="rounded-full border border-app-border bg-app-surface px-2.5 py-0.5 text-xs font-normal text-tx-secondary">
                {t("mcpConnect.readOnlyBadge")}
              </span>
            )}
          </p>
          <p className="text-xs leading-5 text-tx-secondary">
            {t(installLink ? "mcpConnect.installHint" : "mcpConnect.copyHint", { client: clientName(connection.client) })}
          </p>
          <div className="flex flex-wrap gap-2">
            {installLink && verified && (
              <a
                href={installLink}
                aria-disabled={Boolean(busy)}
                onClick={event => { if (busy) event.preventDefault(); }}
                className={`${control} inline-flex items-center border-transparent bg-gradient-to-r from-cyan-500 to-emerald-500 font-semibold text-white shadow-sm hover:brightness-105`}
              >
                {t("mcpConnect.installButton", { client: clientName(connection.client) })}
              </a>
            )}
            {!installLink && (
              <button
                type="button"
                disabled={Boolean(busy) || !verified}
                onClick={() => void copy()}
                className={`${control} inline-flex items-center gap-2 border-transparent font-semibold text-white shadow-sm active:scale-95 ${
                  copiedFlash
                    ? "bg-emerald-500"
                    : "bg-gradient-to-r from-cyan-500 to-teal-500 hover:brightness-105"
                }`}
              >
                {copiedFlash ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                {t("mcpConnect.copyButton", { client: clientName(connection.client) })}
              </button>
            )}
            {!verified && (
              <button type="button" disabled={Boolean(busy)} onClick={() => void run(signal => checkConnection(connection, signal))} className={`${control} bg-app-surface hover:bg-app-hover`}>
                {t("mcpConnect.retry")}
              </button>
            )}
            <button type="button" disabled={Boolean(busy)} onClick={() => void disconnect(connection.id)} className={`${control} border-rose-500/30 bg-rose-500/10 text-rose-600 hover:bg-rose-500/18 dark:text-rose-300`}>
              {t("mcpConnect.disconnect")}
            </button>
          </div>
          <p className="text-xs text-tx-secondary">
            {t("mcpConnect.secretNotice")}
            {connection.expiresAt ? t("mcpConnect.expiresOn", { date: formatAppDate(connection.expiresAt) }) : t("mcpConnect.permanent")}
          </p>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-3 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs font-medium text-rose-600 dark:text-rose-300">
          {error}
        </p>
      )}

      {saved.some(value => value.id !== connection?.id) && (
        <div className="relative mt-5 border-t border-app-border/70 pt-4">
          <p className="mb-2 text-xs font-semibold text-tx-secondary">{t("mcpConnect.yourAssistants")}</p>
          <div className="space-y-2">
            {saved.filter(value => value.id !== connection?.id).map(value => (
              <div key={value.id} className="flex min-h-11 items-center justify-between gap-3 rounded-xl border border-app-border/75 bg-app-surface/90 px-3.5 py-2">
                <span className="text-sm font-medium text-tx-primary">{value.name.slice("MCP · ".length)}</span>
                <button
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() => void disconnect(value.id)}
                  aria-label={t("mcpConnect.disconnectNamed", { client: value.name.slice("MCP · ".length) })}
                  className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-1.5 text-xs font-semibold text-rose-600 transition-colors hover:bg-rose-500/18 active:scale-95 disabled:opacity-50 dark:text-rose-300"
                >
                  {t("mcpConnect.disconnect")}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
