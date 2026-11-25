import React, { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { pluginApi, type PluginDataSnapshot } from "@/lib/pluginApi";
import { getCurrentWorkspace } from "@/lib/api";

/** Exports only the authenticated user's active scope, never all users' data. */
export default function PluginDataActions({ pluginId }: { pluginId: string }) {
  const { t } = useTranslation(), input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(false);
  const exportData = async () => {
    setBusy(true); setError(false);
    const credential = localStorage.getItem("nowen-token"), workspaceId = getCurrentWorkspace();
    try {
      const snapshot = await pluginApi.exportData(pluginId, workspaceId);
      if (credential !== localStorage.getItem("nowen-token") || workspaceId !== getCurrentWorkspace()) throw new Error();
      const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot)], { type: "application/json" }));
      const link = document.createElement("a"); link.href = url; link.download = `${pluginId}-data.json`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { setError(true); } finally { setBusy(false); }
  };
  const restoreData = async (file: File) => {
    const workspaceId = getCurrentWorkspace(), credential = localStorage.getItem("nowen-token");
    if (file.size > 1024 * 1024) { setError(true); if (input.current) input.current.value = ""; return; }
    if (!window.confirm(t("pluginApps.restoreDataConfirm"))) { if (input.current) input.current.value = ""; return; }
    setBusy(true); setError(false);
    try {
      const snapshot = JSON.parse(await file.text()) as PluginDataSnapshot;
      if (snapshot.pluginId !== pluginId) throw new Error();
      if (credential !== localStorage.getItem("nowen-token") || workspaceId !== getCurrentWorkspace()) throw new Error();
      const current = await pluginApi.exportData(pluginId, workspaceId);
      if (credential !== localStorage.getItem("nowen-token") || workspaceId !== getCurrentWorkspace()) throw new Error();
      await pluginApi.importData(pluginId, workspaceId, snapshot, current.digest);
    } catch { setError(true); } finally { setBusy(false); if (input.current) input.current.value = ""; }
  };
  return <div className="flex flex-wrap gap-2 text-xs">
    <button disabled={busy} onClick={() => void exportData()}>{t("pluginApps.exportData")}</button>
    <button disabled={busy} onClick={() => input.current?.click()}>{t("pluginApps.restoreData")}</button>
    <input ref={input} type="file" accept=".json,application/json" className="hidden" onChange={event => { const file = event.target.files?.[0]; if (file) void restoreData(file); }} />
    {error && <span role="alert">{t("pluginApps.dataFailed")}</span>}
  </div>;
}
