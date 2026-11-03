import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  Box,
  Check,
  ChevronRight,
  CircleCheck,
  CircleDashed,
  Clock3,
  ExternalLink,
  FileText,
  FileCheck,
  GitBranch,
  GitCommitHorizontal,
  History,
  LayoutDashboard,
  LoaderCircle,
  LockKeyhole,
  Monitor,
  Moon,
  Package,
  Plus,
  Radio,
  RefreshCw,
  Rocket,
  ShieldCheck,
  Sun,
  Terminal,
  TriangleAlert,
  X,
} from "lucide-react";
import type { Audit, Overview, Plan, PlanInput, Task } from "../shared";
import { Button, Card, Input, cn } from "./components/ui";
import "./style.css";
import { ArtifactReview } from "./components/ArtifactReview";
import { ChannelsPanel } from "./components/ChannelsPanel";
import { CloudPanel } from "./components/CloudPanel";
import { PublicationPanel } from "./components/PublicationPanel";

const modeName = (mode: Task["mode"]) =>
  mode === "debug" ? "调试构建" : mode === "verify" ? "产物复核" : mode === "publication" ? "正式候选操作" : "Dry Run";
const runningLabel = (task: Task) => task.state !== "running" ? undefined : task.mode === "verify" ? "校验中"
  : task.mode === "publication" ? ({ verify: "正式复核中", draft: "准备 Draft", publish: "发布中" }[task.publication!.operation]) : undefined;

const pages = [
  { id: "overview", label: "发布总览", icon: LayoutDashboard },
  { id: "new", label: "新建发布", icon: Plus },
  { id: "preflight", label: "发布前检查", icon: ShieldCheck },
  { id: "builds", label: "构建任务", icon: Terminal },
  { id: "artifacts", label: "产物管理", icon: Package },
  { id: "channels", label: "渠道分发", icon: Radio },
  { id: "legacy", label: "历史调试工具", icon: Monitor },
  { id: "formal", label: "正式候选", icon: FileCheck },
  { id: "history", label: "发布历史", icon: History },
];
const stateNames: Record<string, string> = {
  queued: "等待中",
  running: "构建中",
  reconciling: "对账中",
  cancelling: "正在取消",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
  timed_out: "已超时",
  completed: "已结束",
  in_progress: "进行中",
  success: "成功",
  failure: "失败",
};
const platformNames = {
  windows: "Windows x64",
  macos: "macOS Intel + Apple Silicon",
  linux: "Linux x64",
};
const active = (t: Task) =>
  ["queued", "running", "reconciling", "cancelling"].includes(t.state);
const date = (value?: string | null) =>
  value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";
const bytes = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method: body === undefined ? "GET" : "POST",
    ...(body === undefined
      ? {}
      : {
          headers: {
            "Content-Type": "application/json",
            "X-Release-Center": "1",
          },
          body: JSON.stringify(body),
        }),
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error || `请求失败 ${response.status}`);
  return result;
}
function Badge({
  state,
  children,
}: {
  state: string;
  children?: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
        ["succeeded", "success", "pass"].includes(state)
          ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
          : ["failed", "fail", "failure"].includes(state)
            ? "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300"
            : ["running", "in_progress", "reconciling"].includes(state)
              ? "bg-violet-50 text-violet-700 dark:bg-violet-950 dark:text-violet-300"
              : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
      )}
    >
      <span className="size-1.5 rounded-full bg-current" />
      {children || stateNames[state] || state}
    </span>
  );
}
function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-40 flex-col items-center justify-center gap-3 px-5 py-9 text-center text-sm text-slate-500">
      <Box className="size-8 text-slate-300" />
      {children}
    </div>
  );
}
function GitHubLink({
  url,
  children,
}: {
  url: string;
  children: React.ReactNode;
}) {
  return url.startsWith("https://github.com/cropflre/nowen-note/") ? (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-primary hover:underline"
    >
      {children}
      <ExternalLink size={13} />
    </a>
  ) : (
    <span>{children}</span>
  );
}

