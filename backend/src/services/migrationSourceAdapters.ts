import { MIGRATION_LIMITS, nmfNoteSchema, type NmfNote } from "./migrationFormat";

export const MIGRATION_SOURCE_ADAPTER_API_VERSION = 1 as const;

export interface MigrationSourceAdapterDescriptor {
  readonly id: string;
  readonly version: 1;
  readonly platforms: readonly string[];
  readonly formats: readonly string[];
  readonly extensions: readonly string[];
  readonly autoDetect: boolean;
  readonly unsupported: readonly string[];
}

/** Describes trusted built-ins. User uploads cannot register or execute code. */
export const MIGRATION_SOURCE_ADAPTERS = [
  { id: "nmf-v1", version: 1, platforms: ["*"], formats: ["nmf-v1"], extensions: [".zip"], autoDetect: true,
    unsupported: ["schema-v2", "encrypted-archives"] },
  { id: "siyuan-native-zip", version: 1, platforms: ["siyuan"], formats: ["siyuan-native"], extensions: [".zip"], autoDetect: true,
    unsupported: ["nested-block-links", "history", "sharing-permissions", "timezone-inference"] },
  { id: "notion-markdown-html-csv", version: 1, platforms: ["notion"], formats: ["markdown", "html", "csv-metadata"], extensions: [".md", ".markdown", ".html", ".htm", ".zip"], autoDetect: true,
    unsupported: ["database-relations", "formulas", "comments", "history", "sharing-permissions"] },
  { id: "huawei-notepad-files", version: 1, platforms: ["huawei"], formats: ["txt", "html"], extensions: [".txt", ".html", ".htm", ".zip"], autoDetect: false,
    unsupported: ["cloud-connection", "native-backups", "handwriting", "tags", "original-timestamps"] },
  { id: "generic-files", version: 1, platforms: ["files"], formats: ["markdown", "html", "txt"], extensions: [".md", ".markdown", ".html", ".htm", ".txt", ".zip"], autoDetect: false,
    unsupported: ["source-specific-metadata", "remote-resource-downloads", "scripts", "macros"] },
] as const satisfies readonly MigrationSourceAdapterDescriptor[];

export type MigrationSourceAdapterId = typeof MIGRATION_SOURCE_ADAPTERS[number]["id"];
export type MigrationSourceFile = { readonly diskPath: string; readonly size: number; readonly sha256: string };
export interface MigrationSourceAdapterContext {
  readonly source: Pick<NmfNote["source"], "platform" | "exportId">;
  readonly files: ReadonlyMap<string, MigrationSourceFile>;
  readText(name: string, maxBytes: number): string;
  managedPath(file: MigrationSourceFile): string;
  sniffAsset(diskPath: string, name: string): Promise<string>;
  onNote(note: NmfNote): Promise<void>;
  assertActive?: () => void;
}
export interface MigrationSourceAdapter {
  readonly apiVersion: typeof MIGRATION_SOURCE_ADAPTER_API_VERSION;
  readonly id: MigrationSourceAdapterId;
  matches(context: MigrationSourceAdapterContext): boolean;
  normalize(context: MigrationSourceAdapterContext): Promise<{ warnings: string[] }>;
}

/** Order is owned by the host: manifest, native formats, explicit profiles, fallback. */
export async function normalizeMigrationSource(adapters: readonly MigrationSourceAdapter[], context: MigrationSourceAdapterContext) {
  let emitted = 0;
  const checked: MigrationSourceAdapterContext = { ...context, onNote: async (note) => {
    context.assertActive?.();
    if (++emitted > MIGRATION_LIMITS.notes) throw new Error("MIGRATION_NOTE_COUNT_LIMIT");
    await context.onNote(nmfNoteSchema.parse(note));
  } };
  for (const adapter of adapters) {
    if (adapter.apiVersion !== MIGRATION_SOURCE_ADAPTER_API_VERSION) throw new Error("MIGRATION_ADAPTER_VERSION_UNSUPPORTED");
    context.assertActive?.();
    if (adapter.matches(checked)) return adapter.normalize(checked);
  }
  throw new Error("MIGRATION_UNSUPPORTED_FORMAT");
}
