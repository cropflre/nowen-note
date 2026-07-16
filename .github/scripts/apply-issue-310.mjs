import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const dataManagerPath = path.join(root, "frontend/src/components/DataManager.tsx");
const youdaoPath = path.join(root, "frontend/src/components/YoudaoImport.tsx");
const youdaoLegacyPath = path.join(root, "frontend/src/components/YoudaoImportLegacy.tsx");
const importHubPath = path.join(root, "frontend/src/lib/importHub.ts");
const importHubTestPath = path.join(root, "frontend/src/lib/__tests__/importHub.test.ts");
const zhPath = path.join(root, "frontend/src/i18n/locales/zh-CN.json");
const enPath = path.join(root, "frontend/src/i18n/locales/en.json");

function replaceOnce(source, search, replacement, label) {
  const index = source.indexOf(search);
  if (index < 0) throw new Error(`[issue-310] Missing ${label}`);
  if (source.indexOf(search, index + search.length) >= 0) {
    throw new Error(`[issue-310] ${label} is not unique`);
  }
  return source.slice(0, index) + replacement + source.slice(index + search.length);
}

function replaceBetween(source, startMarker, endMarker, replacement, label) {
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`[issue-310] Missing start marker for ${label}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end < 0) throw new Error(`[issue-310] Missing end marker for ${label}`);
  return source.slice(0, start) + replacement + source.slice(end);
}

const importHubSource = `export type ImportMethod =
  | "siyuan"
  | "obsidian"
  | "wechat-favorites"
  | "youdao"
  | "mobile-memo"
  | "generic"
  | "url"
  | "nowen";

export type ImportMethodGroupId = "migration" | "general" | "restore";

export interface ImportMethodStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const IMPORT_METHOD_STORAGE_KEY = "nowen-data-manager-import-method";
export const DEFAULT_IMPORT_METHOD: ImportMethod = "generic";

export const IMPORT_METHOD_GROUPS: ReadonlyArray<{
  id: ImportMethodGroupId;
  methods: ReadonlyArray<ImportMethod>;
}> = [
  {
    id: "migration",
    methods: ["siyuan", "obsidian", "wechat-favorites", "youdao", "mobile-memo"],
  },
  { id: "general", methods: ["generic", "url"] },
  { id: "restore", methods: ["nowen"] },
];

const IMPORT_METHOD_SET = new Set<ImportMethod>(
  IMPORT_METHOD_GROUPS.flatMap((group) => group.methods),
);
const FILE_IMPORT_METHODS = new Set<ImportMethod>(["siyuan", "generic"]);

export function isImportMethod(value: unknown): value is ImportMethod {
  return typeof value === "string" && IMPORT_METHOD_SET.has(value as ImportMethod);
}

function browserStorage(): ImportMethodStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readImportMethod(
  storage: ImportMethodStorage | null = browserStorage(),
): ImportMethod {
  if (!storage) return DEFAULT_IMPORT_METHOD;
  try {
    const value = storage.getItem(IMPORT_METHOD_STORAGE_KEY);
    return isImportMethod(value) ? value : DEFAULT_IMPORT_METHOD;
  } catch {
    return DEFAULT_IMPORT_METHOD;
  }
}

export function persistImportMethod(
  method: ImportMethod,
  storage: ImportMethodStorage | null = browserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(IMPORT_METHOD_STORAGE_KEY, method);
  } catch {
    // Private mode or storage quota must not block the import center.
  }
}

/**
 * Generic files and SiYuan share one local file-selection state in DataManager.
 * Clear that state whenever either side of a source switch uses the shared flow,
 * so a ZIP selected for one parser is never silently reused by another source.
 */
export function shouldResetSharedFileImport(
  previous: ImportMethod,
  next: ImportMethod,
): boolean {
  return previous !== next && (
    FILE_IMPORT_METHODS.has(previous) || FILE_IMPORT_METHODS.has(next)
  );
}
`;

const importHubTestSource = `import { describe, expect, it } from "vitest";
import {
  DEFAULT_IMPORT_METHOD,
  IMPORT_METHOD_GROUPS,
  IMPORT_METHOD_STORAGE_KEY,
  persistImportMethod,
  readImportMethod,
  shouldResetSharedFileImport,
  type ImportMethodStorage,
} from "../importHub";

function memoryStorage(initial?: string): ImportMethodStorage & { value: string | null } {
  return {
    value: initial ?? null,
    getItem(key) {
      return key === IMPORT_METHOD_STORAGE_KEY ? this.value : null;
    },
    setItem(key, value) {
      if (key === IMPORT_METHOD_STORAGE_KEY) this.value = value;
    },
  };
}

