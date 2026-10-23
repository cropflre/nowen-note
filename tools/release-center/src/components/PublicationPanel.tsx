import { useEffect, useRef, useState } from "react";
import { FileCheck, LoaderCircle, RefreshCw, ShieldCheck } from "lucide-react";
import type { PublicationView, ReleaseCandidate, Task } from "../../shared";
import { Button, Card, Input } from "./ui";

type Request = <T>(path: string, body?: unknown) => Promise<T>;
const states: Record<ReleaseCandidate["state"], string> = { verifying: "下载复核中", verified: "正式产物复核完成", drafting: "准备 Draft", draft: "Draft 待审批", approved: "已审批（30 分钟内有效）", publishing: "发布中", published: "已正式发布", failed: "复核失败", blocked: "操作受阻，需核查" };
async function requestKey(slot: string, value: unknown, fresh = false) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  const name = `${slot}-${Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  const key = (!fresh && sessionStorage.getItem(name)) || crypto.randomUUID();
  sessionStorage.setItem(name, key);
  return key;
}
export function PublicationPanel({ revision, tasks, request }: { revision: number; tasks: Task[]; request: Request }) {
  const [view, setView] = useState<PublicationView>();
  const [version, setVersion] = useState("");
  const [runId, setRunId] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const sequence = useRef(0);
  async function reload() {
    const ticket = ++sequence.current;
    try { const data = await request<PublicationView>("publication"); if (ticket === sequence.current) { setView(data); setError(""); } }
    catch (e) { if (ticket === sequence.current) setError((e as Error).message); }
  }
  useEffect(() => { void reload(); return () => { sequence.current++; }; }, [revision, request]);
  const active = tasks.some((t) => ["queued", "running", "reconciling", "cancelling"].includes(t.state));
  async function perform(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true); setError("");
    try { await action(); await reload(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function importRun(fresh = false) {
    const value = { version: version.trim(), runId: Number(runId), notes };
    await request("publication/import", { ...value, key: await requestKey("rc-formal-import", value, fresh) });
  }
  return <div className="space-y-6">
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
      正式候选只接收已存在 Tag 的成功 release.yml 构建，实际范围固定为完整桌面三平台，包含 Windows Full / Lite 和 macOS 双架构。
      控制台不推 Tag，不触发新的构建；Tag 已触发的 iOS 等任务由原流程负责。调试包不能晋升为正式包。
      新流程尚待回归验证，正式写操作默认关闭。
    </div>
    <Card className="space-y-3 border-dashed p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-semibold">Phase 2C · 独立桌面候选构建</h2>
        <span className="text-xs text-slate-500">候选包 · 不可直接发布</span>
      </div>
      <p className="text-sm leading-6 text-slate-500">可使用独立 GitHub Actions 构建完整 Windows Full/Lite、macOS 双架构及 Linux。
        输入固定 Commit SHA、稳定版本 X.Y.Z 和新 UUID；不会推 Tag，也不会创建 Draft、正式 Release、TestFlight 或商店上传。
        生成的候选 ZIP 与证据分开保存，未签名、未审批，不能冒充下方允许接管的 Tag 正式构建。</p>
      <a className="inline-flex rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-primary hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
        href="https://github.com/cropflre/nowen-note/actions/workflows/release-center-candidate.yml"
        target="_blank" rel="noreferrer">在 GitHub Actions 打开独立候选构建 ↗</a>
      <p className="text-xs text-amber-700 dark:text-amber-300">工作流需先登记到默认分支且在目标 Commit 中包含脚本；当前控制台不提供远端派发和生产晋升入口。完成真实调试验收前不应打开正式发布开关。</p>
    </Card>
    {error && <p role="alert" className="rounded-xl bg-red-50 p-4 text-sm text-red-700 dark:bg-red-950 dark:text-red-200">{error}</p>}
    <Card className="p-5">
      <h2 className="font-semibold">接管已有正式构建</h2>
      <form className="mt-4 space-y-4" onSubmit={(e) => { e.preventDefault(); void perform(() => importRun()); }}>
        <div className="grid gap-4 md:grid-cols-2">
          <label className="grid gap-2 text-xs text-slate-500">正式版本（X.Y.Z）<Input required value={version} disabled={busy || active} onChange={(e) => setVersion(e.target.value)} placeholder="1.5.2" /></label>
          <label className="grid gap-2 text-xs text-slate-500">正式 Actions Run ID<Input required type="number" min="1" step="1" value={runId} disabled={busy || active} onChange={(e) => setRunId(e.target.value)} placeholder="成功的 Tag 构建 Run ID" /></label>
        </div>
        <label className="grid gap-2 text-xs text-slate-500">正式发布说明<textarea required maxLength={20_000} value={notes} disabled={busy || active} onChange={(e) => setNotes(e.target.value)} className="min-h-32 rounded-lg border border-slate-200 bg-transparent p-3 text-sm dark:border-slate-700" /></label>
        <div className="flex flex-wrap gap-3">
          <Button disabled={busy || active}>{busy ? <LoaderCircle size={14} className="animate-spin" /> : <FileCheck size={14} />}接管并下载复核</Button>
          <Button type="button" variant="outline" disabled={busy || active || !version || !runId || !notes.trim()} onClick={() => void perform(() => importRun(true))}>新任务重新复核</Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => void reload()}><RefreshCw size={14} />刷新记录</Button>
        </div>
      </form>
      <p className="mt-3 text-xs leading-6 text-slate-500">接管、下载、Hash 和更新元数据校验只读执行。任务与既有调试构建共用互斥、SSE 和取消入口，进度可在“构建任务”查看。部分平台失败不能准备 Draft。</p>
    </Card>
    {!view && <p role="status" className="text-sm text-slate-500">加载正式候选…</p>}
    {view && !view.candidates.length && <Card className="p-8 text-center text-sm text-slate-500">尚无正式候选。已完成的调试验收不会自动出现在这里。</Card>}
    {view?.candidates.map((candidate) => <CandidateCard key={candidate.id} candidate={candidate} view={view} disabled={busy || active}
      submit={(operation, value, fresh) => perform(async () => {
        const body = operation === "approve" ? value : { ...value, key: await requestKey(`rc-formal-${candidate.id}-${operation}`, value, fresh) };
        await request(`publication/${candidate.id}/${operation}`, body);
      })} />)}
  </div>;
}
function CandidateCard({ candidate, view, disabled, submit }: { candidate: ReleaseCandidate; view: PublicationView; disabled: boolean;
  submit: (operation: "draft" | "approve" | "publish", body: any, fresh?: boolean) => Promise<void> }) {
  const [tag, setTag] = useState("");
  const [draft, setDraft] = useState(false);
  const [approval, setApproval] = useState(false);
  const [publish, setPublish] = useState(false);
  useEffect(() => { setDraft(false); setApproval(false); setPublish(false); }, [tag, candidate.digest, candidate.state]);
  const confirmed = tag === candidate.tag && !!candidate.digest;
  const value = { tag, digest: candidate.digest };
  return <Card className="min-w-0 space-y-4 p-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-semibold">{candidate.tag} · 正式候选</h2><span className="text-xs text-slate-500">{states[candidate.state]}</span></div>
    <p className="break-all font-mono text-xs text-slate-500">Commit {candidate.sha}<br />证据 {candidate.digest || "所有平台复核前无证据摘要"}</p>
    <p className="text-xs text-primary"><a href={`https://github.com/cropflre/nowen-note/actions/runs/${candidate.runId}`} target="_blank" rel="noreferrer">来源 Run {candidate.runId} · attempt {candidate.runAttempt}</a></p>
    {candidate.draftId && <p className="text-xs text-slate-500">绑定 Release ID {candidate.draftId} · 仅维护本工具创建的 Draft，不接管其他 Draft，不覆盖同名文件。</p>}
    {candidate.error && <p className="break-words text-xs text-red-600 dark:text-red-300">{candidate.error}</p>}
    {candidate.verifications.map((v) => <details key={v.platform} className="text-xs text-slate-500"><summary className="cursor-pointer">{v.platform} · {v.files.length} 个文件完成内容校验</summary>
      <div className="mt-2 overflow-x-auto"><table className="w-full min-w-[600px] text-left text-[11px]"><thead><tr><th>文件</th><th>大小</th><th>SHA-256</th></tr></thead><tbody>{v.files.map((f) => <tr key={f.name}><td className="py-2 pr-4">{f.name}</td><td className="pr-4">{f.size.toLocaleString()} B</td><td className="font-mono">{f.sha256}</td></tr>)}</tbody></table></div>
    </details>)}
    {candidate.approval && <p className="text-xs text-slate-500">审批：GitHub {candidate.approval.login}（ID {candidate.approval.actorId}）· {new Date(candidate.approval.at).toLocaleString("zh-CN")}<br />审批绑定远端文件 ID/摘要与发布说明；变化后需重新审批。</p>}
    {candidate.state !== "published" && <div className="space-y-3 border-t border-slate-100 pt-4 dark:border-slate-800">
      <label className="grid gap-2 text-xs text-slate-500">确认正式 Tag（{candidate.tag}）<Input value={tag} disabled={disabled} onChange={(e) => setTag(e.target.value)} /></label>
      <label className="flex items-start gap-2 text-xs leading-5 text-slate-500"><input type="checkbox" checked={draft} disabled={disabled || !candidate.digest} onChange={(e) => setDraft(e.target.checked)} />我确认创建或补齐此候选的未发布 Draft，仅上传上列已复核文件。</label>
      <Button variant="outline" disabled={disabled || !confirmed || !draft || !view.draftsEnabled} onClick={() => void submit("draft", { ...value, confirmDraft: true }, candidate.state === "blocked")}>准备 Draft</Button>
      {!view.draftsEnabled && <p className="text-xs text-amber-700 dark:text-amber-300">服务端 Draft 写开关和独立维护者凭据未配置。</p>}
      <label className="flex items-start gap-2 text-xs leading-5 text-slate-500"><input type="checkbox" checked={approval} disabled={disabled} onChange={(e) => setApproval(e.target.checked)} />我已核对正式构建来源、各平台产物及签名/公证情况，批准当前 Draft 的固定证据；此确认本身不发布。</label>
      <Button variant="outline" disabled={disabled || !confirmed || !approval || !view.draftsEnabled || !["draft", "approved"].includes(candidate.state)} onClick={() => void submit("approve", { ...value, confirmApproval: true })}><ShieldCheck size={14} />记录正式审批</Button>
      <label className="flex items-start gap-2 text-xs leading-5 text-slate-500"><input type="checkbox" checked={publish} disabled={disabled} onChange={(e) => setPublish(e.target.checked)} />我明确授权将已审批 Draft 转为正式 Release，并更新最新版本；这会通知用户并使更新资产可用。</label>
      <Button variant="destructive" disabled={disabled || !confirmed || !publish || !view.publishEnabled || candidate.state !== "approved"} onClick={() => void submit("publish", { ...value, confirmPublish: true })}>正式发布已审批版本</Button>
      {!view.publishEnabled && <p className="text-xs text-amber-700 dark:text-amber-300">正式发布开关关闭；未经过回归验收前请保持关闭。</p>}
    </div>}
  </Card>;
}
