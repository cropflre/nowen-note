import React, { useEffect, useId, useState } from "react";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { api } from "@/lib/api";
import { ScopeBadge } from "@/components/settings/preferences/PreferenceControls";
import { notifyPreferenceSaveFailed } from "@/components/settings/preferences/preferenceFeedback";

/**
 * Administrators only (rendered inside User management). When the web UI is turned off the
 * server keeps only the API; desktop clients use their own UI and are unaffected.
 */
export default function AdminWebUiSetting() {
  const { t } = useTranslation();
  const titleId = useId();
  const descriptionId = useId();
  // null until the server answers: the switch stays disabled rather than guessing.
  const [webUiEnabled, setWebUiEnabled] = useState<boolean | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.getSiteSettings()
      .then((settings) => { if (!cancelled) setWebUiEnabled(settings.web_ui_enabled !== "false"); })
      .catch(() => { if (!cancelled) setLoadFailed(true); });
    return () => { cancelled = true; };
  }, []);

  const handleChange = async (disableWebUi: boolean) => {
    if (webUiEnabled === null) return;
    const previous = webUiEnabled;
    setWebUiEnabled(!disableWebUi);
    setSaving(true);
    try {
      const updated = await api.updateSiteSettings({ web_ui_enabled: !disableWebUi });
      setWebUiEnabled(updated.web_ui_enabled !== "false");
    } catch (error) {
      setWebUiEnabled(previous);
      notifyPreferenceSaveFailed(t, error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <label
      data-settings-section="web-ui-access"
      className="flex cursor-pointer items-center justify-between gap-3 rounded-xl border border-zinc-200 bg-zinc-50/50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-800/30 sm:px-4 sm:py-3"
    >
      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-2">
          <span id={titleId} className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{t("settings.disableWebUi")}</span>
          <ScopeBadge scope="admin" />
          {(saving || (webUiEnabled === null && !loadFailed)) && <Loader2 size={12} className="animate-spin text-zinc-400" aria-hidden="true" />}
        </span>
        <span id={descriptionId} className="mt-0.5 block text-xs text-zinc-500 dark:text-zinc-400">{t("settings.disableWebUiDesc")}</span>
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={webUiEnabled === false}
        disabled={saving || webUiEnabled === null}
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onChange={(event) => void handleChange(event.target.checked)}
        className="accent-indigo-600"
      />
    </label>
  );
}
