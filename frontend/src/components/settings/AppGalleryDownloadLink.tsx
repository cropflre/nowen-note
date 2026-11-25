import { ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";

export default function AppGalleryDownloadLink({ className }: { className: string }) {
  const { t } = useTranslation();

  return (
    <a
      href="https://appgallery.huawei.com/app/detail?id=com.nowen.note"
      target="_blank"
      rel="noopener noreferrer"
      className={className}
    >
      {t("download.appGalleryLink")}
      <ExternalLink size={12} aria-hidden="true" className="shrink-0" />
    </a>
  );
}
