import { useEffect, useRef, useState } from "react";
import { ClipboardCopy, Loader2, PlugZap } from "lucide-react";
import { useTranslation } from "react-i18next";
import { getBaseUrl } from "@/lib/api";
import { getOfflineQueueStorageKey } from "@/lib/offlineScope";
import { migrationApi, type MigrationCapabilities } from "@/lib/migrations";
import { buildMigrationClientConfig, MIGRATION_CLIENTS, validateMigrationClientSetup, type MigrationClientId } from "@/lib/migrationClientSetup";

const control = "min-h-10 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text-primary)]";
const button = "inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-[var(--color-border)] px-3 py-2 text-xs disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent-primary)]";

export default function MigrationConnectionSetup({ client = "codex", notebooks = [] }: {
  client?: MigrationClientId; notebooks?: { id: string; name: string }[];
}) {
  const { t } = useTranslation();
  const [transport, setTransport] = useState<"stdio" | "http">("stdio");
  const [endpoint, setEndpoint] = useState("");
  const [launcherPath, setLauncherPath] = useState("");
  const [notebookId, setNotebookId] = useState("");
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState("idle");
  const [capabilities, setCapabilities] = useState<MigrationCapabilities | null>(null);
  const pending = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const initialScope = useRef(getOfflineQueueStorageKey());
  const current = () => mounted.current && initialScope.current === getOfflineQueueStorageKey();
  let apiUrl = getBaseUrl();
  try { apiUrl = new URL(apiUrl, window.location.href).href.replace(/\/api\/?$/, ""); } catch { /* validation reports an unusable address */ }
  const options = { client, transport, apiUrl, endpoint, launcherPath, notebookId };
  const issues = validateMigrationClientSetup(options);
  const invalid = issues.some((issue) => issue.severity === "error");
  const config = invalid ? null : buildMigrationClientConfig(options);
  const profile = MIGRATION_CLIENTS.find((entry) => entry.id === client)!;

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; pending.current?.abort(); }; }, []);
  useEffect(() => { setCopied(false); setCopyFailed(false); }, [client, transport, endpoint, launcherPath, notebookId]);

  const diagnose = async () => {
    if (!current() || pending.current) return;
    const controller = new AbortController(); pending.current = controller;
    const timer = setTimeout(() => controller.abort(), 8000);
    setChecking(true); setCapabilities(null); setStatus("checking");
    try {
      const value = await migrationApi.capabilities(controller.signal);
      if (!current()) return;
      if (controller.signal.aborted) { setStatus("timeout"); return; }
      setCapabilities(value);
      setStatus(value.schemaVersion === 1 && value.formats.includes("nmf-v1") && value.humanApprovalRequired ? "ready" : "unsupported");
    } catch (error) {
      if (current()) setStatus(controller.signal.aborted ? "timeout" : (error as { status?: number }).status === 401 ? "unauthorized"
        : (error as { status?: number }).status === 403 ? "forbidden" : "failed");
    } finally {
      clearTimeout(timer); pending.current = null;
      if (current()) setChecking(false);
    }
  };
  const copy = async () => {
    if (!config || !current()) return;
    setCopyFailed(false);
    try { await navigator.clipboard.writeText(config.content); if (current()) setCopied(true); }
    catch { if (current()) setCopyFailed(true); }
  };

  return <section className="min-w-0 space-y-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3" aria-label={t("migration.setup.title")}>
    <div className="flex items-center gap-2 text-sm font-semibold"><PlugZap size={16}/>{t("migration.setup.title", { client: profile.label })}</div>
    <p className="text-xs leading-5 text-[var(--color-text-secondary)]">{t("migration.setup.hostBoundary")}</p>
    <label className="block text-xs">{t("migration.setup.transport")}<select className={`${control} mt-1`} value={transport} onChange={(event) => setTransport(event.target.value as "stdio" | "http")}>
      <option value="stdio">{t("migration.setup.stdio")}</option><option value="http">{t("migration.setup.http")}</option>
    </select></label>
    {transport === "stdio" ? <>
      <label className="block text-xs">{t("migration.setup.launcher")}<input className={`${control} mt-1`} value={launcherPath} maxLength={4096} onChange={(event) => setLauncherPath(event.target.value)} placeholder="/absolute/path/to/nowen-mcp/bin/nowen-mcp.mjs" autoComplete="off" spellCheck={false}/></label>
      <label className="block text-xs">{t("migration.setup.target")}<select className={`${control} mt-1`} value={notebookId} onChange={(event) => setNotebookId(event.target.value)}><option value="">{t("migration.setup.selectTarget")}</option>{notebooks.map((notebook) => <option key={notebook.id} value={notebook.id}>{notebook.name}</option>)}</select></label>
    </> : <label className="block text-xs">{t("migration.setup.endpoint")}<input className={`${control} mt-1`} type="url" value={endpoint} maxLength={2048} onChange={(event) => setEndpoint(event.target.value)} placeholder="https://mcp.example.com/mcp" autoComplete="off" spellCheck={false}/></label>}
    {issues.length > 0 && <ul className="list-disc space-y-1 pl-4 text-xs leading-5 text-[var(--color-text-secondary)]">{issues.map((issue) => <li key={issue.code} data-severity={issue.severity}>{t(`migration.setup.issues.${issue.code}`)}</li>)}</ul>}
    {config && <div className="min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
      <p className="mb-2 text-xs">{t(config.template ? "migration.setup.template" : "migration.setup.documented")} · {config.format.toUpperCase()}</p>
      <pre className="max-h-64 max-w-full overflow-auto whitespace-pre text-[11px] leading-5" tabIndex={0}>{config.content}</pre>
    </div>}
    <div className="flex flex-wrap gap-2"><button className={button} type="button" disabled={!config} onClick={() => void copy()}><ClipboardCopy size={14}/>{t(copied ? "migration.setup.copied" : "migration.setup.copy")}</button>
      <button className={button} type="button" disabled={checking} onClick={() => void diagnose()}>{checking && <Loader2 size={14} className="animate-spin motion-reduce:animate-none"/>}{t("migration.setup.diagnose")}</button>
      {profile.documentationUrl && <a className="inline-flex min-h-10 items-center text-xs text-[var(--color-accent-primary)] underline" href={profile.documentationUrl} target="_blank" rel="noreferrer">{t("migration.setup.documentation")}</a>}
    </div>
    {copyFailed && <p role="alert" className="text-xs">{t("migration.copyFailed")}</p>}
    {status !== "idle" && <p role="status" className="text-xs leading-5">{t(`migration.setup.status.${status}`)}</p>}
    <p className="text-xs leading-5 text-[var(--color-text-secondary)]">{t("migration.setup.diagnosticBoundary")}</p>
    {capabilities?.adapters && <details><summary className="cursor-pointer text-xs font-medium">{t("migration.setup.sources")}</summary><ul className="mt-2 space-y-2 text-xs">{capabilities.adapters.map((adapter) => <li key={adapter.id} className="break-words rounded-lg border border-[var(--color-border)] p-2"><p className="font-medium">{adapter.platforms.join(" / ")}</p><p>{adapter.formats.join(" · ")}</p>{adapter.unsupported.length > 0 && <p className="mt-1 text-[var(--color-text-secondary)]">{adapter.unsupported.join("; ")}</p>}</li>)}</ul></details>}
  </section>;
}