function App() {
  const [page, setPage] = useState(location.hash.slice(1) || "overview");
  const [dark, setDark] = useState(localStorage.getItem("rc-theme") === "dark");
  const [data, setData] = useState<Overview>();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [audit, setAudit] = useState<Audit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<Plan>();
  const [confirmed, setConfirmed] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [input, setInput] = useState<PlanInput>({
    branch: "release/v1.5.2",
    version: "",
    channel: "stable",
    platforms: ["windows", "macos", "linux"],
    notes: "",
  });
  const navigate = (id: string) => {
    location.hash = id;
    setPage(id);
  };
  useEffect(() => {
    const change = () => setPage(location.hash.slice(1) || "overview");
    addEventListener("hashchange", change);
    return () => removeEventListener("hashchange", change);
  }, []);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("rc-theme", dark ? "dark" : "light");
  }, [dark]);
  async function refresh() {
    setLoading(true);
    setError("");
    try {
      await api("session");
      const value = await api<Overview>("overview");
      setData(value);
      setTasks(value.tasks);
      setInput((previous) => ({
        ...previous,
        version: previous.version || value.localVersion,
      }));
      setAudit(await api<Audit[]>("audit"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    let events: EventSource | undefined;
    let stopped = false;
    void refresh().then(() => {
      if (stopped) return;
      events = new EventSource("/api/events");
      events.onopen = () => setConnected(true);
      events.onerror = () => setConnected(false);
      events.onmessage = (e) => {
        const snapshot = JSON.parse(e.data);
        setTasks(snapshot.tasks);
        setAudit((previous) =>
          [
            ...new Map(
              [...previous, ...snapshot.audit].map((a: Audit) => [a.seq, a]),
            ).values(),
          ]
            .sort((a, b) => b.seq - a.seq)
            .slice(0, 500),
        );
      };
    });
    return () => {
      stopped = true;
      events?.close();
    };
  }, []);
  async function perform(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const preview = (value = input) =>
    perform(async () => {
      const result = await api<Plan>("plans", value);
      setPlan(result);
      setConfirmed(false);
      navigate("preflight");
    });
  function start(mode: "dry-run" | "debug") {
    if (!plan) return;
    void perform(async () => {
      const storageKey = `rc-task-${plan.id}-${mode}`;
      const key = sessionStorage.getItem(storageKey) || crypto.randomUUID();
      sessionStorage.setItem(storageKey, key);
      const task = await api<Task>("tasks", {
        planId: plan.id,
        mode,
        key,
        confirmDebug: confirmed,
      });
      setSelected(task.id);
      setTasks((previous) => [
        task,
        ...previous.filter((t) => t.id !== task.id),
      ]);
      navigate("builds");
    });
  }
  const latest = data?.releases.find((r) => !r.draft && !r.prerelease);
  const candidate = data?.releases.find((r) => r.draft || r.prerelease);
  const focused = tasks.find((t) => t.id === selected) || tasks[0];
  const currentTitle = pages.find((p) => p.id === page)?.label || "发布总览";
  const taskRows = (limit = 100) =>
    tasks.length ? (
      <div className="divide-y divide-slate-100 dark:divide-slate-800">
        {tasks.slice(0, limit).map((task) => (
          <button
            key={task.id}
            className={cn(
              "flex w-full flex-wrap items-center gap-3 px-5 py-4 text-left hover:bg-slate-50 dark:hover:bg-slate-800",
              focused?.id === task.id &&
                page === "builds" &&
                "bg-violet-50/60 dark:bg-violet-950/30",
            )}
            onClick={() => {
              setSelected(task.id);
              navigate("builds");
            }}
          >
            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-slate-50 text-slate-500 dark:bg-slate-800">
              <Terminal size={18} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-medium">
                v{task.plan.version}{" "}
                <span className="ml-2 text-xs font-normal text-slate-400">
                  {modeName(task.mode)}
                </span>
              </div>
              <div className="mt-1 truncate font-mono text-xs text-slate-400">
                {task.plan.sha.slice(0, 10)} · {task.plan.platforms.join(" / ")}
              </div>
            </div>
            <Badge state={task.state}>
              {runningLabel(task)}
            </Badge>
            <ChevronRight size={16} className="text-slate-400" />
          </button>
        ))}
      </div>
    ) : (
      <Empty>还没有构建任务。从一个发布计划开始。</Empty>
    );

  return (
    <div className="min-h-screen bg-[#f7f8fb] text-slate-800 dark:bg-slate-950 dark:text-slate-100">
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-60 flex-col border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900 lg:flex">
        <a href="#overview" className="flex items-center gap-3 px-6 pb-8 pt-7">
          <span className="flex size-10 items-center justify-center rounded-xl bg-primary text-white">
            <Rocket size={21} />
          </span>
          <span>
            <strong className="text-lg tracking-tight">Nowen</strong>
            <span className="block text-xs text-slate-400">Release Center</span>
          </span>
        </a>
        <div className="px-6 pb-3 text-[10px] font-semibold tracking-[.18em] text-slate-400">
          WORKSPACE
        </div>
        <nav className="space-y-1 px-3" aria-label="主导航">
          {pages.map((p) => (
            <button
              key={p.id}
              onClick={() => navigate(p.id)}
              className={cn(
                "flex w-full items-center gap-3 rounded-lg px-4 py-3 text-sm",
                page === p.id
                  ? "bg-violet-50 font-semibold text-primary dark:bg-violet-950"
                  : "text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800",
              )}
            >
              <p.icon size={18} />
              {p.label}
              {p.id === "builds" && tasks.some(active) && (
                <span className="ml-auto size-2 rounded-full bg-primary" />
              )}
            </button>
          ))}
        </nav>
        <div className="mx-4 mt-8 rounded-xl border border-dashed border-slate-200 p-4 dark:border-slate-700">
          <div className="flex items-center gap-2 text-xs font-medium">
            <LockKeyhole size={14} />
            GitHub Actions 构建
          </div>
          <p className="mt-2 text-xs leading-5 text-slate-400">
            新建发布使用远端构建。构建完成后，使用已有产物单独确认发布。
          </p>
        </div>
        <div className="mt-auto border-t border-slate-100 p-5 dark:border-slate-800">
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <span
              className={cn(
                "size-2 rounded-full",
                connected ? "bg-emerald-500" : "bg-amber-400",
              )}
            />
            {connected ? "实时连接正常" : "正在重新连接"}
          </div>
          <div className="mt-2 font-mono text-[10px] text-slate-400">
            cropflre / nowen-note
          </div>
        </div>
      </aside>
      <div className="lg:ml-60">
        <header className="flex h-[76px] items-center justify-between gap-3 border-b border-slate-200 bg-white/90 px-5 dark:border-slate-800 dark:bg-slate-900 md:px-9">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-slate-400">工作空间</span>
            <ChevronRight size={14} className="text-slate-300" />
            <span>{currentTitle}</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden rounded-md bg-slate-100 px-2.5 py-1 font-mono text-xs text-slate-500 dark:bg-slate-800 sm:inline">
              {data?.branch || "release/v1.5.2"}
            </span>
            <Button
              variant="ghost"
              size="icon"
              aria-label={dark ? "切换浅色模式" : "切换暗色模式"}
              onClick={() => setDark(!dark)}
            >
              {dark ? <Sun size={18} /> : <Moon size={18} />}
            </Button>
            <span className="flex size-8 items-center justify-center rounded-full bg-violet-100 text-xs font-semibold text-primary">
              N
            </span>
          </div>
        </header>
        <nav
          className="flex gap-1 overflow-x-auto border-b border-slate-200 bg-white p-2 dark:border-slate-800 dark:bg-slate-900 lg:hidden"
          aria-label="移动导航"
        >
          {pages.map((p) => (
            <button
              key={p.id}
              onClick={() => navigate(p.id)}
              className={cn(
                "shrink-0 rounded-md px-3 py-2 text-xs",
                page === p.id && "bg-violet-50 text-primary dark:bg-violet-950",
              )}
            >
              {p.label}
            </button>
          ))}
        </nav>
        <main className="mx-auto max-w-[1550px] px-5 py-7 md:px-9 md:py-9">
          <div className="mb-7 flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold tracking-widest text-primary">
                <span className="h-px w-5 bg-primary" />
                NOWEN RELEASE CENTER
              </div>
              <h1 className="text-2xl font-semibold tracking-tight md:text-[28px]">
                {page === "overview"
                  ? "每一次发布，都有据可查。"
                  : currentTitle}
              </h1>
              <p className="mt-2 text-sm text-slate-400">
                {page === "overview"
                  ? "从代码检查到构建产物，在一个工作空间里掌握发布进展。"
                  : "固定 Commit、保留操作记录，安全地准备下一个版本。"}
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                disabled={loading}
                onClick={() => void refresh()}
              >
                <RefreshCw
                  size={15}
                  className={loading ? "animate-spin" : ""}
                />
                刷新
              </Button>
              {page !== "new" && (
                <Button onClick={() => navigate("new")}>
                  <Plus size={16} />
                  新建发布
                </Button>
              )}
            </div>
          </div>
          {error && (
            <div
              role="alert"
              className="mb-5 flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700"
            >
              <TriangleAlert size={18} className="shrink-0" />
              <span className="min-w-0 break-words">{error}</span>
              <button
                className="ml-auto"
                aria-label="关闭错误"
                onClick={() => setError("")}
              >
                <X size={16} />
              </button>
            </div>
          )}
          {data?.githubError && (
            <div
              role="status"
              className="mb-5 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800"
            >
              GitHub 数据暂不可用：{data.githubError}
              。本地任务与审计仍可查看；预检不会将未知结果视为通过。
            </div>
          )}
          {loading && !data ? (
            <Card className="flex min-h-80 items-center justify-center gap-3 text-sm text-slate-400">
              <LoaderCircle className="animate-spin" size={20} />
              正在读取仓库与 GitHub 状态…
            </Card>
          ) : (
            <>
              {page === "overview" && (
                <>
                  <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                    {[
                      {
                        label: "最新正式版本",
                        value: latest?.tag || "暂无数据",
                        detail: latest
                          ? date(latest.publishedAt)
                          : "以 GitHub Release 为准",
                        icon: Package,
                        color: "text-primary bg-violet-50 dark:bg-violet-950",
                      },
                      {
                        label: "候选版本",
                        value: candidate?.tag || "尚未创建",
                        detail: candidate
                          ? candidate.draft
                            ? "Draft · 尚未发布"
                            : "Prerelease · 预发布"
                          : "先创建并检查发布计划",
                        icon: GitBranch,
                        color: "text-blue-600 bg-blue-50 dark:bg-blue-950",
                      },
                      {
                        label: "进行中的任务",
                        value: String(tasks.filter(active).length).padStart(
                          2,
                          "0",
                        ),
                        detail: "仓库级互斥 · 同时一个任务",
                        icon: Activity,
                        color: "text-amber-600 bg-amber-50 dark:bg-amber-950",
                      },
                      {
                        label: "本地任务记录",
                        value: String(tasks.length).padStart(2, "0"),
                        detail: "Dry Run、调试构建与产物复核",
                        icon: History,
                        color:
                          "text-emerald-600 bg-emerald-50 dark:bg-emerald-950",
                      },
                    ].map((stat) => (
                      <Card key={stat.label} className="p-5">
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-slate-500">
                            {stat.label}
                          </span>
                          <span className={cn("rounded-lg p-2", stat.color)}>
                            <stat.icon size={16} />
                          </span>
                        </div>
                        <div className="mb-2 mt-4 text-2xl font-semibold tracking-tight">
                          {stat.value}
                        </div>
                        <p className="text-xs text-slate-400">{stat.detail}</p>
                      </Card>
                    ))}
                  </div>
                  <div className="grid gap-6 xl:grid-cols-[minmax(0,1.75fr)_minmax(280px,1fr)]">
                    <div className="space-y-6">
                      <Card className="overflow-hidden">
                        <div className="relative border-b border-violet-100 bg-gradient-to-br from-violet-50 via-white to-blue-50 p-6 dark:border-violet-900 dark:from-violet-950 dark:via-slate-900 dark:to-slate-900">
                          <div className="mb-4 flex items-center gap-2 text-xs font-medium text-primary">
                            <ShieldCheck size={16} />
                            安全发布，从准备开始
                          </div>
                          <h2 className="text-xl font-semibold">
                            让下一次发布更从容
                          </h2>
                          <p className="mt-2 max-w-md text-sm leading-6 text-slate-500">
                            选择分支与平台，先完成版本预检，再查看完整执行计划。每一步都有明确的状态与操作记录。
                          </p>
                          <Button
                            className="mt-5"
                            onClick={() => navigate("new")}
                          >
                            创建发布计划
                            <ArrowRight size={15} />
                          </Button>
                        </div>
                        <div className="grid grid-cols-3 gap-3 p-5">
                          {[
                            "选择版本与平台",
                            "检查并预览计划",
                            "运行安全调试构建",
                          ].map((t, i) => (
                            <div
                              key={t}
                              className="flex items-start gap-2 text-xs text-slate-500"
                            >
                              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-slate-100 font-mono text-[10px] text-slate-400 dark:bg-slate-800">
                                0{i + 1}
                              </span>
                              <span className="pt-0.5 leading-5">{t}</span>
                            </div>
                          ))}
                        </div>
                      </Card>
                      <Card>
                        <div className="panel-title">
                          <h2>最近任务</h2>
                          <button
                            className="text-xs font-normal text-primary"
                            onClick={() => navigate("builds")}
                          >
                            查看全部 →
                          </button>
                        </div>
                        {taskRows(4)}
                      </Card>
                      <Card>
                        <div className="panel-title">
                          <h2>GitHub 构建动态</h2>
                          <span className="text-xs font-normal text-slate-400">
                            最近 20 次
                          </span>
                        </div>
                        {data?.runs.length ? (
                          data.runs.slice(0, 5).map((run) => (
                            <div
                              key={run.id}
                              className="flex flex-wrap items-center gap-3 border-t border-slate-100 px-5 py-4 dark:border-slate-800"
                            >
                              <div className="min-w-0 flex-1">
                                <div className="truncate text-sm">
                                  <GitHubLink url={run.url}>
                                    {run.workflow}
                                  </GitHubLink>
                                </div>
                                <p className="mt-1 font-mono text-xs text-slate-400">
                                  {run.sha.slice(0, 10)} · {run.event}
                                </p>
                              </div>
                              <Badge state={run.conclusion || run.status} />
                            </div>
                          ))
                        ) : (
                          <Empty>暂无 GitHub 工作流数据。</Empty>
                        )}
                      </Card>
                    </div>
                    <div className="space-y-6">
                      <Card>
                        <div className="panel-title">
                          <h2>工作环境</h2>
                          <Monitor size={16} className="text-slate-400" />
                        </div>
                        <div className="space-y-5 p-5">
                          {[
                            ["当前分支", data?.branch || "—"],
                            ["应用版本", data?.localVersion || "—"],
                            ["工作区", data?.dirty ? "存在未提交改动" : "干净"],
                            [
                              "GitHub 凭据",
                              data?.tokenConfigured
                                ? "已在服务端配置"
                                : "未配置 · 公开只读",
                            ],
                            [
                              "调试构建",
                              data?.debugEnabled ? "服务端已启用" : "默认关闭",
                            ],
                          ].map(([k, v]) => (
                            <div
                              key={k}
                              className="flex items-start justify-between gap-3 text-xs"
                            >
                              <span className="shrink-0 text-slate-400">
                                {k}
                              </span>
                              <span className="break-all text-right">{v}</span>
                            </div>
                          ))}
                          <div className="rounded-lg bg-slate-50 p-3 dark:bg-slate-800">
                            <div className="mb-2 flex items-center gap-1 text-[10px] text-slate-400">
                              <GitCommitHorizontal size={13} />
                              本地 HEAD
                            </div>
                            <code className="break-all text-[11px] text-slate-500">
                              {data?.localSha || "—"}
                            </code>
                          </div>
                        </div>
                      </Card>
                      <Card className="border-violet-200 bg-violet-50/30 dark:border-violet-900">
                        <div className="p-5">
                          <LockKeyhole
                            className="mb-3 text-primary"
                            size={21}
                          />
                          <h2 className="text-sm font-semibold">
                            正式发布暂未开放
                          </h2>
                          <p className="mb-4 mt-2 text-xs leading-6 text-slate-500">
                            当前支持计划、调试构建和本地产物复核。Draft Release
                            与正式发布审批仍待实现。本地调试产物复核和验收已开放。
                          </p>
                          <Button variant="outline" className="w-full" disabled>
                            <LockKeyhole size={14} />
                            正式发布 · Phase 2
                          </Button>
                        </div>
                      </Card>
                      <div className="px-1 text-xs leading-6 text-slate-400">
                        <ShieldCheck
                          size={14}
                          className="mr-1 inline text-emerald-600"
                        />
                        所有调试产物与正式发布渠道隔离。现有 Windows EXE、Store
                        AppX 和 iOS 发布流程保持独立。
                      </div>
                    </div>
                  </div>
                </>
              )}
              {page === "new" && <CloudPanel request={api} branch={data?.branch || ""} version={data?.localVersion || ""} />}
              {page === "legacy" && (
                <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
                  <Card className="p-6">
                    <div className="mb-6 flex items-center gap-3 text-sm">
                      <Badge state="running">01 版本与平台</Badge>
                      <ChevronRight size={14} className="text-slate-300" />
                      <span className="text-slate-400">02 预检与执行</span>
                    </div>
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        void preview();
                      }}
                      className="space-y-6"
                    >
                      <div className="grid gap-5 sm:grid-cols-2">
                        <label className="field-label">
                          源码分支
                          <Input
                            list="branches"
                            required
                            value={input.branch}
                            onChange={(e) =>
                              setInput({ ...input, branch: e.target.value })
                            }
                          />
                          <datalist id="branches">
                            {data?.branches.map((b) => (
                              <option key={b} value={b} />
                            ))}
                          </datalist>
                          <span className="field-help">
                            预检后固定 Commit SHA
                          </span>
                        </label>
                        <label className="field-label">
                          候选版本
                          <Input
                            placeholder="例如 1.5.2"
                            required
                            value={input.version}
                            onChange={(e) =>
                              setInput({ ...input, version: e.target.value })
                            }
                          />
                          <span className="field-help">
                            不会自动修改仓库版本文件
                          </span>
                        </label>
                      </div>
                      <label className="field-label">
                        发布渠道
                        <select
                          className="select-input"
                          value={input.channel}
                          onChange={(e) =>
                            setInput({
                              ...input,
                              channel: e.target.value as PlanInput["channel"],
                            })
                          }
                        >
                          <option value="stable">Stable · 稳定版计划</option>
                          <option value="prerelease">
                            Prerelease · 预发布计划
                          </option>
                        </select>
                      </label>
                      <fieldset>
                        <legend className="mb-3 text-sm font-medium">
                          目标平台{" "}
                          <span className="ml-2 text-xs font-normal text-slate-400">
                            调试仅构建所选平台 · Full 版本
                          </span>
                        </legend>
                        <div className="grid gap-3 sm:grid-cols-3">
                          {Object.entries(platformNames).map(([p, label]) => (
                            <label
                              key={p}
                              className={cn(
                                "flex cursor-pointer items-start gap-2 rounded-xl border p-4 text-sm",
                                input.platforms.includes(p as any)
                                  ? "border-primary bg-violet-50/50 dark:bg-violet-950/40"
                                  : "border-slate-200 dark:border-slate-700",
                              )}
                            >
                              <input
                                type="checkbox"
                                className="mt-1 accent-primary"
                                checked={input.platforms.includes(p as any)}
                                onChange={(e) =>
                                  setInput({
                                    ...input,
                                    platforms: e.target.checked
                                      ? [...input.platforms, p as any]
                                      : input.platforms.filter((v) => v !== p),
                                  })
                                }
                              />
                              <span>{label}</span>
                            </label>
                          ))}
                        </div>
                      </fieldset>
                      <label className="field-label">
                        发布说明
                        <textarea
                          className="select-input min-h-36 resize-y py-3"
                          placeholder="记录此次候选版本的更新与验证范围，仅保存到本地计划。"
                          maxLength={20000}
                          value={input.notes}
                          onChange={(e) =>
                            setInput({ ...input, notes: e.target.value })
                          }
                        />
                      </label>
                      <div className="flex justify-end border-t border-slate-100 pt-5 dark:border-slate-800">
                        <Button disabled={busy || !input.platforms.length}>
                          {busy ? (
                            <LoaderCircle size={15} className="animate-spin" />
                          ) : (
                            <ShieldCheck size={15} />
                          )}
                          检查并预览计划
                          <ArrowRight size={15} />
                        </Button>
                      </div>
                    </form>
                  </Card>
                  <Card className="h-fit p-6">
                    <h2 className="mb-4 text-sm font-semibold">
                      发布前，我们会检查
                    </h2>
                    <div className="space-y-4">
                      {[
                        "固定远端 Commit SHA",
                        "版本文件与 lockfile 一致性",
                        "Tag 与 Release 重复冲突",
                        "现有关键 CI 证据",
                        "隔离工作流与服务端配置",
                      ].map((t) => (
                        <div
                          className="flex gap-2 text-xs text-slate-500"
                          key={t}
                        >
                          <CircleDashed
                            size={16}
                            className="shrink-0 text-primary"
                          />
                          {t}
                        </div>
                      ))}
                    </div>
                    <p className="mt-6 border-t border-slate-100 pt-4 text-xs leading-6 text-slate-400 dark:border-slate-800">
                      预检和 Dry Run
                      不执行现有发布脚本。正式版本发布仍有独立质量门禁。
                    </p>
                  </Card>
                </div>
              )}
              {page === "preflight" &&
                (plan ? (
                  <div className="space-y-5">
                    <Card className="p-5">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <h2 className="font-semibold">
                            v{plan.version}{" "}
                            <span className="ml-2 text-xs font-normal text-slate-400">
                              {plan.channel} · {plan.branch}
                            </span>
                          </h2>
                          <p className="mt-2 break-all font-mono text-xs text-slate-400">
                            {plan.sha || "无法固定 SHA"}
                          </p>
                        </div>
                        <Badge state={plan.ready ? "pass" : "fail"}>
                          {plan.ready ? "计划可执行 Dry Run" : "存在阻断项"}
                        </Badge>
                      </div>
                    </Card>
                    <Card>
                      <div className="panel-title">
                        <h2>预检结果</h2>
                        <span className="text-xs font-normal text-slate-400">
                          未知项不代表通过
                        </span>
                      </div>
                      <div className="divide-y divide-slate-100 dark:divide-slate-800">
                        {plan.checks.map((c) => (
                          <div
                            className="flex items-start gap-3 p-4 md:px-5"
                            key={c.name}
                          >
                            {c.status === "pass" ? (
                              <CircleCheck
                                size={18}
                                className="mt-0.5 shrink-0 text-emerald-600"
                              />
                            ) : c.status === "fail" ? (
                              <TriangleAlert
                                size={18}
                                className="mt-0.5 shrink-0 text-red-500"
                              />
                            ) : (
                              <CircleDashed
                                size={18}
                                className="mt-0.5 shrink-0 text-amber-500"
                              />
                            )}
                            <div className="min-w-0">
                              <p className="text-sm font-medium">{c.name}</p>
                              <p className="mt-1 break-words text-xs leading-5 text-slate-500">
                                {c.detail}
                              </p>
                            </div>
                          </div>
                        ))}
                      </div>
                    </Card>
                    <Card className="p-5">
                      <h2 className="mb-3 text-sm font-semibold">
                        执行计划与副作用
                      </h2>
                      <div className="space-y-2">
                        {plan.effects.map((t) => (
                          <p
                            className="flex gap-2 text-xs leading-6 text-slate-500"
                            key={t}
                          >
                            <Check
                              size={14}
                              className="mt-1 shrink-0 text-primary"
                            />
                            {t}
                          </p>
                        ))}
                      </div>
                      <div className="mt-4 rounded-lg bg-slate-50 p-3 text-xs leading-6 text-slate-500 dark:bg-slate-800">
                        目标：
                        {plan.platforms.map((p) => platformNames[p]).join("、")}
                        <br />
                        工作流控制分支：{plan.workflowRef}
                        <br />
                        说明：{plan.notes || "未填写"}
                      </div>
                      <label className="mt-5 flex items-start gap-2 text-xs leading-5 text-slate-500">
                        <input
                          type="checkbox"
                          className="mt-1 accent-primary"
                          checked={confirmed}
                          onChange={(e) => setConfirmed(e.target.checked)}
                        />
                        我确认启动所选平台的调试构建，将消耗 GitHub Actions
                        额度；这不授权正式发布。
                      </label>
                      <div className="mt-5 flex flex-wrap gap-3">
                        <Button
                          variant="outline"
                          disabled={busy}
                          onClick={() => start("dry-run")}
                        >
                          运行 Dry Run
                        </Button>
                        <Button
                          disabled={busy || !plan.debugReady || !confirmed}
                          onClick={() => start("debug")}
                        >
                          <Terminal size={15} />
                          启动调试构建
                        </Button>
                        <Button disabled variant="outline">
                          <LockKeyhole size={14} />
                          正式发布 · Phase 2
                        </Button>
                      </div>
                      {!plan.debugReady && (
                        <p className="mt-3 text-xs text-amber-600">
                          调试构建尚未就绪。请先解决阻断项、部署专用
                          workflow，并在服务端启用权限。
                        </p>
                      )}
                    </Card>
                  </div>
                ) : (
                  <Card>
                    <Empty>
                      尚无预检计划。
                      <Button onClick={() => navigate("new")}>
                        创建发布计划
                      </Button>
                    </Empty>
                  </Card>
                ))}
              {page === "builds" && (
                <div className="space-y-6">
                <CloudPanel request={api} branch={data?.branch || ""} version={data?.localVersion || ""} tasksOnly />
                <div className="grid items-start gap-6 xl:grid-cols-[330px_minmax(0,1fr)]">
                  <Card>
                    <div className="panel-title">
                      <h2>本地任务</h2>
                      <Badge state="unknown">{tasks.length}</Badge>
                    </div>
                    {taskRows()}
                  </Card>
                  {focused ? (
                    <div className="space-y-5">
                      <Card className="p-5">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <h2 className="font-semibold">
                              v{focused.plan.version} · {modeName(focused.mode)}
                            </h2>
                            <p className="mt-2 break-all font-mono text-xs text-slate-400">
                              {focused.id}
                            </p>
                          </div>
                          <Badge state={focused.state}>
                            {runningLabel(focused)}
                          </Badge>
                        </div>
                        <dl className="mt-5 grid gap-4 text-xs sm:grid-cols-2">
                          <div>
                            <dt className="text-slate-400">固定源码 Commit</dt>
                            <dd className="mt-1 break-all font-mono">
                              {focused.plan.sha || "未能固定"}
                            </dd>
                          </div>
                          <div>
                            <dt className="text-slate-400">创建时间</dt>
                            <dd className="mt-1">{date(focused.createdAt)}</dd>
                          </div>
                        </dl>
                        {focused.error && (
                          <p className="mt-4 rounded-lg bg-amber-50 p-3 text-xs leading-6 text-amber-800">
                            {focused.error}
                          </p>
                        )}
                        <div className="mt-4 flex flex-wrap items-center gap-3">
                          {active(focused) ? (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={busy}
                              onClick={() =>
                                void perform(async () => {
                                  await api(`tasks/${focused.id}/cancel`, {});
                                })
                              }
                            >
                              取消任务
                            </Button>
                          ) : (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={busy}
                              onClick={() => {
                                if (focused.mode === "publication") {
                                  navigate("formal");
                                  return;
                                }
                                if (focused.mode === "verify") {
                                  navigate("artifacts");
                                  return;
                                }
                                setInput(focused.plan);
                                void preview({
                                  branch: focused.plan.branch,
                                  version: focused.plan.version,
                                  channel: focused.plan.channel,
                                  platforms: focused.plan.platforms,
                                  notes: focused.plan.notes,
                                });
                              }}
                            >
                              {focused.mode === "publication" ? "查看正式候选与后续操作" : focused.mode === "verify"
                                ? "查看校验结果与重试"
                                : "重新预检并重试"}
                            </Button>
                          )}
                          {focused.runId && (
                            <GitHubLink
                              url={`https://github.com/cropflre/nowen-note/actions/runs/${focused.runId}`}
                            >
                              查看 GitHub Run
                            </GitHubLink>
                          )}
                        </div>
                        {focused.mode === "dry-run" && (
                          <p className="mt-4 text-xs text-slate-400">
                            Dry Run 只验证计划；未运行编译、打包或发布。
                          </p>
                        )}
                      </Card>
                      <Card>
                        <div className="panel-title">
                          <h2>平台与步骤</h2>
                          <Radio size={15} className="text-primary" />
                        </div>
                        {focused.jobs.length ? (
                          focused.jobs.map((job) => (
                            <div
                              key={job.id}
                              className="border-t border-slate-100 p-5 dark:border-slate-800"
                            >
                              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                                <h3 className="text-sm font-medium">
                                  {job.name}
                                </h3>
                                <Badge state={job.conclusion || job.status} />
                              </div>
                              <div className="space-y-2">
                                {job.steps.map((s, i) => (
                                  <div
                                    key={i}
                                    className="flex items-center gap-2 text-xs text-slate-500"
                                  >
                                    {s.conclusion === "success" ? (
                                      <Check
                                        size={13}
                                        className="text-emerald-600"
                                      />
                                    ) : s.status === "in_progress" ? (
                                      <LoaderCircle
                                        size={13}
                                        className="animate-spin text-primary"
                                      />
                                    ) : (
                                      <CircleDashed size={13} />
                                    )}
                                    <span className="min-w-0 flex-1">
                                      {s.name}
                                    </span>
                                    <span>
                                      {stateNames[s.conclusion || s.status] ||
                                        s.conclusion ||
                                        s.status}
                                    </span>
                                  </div>
                                ))}
                              </div>
                              <Button
                                className="mt-4"
                                size="sm"
                                variant="outline"
                                disabled={busy || job.status !== "completed"}
                                onClick={() =>
                                  void perform(async () => {
                                    await api(
                                      `tasks/${focused.id}/logs/${job.id}`,
                                      {},
                                    );
                                    setAudit(await api("audit"));
                                  })
                                }
                              >
                                <FileText size={13} />
                                读取已完成 Job 日志
                              </Button>
                            </div>
                          ))
                        ) : (
                          <Empty>
                            {focused.mode === "dry-run"
                              ? "计划检查详情见下方审计日志。"
                              : focused.mode === "verify"
                                ? "下载与校验进度见审计日志；不会建立新的 GitHub Run。"
                                : focused.mode === "publication"
                                  ? "正式候选操作进度见审计日志；使用已有构建，不建立新的 Run。"
                                : "等待 GitHub 建立构建任务。"}
                          </Empty>
                        )}
                      </Card>
                      <Card className="overflow-hidden">
                        <div className="panel-title">
                          <h2>实时审计与构建日志</h2>
                          <span className="text-xs font-normal text-slate-400">
                            已脱敏
                          </span>
                        </div>
                        <p className="px-5 pt-3 text-xs leading-5 text-slate-400">
                          实时更新任务与步骤状态。GitHub 完整 Job
                          日志在结束后读取；最多读取 2
                          MB，超长日志保存首尾摘要并标记截断。
                        </p>
                        <pre
                          className="m-4 max-h-[440px] overflow-auto rounded-lg bg-[#151a2d] p-4 font-mono text-[11px] leading-6 text-slate-300"
                          aria-label="构建日志"
                        >
                          {audit
                            .filter((a) => a.taskId === focused.id)
                            .sort((a, b) => a.seq - b.seq)
                            .map(
                              (a) =>
                                `[${date(a.at)}] ${a.event}\n${a.detail}\n`,
                            )
                            .join("\n") || "等待任务日志…"}
                        </pre>
                      </Card>
                    </div>
                  ) : (
                    <Card>
                      <Empty>选择任务以查看实时进度与日志。</Empty>
                    </Card>
                  )}
                </div>
                </div>
              )}
              {page === "channels" && <ChannelsPanel initialVersion={data?.localVersion || "1.5.2"} revision={audit[0]?.seq || 0} request={api} />}
              {page === "formal" && <PublicationPanel revision={audit[0]?.seq || 0} tasks={tasks} request={api} />}
              {page === "artifacts" && (
                <div className="space-y-6">
                  <ArtifactReview
                    tasks={tasks}
                    busy={busy}
                    verify={(sourceId, retry) =>
                      void perform(async () => {
                        const storage = `rc-verify-${sourceId}`;
                        const key = retry
                          ? crypto.randomUUID()
                          : sessionStorage.getItem(storage) ||
                            crypto.randomUUID();
                        sessionStorage.setItem(storage, key);
                        const task = await api<Task>(
                          `tasks/${sourceId}/verify`,
                          { key },
                        );
                        setTasks((previous) => [
                          task,
                          ...previous.filter((t) => t.id !== task.id),
                        ]);
                      })
                    }
                    cancel={(id) =>
                      void perform(async () => {
                        await api(`tasks/${id}/cancel`, {});
                      })
                    }
                    accept={(task) =>
                      void perform(async () => {
                        const accepted = await api<Task>(
                          `tasks/${task.id}/accept`,
                          {
                            version: task.plan.version,
                            sha: task.plan.sha,
                            confirmDebugOnly: true,
                          },
                        );
                        setTasks((previous) =>
                          previous.map((t) =>
                            t.id === accepted.id ? accepted : t,
                          ),
                        );
                      })
                    }
                  />
                  <Card>
                    <div className="panel-title">
                      <h2>调试构建产物</h2>
                      <ArrowDownToLine size={16} className="text-slate-400" />
                    </div>
                    {tasks.some((t) => t.artifacts.length) ? (
                      tasks
                        .filter((t) => t.mode === "debug")
                        .flatMap((t) =>
                          t.artifacts.map((a) => (
                            <div
                              className="border-t border-slate-100 p-5 dark:border-slate-800"
                              key={`${t.id}-${a.id}`}
                            >
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <div className="min-w-0 text-sm font-medium break-all">
                                  {a.name}
                                </div>
                                <Badge
                                  state={
                                    a.expired
                                      ? "failed"
                                      : tasks.find(
                                            (v) =>
                                              v.mode === "verify" &&
                                              v.sourceTaskId === t.id,
                                          )?.state === "succeeded"
                                        ? "pass"
                                        : "unknown"
                                  }
                                >
                                  {a.expired
                                    ? "已过期"
                                    : tasks.find(
                                          (v) =>
                                            v.mode === "verify" &&
                                            v.sourceTaskId === t.id,
                                        )?.state === "succeeded"
                                      ? "本机已复核"
                                      : "未下载验证"}
                                </Badge>
                              </div>
                              <p className="mt-2 text-xs text-slate-400">
                                {bytes(a.size)} · v{t.plan.version} · 源码{" "}
                                {t.plan.sha.slice(0, 10)}
                              </p>
                              <p className="mt-2 break-all font-mono text-[11px] text-slate-500">
                                {a.digest || "GitHub 未提供 digest"}
                              </p>
                              {t.runId && (
                                <div className="mt-3 text-xs">
                                  <GitHubLink
                                    url={`https://github.com/cropflre/nowen-note/actions/runs/${t.runId}`}
                                  >
                                    查看 artifact 与 manifest
                                  </GitHubLink>
                                </div>
                              )}
                            </div>
                          )),
                        )
                    ) : (
                      <Empty>尚无调试产物。完成调试构建后在此查看。</Empty>
                    )}
                  </Card>
                  <Card>
                    <div className="panel-title">
                      <h2>已有 Release 资产 · 只读</h2>
                    </div>
                    {data?.releases.some((r) => r.assets.length) ? (
                      data.releases.slice(0, 4).map((r) => (
                        <div
                          className="border-t border-slate-100 p-5 dark:border-slate-800"
                          key={r.id}
                        >
                          <h3 className="mb-4 text-sm font-medium">
                            <GitHubLink url={r.url}>{r.tag}</GitHubLink>
                          </h3>
                          <div className="space-y-3">
                            {r.assets.map((a) => (
                              <div
                                key={a.name}
                                className="flex flex-wrap justify-between gap-2 text-xs"
                              >
                                <span className="min-w-0 break-all font-mono">
                                  {a.name}
                                </span>
                                <span className="text-slate-400">
                                  {bytes(a.size)} · 未下载验证
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))
                    ) : (
                      <Empty>暂无 Release 资产数据。</Empty>
                    )}
                  </Card>
                </div>
              )}
              {page === "history" && (
                <div className="space-y-6">
                  <Card>
                    <div className="panel-title">
                      <h2>GitHub 发布历史</h2>
                      <Badge state="unknown">只读</Badge>
                    </div>
                    {data?.releases.length ? (
                      data.releases.map((r) => (
                        <div
                          key={r.id}
                          className="flex flex-wrap items-center justify-between gap-4 border-t border-slate-100 p-5 dark:border-slate-800"
                        >
                          <div>
                            <div className="text-sm font-medium">
                              <GitHubLink url={r.url}>{r.tag}</GitHubLink>
                            </div>
                            <p className="mt-2 text-xs text-slate-400">
                              {date(r.publishedAt)} · {r.assets.length} 个资产
                            </p>
                          </div>
                          <Badge
                            state={
                              r.draft || r.prerelease ? "unknown" : "success"
                            }
                          >
                            {r.draft
                              ? "Draft"
                              : r.prerelease
                                ? "Prerelease"
                                : "已发布"}
                          </Badge>
                        </div>
                      ))
                    ) : (
                      <Empty>暂无发布数据。</Empty>
                    )}
                  </Card>
                  <Card>
                    <div className="panel-title">
                      <h2>本地操作审计</h2>
                      <span className="text-xs font-normal text-slate-400">
                        最近 500 条
                      </span>
                    </div>
                    {audit.length ? (
                      <div className="max-h-[560px] overflow-auto">
                        {audit
                          .filter((a) => !a.event.startsWith("job.log"))
                          .map((a) => (
                            <div
                              key={a.seq}
                              className="flex items-start gap-3 border-t border-slate-100 p-4 dark:border-slate-800"
                            >
                              <Clock3
                                size={15}
                                className="mt-1 shrink-0 text-slate-400"
                              />
                              <div className="min-w-0 flex-1">
                                <p className="break-all text-xs font-medium">
                                  {a.event}
                                </p>
                                <p className="mt-1 break-all text-xs text-slate-400">
                                  {a.taskId || "服务 / 计划"} · {date(a.at)}
                                </p>
                              </div>
                            </div>
                          ))}
                      </div>
                    ) : (
                      <Empty>还没有操作记录。</Empty>
                    )}
                  </Card>
                  <p className="text-xs text-slate-400">
                    本地产物验收不授予发布权限；已有 GitHub Releases
                    的历史审批证据不在此推断。
                  </p>
                </div>
              )}
            </>
          )}
          <footer className="mt-10 flex flex-wrap justify-between gap-3 border-t border-slate-200 pt-5 text-[10px] text-slate-400 dark:border-slate-800">
            <span>NOWEN · Release with confidence</span>
            <span className="flex items-center gap-1">
              <ShieldCheck size={12} />
              本机独立控制台 · Phase 3
            </span>
          </footer>
        </main>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
