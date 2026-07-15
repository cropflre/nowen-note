export type McpAccessMode = "read-only" | "read-write";

export interface NotebookLike {
  id: string;
  parentId?: string | null;
}

export interface ScopeEnvironment {
  NOWEN_API_TOKEN?: string;
  ALLOWED_NOTEBOOK_IDS?: string;
  MCP_ACCESS_MODE?: string;
  MCP_INCLUDE_DESCENDANTS?: string;
  [key: string]: string | undefined;
}

export interface ScopeConfiguration {
  apiToken?: string;
  enabled: boolean;
  rootNotebookIds: string[];
  accessMode: McpAccessMode;
  includeDescendants: boolean;
}

export class ScopeDeniedError extends Error {
  readonly code = "MCP_SCOPE_DENIED";

  constructor(message: string) {
    super(message);
    this.name = "ScopeDeniedError";
  }
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function loadScopeConfiguration(env: ScopeEnvironment = process.env): ScopeConfiguration {
  const scopeConfigured = Object.prototype.hasOwnProperty.call(env, "ALLOWED_NOTEBOOK_IDS");
  const rootNotebookIds = Array.from(new Set(
    (env.ALLOWED_NOTEBOOK_IDS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  ));
  const accessMode: McpAccessMode = env.MCP_ACCESS_MODE === "read-only"
    ? "read-only"
    : "read-write";

  return {
    apiToken: env.NOWEN_API_TOKEN?.trim() || undefined,
    enabled: scopeConfigured,
    rootNotebookIds,
    accessMode,
    includeDescendants: parseBoolean(env.MCP_INCLUDE_DESCENDANTS, false),
  };
}

export class NotebookScopePolicy {
  readonly enabled: boolean;
  readonly accessMode: McpAccessMode;
  readonly includeDescendants: boolean;

  private readonly rootNotebookIds: Set<string>;
  private readonly allowedNotebookIds: Set<string>;

  constructor(config: ScopeConfiguration) {
    this.enabled = config.enabled;
    this.accessMode = config.accessMode;
    this.includeDescendants = config.includeDescendants;
    this.rootNotebookIds = new Set(config.rootNotebookIds);
    this.allowedNotebookIds = new Set(config.rootNotebookIds);
  }

  get roots(): string[] {
    return Array.from(this.rootNotebookIds);
  }

  get allowedIds(): string[] {
    return Array.from(this.allowedNotebookIds);
  }

  hydrateDescendants(notebooks: NotebookLike[]): void {
    if (!this.enabled || !this.includeDescendants || this.allowedNotebookIds.size === 0) return;

    let changed = true;
    while (changed) {
      changed = false;
      for (const notebook of notebooks) {
        if (!notebook?.id || !notebook.parentId) continue;
        if (this.allowedNotebookIds.has(notebook.parentId) && !this.allowedNotebookIds.has(notebook.id)) {
          this.allowedNotebookIds.add(notebook.id);
          changed = true;
        }
      }
    }
  }

  registerCreatedNotebook(notebookId: string, parentId?: string | null): void {
    if (!this.enabled || !this.includeDescendants || !notebookId || !parentId) return;
    if (this.allowedNotebookIds.has(parentId)) this.allowedNotebookIds.add(notebookId);
  }

  isNotebookAllowed(notebookId: string | null | undefined): boolean {
    if (!this.enabled) return true;
    return Boolean(notebookId && this.allowedNotebookIds.has(notebookId));
  }

  assertNotebookAllowed(notebookId: string | null | undefined, operation = "访问"): void {
    if (this.isNotebookAllowed(notebookId)) return;
    throw new ScopeDeniedError(`MCP 笔记本作用域拒绝${operation}: ${notebookId || "未指定笔记本"}`);
  }

  assertWritable(operation = "写入"): void {
    if (!this.enabled || this.accessMode === "read-write") return;
    throw new ScopeDeniedError(`当前 MCP_ACCESS_MODE=read-only，禁止${operation}`);
  }

  filterNotebooks<T extends NotebookLike>(items: T[]): T[] {
    if (!this.enabled) return items;
    return items.filter((item) => this.isNotebookAllowed(item.id));
  }

  filterNotes<T extends { notebookId?: string | null }>(items: T[]): T[] {
    if (!this.enabled) return items;
    return items.filter((item) => this.isNotebookAllowed(item.notebookId));
  }

  filterFiles<T extends { primaryNote?: { notebookId?: string | null } | null }>(items: T[]): T[] {
    if (!this.enabled) return items;
    return items.filter((item) => this.isNotebookAllowed(item.primaryNote?.notebookId));
  }

  assertFileNotebookIds(notebookIds: Array<string | null | undefined>, write = false): void {
    if (!this.enabled) return;
    const concreteIds = Array.from(new Set(notebookIds.filter((id): id is string => Boolean(id))));
    const allowed = write
      ? concreteIds.length > 0 && concreteIds.every((id) => this.isNotebookAllowed(id))
      : concreteIds.some((id) => this.isNotebookAllowed(id));
    if (!allowed) {
      throw new ScopeDeniedError("附件不属于当前 MCP 允许访问的笔记本范围");
    }
  }
}
