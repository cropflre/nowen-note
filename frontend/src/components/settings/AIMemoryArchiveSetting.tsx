import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { motion } from "framer-motion";
import { Brain } from "lucide-react";

import { useSiteSettings } from "@/hooks/useSiteSettings";
import { PreferenceGroup, ScopeBadge, SwitchRow } from "@/components/settings/preferences/PreferenceControls";
import { notifyPreferenceSaveFailed } from "@/components/settings/preferences/preferenceFeedback";

/**
 * Server-wide switch for the AI conversation archive (site setting `feature_ai_memory_enabled`).
 * Rendered for administrators outside device-only mode; the server enforces the permission.
 */
export default function AIMemoryArchiveSetting() {
  const { t } = useTranslation();
  const { siteConfig, updateAIMemoryEnabled } = useSiteSettings();
  // Shown right away; reverted if the server refuses.
  const [checked, setChecked] = useState(siteConfig.aiMemoryEnabled);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setChecked(siteConfig.aiMemoryEnabled); }, [siteConfig.aiMemoryEnabled]);

  const handleChange = async (enabled: boolean) => {
    const previous = siteConfig.aiMemoryEnabled;
    setChecked(enabled);
    setSaving(true);
    try {
      await updateAIMemoryEnabled(enabled);
    } catch (error) {
      setChecked(previous);
      notifyPreferenceSaveFailed(t, error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section data-settings-section="ai-memory-archive" className="space-y-3">
      <div className="flex flex-wrap items-center gap-2.5">
        <motion.span
          whileHover={{ rotate: [0, -10, 10, 0], scale: 1.08 }}
          transition={{ duration: 0.45 }}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-fuchsia-500/18 to-violet-500/18 text-fuchsia-600 ring-1 ring-fuchsia-500/20 dark:text-fuchsia-300"
        >
          <Brain size={15} />
        </motion.span>
        <h4 className="text-sm font-bold text-tx-primary">{t("aiMemory.title")}</h4>
        <ScopeBadge scope="admin" />
      </div>
      <PreferenceGroup>
        <SwitchRow
          title={t("aiMemory.switchTitle")}
          description={t("aiMemory.switchHint")}
          checked={checked}
          busy={saving}
          onChange={(enabled) => void handleChange(enabled)}
        />
      </PreferenceGroup>
    </section>
  );
}
