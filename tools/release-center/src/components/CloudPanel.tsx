import { useEffect, useRef, useState } from "react";
import { CloudUpload, ExternalLink, LoaderCircle, RefreshCw } from "lucide-react";
import { BUILD_TARGETS, PUBLISH_CHANNELS } from "../../../../scripts/lib/release-cloud-contract.mjs";
import type { BuildTarget, PublishChannel, BuildRequest } from "../../../../scripts/lib/release-cloud-contract.mjs";
import type { CloudPlan, CloudRequest, CloudView } from "../../shared";
import { Button, Card, Input } from "./ui";
const names: Record<BuildTarget, string> = { windows: "Windows Full / Lite", macos: "macOS Intel / Apple Silicon", linux: "Linux x64", android: "Android APK / AAB", ios: "iOS IPA", store: "Microsoft Store AppX", docker: "Docker amd64 / arm64", fpk: "飞牛 FPK", upk: "绿联 UPK", clipper: "浏览器扩展 Chrome / Edge / Firefox" };
const channels: Record<PublishChannel, string> = { github: "GitHub Release", docker: "Docker Hub", testflight: "TestFlight" };
const states = { dispatching: "正在触发", unknown: "等待核对远端结果", running: "GitHub 执行中", succeeded: "已完成", failed: "失败，请核查各 Job" };
const active = (r: CloudRequest) => ["dispatching", "unknown", "running"].includes(r.state);
type Request = <T>(path: string, body?: unknown) => Promise<T>;
export function CloudPanel({ request, branch, version, tasksOnly = false }: { request: Request; branch: string; version: string; tasksOnly?: boolean }) {
  const [view, setView] = useState<CloudView>();
  const [ref, setRef] = useState(branch);
  const [candidate, setCandidate] = useState(version);
  const [notes, setNotes] = useState("");
  const [targets, setTargets] = useState<BuildTarget[]>(["windows", "macos", "linux"]);
  const [plan, setPlan] = useState<CloudPlan>();
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [log, setLog] = useState("");
  const [source, setSource] = useState<CloudRequest>();
  const [destinations, setDestinations] = useState<PublishChannel[]>([]);
  const [confirmation, setConfirmation] = useState("");
  const mounted = useRef(true);
  const refreshing = useRef(false);
  useEffect(() => { setRef(current => current || branch); setCandidate(current => current || version); }, [branch, version]);
  async function refresh() {
    if (refreshing.current) return;
    refreshing.current = true;
    try { const data = await request<CloudView>("cloud"); if (mounted.current) setView(data); }
    catch (e) { if (mounted.current) setError((e as Error).message); }
    finally { refreshing.current = false; }
  }
  useEffect(() => { mounted.current = true; void refresh(); const timer = setInterval(() => void refresh(), 5000); return () => { mounted.current = false; clearInterval(timer); }; }, [request]);
  async function perform(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError("");
    try { await fn(); await refresh(); } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  function invalidate() { setPlan(undefined); setConfirmed(false); }
  function publishOptions(value: CloudRequest): PublishChannel[] {
    const targets = (value.inputs as BuildRequest).targets;
    return PUBLISH_CHANNELS.filter(channel => channel === "docker" ? targets.includes("docker") : channel === "testflight" ? targets.includes("ios") : targets.some(target => !["docker", "ios", "store"].includes(target)));
  }
  const locked = busy || !view?.enabled || view.requests.some(active);
  return <div className="space-y-6">
    {!tasksOnly && <Card className="space-y-3 p-5">
      <h2 className="flex items-center gap-2 font-semibold"><CloudUpload size={20} />GitHub Actions 发版</h2>
      <p className="text-sm leading-6 text-slate-500">选择已提交的版本和目标，构建在 GitHub 后台运行。关闭本机不会中断远端任务。构建完成后可选择渠道确认发布。</p>
      {view && !view.enabled && <p role="status" className="text-sm text-amber-700">请为服务配置 GitHub Token（Contents 读、Actions 写权限）。</p>}
      {error && <p role="alert" className="break-words rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950">{error}</p>}
      <form className="space-y-5" onSubmit={e => { e.preventDefault(); void perform(async () => { setPlan(undefined); setConfirmed(false); setPlan(await request<CloudPlan>("cloud/plans", { branch: ref, version: candidate, targets, notes })); }); }}>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="field-label">源码分支<Input required value={ref} onChange={e => { setRef(e.target.value); invalidate(); }} placeholder="release/v1.5.4" /></label>
          <label className="field-label">发布版本<Input required value={candidate} onChange={e => { setCandidate(e.target.value); invalidate(); }} placeholder="X.Y.Z" /></label>
        </div>
        <fieldset><legend className="mb-3 text-sm font-medium">构建目标</legend><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{BUILD_TARGETS.map(target => <label key={target} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={targets.includes(target)} onChange={e => { setTargets(current => e.target.checked ? [...current, target] : current.filter(t => t !== target)); invalidate(); }} />{names[target]}</label>)}</div></fieldset>
        <label className="field-label">发布说明（可选）<textarea className="w-full rounded-lg border border-slate-200 bg-transparent p-3 text-sm dark:border-slate-700" rows={3} maxLength={10000} value={notes} onChange={e => { setNotes(e.target.value); invalidate(); }} /></label>
        <p className="text-xs leading-5 text-slate-500">FPK / UPK 会自动包含同次 Docker 双架构构建。iOS、Android 需要签名配置，macOS 正式分发需要签名与公证；FPK 需要已校验的 fnpack。AppX 和 NAS 商店上架使用各平台入口。</p>
        <Button disabled={locked || !targets.length}>{busy ? <LoaderCircle className="animate-spin" size={16} /> : null}检查远端版本</Button>
      </form>
      {plan && <div className="space-y-3 rounded-xl bg-slate-50 p-4 text-sm dark:bg-slate-800">
        <p>版本 {plan.version} · {plan.branch}</p><p className="break-all font-mono text-xs">{plan.sha}</p>
        <p>{plan.targets.map(t => names[t]).join("、")}</p>
        <label className="flex items-start gap-2"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />确认构建以上目标；本次不发布到任何渠道</label>
        <Button disabled={locked || !confirmed} onClick={() => void perform(async () => { await request("cloud/build", { planId: plan.id, confirm: true }); setConfirmed(false); })}>开始 GitHub 构建</Button>
      </div>}
    </Card>}
    {tasksOnly && error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    <div className="flex items-center justify-between"><h2 className="font-semibold">远端任务</h2><Button variant="outline" size="sm" disabled={busy} onClick={() => void refresh()}><RefreshCw size={14} />刷新</Button></div>
    {!view?.requests.length && <Card className="p-6 text-sm text-slate-500">还没有远端任务。先检查版本，再开始构建。</Card>}
    {view?.requests.map(value => <Card key={value.id} className="space-y-3 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="font-medium">{value.inputs.version} · {value.kind === "build" ? "构建" : "发布"} · {states[value.state]}</h3>{value.url && <a href={value.url} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-sm text-primary">GitHub 日志与产物<ExternalLink size={14} /></a>}</div>
      <p className="break-all text-xs text-slate-500">{value.branch} · {value.workflowSha.slice(0, 12)}{value.runId ? ` · Run ${value.runId} / attempt ${value.runAttempt || 1}` : ""}</p>
      {value.error && <p className="break-words text-sm text-amber-700">{value.error}</p>}
      {value.jobs.map(job => <details key={job.id} className="rounded-lg border border-slate-100 p-3 text-sm dark:border-slate-800"><summary className="cursor-pointer break-words">{job.name} · {job.conclusion || job.status}</summary><ul className="mt-2 space-y-1 text-xs text-slate-500">{job.steps.map((step, i) => <li key={i}>{step.name} · {step.conclusion || step.status}</li>)}</ul><Button className="mt-3" size="sm" variant="outline" disabled={busy || job.status !== "completed"} onClick={() => void perform(async () => { const result = await request<{ log: string }>(`cloud/${value.id}/logs`, { jobId: job.id }); setLog(result.log); })}>读取 Job 日志</Button></details>)}
      <div className="flex flex-wrap gap-2">
        {value.runId && active(value) && <Button size="sm" variant="outline" disabled={busy} onClick={() => void perform(async () => { await request(`cloud/${value.id}/cancel`, {}); })}>请求取消远端任务</Button>}
        {value.kind === "build" && value.state === "succeeded" && publishOptions(value).length > 0 && <Button size="sm" disabled={!view.publishEnabled || busy} onClick={() => { setSource(value); setDestinations(publishOptions(value).filter(c => c !== "testflight")); setConfirmation(""); }}>使用此构建发布</Button>}
      </div>
      {value.kind === "build" && value.state === "succeeded" && !view.publishEnabled && <p className="text-xs text-slate-500">产物已就绪。正式发布触发默认关闭，启用后可使用本次产物发布。</p>}
    </Card>)}
    {source && <Card className="space-y-4 p-5">
      <h2 className="font-semibold">发布已验证的 {source.inputs.version}</h2>
      <p className="text-sm text-slate-500">使用 Run {source.runId} 的已有产物。请确认目标渠道；已完成的外部发布无法通过取消任务撤销。</p>
      <div className="flex flex-wrap gap-4">{publishOptions(source).map(channel => <label className="flex items-center gap-2 text-sm" key={channel}><input type="checkbox" checked={destinations.includes(channel)} onChange={e => setDestinations(current => e.target.checked ? [...current, channel] : current.filter(c => c !== channel))} />{channels[channel]}</label>)}</div>
      <label className="field-label">输入版本号确认发布<Input value={confirmation} onChange={e => setConfirmation(e.target.value)} /></label>
      <Button disabled={locked || !view?.publishEnabled || !destinations.length || confirmation !== source.inputs.version} onClick={() => void perform(async () => {
        const value = { branch: ref, version: source.inputs.version, source_run_id: source.runId, source_attempt: source.runAttempt, channels: destinations, confirmation };
        const fingerprint = JSON.stringify(value), slot = `rc-cloud-publish-${fingerprint}`;
        const id = sessionStorage.getItem(slot) || crypto.randomUUID(); sessionStorage.setItem(slot, id);
        await request("cloud/publish", { ...value, request_id: id }); setSource(undefined);
      })}>确认向所选渠道发布</Button>
    </Card>}
    {log && <Card className="p-4"><h2 className="mb-3 font-semibold">Job 日志</h2><pre aria-label="远端 Job 日志" className="max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs">{log}</pre></Card>}
  </div>;
}