describe("import hub information architecture", () => {
  it("exposes eight unique first-level sources in the intended groups", () => {
    const methods = IMPORT_METHOD_GROUPS.flatMap((group) => group.methods);
    expect(IMPORT_METHOD_GROUPS.map((group) => group.id)).toEqual([
      "migration",
      "general",
      "restore",
    ]);
    expect(methods).toEqual([
      "siyuan",
      "obsidian",
      "wechat-favorites",
      "youdao",
      "mobile-memo",
      "generic",
      "url",
      "nowen",
    ]);
    expect(new Set(methods).size).toBe(methods.length);
  });

  it("defaults to generic files and restores a valid previous source", () => {
    expect(readImportMethod(memoryStorage("not-a-source"))).toBe(DEFAULT_IMPORT_METHOD);
    expect(readImportMethod(memoryStorage("wechat-favorites"))).toBe("wechat-favorites");
  });

  it("persists the selected source without throwing", () => {
    const storage = memoryStorage();
    persistImportMethod("obsidian", storage);
    expect(storage.value).toBe("obsidian");
  });

  it("clears shared file state whenever SiYuan or generic files are crossed", () => {
    expect(shouldResetSharedFileImport("generic", "siyuan")).toBe(true);
    expect(shouldResetSharedFileImport("siyuan", "obsidian")).toBe(true);
    expect(shouldResetSharedFileImport("obsidian", "generic")).toBe(true);
    expect(shouldResetSharedFileImport("obsidian", "wechat-favorites")).toBe(false);
  });
});
`;

fs.mkdirSync(path.dirname(importHubPath), { recursive: true });
fs.mkdirSync(path.dirname(importHubTestPath), { recursive: true });
fs.writeFileSync(importHubPath, importHubSource, "utf8");
fs.writeFileSync(importHubTestPath, importHubTestSource, "utf8");

let source = fs.readFileSync(dataManagerPath, "utf8");

source = replaceOnce(
  source,
  '  User as UserIcon, Users, ServerCog, Package, Smartphone,\n',
  '  User as UserIcon, Users, ServerCog, Package, Smartphone, FolderOpen, Heart,\n',
  "lucide import",
);

source = replaceOnce(
  source,
  'import YoudaoImport from "@/components/YoudaoImport";\nimport UrlImport from "@/components/UrlImport";\n',
  'import YoudaoImport from "@/components/YoudaoImport";\n' +
    'import ObsidianImport from "@/components/ObsidianImport";\n' +
    'import WeChatFavoritesImport from "@/components/WeChatFavoritesImport";\n' +
    'import UrlImport from "@/components/UrlImport";\n' +
    'import {\n' +
    '  IMPORT_METHOD_GROUPS,\n' +
    '  persistImportMethod,\n' +
    '  readImportMethod,\n' +
    '  shouldResetSharedFileImport,\n' +
    '  type ImportMethod,\n' +
    '} from "@/lib/importHub";\n',
  "import hub imports",
);

source = replaceOnce(
  source,
  'type ImportMethod = "siyuan" | "generic" | "nowen" | "url" | "mobile-memo" | "youdao";\n',
  "",
  "legacy ImportMethod type",
);

source = replaceOnce(
  source,
  '  const [activeImportMethod, setActiveImportMethod] = useState<ImportMethod>("siyuan");\n' +
    '  const [activeMobileMemoMethod, setActiveMobileMemoMethod] = useState<MobileMemoMethod>("xiaomi");\n',
  '  const [activeImportMethod, setActiveImportMethod] = useState<ImportMethod>(() => readImportMethod());\n' +
    '  const [activeMobileMemoMethod, setActiveMobileMemoMethod] = useState<MobileMemoMethod>("xiaomi");\n' +
    '  useEffect(() => persistImportMethod(activeImportMethod), [activeImportMethod]);\n',
  "import method state",
);

source = replaceOnce(
  source,
  '  const selectedCount = importFiles.filter((f) => f.selected).length;\n',
  '  const handleImportMethodChange = (method: ImportMethod) => {\n' +
    '    if (method === activeImportMethod) return;\n' +
    '    if (shouldResetSharedFileImport(activeImportMethod, method)) clearImportList();\n' +
    '    setActiveImportMethod(method);\n' +
    '  };\n\n' +
    '  const selectedCount = importFiles.filter((f) => f.selected).length;\n',
  "import method change handler",
);

const importConfigReplacement = `  const importMethodConfigs: Record<ImportMethod, {
    icon: React.ComponentType<{ className?: string }>;
    label: string;
    desc: string;
    tag: string;
    iconClass: string;
  }> = {
    siyuan: {
      icon: BookOpen,
      label: t("dataManager.importMethodSiyuan"),
      desc: t("dataManager.importMethodSiyuanDesc"),
      tag: t("dataManager.importMethodSiyuanTag"),
      iconClass: "text-emerald-600 dark:text-emerald-400",
    },
    obsidian: {
      icon: FolderOpen,
      label: t("dataManager.importMethodObsidian"),
      desc: t("dataManager.importMethodObsidianDesc"),
      tag: t("dataManager.importMethodObsidianTag"),
      iconClass: "text-violet-600 dark:text-violet-400",
    },
    "wechat-favorites": {
      icon: Heart,
      label: t("dataManager.importMethodWechatFavorites"),
      desc: t("dataManager.importMethodWechatFavoritesDesc"),
      tag: t("dataManager.importMethodWechatFavoritesTag"),
      iconClass: "text-emerald-600 dark:text-emerald-400",
    },
    youdao: {
      icon: BookOpen,
      label: t("dataManager.importMethodYoudao"),
      desc: t("dataManager.importMethodYoudaoDesc"),
      tag: t("dataManager.importMethodYoudaoTag"),
      iconClass: "text-rose-600 dark:text-rose-400",
    },
    "mobile-memo": {
      icon: Smartphone,
      label: t("dataManager.importMethodMobileMemo"),
      desc: t("dataManager.importMethodMobileMemoDesc"),
      tag: t("dataManager.importMethodMobileMemoTag"),
      iconClass: "text-orange-600 dark:text-orange-400",
    },
    generic: {
      icon: FileUp,
      label: t("dataManager.importMethodGeneric"),
      desc: t("dataManager.importMethodGenericDesc"),
      tag: t("dataManager.importMethodGenericTag"),
      iconClass: "text-indigo-600 dark:text-indigo-400",
    },
    url: {
      icon: ExternalLink,
      label: t("dataManager.importMethodUrl"),
      desc: t("dataManager.importMethodUrlDesc"),
      tag: t("dataManager.importMethodUrlTag"),
      iconClass: "text-blue-600 dark:text-blue-400",
    },
    nowen: {
      icon: Package,
      label: t("dataManager.importMethodNowen"),
      desc: t("dataManager.importMethodNowenDesc"),
      tag: t("dataManager.importMethodNowenTag"),
      iconClass: "text-violet-600 dark:text-violet-400",
    },
  };

  const importGroupCopy = {
    migration: {
      title: t("dataManager.importGroupMigration"),
      description: t("dataManager.importGroupMigrationDesc"),
    },
    general: {
      title: t("dataManager.importGroupGeneral"),
      description: t("dataManager.importGroupGeneralDesc"),
    },
    restore: {
      title: t("dataManager.importGroupRestore"),
      description: t("dataManager.importGroupRestoreDesc"),
    },
  } as const;

  const importMethodGroups = IMPORT_METHOD_GROUPS.map((group) => ({
    ...group,
    ...importGroupCopy[group.id],
    methods: group.methods.map((id) => ({ id, ...importMethodConfigs[id] })),
  }));
