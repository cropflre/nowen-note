import { useEffect, useRef, useState } from "react";
import { Download, ExternalLink, LoaderCircle, RefreshCw, ShieldCheck } from "lucide-react";
import {
  CHANNELS, RECEIPT_STATES, type ChannelId, type ChannelObservation, type ChannelView,
  type DistributionPlan, type DistributionReceipt,
} from "../../shared";
import { Button, Card, Input, cn } from "./ui";

const names: Record<ChannelId, string> = { "microsoft-store": "Microsoft Store", "docker-hub": "Docker Hub", nas: "NAS 应用商店" };
const states: Record<ChannelObservation["state"], string> = {
  available: "已观察到目标版本", pending: "平台处理中", not_found: "未发现", not_configured: "未配置", unknown: "未知", error: "查询异常",
};
const receiptNames: Record<DistributionReceipt["status"], string> = {
  submitted: "已提交", reviewing: "审核中", published: "已上架", rejected: "被拒绝", withdrawn: "已撤回",
};
type Request = <T>(path: string, body?: unknown) => Promise<T>;
const time = (at: string) => new Date(at).toLocaleString("zh-CN", { hour12: false });
function Link({ href, children }: { href: string; children: React.ReactNode }) {
  let url: URL | undefined;
  try { url = new URL(href); } catch { /* Invalid links are rendered as text. */ }
  return url?.protocol === "https:" && !url.username && !url.password
    ? <a href={url.href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">{children}<ExternalLink size={12} /></a>
    : <span>{children}</span>;
}
function exportPlan(plan: DistributionPlan) {
  const blob = new Blob([JSON.stringify({ schema: 1, purpose: "distribution-handoff-only", ...plan }, null, 2) + "\n"], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `nowen-distribution-${plan.version}-${plan.id}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ChannelsPanel({ initialVersion, revision, request }: { initialVersion: string; revision: number; request: Request }) {
  const [version, setVersion] = useState(initialVersion);
  const [selectedVersion, setSelectedVersion] = useState(initialVersion);
  const [view, setView] = useState<ChannelView>();
  const [selected, setSelected] = useState<ChannelId[]>([...CHANNELS]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const sequence = useRef(0);
  useEffect(() => {
    const ticket = ++sequence.current;
    setLoading(true);
    void request<ChannelView>(`channels?version=${encodeURIComponent(selectedVersion)}`).then((data) => {
      if (ticket === sequence.current) { setView(data); setError(""); }
    }).catch((e: Error) => { if (ticket === sequence.current) setError(e.message); })
      .finally(() => { if (ticket === sequence.current) setLoading(false); });
    return () => { sequence.current++; };
  }, [selectedVersion, revision, request]);

  async function operate(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError("");
    try { await action(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function reload(v: string) {
    const data = await request<ChannelView>(`channels?version=${encodeURIComponent(v)}`);
    sequence.current++; setView(data); setLoading(false); setSelectedVersion(v);
  }
  function refresh() {
    void operate(async () => {
      const v = version.trim();
      const data = await request<ChannelView>("channels/refresh", { version: v });
      sequence.current++; setView(data); setLoading(false); setSelectedVersion(v);
    });
  }
  function plan(regenerate = false) {
    if (!view) return;
    void operate(async () => {
      const slot = `rc-distribution-${view.version}-${[...selected].sort().join(",")}`;
      const key = (!regenerate && sessionStorage.getItem(slot)) || crypto.randomUUID();
      sessionStorage.setItem(slot, key);
      await request<DistributionPlan>("distribution/plans", { version: view.version, channels: selected, key });
      await reload(view.version);
    });
  }
  return <div className="space-y-6">
    <div className="rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm leading-6 text-blue-900 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-200">
      渠道查询只读取平台状态。交接计划固定已发布版本的 Commit，导出不会上传安装包或镜像。
      正式审批和执行尚未接入；已有 Docker Tag 不得覆盖，人工回执不替代平台核验。
    </div>
    <Card className="p-5">
      <div className="flex flex-wrap items-end gap-3">
        <label className="w-full min-w-0 text-xs text-slate-500 sm:w-auto sm:flex-1">渠道版本（X.Y.Z）
          <Input className="mt-2" value={version} disabled={busy} onChange={(e) => setVersion(e.target.value)} placeholder="1.5.2" />
        </label>
        <Button className="flex-1 sm:flex-none" variant="outline" disabled={busy} onClick={() => void operate(() => reload(version.trim()))}>查看本地记录</Button>
        <Button className="flex-1 sm:flex-none" disabled={busy} onClick={refresh}>{busy ? <LoaderCircle size={14} className="animate-spin" /> : <RefreshCw size={14} />}查询渠道</Button>
      </div>
      <p className="mt-3 text-xs leading-5 text-slate-400">查询结果按版本保留历史；一分钟内重复查询复用结果。未配置凭据或查询失败不会显示为已发布。</p>
    </Card>
    {error && <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-200">{error}</div>}
    {loading && !view && <div role="status" className="flex items-center gap-2 text-sm text-slate-500"><LoaderCircle className="animate-spin" size={16} />加载渠道记录…</div>}
    {view && <>
      <p className="text-xs text-slate-500">当前查看 v{view.version} · 外部状态以观察时间为准</p>
      <div className="grid gap-4 xl:grid-cols-3">
        {CHANNELS.map((id) => {
          const item = view.observations.find((o) => o.channel === id);
          return <Card key={id} className="min-w-0 p-5">
            <h2 className="font-semibold">{names[id]}</h2>
            <p className={cn("mt-3 text-xs font-medium", item?.state === "error" ? "text-red-600 dark:text-red-300" : "text-slate-500 dark:text-slate-300")}>{item ? states[item.state] : "尚未查询"}</p>
            <p className="mt-2 break-words text-sm leading-6">{item?.summary || "点击查询渠道，读取实际平台数据。"}</p>
            {item?.details.map((text, i) => <p key={i} className="mt-2 break-words text-xs leading-5 text-slate-500 dark:text-slate-400">{text}</p>)}
            {item && <>
              <p className="mt-3 text-[11px] text-slate-400">观察于 {time(item.at)}</p>
              {item.url && <div className="mt-2 text-xs"><Link href={item.url}>查看平台</Link></div>}
              {Object.keys(item.evidence).length > 0 && <details className="mt-3 text-xs text-slate-500"><summary className="cursor-pointer">平台观察数据</summary><pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-slate-50 p-3 text-[10px] dark:bg-slate-950">{JSON.stringify(item.evidence, null, 2)}</pre></details>}
            </>}
          </Card>;
        })}
      </div>
      <Card className="p-5">
        <h2 className="font-semibold">分发交接计划</h2>
        <p className="mt-2 text-xs leading-6 text-slate-500">来源必须是已正式发布的同版本 GitHub Release。调试包、Draft 和 EXE 不能代替 Store AppX；创建计划不执行分发。</p>
        <div className="my-4 flex flex-wrap gap-4">{CHANNELS.map((id) => <label key={id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={selected.includes(id)} disabled={busy} onChange={(e) => setSelected((before) => e.target.checked ? [...before, id] : before.filter((v) => v !== id))} />{names[id]}</label>)}</div>
        <div className="flex flex-wrap gap-3">
          <Button disabled={busy || !selected.length || version.trim() !== view.version} onClick={() => plan()}><ShieldCheck size={14} />生成 / 恢复计划</Button>
          {view.plans.length > 0 && <Button variant="outline" disabled={busy || !selected.length || version.trim() !== view.version} onClick={() => plan(true)}>重新生成计划</Button>}
          <Button disabled title="需先接入正式审批与渠道内容验证">执行分发（待正式审批）</Button>
        </div>
      </Card>
      {!view.plans.length && <Card className="p-8 text-center text-sm text-slate-500">此版本还没有分发计划。已有安装包或 Tag 不代表可以直接分发。</Card>}
      {view.plans.map((item) => <Card key={item.id} className="min-w-0 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-semibold">v{item.version} · 交接计划</h2><Button variant="outline" size="sm" onClick={() => exportPlan(item)}><Download size={14} />导出交接 JSON</Button></div>
        <p className="mt-3 break-all font-mono text-xs text-slate-500">Commit {item.source.sha}</p>
        <p className="mt-2 text-xs text-slate-400">{time(item.createdAt)} · <Link href={item.source.url}>来源 Release</Link> · 计划不可执行</p>
        <div className="mt-4 grid gap-4 xl:grid-cols-3">{item.handoffs.map((handoff) => <div key={handoff.channel} className="min-w-0 rounded-xl border border-slate-200 p-4 dark:border-slate-700">
          <h3 className="text-sm font-medium">{names[handoff.channel]}</h3><p className="mt-2 break-all text-xs text-slate-500">{handoff.target}</p>
          <ul className="mt-3 list-inside list-disc space-y-2 text-xs leading-5 text-amber-700 dark:text-amber-300">{handoff.blockers.map((text, i) => <li key={i}>{text}</li>)}</ul>
          {handoff.instructions.map((text, i) => <p key={i} className="mt-3 break-words text-xs leading-5 text-slate-500">{text}</p>)}
          {handoff.assets.map((asset) => <p key={asset.id} className="mt-3 break-all font-mono text-[10px] text-slate-500">{asset.name} · {asset.size.toLocaleString()} B<br />{asset.digest || "无平台摘要"}<br />内容未下载验证</p>)}
          <details className="mt-3 text-xs text-slate-500"><summary className="cursor-pointer">交接数据</summary><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all text-[10px]">{JSON.stringify(handoff.metadata, null, 2)}</pre></details>
        </div>)}</div>
        <ReceiptForm plan={item} busy={busy} save={(receipt) => operate(async () => {
          await request<DistributionReceipt>("distribution/receipts", receipt);
          await reload(view.version);
        })} />
      </Card>)}
      <Card className="p-5">
        <h2 className="font-semibold">人工平台回执</h2>
        <p className="mt-2 text-xs text-slate-500">仅记录维护者在平台上的操作结果，不会更改平台观察状态，也不授予发布权限。</p>
        {!view.receipts.length && <p className="py-6 text-center text-sm text-slate-400">尚无人工回执</p>}
        {view.receipts.map((receipt) => <div key={receipt.id} className="mt-4 border-t border-slate-100 pt-4 text-xs dark:border-slate-800">
          <p className="font-medium">{names[receipt.channel]} · {receiptNames[receipt.status]} <span className="font-normal text-amber-700 dark:text-amber-300">（人工记录，平台未核实）</span></p>
          <p className="mt-2 break-words text-slate-500">回执 {receipt.reference} · {time(receipt.at)}</p>
          <p className="mt-2 break-all font-mono text-slate-400">{receipt.sha}</p>
          {receipt.notes && <p className="mt-2 break-words leading-5">{receipt.notes}</p>}
          <div className="mt-2"><Link href={receipt.evidenceUrl}>人工证据链接</Link></div>
        </div>)}
      </Card>
      <Card className="overflow-hidden">
        <div className="panel-title"><h2>渠道观察历史</h2></div>
        {!view.history.length ? <p className="p-6 text-center text-sm text-slate-400">尚无观察记录</p> : <div className="overflow-x-auto"><table className="w-full min-w-[600px] text-left text-xs"><thead><tr className="text-slate-400"><th className="p-4">时间</th><th>渠道</th><th>状态</th><th>说明</th></tr></thead><tbody>{view.history.map((o, i) => <tr key={`${o.at}-${o.channel}-${i}`} className="border-t border-slate-100 dark:border-slate-800"><td className="p-4">{time(o.at)}</td><td>{names[o.channel]}</td><td>{states[o.state]}</td><td className="p-3">{o.summary}</td></tr>)}</tbody></table></div>}
      </Card>
    </>}
  </div>;
}

function ReceiptForm({ plan, busy, save }: { plan: DistributionPlan; busy: boolean; save: (value: unknown) => Promise<void> }) {
  const channels = plan.handoffs.filter((h) => h.channel !== "docker-hub").map((h) => h.channel);
  const [channel, setChannel] = useState<ChannelId>(channels[0] || "nas");
  const [status, setStatus] = useState<DistributionReceipt["status"]>("submitted");
  const [reference, setReference] = useState("");
  const [url, setUrl] = useState("");
  const [notes, setNotes] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const keys = useRef(new Map<string, string>());
  useEffect(() => setConfirmed(false), [channel, status, reference, url, notes]);
  if (!channels.length) return null;
  const selectClass = "h-10 min-w-0 rounded-lg border border-slate-200 bg-transparent px-3 text-sm dark:border-slate-700 dark:bg-slate-900";
  return <details className="mt-5 border-t border-slate-100 pt-4 dark:border-slate-800"><summary className="cursor-pointer text-sm font-medium">记录已有平台回执</summary>
    <form className="mt-4 space-y-4" onSubmit={(e) => {
      e.preventDefault();
      if (!confirmed || busy) return;
      const value = { planId: plan.id, channel, version: plan.version, sha: plan.source.sha, status, reference, evidenceUrl: url, notes, confirmManual: true };
      const fingerprint = JSON.stringify(value);
      const key = keys.current.get(fingerprint) || crypto.randomUUID(); keys.current.set(fingerprint, key);
      void save({ ...value, key }).then(() => setConfirmed(false));
    }}>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="grid gap-2 text-xs text-slate-500">回执渠道<select className={selectClass} value={channel} disabled={busy} onChange={(e) => setChannel(e.target.value as ChannelId)}>{channels.map((id) => <option key={id} value={id}>{names[id]}</option>)}</select></label>
        <label className="grid gap-2 text-xs text-slate-500">平台状态<select className={selectClass} value={status} disabled={busy} onChange={(e) => setStatus(e.target.value as DistributionReceipt["status"])}>{RECEIPT_STATES.map((id) => <option key={id} value={id}>{receiptNames[id]}</option>)}</select></label>
        <label className="grid gap-2 text-xs text-slate-500">平台回执编号<Input required maxLength={160} value={reference} disabled={busy} onChange={(e) => setReference(e.target.value)} /></label>
        <label className="grid gap-2 text-xs text-slate-500">HTTPS 证据链接（不含查询参数）<Input required type="url" maxLength={2000} value={url} disabled={busy} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" /></label>
      </div>
      <label className="grid gap-2 text-xs text-slate-500">备注（不要填写凭据）<textarea maxLength={4000} value={notes} disabled={busy} onChange={(e) => setNotes(e.target.value)} className="min-h-20 w-full rounded-lg border border-slate-200 bg-transparent p-3 text-sm dark:border-slate-700" /></label>
      <label className="flex items-start gap-2 text-xs leading-5 text-slate-500"><input className="mt-1" type="checkbox" checked={confirmed} disabled={busy} onChange={(e) => setConfirmed(e.target.checked)} />我确认这是人工提供的外部回执，平台接口尚未核实；它不代表产物校验通过或正式发布审批。</label>
      <Button size="sm" variant="outline" disabled={busy || !confirmed}>保存人工记录</Button>
    </form>
  </details>;
}
