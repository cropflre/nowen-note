import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cropShareBannerImage, type ShareBannerConfig } from "@/lib/shareBanner";

interface Props {
  value: ShareBannerConfig;
  onChange: (value: ShareBannerConfig) => void;
  disabled: boolean;
}

export default function ShareBannerEditor({ value, onChange, disabled }: Props) {
  const { t } = useTranslation();
  const fileRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<HTMLImageElement | null>(null);
  const [horizontal, setHorizontal] = useState(50);
  const [vertical, setVertical] = useState(50);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const buttonClass = "min-h-10 rounded-lg border border-app-border px-3 py-1.5 text-sm hover:bg-app-hover disabled:cursor-not-allowed disabled:opacity-50";

  async function chooseImage(file: File) {
    setError("");
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      setError(t("settings.shareBannerInvalidImage"));
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError(t("settings.shareBannerTooLarge"));
      return;
    }
    setLoading(true);
    try {
      const src = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("图片读取失败"));
        reader.readAsDataURL(file);
      });
      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("图片解码失败"));
        image.src = src;
      });
      setHorizontal(50);
      setVertical(50);
      setDraft(image);
    } catch {
      setError(t("settings.shareBannerInvalidImage"));
    } finally {
      setLoading(false);
    }
  }

  function applyCrop() {
    if (!draft) return;
    try {
      onChange({ enabled: true, image: cropShareBannerImage(draft, horizontal, vertical) });
      setDraft(null);
      setError("");
    } catch {
      setError(t("settings.shareBannerInvalidImage"));
    }
  }

  return (
    <div className="space-y-3" data-share-banner-editor="">
      <div>
        <span className="text-sm font-medium text-tx-primary">{t("settings.shareBanner")}</span>
        <p className="mt-1 text-xs text-tx-secondary">{t("settings.shareBannerHint")}</p>
      </div>
      <label className="flex min-h-10 items-center gap-2 text-sm text-tx-primary">
        <input type="checkbox" checked={value.enabled} disabled={disabled || !value.image || !!draft || loading}
          onChange={event => onChange({ ...value, enabled: event.target.checked })} />
        {t("settings.shareBannerEnabled")}
      </label>
      {(draft || value.image) && (
        <div className="aspect-[4/1] overflow-hidden rounded-lg bg-white">
          <img src={draft?.src || value.image} alt={t("settings.shareBannerPreview")} className="h-full w-full object-cover"
            style={{ objectPosition: draft ? `${horizontal}% ${vertical}%` : "center" }} />
        </div>
      )}
      {draft && (
        <div className="space-y-3">
          {([ ["horizontal", horizontal, setHorizontal], ["vertical", vertical, setVertical] ] as const).map(([axis, position, setPosition]) => (
            <label key={axis} className="block text-xs text-tx-secondary">
              {t(`settings.shareBannerCrop_${axis}`)}
              <input type="range" min={0} max={100} value={position} disabled={disabled || loading} className="mt-1 block w-full"
                aria-label={t(`settings.shareBannerCrop_${axis}`)} onChange={event => setPosition(Number(event.target.value))} />
            </label>
          ))}
          <p className="text-xs text-tx-secondary">{t("settings.shareBannerCropHint")}</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={buttonClass} disabled={disabled || loading} onClick={applyCrop}>{t("settings.shareBannerApplyCrop")}</button>
            <button type="button" className={buttonClass} disabled={disabled || loading} onClick={() => { setDraft(null); setError(""); }}>{t("settings.shareBannerCancelCrop")}</button>
          </div>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <input ref={fileRef} type="file" className="hidden" accept="image/png,image/jpeg,image/webp" disabled={disabled || loading}
          aria-label={t("settings.shareBannerChooseImage")} onChange={event => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void chooseImage(file);
          }} />
        <button type="button" className={buttonClass} disabled={disabled || loading} onClick={() => fileRef.current?.click()}>
          {t(loading ? "settings.shareBannerLoading" : "settings.shareBannerChooseImage")}
        </button>
        {value.image && <button type="button" className={buttonClass} disabled={disabled || loading} onClick={() => {
          setDraft(null); setError(""); onChange({ enabled: false, image: "" });
        }}>{t("settings.shareBannerRemove")}</button>}
      </div>
      {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
    </div>
  );
}
