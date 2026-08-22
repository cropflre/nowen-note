/**
 * 同步设置 Tab 容器（Phase 7 接线）。
 *
 * 把「同步设置」与「冲突中心」组合成设置页的一个入口。
 * 单独拆一个容器而不是直接塞进 SettingsModal，原因：
 * - deviceId 需要在两个子组件间共享（冲突解决要标记是哪台设备的选择）；
 * - Sync V2 关闭时整个区域都不该渲染，判定逻辑集中在这里更清楚；
 * - SettingsModal 已经很长，不该继续堆同步相关状态。
 */

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Download, FolderInput, Loader2 } from "lucide-react";

import { ConflictCenter } from "@/components/settings/ConflictCenter";
import { SyncSettingsPanel } from "@/components/settings/SyncSettingsPanel";
import {
  SyncV2DisabledError,
  fetchSyncDiagnostics,
  copySyncScopeToPersonal,
  exportSyncScope,
  fetchSyncScopes,
  type SyncScopeStatus,
} from "@/lib/syncLocalApi";
import {
  getAppInfo,
  getLiteMigrationProgress,
  startLiteMigration,
  type LiteMigrationProgress,
} from "@/lib/desktopBridge";
import { getServerUrl } from "@/lib/api";
import { getAccessToken } from "@/lib/authSession";

export default function SyncSettingsTab() {
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [disabled, setDisabled] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [legacyLite, setLegacyLite] = useState(false);
  const [migration, setMigration] = useState<LiteMigrationProgress | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const appInfo = await getAppInfo();
        const completedThisSession = sessionStorage.getItem("nowen-lite-migration-complete-this-session") === "1";
        if (appInfo?.mode === "lite" && (appInfo.runtime !== "local" || completedThisSession)) {
          const result = await getLiteMigrationProgress();
          if (!cancelled) {
            setLegacyLite(true);
            setMigration(result.progress || { stage:"pending" });
          }
          return;
        }
        const diag = await fetchSyncDiagnostics();
        if (!cancelled) setDeviceId(diag.deviceId ?? null);
      } catch (error) {
        // Flag 关闭是默认状态，不是错误：安静地不渲染同步 UI。
        if (!cancelled && error instanceof SyncV2DisabledError) setDisabled(true);
      }
    })();
    return () => { cancelled = true; };
  }, [reloadKey]);

  if (legacyLite) {
    return <LiteMigrationWizard progress={migration} onProgress={setMigration} />;
  }

  if (disabled) {
    return (
      <div className="text-sm text-muted-foreground">
        当前版本未启用多设备同步。笔记全部保存在此设备。
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <SyncSettingsPanel />
      <WorkspaceScopePanel />
      {/* 冲突解决后刷新 deviceId 与诊断，避免显示已处理的冲突数 */}
      <ConflictCenter
        deviceId={deviceId}
        onResolved={() => setReloadKey((n) => n + 1)}
      />
    </div>
  );
}

const MIGRATION_LABEL: Record<LiteMigrationProgress["stage"], string> = {
  pending:"等待开始",auth_required:"需要重新登录",preparing:"准备本地数据库",
  downloading:"下载远端数据",applying:"写入本地数据库",attachments:"下载附件",
  verifying:"核对数据完整性",switching:"切换到本地运行时",complete:"迁移完成",failed:"迁移失败",
};

