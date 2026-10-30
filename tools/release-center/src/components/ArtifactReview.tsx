import { useState } from "react";
import { CircleCheck, LoaderCircle, ShieldCheck } from "lucide-react";
import type { Task } from "../../shared";
import { Button, Card, Input } from "./ui";

export function ArtifactReview({
  tasks,
  busy,
  verify,
  accept,
  cancel,
}: {
  tasks: Task[];
  busy: boolean;
  verify: (sourceId: string, retry: boolean) => void;
  accept: (task: Task) => void;
  cancel: (id: string) => void;
}) {
  const [version, setVersion] = useState<Record<string, string>>({});
  const [confirmed, setConfirmed] = useState<Record<string, boolean>>({});
  const sources = tasks.filter(
    (task) => task.mode === "debug" && task.state === "succeeded",
  );
  return (
    <div className="space-y-5">
      <div className="rounded-lg border border-blue-100 bg-blue-50 p-4 text-xs leading-6 text-blue-800">
        下载复核会验证 archive SHA-256、安全解压、固定 Commit 与
        manifest、逐文件 SHA-256 和更新元数据。
        校验与本地验收记录仅用于未签名调试产物；Draft 创建和正式发布尚未开放。
      </div>
      {sources.map((source) => {
        const task = tasks.find(
          (t) => t.mode === "verify" && t.sourceTaskId === source.id,
        );
        const running =
          !!task && ["queued", "running", "cancelling"].includes(task.state);
        return (
          <Card key={source.id} className="overflow-hidden">
            <div className="panel-title">
              <h2>v{source.plan.version} · 下载复核与调试验收</h2>
              <ShieldCheck size={16} className="shrink-0 text-primary" />
            </div>
            <div className="space-y-4 p-5">
              <p className="break-all font-mono text-xs text-slate-500">
                源码 SHA：{source.plan.sha}
              </p>
              <p className="text-xs text-slate-400">
                目标：{source.plan.platforms.join(" / ")} · 原构建任务{" "}
                {source.id}
              </p>
              {source.plan.notes && (
                <p className="break-words text-xs leading-5 text-slate-400">
                  说明：{source.plan.notes}
                </p>
              )}
              <div className="flex flex-wrap gap-3">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || running}
                  onClick={() => verify(source.id, !!task)}
                >
                  {running ? (
                    <LoaderCircle className="animate-spin" size={14} />
                  ) : (
                    <ShieldCheck size={14} />
                  )}
                  {running
                    ? "正在下载复核"
                    : task
                      ? "重新下载并复核"
                      : "下载并复核全部平台"}
                </Button>
                {running && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => cancel(task!.id)}
                  >
                    取消校验
                  </Button>
                )}
              </div>
              {task?.error && (
                <p
                  role="alert"
                  className="rounded-lg bg-red-50 p-3 text-xs leading-6 text-red-700"
                >
                  校验失败：{task.error}
                </p>
              )}
              {task && ["cancelled", "timed_out"].includes(task.state) && (
                <p className="text-xs text-amber-700">
                  {task.state === "cancelled" ? "校验已取消" : "校验已超时"}
                  ，可重新下载复核。
                </p>
              )}
              {task?.verifications?.map((result) => (
                <div
                  key={result.artifactId}
                  className="space-y-3 border-t border-slate-100 pt-4 dark:border-slate-800"
                >
                  <div className="flex items-center gap-2 text-sm font-medium text-emerald-600">
                    <CircleCheck size={16} />
                    {result.platform} · 本机校验通过
                  </div>
                  <p className="break-all font-mono text-[11px] text-slate-400">
                    archive：{result.archiveDigest}
                  </p>
                  <p className="text-xs text-slate-500">
                    更新元数据：{result.metadata.join("、")}
                  </p>
                  <div className="max-w-full overflow-x-auto">
                    <table className="w-full min-w-[640px] text-left text-xs">
                      <thead className="bg-slate-50 text-slate-400 dark:bg-slate-800">
                        <tr>
                          <th className="p-2">文件名</th>
                          <th>架构</th>
                          <th>大小</th>
                          <th>SHA-256</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.files.map((file) => (
                          <tr
                            key={file.name}
                            className="border-b border-slate-100 dark:border-slate-800"
                          >
                            <td className="p-2 font-mono">{file.name}</td>
                            <td className="pr-3">{file.architecture}</td>
                            <td className="whitespace-nowrap pr-3">
                              {file.size.toLocaleString()} B
                            </td>
                            <td className="max-w-56 break-all font-mono text-[10px]">
                              {file.sha256}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
              {task?.state === "succeeded" && !task.acceptance && (
                <div className="space-y-3 rounded-lg border border-violet-200 p-4 dark:border-violet-900">
                  <h3 className="text-sm font-semibold">记录本地调试验收</h3>
                  <label className="field-label text-xs">
                    输入版本号以确认本次验收
                    <Input
                      aria-label={`验收版本 ${source.id}`}
                      placeholder={task.plan.version}
                      value={version[task.id] || ""}
                      onChange={(e) =>
                        setVersion({ ...version, [task.id]: e.target.value })
                      }
                    />
                  </label>
                  <label className="flex items-start gap-2 text-xs leading-5 text-slate-500">
                    <input
                      type="checkbox"
                      className="mt-1 accent-primary"
                      checked={!!confirmed[task.id]}
                      onChange={(e) =>
                        setConfirmed({
                          ...confirmed,
                          [task.id]: e.target.checked,
                        })
                      }
                    />
                    我已检查上列文件和固定 SHA，确认仅记录调试验收；不授权
                    Draft、Tag 或正式发布。
                  </label>
                  <Button
                    size="sm"
                    disabled={
                      busy ||
                      version[task.id] !== task.plan.version ||
                      !confirmed[task.id]
                    }
                    onClick={() => accept(task)}
                  >
                    记录调试验收
                  </Button>
                </div>
              )}
              {task?.acceptance && (
                <div className="rounded-lg bg-emerald-50 p-4 text-xs leading-6 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                  <p className="font-semibold">已记录 · 仅调试验收</p>
                  <p>
                    {new Date(task.acceptance.at).toLocaleString("zh-CN", {
                      hour12: false,
                    })}{" "}
                    · 本机维护者
                  </p>
                  <p className="break-all font-mono text-[10px]">
                    验收证据 SHA-256：{task.acceptance.digest}
                  </p>
                  <p>正式发布仍不可用。</p>
                </div>
              )}
            </div>
          </Card>
        );
      })}
    </div>
  );
}
