import { useTranslation } from "react-i18next";

export default function AiGeneratedNotice() {
  const { t } = useTranslation();
  return <p role="note" className="my-2 text-xs font-medium text-tx-secondary" data-ai-generated="true">
    {t("ai.generatedLabel")}
  </p>;
}