function LiteMigrationWizard({progress,onProgress}:{
  progress: LiteMigrationProgress | null;
  onProgress: (value:LiteMigrationProgress) => void;
}) {
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState<string|null>(null);
  const stage = progress?.stage || "pending";
  const running = busy || ["preparing","downloading","applying","attachments","verifying","switching"].includes(stage);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(async () => {
      const result = await getLiteMigrationProgress();
      if (result.progress) onProgress(result.progress);
    },1500);
    return () => window.clearInterval(timer);
  },[running,onProgress]);

  const start = async () => {
    const token = getAccessToken();
    if (!token) { setError("请先重新登录远端服务器，再开始迁移。"); return; }
    setBusy(true);setError(null);
    try {
      const result = await startLiteMigration(getServerUrl(),token);
      if (result.progress) onProgress(result.progress);
      if (result.progress?.stage === "complete") {
        sessionStorage.setItem("nowen-lite-migration-complete-this-session","1");
      }
      if (!result.ok) setError(result.progress?.error || result.error || "迁移未能完成");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setBusy(false); }
  };

  return <section className="space-y-4 rounded-lg border p-4">
    <div>
      <h3 className="font-medium">将数据安全保存到本机</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        检测到旧版轻量模式。迁移会复制远端笔记与附件并核对完整性，完成前仍保持原有远端访问方式，且不会删除远端数据。
      </p>
    </div>
    <div className="rounded-md bg-muted/50 p-3 text-sm">
      <div className="flex items-center gap-2">
        {stage === "complete" ? <CheckCircle2 className="h-4 w-4 text-emerald-600" />
          : running ? <Loader2 className="h-4 w-4 animate-spin" />
            : <AlertTriangle className="h-4 w-4 text-amber-600" />}
        <span>{MIGRATION_LABEL[stage]}</span>
      </div>
      {progress ? <p className="mt-2 text-xs text-muted-foreground">
        已下载 {progress.downloaded || 0} 项 · 已写入 {progress.applied || 0} 项
        {stage === "attachments" ? ` · 附件完成 ${progress.attachmentsDone || 0}，剩余 ${progress.attachmentsPending || 0}` : ""}
      </p> : null}
    </div>
    {(error || progress?.error) ? <p className="text-sm text-destructive">{error || progress?.error}</p> : null}
    {stage === "complete" ? <p className="text-sm text-emerald-700">数据已完整落地。退出并重新打开应用后，将使用本地优先模式。</p>
      : <button type="button" disabled={running} onClick={() => { void start(); }}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50">
          {running ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {stage === "failed" || stage === "auth_required" ? "重新尝试" : "开始迁移"}
        </button>}
  </section>;
}

function WorkspaceScopePanel() {
  const [items, setItems] = useState<SyncScopeStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setItems((await fetchSyncScopes()).items.filter((item) => item.workspaceId));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const download = async (scope: SyncScopeStatus) => {
    setBusy(scope.scopeKey);
    setError(null);
    try {
      const payload = await exportSyncScope(scope.scopeKey);
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `nowen-${scope.workspaceName || scope.workspaceId}-recovery.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  const copy = async (scope: SyncScopeStatus) => {
    setBusy(scope.scopeKey);
    setError(null);
    try {
      await copySyncScopeToPersonal(scope.scopeKey);
      await reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <Loader2 className="h-3.5 w-3.5 animate-spin" />正在读取工作区同步状态…
    </div>;
  }
  if (items.length === 0) return null;

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-medium">工作区同步</h3>
      <div className="space-y-2">
        {items.map((scope) => (
          <div key={scope.scopeKey} className="rounded-md border p-3 text-xs">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-medium">{scope.workspaceName || scope.workspaceId}</p>
                <p className="mt-1 text-muted-foreground">
                  {scope.role || "成员"} · 待同步 {scope.pendingMutations} · 冲突 {scope.conflictCount}
                </p>
              </div>
              <span className={scope.accessStatus === "access_revoked"
                ? "text-destructive"
                : scope.accessStatus === "replan_required"
                  ? "text-amber-600"
                  : "text-emerald-600"}
              >
                {scope.accessStatus === "access_revoked" ? "权限已撤销"
                  : scope.accessStatus === "replan_required" ? "正在重新对账" : "同步中"}
              </span>
            </div>
            {scope.accessStatus === "access_revoked" ? (
              <div className="mt-3 space-y-2">
                <p className="flex gap-2 text-muted-foreground">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-600" />
                  本地副本仍完整保留，但该工作区已停止上传和下载。
                </p>
                <div className="flex flex-wrap gap-2">
                  <button type="button" disabled={busy === scope.scopeKey}
                    onClick={() => { void download(scope); }}
                    className="inline-flex items-center gap-1 rounded border px-2 py-1 hover:bg-accent disabled:opacity-50">
                    <Download className="h-3.5 w-3.5" />导出本地副本
                  </button>
                  <button type="button" disabled={busy === scope.scopeKey}
                    onClick={() => { void copy(scope); }}
                    className="inline-flex items-center gap-1 rounded border px-2 py-1 hover:bg-accent disabled:opacity-50">
                    <FolderInput className="h-3.5 w-3.5" />复制到个人空间
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        ))}
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </section>
  );
}
