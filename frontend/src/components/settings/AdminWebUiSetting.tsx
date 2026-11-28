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
      className="flex cursor-pointer items-center justify-between gap-4 rounded-2xl border border-app-border/80 bg-app-elevated/80 px-4 py-3.5 shadow-xs backdrop-blur-sm transition-colors hover:border-blue-400/40"
    >
      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-2">
          <span id={titleId} className="text-sm font-semibold text-tx-primary">{t("settings.disableWebUi")}</span>
          <ScopeBadge scope="admin" />
          {(saving || (webUiEnabled === null && !loadFailed)) && <Loader2 size={12} className="animate-spin text-blue-500" aria-hidden="true" />}
        </span>
        <span id={descriptionId} className="mt-0.5 block text-xs leading-relaxed text-tx-secondary">{t("settings.disableWebUiDesc")}</span>
      </span>
      <span className="relative inline-flex shrink-0 items-center">
        <input
          type="checkbox"
          role="switch"
          checked={webUiEnabled === false}
          disabled={saving || webUiEnabled === null}
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          onChange={(event) => void handleChange(event.target.checked)}
          className="peer sr-only"
        />
        <span
          aria-hidden="true"
          className="h-6 w-11 rounded-full bg-app-border/90 p-0.5 transition-all peer-checked:bg-gradient-to-r peer-checked:from-blue-500 peer-checked:to-indigo-500 peer-focus-visible:ring-2 peer-focus-visible:ring-blue-500/40 peer-disabled:opacity-50"
        >
          <span className="block h-5 w-5 rounded-full bg-white shadow-sm transition-transform duration-200 peer-checked:translate-x-5" />
        </span>
      </span>
    </label>
  );
}
