import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, getCurrentWorkspace } from "@/lib/api";
import { useFileToolDialog } from "@/hooks/useFileToolDialog";
import { folderPath } from "@/lib/fileExplorerModel";
import { newLocalId } from "@/lib/localRepository";
import type { AssetAIPreview, AssetAISearch, AssetAISuggestion } from "@/lib/assetAI";

export default function AssetAIDialog({ mode, files, isCurrent, onClose, onApplied, onOpen }: {
  mode: "organize" | "search"; files: Array<{id:string;filename:string}>;
  isCurrent: () => boolean; onClose: () => void; onApplied: () => void; onOpen: (id:string) => void;
}) {
  const { t, i18n } = useTranslation();
  const [source] = useState(files);
  const [consent,setConsent] = useState(false);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState("");
  const [preview,setPreview] = useState<AssetAIPreview | null>(null);
  const [included,setIncluded] = useState(new Set<string>());
  const [tagDrafts,setTagDrafts] = useState<Record<string,string>>({});
  const [query,setQuery] = useState("");
  const [search,setSearch] = useState<AssetAISearch | null>(null);
  const [searchedQuery,setSearchedQuery] = useState("");
  const controller = useRef<AbortController>(undefined);
  const requestId = useRef(newLocalId());
  const attempt = useRef<{requestId:string;items:AssetAISuggestion[]} | null>(null);
  const dialog = useFileToolDialog(onClose,busy);
  const canMove = !getCurrentWorkspace() || getCurrentWorkspace() === "personal";
  useEffect(() => () => controller.current?.abort(),[]);
  const report = (failure: unknown) => {
    const code = (failure as {code?:string})?.code;
    const key = code && ["AI_NOT_CONFIGURED","EMBEDDING_NOT_CONFIGURED","ASSET_AI_SYNC_UNSUPPORTED","ASSET_AI_STALE","ASSET_AI_PROTECTED","ASSET_AI_BUSY"].includes(code) ? code : "failed";
    setError(t(`assetAI.${key}`));
  };
  const generate = async (more = false) => {
    if (busy || !consent || !isCurrent()) return;
    setBusy(true); setError(""); controller.current = new AbortController();
    try {
      if (mode === "search") {
        const value = more ? searchedQuery : query.trim();
        const result = await api.files.organization.aiSearch(value,more ? search?.nextAfter || undefined : undefined,controller.current.signal);
        if (!isCurrent()) return;
        setSearchedQuery(value);
        setSearch(more && search ? {...result,examined:search.examined+result.examined,matches:[...search.matches,...result.matches].sort((a,b) => b.score-a.score)} : result);
      } else {
        setPreview(null); attempt.current = null;
        const result = await api.files.organization.aiPreview(source.map(file => file.id),i18n.language.startsWith("zh") ? "zh-CN" : "en",controller.current.signal);
        if (!isCurrent()) return;
        setPreview(result); setIncluded(new Set(result.items.map(item => item.id))); setTagDrafts(Object.fromEntries(result.items.map(item => [item.id,item.tags.join(", ")]))); requestId.current = newLocalId();
      }
    } catch (failure) { if (isCurrent() && !controller.current?.signal.aborted) report(failure); }
    finally { if (isCurrent()) setBusy(false); }
  };
  const edit = (id:string, patch:Partial<AssetAISuggestion>) => {
    if (attempt.current) return;
    setPreview(value => value && {...value,items:value.items.map(item => item.id === id ? {...item,...patch} : item)});
  };
  const apply = async () => {
    if (busy || !preview || !included.size || !isCurrent()) return;
    const items = preview.items.filter(item => included.has(item.id)).map(item => ({...item,tags:(tagDrafts[item.id] || "").split(/[,，]/).map(tag => tag.trim()).filter(Boolean)}));
    if (items.some(item => item.tags.length > 10 || item.tags.some(tag => tag.length > 100) || item.newFolderName !== null && !item.newFolderName.trim())) {setError(t("assetAI.invalid")); return;}
    const payload = attempt.current || {requestId:requestId.current,items};
    attempt.current = payload;
    setBusy(true); setError("");
    try {
      const result = await api.files.organization.aiConfirm(payload.requestId,payload.items);
      if (isCurrent()) { onApplied(); setError(t("assetAI.applied",{count:result.updated})); setPreview(null); attempt.current = null; }
    } catch (failure) { if (isCurrent()) report(failure); }
    finally { if (isCurrent()) setBusy(false); }
  };
  return <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/40 p-3">
    <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label={t(mode === "organize" ? "assetAI.organize" : "assetAI.search")} className="flex max-h-[90dvh] w-full max-w-3xl flex-col rounded-xl border border-app-border bg-app-elevated p-4 shadow-xl">
      <h2 className="font-semibold">{t(mode === "organize" ? "assetAI.organize" : "assetAI.search")}</h2>
      <p className="my-3 text-xs text-tx-secondary">{t("assetAI.privacy")}</p>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={consent} disabled={busy} onChange={event => setConsent(event.target.checked)} />{t("assetAI.consent")}</label>
      {mode === "organize" ? <p className="my-3 text-sm">{t("assetAI.fileCount",{count:source.length})}</p> : <>
        <label className="mt-3 text-sm">{t("assetAI.query")}<input aria-label={t("assetAI.query")} maxLength={500} value={query} disabled={busy} onChange={event => setQuery(event.target.value)} className="mt-1 w-full rounded border border-app-border bg-app-surface p-2" /></label>
        <p className="my-2 text-xs text-tx-secondary">{t("assetAI.searchHint")}</p>
      </>}
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto py-3">
        {preview?.items.map(item => <fieldset key={item.id} disabled={busy || !!attempt.current} className="min-w-0 rounded border border-app-border p-3 text-sm">
          <label className="flex gap-2 font-medium"><input type="checkbox" checked={included.has(item.id)} onChange={event => setIncluded(previous => {const next = new Set(previous); if(event.target.checked) next.add(item.id); else next.delete(item.id); return next;})} /><span className="min-w-0 break-all">{item.filename}</span></label>
          <p className="my-2 text-xs text-tx-secondary">{item.reason}</p>
          {canMove && <><label>{t("assetAI.folder")}<select aria-label={t("assetAI.folder")} value={item.newFolderName !== null ? "__new" : item.folderId || ""} onChange={event => edit(item.id,{folderId:event.target.value === "__new" ? null : event.target.value || null,newFolderName:event.target.value === "__new" ? "" : null})} className="my-1 block w-full rounded border border-app-border bg-app-surface p-2">
            <option value="">{t("fileExplorer.unorganized")}</option>{preview.folders.map(folder => <option key={folder.id} value={folder.id}>{folderPath(preview.folders,folder.id).map(parent => parent.name).join(" / ")}</option>)}<option value="__new">{t("assetAI.newFolder")}</option>
          </select></label>{item.newFolderName !== null && <input aria-label={t("assetAI.newFolder")} maxLength={100} value={item.newFolderName} onChange={event => edit(item.id,{newFolderName:event.target.value})} className="my-1 w-full rounded border border-app-border bg-app-surface p-2" />}</>}
          <label className="block">{t("assetAI.tags")}<input aria-label={t("assetAI.tags")} value={tagDrafts[item.id] || ""} onChange={event => setTagDrafts(previous => ({...previous,[item.id]:event.target.value}))} className="my-1 w-full rounded border border-app-border bg-app-surface p-2" /></label>
          <label className="block">{t("assetAI.description")}<textarea aria-label={t("assetAI.description")} maxLength={1000} value={item.description} onChange={event => edit(item.id,{description:event.target.value})} className="my-1 w-full rounded border border-app-border bg-app-surface p-2" /></label>
        </fieldset>)}
        {search && <><p className="text-xs">{t("assetAI.examined",{count:search.examined})}</p>{!search.matches.length && <p>{t("assetAI.noMatches")}</p>}{search.matches.map(match => <button key={match.id} onClick={() => {onOpen(match.id);onClose();}} className="block w-full rounded border border-app-border p-3 text-left text-sm"><span className="font-medium">{match.filename}</span><span className="ml-3 text-xs">{t("assetAI.score",{score:match.score.toFixed(3)})}</span><p className="mt-1 text-xs text-tx-secondary">{match.description}</p></button>)}{search.nextAfter && <button disabled={busy || !consent} onClick={() => void generate(true)} className="text-sm text-accent-primary disabled:opacity-30">{t("assetAI.more")}</button>}</>}
      </div>
      {error && <p role="status" className="py-2 text-sm">{error}</p>}
      {attempt.current && !busy && <p className="text-xs text-tx-secondary">{t("assetAI.retryHint")}</p>}
      <div className="mt-3 flex flex-wrap justify-end gap-4 text-sm">
        <button disabled={busy} onClick={onClose} className="min-h-11 px-1">{t("common.close")}</button>
        {busy ? <button onClick={() => controller.current?.abort()} disabled={!!attempt.current} className="min-h-11 px-1">{t("assetAI.cancelRequest")}</button> : <button disabled={!consent || mode === "search" && !query.trim()} onClick={() => void generate()} className="min-h-11 px-1 text-accent-primary disabled:opacity-30">{t(mode === "search" ? "assetAI.search" : "assetAI.generate")}</button>}
        {preview && <button disabled={busy || !included.size || !consent} onClick={() => void apply()} className="min-h-11 px-1 text-accent-primary disabled:opacity-30">{t("assetAI.confirm",{count:included.size})}</button>}
      </div>
    </div>
  </div>;
}
