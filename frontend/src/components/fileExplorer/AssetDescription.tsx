import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Capacitor } from "@capacitor/core";
import { api } from "@/lib/api";

export default function AssetDescription({id}:{id:string}) {
  const {t} = useTranslation();
  const [description,setDescription] = useState("");
  const [error,setError] = useState(false);
  useEffect(() => {
    if (Capacitor.isNativePlatform()) return;
    let stale = false;
    api.files.organization.description(id).then(value => {if(!stale) setDescription(value.description);}).catch(() => {if(!stale) setError(true);});
    return () => { stale = true; };
  },[id]);
  if (Capacitor.isNativePlatform()) return null;
  return <section className="rounded border border-app-border p-3 text-sm"><h3 className="font-medium">{t("assetAI.description")}</h3><p className="mt-2 whitespace-pre-wrap text-xs text-tx-secondary">{error ? t("assetAI.descriptionUnavailable") : description || t("assetAI.noDescription")}</p></section>;
}
