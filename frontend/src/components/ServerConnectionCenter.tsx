import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Cloud,
  DatabaseBackup,
  HardDrive,
  Loader2,
  Network,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { clearCurrentWorkspace, setServerUrl } from "@/lib/api";
import {
  bootstrapServerProfiles,
  getActiveServerProfile,
  isLoopbackProfileUrl,
  listServerProfiles,
  markServerProfileActive,
  profileKindLabel,
  removeServerProfile,
  ServerProfile,
  ServerProfileKind,
  subscribeServerProfiles,
  updateServerProfileStatus,
  upsertServerProfile,
} from "@/lib/serverProfiles";
import {
  analyzeInstanceMigration,
  clearMigrationCheckpoint,
  formatMigrationBytes,
  getMigrationCheckpoint,
  inspectServerProfile,
  loginServerProfile,
  MigrationAnalysis,
  MigrationProgress,
  MigrationRunResult,
  MigrationStrategy,
  type AuthenticatedServerProfile,
  rollbackInstanceMigration,
  runInstanceMigration,
} from "@/lib/serverMigrationV2";
import { isDesktop, switchDesktopToFull } from "@/lib/desktopBridge";
import {
  canPersistProfileSecrets,
  loadProfileCredential,
  migrateLegacyServerProfileCredentials,
  removeProfileCredential,
  saveProfileCredential,
  stagePendingProfileReauthentication,
} from "@/lib/profileCredentialVault";
import { getQueueLength } from "@/lib/offlineQueue";

type Tab = "profiles" | "migration" | "guide";
type FormMode = "create" | "edit";

export const SERVER_CONNECTION_CENTER_OPEN_EVENT = "nowen:server-connection-center-open";

const statusLabel: Record<ServerProfile["status"], string> = {
  unknown: "未检测",
  checking: "检测中",
  online: "在线",
  offline: "离线",
  "auth-expired": "登录失效",
};

function formatTime(timestamp?: number): string {
  if (!timestamp) return "从未";
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(timestamp);
  } catch {
    return new Date(timestamp).toLocaleString();
  }
}

function profileIcon(profile: ServerProfile) {
  if (profile.kind === "local") return <HardDrive size={18} />;
  if (profile.kind === "nas") return <DatabaseBackup size={18} />;
  return <Cloud size={18} />;
}

function statusDot(status: ServerProfile["status"]): string {
  if (status === "online") return "bg-emerald-500";
  if (status === "offline" || status === "auth-expired") return "bg-rose-500";
  if (status === "checking") return "bg-amber-500 animate-pulse";
  return "bg-zinc-400";
}