`;

source = replaceBetween(
  source,
  "  const importMethods = [\n",
  "  const getImportMethodClass",
  importConfigReplacement + "\n",
  "import method configuration",
);

source = replaceBetween(
  source,
  "  const getImportMethodClass = (tone: string, active: boolean): string => {\n",
  "\n\n  // -----------------------------------------------------------------\n  // 入口闸门",
  `  const getImportMethodClass = (active: boolean): string =>
    active
      ? "border-indigo-400 bg-indigo-50/80 text-zinc-900 ring-2 ring-indigo-500/15 dark:border-indigo-600 dark:bg-indigo-500/10 dark:text-zinc-100"
      : "border-zinc-200 bg-white text-zinc-700 hover:border-indigo-200 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-300 dark:hover:border-zinc-700 dark:hover:bg-zinc-800/60";`,
  "import card classes",
);

const hubMarkup = `            <div className="mb-4">
              <h5 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
                {t("dataManager.importHubTitle")}
              </h5>
              <p className="mt-1 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
                {t("dataManager.importHubDescription")}
              </p>
            </div>

            <div className="space-y-5">
              {importMethodGroups.map((group) => (
                <section key={group.id} aria-labelledby={\`import-group-\${group.id}\`}>
                  <div className="mb-2">
                    <h6
                      id={\`import-group-\${group.id}\`}
                      className="text-xs font-semibold text-zinc-700 dark:text-zinc-200"
                    >
                      {group.title}
                    </h6>
                    <p className="mt-0.5 text-[11px] leading-5 text-zinc-400 dark:text-zinc-500">
                      {group.description}
                    </p>
                  </div>
                  <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                    {group.methods.map((method) => {
                      const Icon = method.icon;
                      const active = activeImportMethod === method.id;
                      return (
                        <button
                          key={method.id}
                          type="button"
                          onClick={() => handleImportMethodChange(method.id)}
                          disabled={personalImportLocked}
                          aria-pressed={active}
                          className={\`min-h-[112px] rounded-xl border p-3 text-left transition-all disabled:cursor-not-allowed disabled:opacity-60 \${getImportMethodClass(active)}\`}
                        >
                          <span className="flex items-start gap-2.5">
                            <span className={\`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-zinc-100/80 dark:bg-zinc-950/40 \${method.iconClass}\`}>
                              <Icon className="h-4 w-4" />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block text-sm font-semibold">{method.label}</span>
                              <span className="mt-1 block text-xs leading-5 opacity-75">{method.desc}</span>
                              <span className="mt-2 inline-flex max-w-full rounded-md bg-zinc-100/80 px-1.5 py-0.5 text-[11px] font-medium dark:bg-zinc-950/40">
                                {method.tag}
                              </span>
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>

`;

source = replaceBetween(
  source,
  '            <div className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 mb-2">\n',
  '            <div className="mt-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/40 p-3 sm:p-4">\n',
  hubMarkup,
  "import hub cards",
);

source = replaceOnce(
  source,
  '            <div className="mt-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/40 p-3 sm:p-4">\n',
  '            <div key={activeImportMethod} className="mt-5 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/40 p-3 sm:p-4">\n',
  "active import panel",
);

source = replaceOnce(
  source,
  '              {!personalImportLocked && activeImportMethod === "youdao" && <YoudaoImport />}\n',
  '              {!personalImportLocked && activeImportMethod === "obsidian" && <ObsidianImport />}\n' +
    '              {!personalImportLocked && activeImportMethod === "wechat-favorites" && <WeChatFavoritesImport />}\n' +
    '              {!personalImportLocked && activeImportMethod === "youdao" && <YoudaoImport />}\n',
  "direct migration panels",
);

fs.writeFileSync(dataManagerPath, source, "utf8");

if (!fs.existsSync(youdaoLegacyPath)) {
  throw new Error("[issue-310] Missing YoudaoImportLegacy.tsx");
}
fs.writeFileSync(youdaoPath, fs.readFileSync(youdaoLegacyPath, "utf8"), "utf8");
fs.rmSync(youdaoLegacyPath);

const localeValues = {
  zh: {
    importHubTitle: "选择导入来源",
    importHubDescription: "按数据来源选择迁移方式，点击后在下方完成预检和导入。",
    importGroupMigration: "第三方数据迁移",
    importGroupMigrationDesc: "从其他笔记产品、收藏工具或手机生态迁移结构化数据。",
    importGroupGeneral: "通用内容导入",
    importGroupGeneralDesc: "导入本地文件或网页内容，不依赖特定产品导出格式。",
    importGroupRestore: "Nowen 数据恢复",
    importGroupRestoreDesc: "在 Nowen 实例之间迁移并恢复完整数据包。",
    importMethodObsidian: "Obsidian Vault",
    importMethodObsidianDesc: "Vault 文件夹或 ZIP",
    importMethodObsidianTag: "保留目录与附件",
    importMethodWechatFavorites: "微信收藏",
    importMethodWechatFavoritesDesc: "WeChatDataAnalysis JSON ZIP",
    importMethodWechatFavoritesTag: "收藏内容迁移",
    importMethodYoudao: "有道云笔记",
    importMethodYoudaoDesc: "有道云笔记批量导出目录",
    importMethodYoudaoTag: "批量目录迁移",
  },
  en: {
    importHubTitle: "Choose an import source",
    importHubDescription: "Choose the source of your data, then review and import it in the panel below.",
    importGroupMigration: "Third-party migrations",
    importGroupMigrationDesc: "Move structured data from note apps, favorites tools, and mobile ecosystems.",
    importGroupGeneral: "General content imports",
    importGroupGeneralDesc: "Import local files or web content without a product-specific export format.",
    importGroupRestore: "Nowen data restore",
    importGroupRestoreDesc: "Move and restore complete packages between Nowen instances.",
    importMethodObsidian: "Obsidian Vault",
    importMethodObsidianDesc: "Vault folder or ZIP",
    importMethodObsidianTag: "Keep folders & assets",
    importMethodWechatFavorites: "WeChat Favorites",
    importMethodWechatFavoritesDesc: "WeChatDataAnalysis JSON ZIP",
    importMethodWechatFavoritesTag: "Favorites migration",
    importMethodYoudao: "Youdao Note",
    importMethodYoudaoDesc: "Youdao bulk export folder",
    importMethodYoudaoTag: "Folder migration",
  },
};

for (const [filePath, language] of [[zhPath, "zh"], [enPath, "en"]]) {
  const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!data.dataManager || typeof data.dataManager !== "object") {
    throw new Error(`[issue-310] Missing dataManager translations in ${filePath}`);
  }
  Object.assign(data.dataManager, localeValues[language]);
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

console.log("[issue-310] Import hub information architecture patched successfully.");
