import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getServerUrl, isNativeCapacitor, SERVER_URL_CHANGED_EVENT } from "@/lib/api";
import { isMobileLocalMode } from "@/lib/mobileLocalMode";
import {
  getServerEndpointSnapshot, setAutomaticServerEndpoint,
  SERVER_ENDPOINT_CHANGED_EVENT, SERVER_ENDPOINT_PREFERENCES_CHANGED_EVENT,
} from "@/lib/serverEndpointState";

export default function ServerConnectionSettings() {
  const { t } = useTranslation();
  const [connection, setConnection] = useState(() => getServerEndpointSnapshot(getServerUrl()));
  useEffect(() => {
    const refresh = () => setConnection(getServerEndpointSnapshot(getServerUrl()));
    const events = [SERVER_ENDPOINT_CHANGED_EVENT, SERVER_ENDPOINT_PREFERENCES_CHANGED_EVENT, SERVER_URL_CHANGED_EVENT];
    events.forEach((event) => window.addEventListener(event, refresh));
    return () => events.forEach((event) => window.removeEventListener(event, refresh));
  }, []);
  if (!isNativeCapacitor() || isMobileLocalMode() || !connection.serverUrl) return null;
  return <section className="space-y-3 rounded-lg border p-4">
    <h3 className="text-sm font-medium">{t("serverConnection.title")}</h3>
    <dl className="space-y-2 text-sm">
      <div><dt className="text-xs text-muted-foreground">{t("serverConnection.server")}</dt>
        <dd>{connection.name || "Nowen Note"}{connection.serverInstanceId
          ? <span className="ml-2 text-xs text-muted-foreground" title={connection.serverInstanceId}>{connection.serverInstanceId.slice(0, 8)}</span>
          : null}</dd></div>
      <div><dt className="text-xs text-muted-foreground">{t("serverConnection.currentConnection")}</dt>
        <dd className="break-all">{connection.endpointUrl}<span className="ml-2 text-xs text-muted-foreground">
          {connection.kind === "lan" ? t("serverConnection.lan") : t("serverConnection.savedAddress")}</span></dd></div>
      <div><dt className="text-xs text-muted-foreground">{t("serverConnection.publicAddress")}</dt>
        <dd className="break-all">{connection.serverUrl}</dd></div>
    </dl>
    <label className="flex cursor-pointer items-center gap-2 text-sm">
      <input type="checkbox" checked={connection.automatic}
        onChange={(event) => setAutomaticServerEndpoint(connection.serverUrl, event.target.checked)} />
      {t("serverConnection.automatic")}
    </label>
    <p className="text-xs text-muted-foreground">{t("serverConnection.automaticHint")}</p>
    {!connection.serverInstanceId && connection.automatic
      ? <p className="text-xs text-muted-foreground">{t("serverConnection.verifyFirst")}</p> : null}
  </section>;
}
