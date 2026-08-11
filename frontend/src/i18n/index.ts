import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import zhCN from "./locales/zh-CN.json";
import en from "./locales/en.json";
import {
  enAdditionalTranslations,
  zhCNAdditionalTranslations,
} from "./additionalTranslations";
import {
  enYoudaoTranslations,
  zhCNYoudaoTranslations,
} from "./youdaoTranslations";
import {
  enDownloadNetworkTranslations,
  zhCNDownloadNetworkTranslations,
} from "./downloadNetworkTranslations";
import {
  enMiCloudProgressTranslations,
  zhCNMiCloudProgressTranslations,
} from "./miCloudProgressTranslations";
import {
  enLargeDocumentTranslations,
  zhCNLargeDocumentTranslations,
} from "./largeDocumentTranslations";
import {
  enWorkspaceLayoutTranslations,
  zhCNWorkspaceLayoutTranslations,
} from "./workspaceLayoutTranslations";
import {
  enSecurityAddonTranslations,
  zhCNSecurityAddonTranslations,
} from "./securityAddonTranslations";
import {
  enDiaryMarkdownTranslations,
  zhCNDiaryMarkdownTranslations,
} from "./diaryMarkdownTranslations";
import {
  enEditorSplitTranslations,
  zhCNEditorSplitTranslations,
} from "./editorSplitTranslations";
import { installLegacySettingsI18nBridge } from "./legacySettingsI18nBridge";

function mergeTranslations(base: any, patch: any): any {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const result = { ...(base && typeof base === "object" ? base : {}) };
  for (const [key, value] of Object.entries(patch)) {
    result[key] =
      value && typeof value === "object" && !Array.isArray(value)
        ? mergeTranslations(result[key], value)
        : value;
  }
  return result;
}

function mergeTranslationPatches(base: any, ...patches: any[]): any {
  return patches.reduce((current, patch) => mergeTranslations(current, patch), base);
}

const zhCNWithReleaseTranslations = mergeTranslationPatches(
  zhCN,
  zhCNAdditionalTranslations,
  zhCNYoudaoTranslations,
  zhCNDownloadNetworkTranslations,
  zhCNMiCloudProgressTranslations,
  zhCNLargeDocumentTranslations,
  zhCNWorkspaceLayoutTranslations,
  zhCNSecurityAddonTranslations,
  zhCNDiaryMarkdownTranslations,
  zhCNEditorSplitTranslations,
);

const enWithReleaseTranslations = mergeTranslationPatches(
  en,
  enAdditionalTranslations,
  enYoudaoTranslations,
  enDownloadNetworkTranslations,
  enMiCloudProgressTranslations,
  enLargeDocumentTranslations,
  enWorkspaceLayoutTranslations,
  enSecurityAddonTranslations,
  enDiaryMarkdownTranslations,
  enEditorSplitTranslations,
);

const zhCNWithRuntimeOverrides = mergeTranslations(
  zhCNWithReleaseTranslations,
  {
    auth: {
      ugreenAccess: {
        // Android/iOS 只能在系统浏览器中打开绿联远程工作台，不能回到当前 App 自动续登。
        button: "在系统浏览器中打开",
      },
    },
    tiptap: {
      indent: "增加块级缩进（代码块内 Tab 仅调整代码内容）",
      outdent: "减少块级缩进（代码块内 Shift+Tab 仅调整代码内容）",
    },
  },
);

const enWithRuntimeOverrides = mergeTranslations(
  enWithReleaseTranslations,
  {
    auth: {
      ugreenAccess: {
        // Native mobile opens the UGREEN workspace in the system browser; it does not resume in-app sign-in.
        button: "Open in system browser",
      },
    },
    tiptap: {
      indent: "Increase block indent (Tab only indents code inside code blocks)",
      outdent: "Decrease block indent (Shift+Tab only indents code inside code blocks)",
    },
  },
);

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      "zh-CN": { translation: zhCNWithRuntimeOverrides },
      en: { translation: enWithRuntimeOverrides },
    },
    fallbackLng: "zh-CN",
    interpolation: {
      escapeValue: false,
    },
    detection: {
      order: ["localStorage", "navigator"],
      lookupLocalStorage: "i18nextLng",
      caches: ["localStorage"],
    },
  });

// Release compatibility: translate only known legacy hardcoded copy inside SettingsModal.
// The bridge is DOM-scoped and does not touch the note/editor workspace.
installLegacySettingsI18nBridge(i18n);

export default i18n;
