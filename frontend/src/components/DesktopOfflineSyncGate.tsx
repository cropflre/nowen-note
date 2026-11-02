import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { automaticallyDownloadDesktopCopy } from '@/lib/desktopLocalSession';
import type { LiteMigrationProgress, NowenDesktopAPI } from '@/lib/desktopBridge';
import { getAccessToken } from '@/lib/authSession';
import { getServerUrl } from '@/lib/api';
import { exportQueueDiagnostics, getFailedQueueItems, getQueueLength, retryFailedQueueItems } from '@/lib/offlineQueue';
import { getOfflineQueueStorageKey } from '@/lib/offlineScope';
import { syncNow } from '@/lib/syncEngine';
import '@/loading-experience.css';

export default function DesktopOfflineSyncGate({children}: {children:ReactNode}) {
  const { t } = useTranslation();
  const bridge = (window as unknown as {nowenDesktop?:NowenDesktopAPI}).nowenDesktop;
  const [ready,setReady] = useState(!bridge?.isDesktop);
  const [error,setError] = useState('');
  const [failedEdits,setFailedEdits] = useState(0);
  const [busy,setBusy] = useState(false);
  const [progress,setProgress] = useState<LiteMigrationProgress | null>(null);
  const retry = useRef<(() => void) | null>(null);
  const continueOnline = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!bridge?.isDesktop || ready) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let running = false;
    const run = async () => {
      if (running || cancelled) return;
      running = true;
      setBusy(true);
      setProgress(null);
      const token = getAccessToken() || '', serverUrl = getServerUrl();
      const scope = getOfflineQueueStorageKey();
      const current = () => !cancelled && !!getAccessToken() && getOfflineQueueStorageKey() === scope && getServerUrl() === serverUrl;
      try {
        if (getQueueLength() > 0) await syncNow();
        if (!current()) return;
        const changed = await automaticallyDownloadDesktopCopy(bridge,serverUrl,token,getQueueLength);
        if (!current()) return;
        if (changed) {
          const info = await bridge.getAppInfo();
          if (!current()) return;
          if (!info?.localServerUrl) throw new Error('本地服务暂不可用，将自动重试。');
          localStorage.removeItem('nowen-prefer-cloud');
          const url = new URL(window.location.href);
          url.searchParams.set('serverUrl',info.localServerUrl);
          window.location.replace(url.href);
          return;
        }
        setReady(true);
      } catch (reason) {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : String(reason));
          timer = setTimeout(run,5000);
        }
      } finally {
        running = false;
        if (!cancelled) setBusy(false);
        if (current()) setFailedEdits(getFailedQueueItems().length);
      }
    };
    const online = () => { clearTimeout(timer); void run(); };
    retry.current = () => {
      if (running || cancelled) return;
      retryFailedQueueItems();
      online();
    };
    continueOnline.current = () => {
      if (running || cancelled) return;
      cancelled = true;
      clearTimeout(timer);
      setReady(true);
    };
    window.addEventListener('online',online);
    void run();
    return () => { cancelled = true; retry.current = null; continueOnline.current = null; clearTimeout(timer); window.removeEventListener('online',online); };
  },[bridge,ready]);
  useEffect(() => {
    if (!bridge?.getLiteMigrationProgress || !busy || ready) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const serverUrl = getServerUrl(), scope = getOfflineQueueStorageKey();
    const current = () => !cancelled && getServerUrl() === serverUrl && getOfflineQueueStorageKey() === scope;
    const poll = async () => {
      try {
        const result = await bridge.getLiteMigrationProgress!();
        if (current() && result.ok && result.progress
          && (!result.progress.remoteUrl || result.progress.remoteUrl.replace(/\/+$/,'') === serverUrl.replace(/\/+$/,''))) {
          setProgress(result.progress);
        }
      } catch { /* Progress reads are optional; the download request owns success and failure. */ }
      finally { if (current()) timer = setTimeout(poll,1000); }
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  },[bridge,busy,ready]);
  const exportEdits = () => {
    const url = URL.createObjectURL(new Blob([exportQueueDiagnostics()],{type:'application/json'}));
    const revoke = URL.revokeObjectURL.bind(URL);
    const link = document.createElement('a');
    link.href = url; link.download = `nowen-pending-edits-${Date.now()}.json`;
    document.body.appendChild(link); link.click(); link.remove();
    window.setTimeout(()=>revoke(url),1000);
  };
  if (ready) return children;
  const stage = error && !busy ? 'failed' : progress?.stage === 'complete' ? 'switching' : progress?.stage || 'preparing';
  const attachmentsDone = Math.max(0,progress?.attachmentsDone || 0);
  const attachmentsTotal = attachmentsDone + Math.max(0,progress?.attachmentsPending || 0);
  const percent = stage === 'attachments' && attachmentsTotal > 0
    ? Math.floor(attachmentsDone / attachmentsTotal * 100) : undefined;
  return <div className="min-h-screen flex items-center justify-center bg-app-bg text-tx-primary px-6">
    <div role="status" className="w-full max-w-md space-y-3 text-center">
      <p>{t('offlineAvailability.automaticDownload')}</p>
      <p className="text-sm text-tx-tertiary">{t('offlineAvailability.automaticHint')}</p>
      <div className="space-y-2 text-sm">
        <div className="flex items-center justify-between gap-3 text-tx-secondary">
          <span>{t(`offlineAvailability.downloadStages.${stage}`)}</span>
          {percent !== undefined && <span className="tabular-nums">{percent}%</span>}
        </div>
        <div role="progressbar" aria-label={t('offlineAvailability.downloadProgress')}
          aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}
          aria-valuetext={t(`offlineAvailability.downloadStages.${stage}`)}
          className="h-2 w-full overflow-hidden rounded-full bg-app-hover">
          <div aria-hidden="true"
            className={`h-full rounded-full bg-accent-primary transition-[width] duration-300 ${percent === undefined && busy ? 'motion-safe:animate-[nowen-note-progress_1.15s_ease-in-out_infinite]' : ''}`}
            style={{width:percent !== undefined ? `${percent}%` : busy ? '36%' : '0%'}} />
        </div>
        {progress && <p className="text-tx-tertiary tabular-nums">{t('offlineAvailability.downloadedEntries',{
          downloaded:progress.downloaded || 0,applied:progress.applied || 0,
        })}</p>}
        {attachmentsTotal > 0 && <p className="text-tx-tertiary tabular-nums">{t('offlineAvailability.downloadedAttachments',{
          done:attachmentsDone,total:attachmentsTotal,
        })}</p>}
      </div>
      {error && <p className="text-sm text-amber-600">{error}</p>}
      {failedEdits > 0 && <div className="space-y-3 text-sm">
        <p>{t('offlineAvailability.legacyEditsRetained',{count:failedEdits})}</p>
        <div className="flex justify-center gap-3">
          <button type="button" onClick={exportEdits} className="rounded border border-app-border px-3 py-2">{t('offlineAvailability.exportLegacyEdits')}</button>
        </div>
      </div>}
      {error && <div className="space-y-3 text-sm">
        <p className="text-tx-tertiary">{t('offlineAvailability.onlineOnlyHint')}</p>
        <div className="flex justify-center gap-3">
          <button type="button" disabled={busy} onClick={()=>retry.current?.()} className="rounded border border-app-border px-3 py-2 disabled:opacity-50">{t('offlineAvailability.retryLegacyEdits')}</button>
          <button type="button" disabled={busy} onClick={()=>continueOnline.current?.()} className="rounded border border-app-border px-3 py-2 disabled:opacity-50">{t('offlineAvailability.continueOnline')}</button>
        </div>
      </div>}
    </div>
  </div>;
}
