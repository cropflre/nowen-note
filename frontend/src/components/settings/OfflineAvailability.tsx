import { AlertTriangle, CheckCircle2, HardDrive, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatAppDateTime } from '@/lib/dateTime';
import type { OfflineReadiness } from '@/lib/syncLocalApi';

export function OfflineAvailability({ offline }: { offline?: OfflineReadiness }) {
  const { t, i18n } = useTranslation();
  const total = offline?.attachments.total ?? 0;
  const available = offline?.attachments.available ?? 0;
  const pendingDownloads = offline?.attachments.pendingDownloads ?? 0;
  const failedCount = (offline?.attachments.failedDownloads ?? 0) + (offline?.attachments.missingFiles ?? 0);

  // 下载中的状态优先于少量历史失败：避免 300+ 附件正在正常下载时，因 1 个异常附件把整张卡片误报成“失败”。
  const label = !offline || !offline.supported ? 'unverified'
    : offline.contentState !== 'ready' ? 'downloading'
      : offline.fullyAvailable ? 'ready'
        : pendingDownloads > 0 ? 'attachments'
          : offline.verificationPending ? 'verifying'
            : failedCount > 0 ? 'failed' : 'ready';

  const activeTransfer = label === 'downloading' || label === 'attachments' || label === 'verifying';
  const showProgress = Boolean(offline?.supported && total > 0 && (pendingDownloads > 0 || offline.verificationPending));
  const doneCount = Math.min(total, Math.max(0, available));
  const progressPercent = total > 0 ? Math.min(100, Math.round((doneCount / total) * 100)) : 0;

  return (
    <section className="space-y-2.5 rounded-xl border border-app-border bg-app-surface/60 p-4 text-xs" aria-label={t('offlineAvailability.title')}>
      <div className="flex items-center justify-between gap-2">
        <h4 className="flex items-center gap-1.5 font-medium text-tx-primary">
          {label === 'ready' ? (
            <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
          ) : activeTransfer ? (
            <Loader2 className="h-4 w-4 animate-spin text-accent-primary" aria-hidden="true" />
          ) : label === 'failed' ? (
            <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" aria-hidden="true" />
          ) : (
            <HardDrive className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          )}
          {t('offlineAvailability.title')}
        </h4>
        {showProgress ? (
          <span className="font-mono text-[11px] text-muted-foreground">{progressPercent}%</span>
        ) : null}
      </div>

      <p role="status" className="text-tx-primary">{t(`offlineAvailability.${label}`)}</p>

      {showProgress ? (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={progressPercent} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full rounded-full bg-primary transition-[width] duration-300" style={{ width: `${progressPercent}%` }} />
        </div>
      ) : null}

      {offline ? (
        <p className="text-muted-foreground">
          {t('offlineAvailability.counts', {
            available: offline.attachments.available ?? '—',
            total: offline.attachments.total ?? '—',
            pending: offline.attachments.pendingDownloads ?? '—',
            failed: failedCount,
          })}
        </p>
      ) : null}

      {label === 'attachments' && failedCount > 0 ? (
        <p className="text-amber-700 dark:text-amber-400">
          另有 {failedCount} 个附件暂未下载成功，后台会在剩余附件完成后自动重试。
        </p>
      ) : null}

      {offline?.verifiedAt ? (
        <p className="text-muted-foreground">
          {t('offlineAvailability.verifiedAt', { time: formatAppDateTime(offline.verifiedAt, undefined, undefined, i18n.language) })}
        </p>
      ) : null}
    </section>
  );
}