export default function ServerConnectionCenter() {
  const desktop = isDesktop();
  const [profiles, setProfiles] = useState<ServerProfile[]>(() => bootstrapServerProfiles());
  const [active, setActive] = useState<ServerProfile | null>(() => getActiveServerProfile());
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("profiles");
  const [formOpen, setFormOpen] = useState(false);
  const [formMode, setFormMode] = useState<FormMode>("create");
  const [editingId, setEditingId] = useState("");
  const [formName, setFormName] = useState("");
  const [formUrl, setFormUrl] = useState("");
  const [formKind, setFormKind] = useState<ServerProfileKind>("nas");
  const [formUsername, setFormUsername] = useState("");
  const [formPassword, setFormPassword] = useState("");
  const [formRememberCredential, setFormRememberCredential] = useState(false);
  const [formAutoLogin, setFormAutoLogin] = useState(false);
  const [credentialStorageAvailable, setCredentialStorageAvailable] = useState(false);
  const [formError, setFormError] = useState("");
  const [formBusy, setFormBusy] = useState(false);
  const [checkingId, setCheckingId] = useState("");

  const [sourceId, setSourceId] = useState(active?.id || "");
  const [targetId, setTargetId] = useState("");
  const [strategy, setStrategy] = useState<MigrationStrategy>("skip");
  const [analysis, setAnalysis] = useState<MigrationAnalysis | null>(null);
  const [analysisBusy, setAnalysisBusy] = useState(false);
  const [migrationBusy, setMigrationBusy] = useState(false);
  const [migrationProgress, setMigrationProgress] = useState<MigrationProgress | null>(null);
  const [migrationResult, setMigrationResult] = useState<MigrationRunResult | null>(null);
  const [migrationError, setMigrationError] = useState("");
  const [rollbackBusy, setRollbackBusy] = useState(false);

  const refreshProfiles = () => {
    const next = listServerProfiles();
    setProfiles(next);
    const nextActive = getActiveServerProfile();
    setActive(nextActive);
    if (!sourceId && nextActive) setSourceId(nextActive.id);
  };

  useEffect(() => subscribeServerProfiles(refreshProfiles), []);

  useEffect(() => {
    let cancelled = false;
    void canPersistProfileSecrets().then((available) => {
      if (!cancelled) setCredentialStorageAvailable(available);
    });
    void migrateLegacyServerProfileCredentials().then(() => {
      if (!cancelled) refreshProfiles();
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const openCenter = () => {
      setTab("profiles");
      setOpen(true);
    };
    window.addEventListener(SERVER_CONNECTION_CENTER_OPEN_EVENT, openCenter);
    return () => window.removeEventListener(SERVER_CONNECTION_CENTER_OPEN_EVENT, openCenter);
  }, []);

  useEffect(() => {
    if (!open) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !migrationBusy) setOpen(false);
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, migrationBusy]);

  useEffect(() => {
    if (!targetId) {
      const first = profiles.find((profile) => profile.id !== sourceId);
      if (first) setTargetId(first.id);
    }
  }, [profiles, sourceId, targetId]);

  const source = useMemo(() => profiles.find((profile) => profile.id === sourceId) || null, [profiles, sourceId]);
  const target = useMemo(() => profiles.find((profile) => profile.id === targetId) || null, [profiles, targetId]);
  const checkpoint = getMigrationCheckpoint();
  const previewRows: Array<{ total: number; alreadyImported: number; changed: number; newItems: number }> =
    analysis ? Object.values(analysis.targetPreview.summary) : [];

  const openCreateForm = () => {
    setFormMode("create");
    setEditingId("");
    setFormName("");
    setFormUrl("");
    setFormKind("nas");
    setFormUsername("");
    setFormPassword("");
    setFormRememberCredential(credentialStorageAvailable);
    setFormAutoLogin(false);
    setFormError("");
    setFormOpen(true);
  };

  const openEditForm = (profile: ServerProfile) => {
    setFormMode("edit");
    setEditingId(profile.id);
    setFormName(profile.name);
    setFormUrl(profile.serverUrl);
    setFormKind(profile.kind);
    setFormUsername(profile.username);
    setFormPassword("");
    setFormRememberCredential(profile.rememberCredential && credentialStorageAvailable);
    setFormAutoLogin(profile.autoLogin && credentialStorageAvailable);
    setFormError("");
    setFormOpen(true);
  };

  const getAuthenticatedProfile = async (profile: ServerProfile): Promise<AuthenticatedServerProfile> => {
    const credential = await loadProfileCredential(profile.id);
    const activeToken = profile.id === active?.id ? (localStorage.getItem("nowen-token") || "") : "";
    const token = credential?.token || activeToken;
    if (!token) throw new Error(`「${profile.name}」没有可用安全登录凭据，请先重新登录`);
    return { ...profile, token };
  };

  const saveProfile = async () => {
    setFormError("");
    if (!formName.trim() || !formUrl.trim() || !formUsername.trim()) {
      setFormError("请填写配置名称、服务器地址和用户名");
      return;
    }
    const existing = profiles.find((profile) => profile.id === editingId);
    setFormBusy(true);
    try {
      const existingCredential = existing ? await loadProfileCredential(existing.id) : null;
      let token = existingCredential?.token || (existing?.id === active?.id ? localStorage.getItem("nowen-token") || "" : "");
      let username = formUsername.trim();
      let displayName = existing?.displayName || username;
      if (formPassword) {
        const login = await loginServerProfile({ serverUrl: formUrl.trim() } as ServerProfile, username, formPassword);
        token = login.token;
        username = login.username;
        displayName = login.displayName;
      } else if (!token) {
        throw new Error("请输入密码完成登录；该档案没有可复用的安全凭据");
      }
      const rememberCredential = formRememberCredential && credentialStorageAvailable;
      const profile = upsertServerProfile({
        ...(existing || {}),
        id: existing?.id,
        name: formName.trim(),
        serverUrl: formUrl.trim(),
        kind: formKind,
        username,
        displayName,
        rememberCredential,
        autoLogin: rememberCredential && formAutoLogin,
        status: "checking",
      });
      if (rememberCredential) {
        const saved = await saveProfileCredential({
          profileId: profile.id,
          serverUrl: profile.serverUrl,
          username,
          token,
          password: formPassword || existingCredential?.password || "",
          autoLogin: formAutoLogin,
        });
        if (!saved.ok || !saved.persisted) throw new Error(saved.error || "系统安全存储不可用，未保存任何密码或令牌");
      } else {
        await removeProfileCredential(profile.id);
      }
      const inspected = await inspectServerProfile(profile, token);
      updateServerProfileStatus(profile.id, {
        status: inspected.online ? (inspected.authenticated ? "online" : "auth-expired") : "offline",
        serverInstanceId: inspected.serverInstanceId,
        username: inspected.username || profile.username,
        displayName: inspected.displayName || profile.displayName,
      });
      refreshProfiles();
      setFormOpen(false);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setFormBusy(false);
    }
  };

  const checkProfile = async (profile: ServerProfile) => {
    setCheckingId(profile.id);
    updateServerProfileStatus(profile.id, { status: "checking" });
    refreshProfiles();
    const credential = await loadProfileCredential(profile.id);
    const token = credential?.token || (profile.id === active?.id ? localStorage.getItem("nowen-token") || "" : "");
    const inspected = await inspectServerProfile(profile, token);
    updateServerProfileStatus(profile.id, {
      status: inspected.online ? (inspected.authenticated ? "online" : "auth-expired") : "offline",
      serverInstanceId: inspected.serverInstanceId,
      username: inspected.username || profile.username,
      displayName: inspected.displayName || profile.displayName,
    });
    setCheckingId("");
    refreshProfiles();
  };

  const switchProfile = async (profile: ServerProfile) => {
    if (profile.id === active?.id) return;
    const queueCount = getQueueLength();
    const confirmed = window.confirm(
      `切换到「${profile.name}」？

` +
      `服务器：${profile.serverUrl}
账号：${profile.displayName || profile.username}
` +
      (queueCount > 0 ? `
当前账号还有 ${queueCount} 条未同步笔记操作；它们会保留在当前账号的独立队列中，不会被删除。
` : "\n") +
      `切换会保存当前编辑器内容并重新加载目标账号数据，不会复制或迁移服务器数据。`,
    );
    if (!confirmed) return;

    try { window.dispatchEvent(new CustomEvent("nowen:before-note-switch")); } catch { /* ignore */ }
    await new Promise((resolve) => window.setTimeout(resolve, 80));

    const credential = await loadProfileCredential(profile.id);
    let token = credential?.token || "";
    let inspected = await inspectServerProfile(profile, token);
    if (inspected.online && !inspected.authenticated && credential?.password && profile.autoLogin) {
      try {
        const login = await loginServerProfile(profile, profile.username, credential.password);
        token = login.token;
        const saved = await saveProfileCredential({
          profileId: profile.id,
          serverUrl: profile.serverUrl,
          username: login.username,
          token,
          password: credential.password,
          autoLogin: true,
        });
        if (!saved.persisted) throw new Error("无法更新安全凭据");
        inspected = await inspectServerProfile(profile, token);
      } catch {
        inspected = { ...inspected, authenticated: false };
      }
    }

    if (!inspected.online) {
      window.alert(`服务器不可连接：${inspected.error || "未知错误"}`);
      updateServerProfileStatus(profile.id, { status: "offline" });
      refreshProfiles();
      return;
    }
    if (!inspected.authenticated || !token) {
      updateServerProfileStatus(profile.id, { status: "auth-expired" });
      stagePendingProfileReauthentication(profile);
      clearCurrentWorkspace();
      setServerUrl(profile.serverUrl);
      localStorage.removeItem("nowen-token");
      localStorage.setItem("nowen-server-url-last", profile.serverUrl);
      window.location.reload();
      return;
    }

    clearCurrentWorkspace();
    if (desktop && profile.kind === "local" && isLoopbackProfileUrl(profile.serverUrl)) {
      markServerProfileActive(profile.id);
      const result = await switchDesktopToFull().catch(() => ({ ok: false }));
      if (result?.ok !== false) return;
    }
    setServerUrl(profile.serverUrl);
    localStorage.setItem("nowen-token", token);
    localStorage.removeItem("nowen-prefer-cloud");
    markServerProfileActive(profile.id);
    window.location.reload();
  };

  const deleteProfile = async (profile: ServerProfile) => {
    if (profile.id === active?.id) {
      window.alert("当前正在使用的服务端配置不能删除，请先切换到其他配置。");
      return;
    }
    if (!window.confirm(`删除服务端配置「${profile.name}」？\n只删除本机档案和对应安全凭据，不会删除服务器上的数据。`)) return;
    await removeProfileCredential(profile.id);
    removeServerProfile(profile.id);
    refreshProfiles();
    if (sourceId === profile.id) setSourceId(active?.id || "");
    if (targetId === profile.id) setTargetId("");
  };

  const analyze = async () => {
    setMigrationError("");
    setMigrationResult(null);
    setAnalysis(null);
    if (!source || !target) {
      setMigrationError("请选择源服务器和目标服务器");
      return;
    }
    if (source.id === target.id) {
      setMigrationError("源服务器和目标服务器不能相同");
      return;
    }
    setAnalysisBusy(true);
    try {
      const [sourceAuth, targetAuth] = await Promise.all([
        getAuthenticatedProfile(source),
        getAuthenticatedProfile(target),
      ]);
      const result = await analyzeInstanceMigration(sourceAuth, targetAuth);
      setAnalysis(result);
    } catch (error) {
      setMigrationError(error instanceof Error ? error.message : String(error));
    } finally {
      setAnalysisBusy(false);
    }
  };

  const startMigration = async () => {
    if (!analysis) return;
    const counts = analysis.preflight.counts;
    const confirmed = window.confirm(
      `确认执行一次性迁移？\n\n` +
      `源：${analysis.source.name} / ${analysis.source.displayName || analysis.source.username}\n` +
      `目标：${analysis.target.name} / ${analysis.target.displayName || analysis.target.username}\n` +
      `内容：${counts.notebooks} 个笔记本、${counts.notes} 篇笔记、${counts.tasks} 个任务、${counts.attachments} 个附件\n\n` +
      `开始前会自动在源端创建 ZIP 安全备份。迁移不会删除源端数据，也不会开启双向同步。`,
    );
    if (!confirmed) return;
    setMigrationBusy(true);
    setMigrationError("");
    setMigrationResult(null);
    try {
      const result = await runInstanceMigration({
        analysis,
        strategy,
        onProgress: setMigrationProgress,
      });
      setMigrationResult(result);
    } catch (error) {
      setMigrationError(error instanceof Error ? error.message : String(error));
    } finally {
      setMigrationBusy(false);
    }
  };

  const rollback = async () => {
    if (!target || !checkpoint?.migrationId) return;
    if (!window.confirm("撤销这次未完成迁移在目标端创建的可追踪数据？\n源端数据和源端安全备份不会受影响。")) return;
    setRollbackBusy(true);
    try {
      await rollbackInstanceMigration(await getAuthenticatedProfile(target), checkpoint.migrationId);
      clearMigrationCheckpoint();
      setMigrationError("");
      setMigrationProgress(null);
      setAnalysis(null);
      window.alert("目标端迁移副本已撤销。");
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
    } finally {
      setRollbackBusy(false);
    }
  };

  const switchToMigratedTarget = async () => {
    if (!target) return;
    await switchProfile(target);
  };

  const overlay = open ? createPortal(
    <div className="fixed inset-0 z-[260] bg-black/55 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-5xl max-h-[88vh] overflow-hidden rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 shadow-2xl flex flex-col">
        <header className="flex items-center justify-between gap-4 px-5 py-4 border-b border-zinc-200 dark:border-zinc-800">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-zinc-900 dark:text-zinc-100">
              <Network size={19} className="text-indigo-500" />
              <h2 className="font-semibold">服务端与迁移中心</h2>
            </div>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
              管理多个服务器与账号档案，安全切换登录，并可把本地数据一次性迁移到 NAS。
            </p>
          </div>
          <button
            type="button"
            onClick={() => !migrationBusy && setOpen(false)}
            disabled={migrationBusy}
            className="w-9 h-9 rounded-lg grid place-items-center text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-900 disabled:opacity-40"
            aria-label="关闭"
          >
            <X size={18} />
          </button>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-[180px_minmax(0,1fr)] min-h-0 flex-1">
          <aside className="border-b md:border-b-0 md:border-r border-zinc-200 dark:border-zinc-800 p-3 bg-zinc-50/70 dark:bg-zinc-900/35 flex md:block gap-1 overflow-x-auto">
            {([
              ["profiles", Server, "服务端配置"],
              ["migration", DatabaseBackup, "迁移到 NAS"],
              ["guide", ShieldCheck, "使用说明"],
            ] as const).map(([value, Icon, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setTab(value)}
                className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm text-left transition-colors ${
                  tab === value
                    ? "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400"
                    : "text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-900"
                }`}
              >
                <Icon size={16} />
                {label}
              </button>
            ))}
          </aside>

          <main className="min-w-0 overflow-y-auto p-5">
            {tab === "profiles" && (
              <section>
                <div className="flex items-center justify-between gap-3 mb-4">
                  <div>
                    <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">我的服务端</h3>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
                      档案只保存非敏感元数据；密码和令牌仅存入系统安全存储，Web 端不会保存秘密。
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={openCreateForm}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-sm"
                  >
                    <Plus size={15} />
                    添加服务端
                  </button>
                </div>

                <div className="space-y-2.5">
                  {profiles.map((profile) => {
                    const current = profile.id === active?.id;
                    return (
                      <div
                        key={profile.id}
                        className={`rounded-xl border p-4 ${
                          current
                            ? "border-indigo-400/70 bg-indigo-50/50 dark:bg-indigo-500/8"
                            : "border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950"
                        }`}
                      >
                        <div className="flex items-start gap-3">
                          <div className={`w-10 h-10 rounded-xl grid place-items-center ${
                            current ? "bg-indigo-500/12 text-indigo-600 dark:text-indigo-400" : "bg-zinc-100 dark:bg-zinc-900 text-zinc-500"
                          }`}>
                            {profileIcon(profile)}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-medium text-zinc-900 dark:text-zinc-100">{profile.name}</span>
                              <span className="text-[11px] px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-900 text-zinc-500">
                                {profileKindLabel(profile.kind)}
                              </span>
                              {current && (
                                <span className="text-[11px] px-1.5 py-0.5 rounded bg-indigo-500/12 text-indigo-600 dark:text-indigo-400">
                                  当前
                                </span>
                              )}
                              <span className="inline-flex items-center gap-1 text-[11px] text-zinc-500">
                                <span className={`w-1.5 h-1.5 rounded-full ${statusDot(profile.status)}`} />
                                {statusLabel[profile.status]}
                              </span>
                            </div>
                            <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-1 truncate">{profile.serverUrl}</div>
                            <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
                              账号：{profile.displayName || profile.username || "未登录"} · 最近使用：{formatTime(profile.lastUsedAt)}
                              {profile.rememberCredential && <span className="ml-2 text-emerald-600 dark:text-emerald-400">系统安全凭据</span>}
                            </div>
                          </div>
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => checkProfile(profile)}
                              disabled={checkingId === profile.id}
                              className="w-8 h-8 grid place-items-center rounded-lg text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-900 disabled:opacity-50"
                              title="检测连接"
                            >
                              <RefreshCw size={14} className={checkingId === profile.id ? "animate-spin" : ""} />
                            </button>
                            <button
                              type="button"
                              onClick={() => openEditForm(profile)}
                              className="px-2.5 h-8 rounded-lg text-xs text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-900"
                            >
                              编辑
                            </button>
                            {!current && (
                              <button
                                type="button"
                                onClick={() => switchProfile(profile)}
                                className="px-2.5 h-8 rounded-lg text-xs text-indigo-600 dark:text-indigo-400 hover:bg-indigo-500/10"
                              >
                                切换
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => deleteProfile(profile)}
                              className="w-8 h-8 grid place-items-center rounded-lg text-zinc-400 hover:text-rose-500 hover:bg-rose-500/10"
                              title="删除配置"
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  {profiles.length === 0 && (
                    <div className="rounded-xl border border-dashed border-zinc-300 dark:border-zinc-700 p-10 text-center text-sm text-zinc-500">
                      还没有服务端配置。添加本地服务或 NAS 实例后即可快速切换。
                    </div>
                  )}
                </div>
              </section>
            )}

            {tab === "migration" && (
              <section>
                <div className="mb-4">
                  <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">本地数据迁移到 NAS</h3>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1 leading-relaxed">
                    这是一次性复制，不是双向同步。迁移成功后，建议电脑、手机和平板统一连接 NAS 实例。
                  </p>
                </div>

                <div className="grid md:grid-cols-[1fr_36px_1fr] gap-3 items-end">
                  <label className="block">
                    <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">源服务器</span>
                    <select
                      value={sourceId}
                      onChange={(event) => {
                        setSourceId(event.target.value);
                        setAnalysis(null);
                        setMigrationResult(null);
                      }}
                      disabled={migrationBusy}
                      className="mt-1.5 w-full px-3 py-2.5 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm"
                    >
                      <option value="">请选择</option>
                      {profiles.map((profile) => (
                        <option key={profile.id} value={profile.id}>{profile.name} · {profile.username || "未登录"}</option>
                      ))}
                    </select>
                  </label>
                  <div className="h-10 grid place-items-center text-zinc-400"><ChevronRight size={18} /></div>
                  <label className="block">
                    <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">目标服务器</span>
                    <select
                      value={targetId}
                      onChange={(event) => {
                        setTargetId(event.target.value);
                        setAnalysis(null);
                        setMigrationResult(null);
                      }}
                      disabled={migrationBusy}
                      className="mt-1.5 w-full px-3 py-2.5 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm"
                    >
                      <option value="">请选择</option>
                      {profiles.filter((profile) => profile.id !== sourceId).map((profile) => (
                        <option key={profile.id} value={profile.id}>{profile.name} · {profile.username || "未登录"}</option>
                      ))}
                    </select>
                  </label>
                </div>

                <div className="mt-4 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={analyze}
                    disabled={analysisBusy || migrationBusy || !source || !target}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 text-sm disabled:opacity-50"
                  >
                    {analysisBusy ? <Loader2 size={15} className="animate-spin" /> : <ShieldCheck size={15} />}
                    扫描并评估
                  </button>
                  {checkpoint && (
                    <span className="text-xs text-amber-600 dark:text-amber-400">
                      检测到未完成迁移，可按相同源、目标和策略安全续传。
                    </span>
                  )}
                </div>

                {migrationError && (
                  <div className="mt-4 rounded-xl border border-rose-200 dark:border-rose-900/50 bg-rose-50 dark:bg-rose-950/30 p-3 text-sm text-rose-700 dark:text-rose-300 flex gap-2">
                    <AlertTriangle size={17} className="shrink-0 mt-0.5" />
                    <div className="min-w-0 break-words">{migrationError}</div>
                  </div>
                )}

                {analysis && (
                  <div className="mt-5 space-y-4">
                    <div className="grid grid-cols-2 lg:grid-cols-6 gap-2">
                      {[
                        ["笔记本", analysis.preflight.counts.notebooks],
                        ["笔记", analysis.preflight.counts.notes],
                        ["标签", analysis.preflight.counts.tags],
                        ["任务", analysis.preflight.counts.tasks],
                        ["附件", analysis.preflight.counts.attachments],
                        ["附件容量", formatMigrationBytes(analysis.preflight.attachments.totalBytes)],
                      ].map(([label, value]) => (
                        <div key={String(label)} className="rounded-xl border border-zinc-200 dark:border-zinc-800 p-3 bg-zinc-50/60 dark:bg-zinc-900/40">
                          <div className="text-[11px] text-zinc-500">{label}</div>
                          <div className="mt-1 font-semibold text-zinc-900 dark:text-zinc-100">{value}</div>
                        </div>
                      ))}
                    </div>

                    {analysis.preflight.counts.missingAttachments > 0 && (
                      <div className="rounded-xl border border-rose-200 dark:border-rose-900/50 bg-rose-50 dark:bg-rose-950/30 p-3 text-sm text-rose-700 dark:text-rose-300">
                        源端有 {analysis.preflight.counts.missingAttachments} 个附件物理文件缺失。为避免迁出残缺数据，开始迁移按钮已禁用。
                      </div>
                    )}

                    <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <h4 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">目标端重复与历史迁移检查</h4>
                          <p className="text-xs text-zinc-500 mt-1">相同源实例、账号和源 ID 会被服务端追踪，重复执行不会静默制造副本。</p>
                        </div>
                        <div className="text-xs text-zinc-500">
                          已迁移：{previewRows.reduce((sum, row) => sum + row.alreadyImported, 0)}
                          {" · "}
                          源端有更新：{previewRows.reduce((sum, row) => sum + row.changed, 0)}
                        </div>
                      </div>

                      <div className="grid md:grid-cols-3 gap-2 mt-3">
                        {([
                          ["skip", "跳过已有", "最稳妥。已迁移项目保留目标版本，只补充新内容。"],
                          ["replace", "更新迁移副本", "只更新历史迁移创建的可追踪副本，不覆盖目标端原生内容。"],
                          ["keep-both", "保留两份", "源内容变化时新建“迁移副本”，目标旧版本继续保留。"],
                        ] as const).map(([value, title, description]) => (
                          <button
                            key={value}
                            type="button"
                            onClick={() => setStrategy(value)}
                            disabled={migrationBusy}
                            className={`text-left rounded-xl border p-3 transition-colors ${
                              strategy === value
                                ? "border-indigo-500 bg-indigo-50/70 dark:bg-indigo-500/10"
                                : "border-zinc-200 dark:border-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-700"
                            }`}
                          >
                            <div className="flex items-center gap-2 text-sm font-medium text-zinc-900 dark:text-zinc-100">
                              <span className={`w-4 h-4 rounded-full border grid place-items-center ${strategy === value ? "border-indigo-500" : "border-zinc-400"}`}>
                                {strategy === value && <span className="w-2 h-2 rounded-full bg-indigo-500" />}
                              </span>
                              {title}
                            </div>
                            <p className="text-xs text-zinc-500 mt-1.5 leading-relaxed">{description}</p>
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="rounded-xl border border-emerald-200 dark:border-emerald-900/50 bg-emerald-50/70 dark:bg-emerald-950/20 p-3 text-xs text-emerald-800 dark:text-emerald-300 leading-relaxed">
                      <strong>安全流程：</strong>源端自动生成 ZIP 备份 → 数据事务导入 → 附件逐个 SHA-256 校验并断点记录 →
                      重写引用 → 目标端重新读取文件复核数量、大小和哈希。失败后可续传或撤销可追踪迁移副本。
                    </div>

                    {migrationProgress && (
                      <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 p-4">
                        <div className="flex items-center justify-between text-xs text-zinc-500 mb-2">
                          <span>{migrationProgress.message}</span>
                          <span>{Math.round(migrationProgress.ratio * 100)}%</span>
                        </div>
                        <div className="h-2 rounded-full bg-zinc-100 dark:bg-zinc-900 overflow-hidden">
                          <div
                            className="h-full bg-indigo-500 transition-all duration-300"
                            style={{ width: `${Math.max(2, Math.round(migrationProgress.ratio * 100))}%` }}
                          />
                        </div>
                      </div>
                    )}

                    {migrationResult ? (
                      <div className="rounded-xl border border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/20 p-4">
                        <div className="flex items-start gap-3">
                          <div className="w-9 h-9 rounded-full bg-emerald-500/15 text-emerald-600 grid place-items-center"><Check size={18} /></div>
                          <div className="min-w-0 flex-1">
                            <h4 className="font-medium text-emerald-900 dark:text-emerald-200">迁移与完整性校验完成</h4>
                            <p className="text-xs text-emerald-800/80 dark:text-emerald-300/80 mt-1">
                              已验证 {migrationResult.verification.verifiedAttachments} 个附件，
                              共 {formatMigrationBytes(migrationResult.verification.verifiedBytes)}。
                            </p>
                            <p className="text-xs text-emerald-800/80 dark:text-emerald-300/80 mt-1 break-all">
                              源端备份：{migrationResult.backup.filename}
                            </p>
                            <button
                              type="button"
                              onClick={switchToMigratedTarget}
                              className="mt-3 px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm"
                            >
                              切换到目标服务器
                            </button>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={startMigration}
                          disabled={migrationBusy || analysis.preflight.counts.missingAttachments > 0}
                          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-sm disabled:opacity-50"
                        >
                          {migrationBusy ? <Loader2 size={15} className="animate-spin" /> : <DatabaseBackup size={15} />}
                          {checkpoint ? "继续迁移" : "创建备份并开始迁移"}
                        </button>
                        {checkpoint && !migrationBusy && (
                          <button
                            type="button"
                            onClick={rollback}
                            disabled={rollbackBusy}
                            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-rose-200 dark:border-rose-900/60 text-rose-600 dark:text-rose-400 text-sm disabled:opacity-50"
                          >
                            {rollbackBusy ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                            撤销未完成迁移
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </section>
            )}

            {tab === "guide" && (
              <section className="space-y-4">
                <div>
                  <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">三种操作不要混淆</h3>
                  <p className="text-xs text-zinc-500 mt-1">入口和结果完全不同，系统不会替你偷偷复制数据。</p>
                </div>
                {[
                  ["切换服务器", "只改变当前客户端连接地址和账号。不会复制、合并或删除任何数据。", Server],
                  ["迁移数据", "从一个实例向另一个实例一次性复制个人笔记、标签、历史版本、任务和附件。源端保留。", DatabaseBackup],
                  ["导入备份", "从用户选择的备份文件恢复数据，属于数据管理功能，不等同于服务器切换。", HardDrive],
                ].map(([title, description, Icon]) => {
                  const ItemIcon = Icon as typeof Server;
                  return (
                    <div key={String(title)} className="rounded-xl border border-zinc-200 dark:border-zinc-800 p-4 flex gap-3">
                      <div className="w-10 h-10 rounded-xl bg-zinc-100 dark:bg-zinc-900 grid place-items-center text-zinc-500"><ItemIcon size={18} /></div>
                      <div>
                        <h4 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{title as string}</h4>
                        <p className="text-xs text-zinc-500 mt-1 leading-relaxed">{description as string}</p>
                      </div>
                    </div>
                  );
                })}
                <div className="rounded-xl border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/20 p-4">
                  <div className="flex gap-2 text-amber-800 dark:text-amber-300">
                    <AlertTriangle size={17} className="shrink-0" />
                    <div>
                      <h4 className="text-sm font-medium">推荐长期方案</h4>
                      <p className="text-xs mt-1 leading-relaxed">
                        完成本地 → NAS 一次性迁移后，将电脑、手机和平板全部配置为同一个 NAS 服务端。
                        本地实例只保留为只读备份或应急恢复源，不要在两端同时继续编辑同一批数据。
                      </p>
                    </div>
                  </div>
                </div>
              </section>
            )}
          </main>
        </div>
      </div>

      {formOpen && (
        <div className="fixed inset-0 z-[270] bg-black/35 grid place-items-center p-4">
          <div className="w-full max-w-md rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 shadow-2xl p-5">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">
                {formMode === "create" ? "添加服务端" : "编辑服务端"}
              </h3>
              <button type="button" onClick={() => !formBusy && setFormOpen(false)} className="w-8 h-8 grid place-items-center rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-900">
                <X size={16} />
              </button>
            </div>
            <div className="space-y-3 mt-4">
              <label className="block">
                <span className="text-xs text-zinc-600 dark:text-zinc-400">配置名称</span>
                <input value={formName} onChange={(event) => setFormName(event.target.value)} placeholder="例如：家里 NAS" className="mt-1 w-full px-3 py-2.5 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm" />
              </label>
              <label className="block">
                <span className="text-xs text-zinc-600 dark:text-zinc-400">服务器地址</span>
                <input value={formUrl} onChange={(event) => setFormUrl(event.target.value)} placeholder="http://192.168.1.10:3001" className="mt-1 w-full px-3 py-2.5 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm" />
              </label>
              <label className="block">
                <span className="text-xs text-zinc-600 dark:text-zinc-400">类型</span>
                <select value={formKind} onChange={(event) => setFormKind(event.target.value as ServerProfileKind)} className="mt-1 w-full px-3 py-2.5 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm">
                  <option value="local">本地服务</option>
                  <option value="nas">NAS</option>
                  <option value="remote">远程服务器</option>
                  <option value="demo">演示环境</option>
                </select>
              </label>
              <label className="block">
                <span className="text-xs text-zinc-600 dark:text-zinc-400">用户名</span>
                <input value={formUsername} onChange={(event) => setFormUsername(event.target.value)} autoComplete="username" className="mt-1 w-full px-3 py-2.5 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm" />
              </label>
              <label className="block">
                <span className="text-xs text-zinc-600 dark:text-zinc-400">
                  密码{formMode === "edit" ? "（留空则继续使用系统安全凭据）" : ""}
                </span>
                <input value={formPassword} onChange={(event) => setFormPassword(event.target.value)} type="password" autoComplete="new-password" className="mt-1 w-full px-3 py-2.5 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm" />
                <p className="text-[11px] text-zinc-500 mt-1">
                  {credentialStorageAvailable
                    ? "密码和令牌不会写入档案 JSON；勾选后仅加密保存到系统安全存储。"
                    : "当前平台无法安全保存密码或令牌，只会记录服务器地址和用户名。"}
                </p>
              </label>
              <label className="flex items-start gap-2 text-xs text-zinc-600 dark:text-zinc-400">
                <input
                  type="checkbox"
                  checked={formRememberCredential}
                  disabled={!credentialStorageAvailable}
                  onChange={(event) => {
                    setFormRememberCredential(event.target.checked);
                    if (!event.target.checked) setFormAutoLogin(false);
                  }}
                  className="mt-0.5"
                />
                <span>使用系统安全存储记住此账号凭据</span>
              </label>
              <label className="flex items-start gap-2 text-xs text-zinc-600 dark:text-zinc-400">
                <input
                  type="checkbox"
                  checked={formAutoLogin}
                  disabled={!credentialStorageAvailable || !formRememberCredential}
                  onChange={(event) => setFormAutoLogin(event.target.checked)}
                  className="mt-0.5"
                />
                <span>令牌失效时尝试使用加密密码自动重新登录（2FA 仍会进入验证码流程）</span>
              </label>
            </div>
            {formError && <div className="mt-3 text-sm text-rose-600 dark:text-rose-400">{formError}</div>}
            <div className="flex justify-end gap-2 mt-5">
              <button type="button" onClick={() => setFormOpen(false)} disabled={formBusy} className="px-3 py-2 rounded-lg text-sm text-zinc-600 hover:bg-zinc-100 dark:hover:bg-zinc-900">取消</button>
              <button type="button" onClick={saveProfile} disabled={formBusy} className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm inline-flex items-center gap-1.5 disabled:opacity-50">
                {formBusy && <Loader2 size={14} className="animate-spin" />}
                保存并验证
              </button>
            </div>
          </div>
        </div>
      )}
    </div>,
    document.body,
  ) : null;

  return (
    <>
      {overlay}
    </>
  );
}
