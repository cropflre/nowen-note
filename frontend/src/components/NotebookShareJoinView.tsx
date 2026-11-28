import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";

interface NotebookShareJoinViewProps {
  token: string;
}

type ShareInfo = Awaited<ReturnType<typeof api.getNotebookShareInfo>>;

export default function NotebookShareJoinView({ token }: NotebookShareJoinViewProps) {
  const [info, setInfo] = useState<ShareInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    const hasToken = !!localStorage.getItem("nowen-token");
    if (!hasToken) {
      setNeedsLogin(true);
      setLoading(false);
      return;
    }
    api.getNotebookShareInfo(token)
      .then((data) => {
        if (!cancelled) setInfo(data);
      })
      .catch((err: any) => {
        if (cancelled) return;
        if (err?.status === 401) setNeedsLogin(true);
        else setError(err?.message || "分享链接不可用");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const join = async () => {
    setJoining(true);
    try {
      await api.joinNotebookShareLink(token);
      toast.success("已加入共享笔记本");
      window.location.assign("/");
    } catch (err: any) {
      if (err?.status === 401) {
        setNeedsLogin(true);
      } else {
        toast.error(err?.message || "加入失败");
      }
    } finally {
      setJoining(false);
    }
  };

  const loginUrl = `/login?redirect=${encodeURIComponent(`/notebook-share/${token}`)}`;

  return (
    <div className="relative min-h-screen overflow-hidden bg-gradient-to-br from-slate-50 via-indigo-50/40 to-sky-50/50 text-tx-primary dark:from-[#070a12] dark:via-[#0b1020] dark:to-[#0a1322] flex items-center justify-center px-4 py-8">
      <div className="pointer-events-none fixed inset-0 overflow-hidden" aria-hidden="true">
        <div className="absolute -top-36 -left-24 h-96 w-96 rounded-full bg-indigo-400/16 blur-3xl dark:bg-indigo-500/22" />
        <div className="absolute -bottom-36 -right-24 h-96 w-96 rounded-full bg-sky-400/16 blur-3xl dark:bg-cyan-500/18" />
      </div>

      <div className="relative w-full max-w-sm overflow-hidden rounded-[28px] border border-white/75 bg-white/84 p-7 shadow-[0_24px_64px_-20px_rgba(15,23,42,0.16)] backdrop-blur-2xl dark:border-white/[0.09] dark:bg-zinc-900/78 dark:shadow-[0_28px_72px_-16px_rgba(0,0,0,0.68)]">
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-transparent via-indigo-500/60 to-transparent" />

        <div className="mb-4 inline-flex items-center gap-1.5 rounded-full border border-indigo-500/20 bg-indigo-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-indigo-600 dark:text-indigo-300">
          共享笔记本
        </div>
        {loading ? (
          <div className="py-6 text-center text-sm text-tx-secondary">正在加载...</div>
        ) : needsLogin ? (
          <>
            <h1 className="text-lg font-bold tracking-tight text-tx-primary mb-2">登录后加入共享笔记本</h1>
            <p className="text-sm leading-relaxed text-tx-secondary mb-5">这个链接会把笔记本加入到你的账号中。</p>
            <Button
              className="w-full rounded-xl bg-gradient-to-r from-indigo-600 via-indigo-500 to-violet-600 text-white shadow-md shadow-indigo-500/25 hover:from-indigo-500 hover:to-violet-500"
              onClick={() => window.location.assign(loginUrl)}
            >
              去登录
            </Button>
          </>
        ) : error ? (
          <>
            <h1 className="text-lg font-bold tracking-tight text-tx-primary mb-2">链接不可用</h1>
            <p className="text-sm leading-relaxed text-tx-secondary">{error}</p>
          </>
        ) : info ? (
          <>
            <div className="mb-4 flex items-center gap-3.5">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500/16 to-sky-500/14 text-2xl ring-1 ring-inset ring-indigo-500/20 shadow-sm">
                {info.icon || "📒"}
              </div>
              <div className="min-w-0">
                <h1 className="text-lg font-bold tracking-tight text-tx-primary truncate">
                  {info.name}
                </h1>
                <span className="mt-1 inline-flex rounded-full bg-emerald-500/12 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">
                  {info.role === "editor" ? "可编辑权限" : "只读权限"}
                </span>
              </div>
            </div>
            <p className="text-sm leading-relaxed text-tx-secondary mb-5">
              {info.ownerDisplayName || info.ownerUsername} 分享给你，权限为
              {info.role === "editor" ? "可编辑" : "只读"}。
            </p>
            <Button
              className="w-full rounded-xl bg-gradient-to-r from-indigo-600 via-indigo-500 to-violet-600 text-white shadow-md shadow-indigo-500/25 hover:from-indigo-500 hover:to-violet-500"
              onClick={join}
              disabled={joining}
            >
              {joining ? "正在加入..." : "加入笔记本"}
            </Button>
          </>
        ) : null}
      </div>
    </div>
  );
}
