import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { automaticallyDownloadDesktopCopy } from '@/lib/desktopLocalSession';
import type { NowenDesktopAPI } from '@/lib/desktopBridge';
import { getAccessToken } from '@/lib/authSession';
import { getServerUrl } from '@/lib/api';
import { exportQueueDiagnostics, getFailedQueueItems, getQueueLength, retryFailedQueueItems } from '@/lib/offlineQueue';
import { getOfflineQueueStorageKey } from '@/lib/offlineScope';
import { syncNow } from '@/lib/syncEngine';

export default function DesktopOfflineSyncGate({children}: {children:ReactNode}) {
  const { t } = useTranslation();
  const bridge = (window as unknown as {nowenDesktop?:NowenDesktopAPI}).nowenDesktop;
  const [ready,setReady] = useState(!bridge?.isDesktop);
  const [error,setError] = useState('');
  const [failedEdits,setFailedEdits] = useState(0);
  const retry = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!bridge?.isDesktop) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let running = false;
    const run = async () => {
      if (running || cancelled) return;
      running = true;
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
        if (current()) setFailedEdits(getFailedQueueItems().length);
      }
    };
    const online = () => { clearTimeout(timer); void run(); };
    retry.current = () => {
      if (running || cancelled) return;
      retryFailedQueueItems();
      online();
    };
    window.addEventListener('online',online);
    void run();
    return () => { cancelled = true; retry.current = null; clearTimeout(timer); window.removeEventListener('online',online); };
  },[bridge]);
  const exportEdits = () => {
    const url = URL.createObjectURL(new Blob([exportQueueDiagnostics()],{type:'application/json'}));
    const revoke = URL.revokeObjectURL.bind(URL);
    const link = document.createElement('a');
    link.href = url; link.download = `nowen-pending-edits-${Date.now()}.json`;
    document.body.appendChild(link); link.click(); link.remove();
    window.setTimeout(()=>revoke(url),1000);
  };
  if (ready) return children;
  return <div className="min-h-screen flex items-center justify-center bg-app-bg text-tx-primary px-6">
    <div role="status" className="max-w-md space-y-3 text-center">
      <p>{t('offlineAvailability.automaticDownload')}</p>
      <p className="text-sm text-tx-tertiary">{t('offlineAvailability.automaticHint')}</p>
      {error && <p className="text-sm text-amber-600">{error}</p>}
      {failedEdits > 0 && <div className="space-y-3 text-sm">
        <p>{t('offlineAvailability.legacyEditsRetained',{count:failedEdits})}</p>
        <div className="flex justify-center gap-3">
          <button type="button" onClick={exportEdits} className="rounded border border-app-border px-3 py-2">{t('offlineAvailability.exportLegacyEdits')}</button>
          <button type="button" onClick={()=>retry.current?.()} className="rounded border border-app-border px-3 py-2">{t('offlineAvailability.retryLegacyEdits')}</button>
        </div>
      </div>}
    </div>
  </div>;
}
