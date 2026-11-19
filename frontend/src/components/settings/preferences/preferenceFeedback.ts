import type { TFunction } from "i18next";

import { toast } from "@/lib/toast";

/** Toast shown after a setting failed to save and the control went back to its previous value. */
export function notifyPreferenceSaveFailed(t: TFunction, error: unknown): void {
  const reason = error instanceof Error ? error.message.trim() : "";
  toast.error(reason ? t("preferences.saveFailedReason", { reason }) : t("preferences.saveFailed"));
}
