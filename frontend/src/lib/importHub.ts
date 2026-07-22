export type ImportMethod =
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
