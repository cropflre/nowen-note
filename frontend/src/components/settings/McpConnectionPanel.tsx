import { useEffect, useState } from "react";
import { api, getBaseUrl, type EmbeddedMcpStatus } from "@/lib/api";
import { getOfflineQueueStorageKey } from "@/lib/offlineScope";
import type { MigrationClientId } from "@/lib/migrationClientSetup";
import MigrationConnectionSetup from "./MigrationConnectionSetup";
import McpQuickConnect from "./McpQuickConnect";

export default function McpConnectionPanel({ purpose, client, notebooks }: {
  purpose?: "migration"; client?: MigrationClientId; notebooks?: { id: string; name: string }[];
} = {}) {
  return purpose === "migration" ? <MigrationConnectionSetup client={client} notebooks={notebooks}/> : <GeneralMcpConnectionPanel/>;
}

function GeneralMcpConnectionPanel() {
  const [service, setService] = useState<EmbeddedMcpStatus | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const scope = getOfflineQueueStorageKey();
  const apiUrl = new URL(getBaseUrl(), window.location.href).href.replace(/\/api\/?$/, "");
  useEffect(() => {
    let active = true;
    setService(null); setLoadError(false);
    void api.mcp.status().then(status => {
      if (active && scope === getOfflineQueueStorageKey()) setService(status);
    }).catch(() => { if (active) setLoadError(true); });
    return () => { active = false; };
  }, [apiUrl, scope, refresh]);
  return <McpQuickConnect key={`${scope}:${apiUrl}`} service={service} defaultUrl={`${apiUrl}/mcp`}
    loadError={loadError} onRetry={() => setRefresh(value => value + 1)} onServiceChange={setService} />;
}
