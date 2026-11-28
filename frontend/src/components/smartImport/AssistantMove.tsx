import { useEffect, useState } from "react";
import { Bot, Check, ClipboardCopy } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import McpConnectionPanel from "@/components/settings/McpConnectionPanel";
import { api } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { formatAppDateTime } from "@/lib/dateTime";
import { MIGRATION_CLIENTS, type MigrationClientId } from "@/lib/migrationClientSetup";
import type { MigrationJob } from "@/lib/migrations";
import { assistantConnection } from "@/lib/smartImport";
import type { Notebook } from "@/types";

const field = "min-h-10 w-full rounded-lg border border-app-border bg-app-bg px-3 py-2 text-sm text-tx-primary";

/**
 * The optional "let an AI assistant move it" path. Nowen cannot see or start the assistant: it only shows what the
 * server actually knows (an import token that has been used, jobs an assistant prepared) and the steps to take.
 */
export default function AssistantMove({ jobs, notebooks, disabled, onOpenJob, onBack }: {
  jobs: MigrationJob[]; notebooks: Notebook[]; disabled: boolean;
  onOpenJob: (job: MigrationJob) => void; onBack: () => void;
}) {
  const { t } = useTranslation();
  const [client, setClient] = useState<MigrationClientId>("codex");
  const [copied, setCopied] = useState<"done" | "failed" | null>(null);
  const [connection, setConnection] = useState<{ lastUsedAt: string } | null>(null);
  useEffect(() => {
    let active = true;
    void api.tokens.list().then((result) => { if (active) setConnection(assistantConnection(result.tokens)); }).catch(() => { if (active) setConnection(null); });
    return () => { active = false; };
  }, []);
  const assistantJobs = jobs.filter((job) => job.preparedBy === "assistant");
  const ready = assistantJobs.find((job) => job.status === "PREVIEW_READY");
  // A job still being prepared only counts while the assistant is recently active with it.
  const preparing = assistantJobs.some((job) => ["CREATED", "UPLOADING", "SCANNING", "NORMALIZING"].includes(job.status) && Date.now() - Date.parse(job.updatedAt) < 60 * 60 * 1000);
  const copy = () => { void copyText(t("migration.prompt")).then((ok) => setCopied(ok ? "done" : "failed")); };

  return <section className="space-y-4 rounded-2xl border border-app-border bg-app-surface p-5" aria-label={t("migration.smart.assistant.region")}>
    {ready ? <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-app-hover p-3" role="status">
      <span className="text-sm font-medium text-tx-primary">{t("migration.smart.assistant.ready", { count: ready.counts.total })}</span>
      <Button type="button" size="sm" disabled={disabled} onClick={() => onOpenJob(ready)}>{t("migration.smart.assistant.review")}</Button>
    </div> : preparing && <p role="status" className="text-sm text-tx-secondary">{t("migration.smart.assistant.preparing")}</p>}
    <div className="flex items-start gap-3">
      <Bot size={20} className="mt-0.5 shrink-0 text-tx-secondary" aria-hidden="true" />
      <div className="min-w-0 space-y-1">
        <h5 className="text-sm font-semibold text-tx-primary">{t(connection ? "migration.smart.assistant.connected" : "migration.smart.assistant.title")}</h5>
        {connection && <p className="text-xs text-tx-secondary">{t("migration.smart.assistant.lastUsed", { time: formatAppDateTime(connection.lastUsedAt) })}</p>}
        <p className="text-sm leading-6 text-tx-secondary">{t("migration.smart.assistant.intro")}</p>
      </div>
    </div>
    <div className="flex flex-wrap items-center gap-3">
      <Button type="button" disabled={disabled} onClick={copy}>
        {copied === "done" ? <Check size={15} className="mr-1.5" aria-hidden="true" /> : <ClipboardCopy size={15} className="mr-1.5" aria-hidden="true" />}
        {t("migration.smart.assistant.copy")}
      </Button>
      {copied && <span role="status" className="text-xs text-tx-secondary">{t(copied === "done" ? "migration.smart.assistant.copied" : "migration.copyFailed")}</span>}
    </div>
    <p className="text-xs leading-5 text-tx-secondary">{t("migration.smart.assistant.privacy")}</p>
    <p className="text-xs leading-5 text-tx-secondary">{t("migration.smart.assistant.fallback")}</p>
    <details className="rounded-xl border border-app-border p-3">
      <summary className="cursor-pointer text-sm text-tx-primary">{t("migration.smart.assistant.connect")}</summary>
      <div className="mt-3 space-y-3">
        <label className="block text-xs font-medium text-tx-primary">{t("migration.client")}
          <select className={`${field} mt-1`} value={client} onChange={(event) => setClient(event.target.value as MigrationClientId)}>
            {MIGRATION_CLIENTS.map((entry) => <option key={entry.id} value={entry.id}>{entry.id === "other" ? t("migration.clientOther") : entry.label}</option>)}
          </select>
        </label>
        <p className="text-xs leading-5 text-tx-secondary">{t("migration.clientBoundary")}</p>
        <p className="text-xs leading-5 text-tx-secondary">{t("migration.connectionScopes")}</p>
        <McpConnectionPanel purpose="migration" client={client} notebooks={notebooks} />
      </div>
    </details>
    <Button type="button" variant="link" size="sm" className="h-auto min-h-8 whitespace-normal py-1 text-left px-0" onClick={onBack}>{t("migration.smart.assistant.back")}</Button>
  </section>;
}
