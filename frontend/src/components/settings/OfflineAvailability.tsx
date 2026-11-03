import { useTranslation } from 'react-i18next';
import type { OfflineReadiness } from '@/lib/syncLocalApi';

export function OfflineAvailability({ offline }: { offline?: OfflineReadiness }) {
  const { t, i18n } = useTranslation();
  const label = !offline || !offline.supported ? 'unverified'
    : offline.contentState !== 'ready' ? 'downloading'
      : offline.fullyAvailable ? 'ready'
        : offline.verificationPending ? 'verifying'
          : (offline.attachments.failedDownloads || offline.attachments.missingFiles) ? 'failed' : 'attachments';
  return <section className="space-y-2 rounded-md border p-4 text-xs" aria-label={t('offlineAvailability.title')}>
    <h4 className="font-medium">{t('offlineAvailability.title')}</h4>
    <p role="status">{t(`offlineAvailability.${label}`)}</p>
    {offline && <p className="text-muted-foreground">{t('offlineAvailability.counts', {
      available: offline.attachments.available ?? '—', total: offline.attachments.total ?? '—',
      pending: offline.attachments.pendingDownloads ?? '—', failed: (offline.attachments.failedDownloads ?? 0) + (offline.attachments.missingFiles ?? 0),
    })}</p>}
    {offline?.verifiedAt && <p className="text-muted-foreground">{t('offlineAvailability.verifiedAt', { time: new Date(offline.verifiedAt).toLocaleString(i18n.language) })}</p>}
    <p className="text-muted-foreground">{t('offlineAvailability.hint')}</p>
  </section>;
}
