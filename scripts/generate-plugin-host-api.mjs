import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACT_PATH = path.join(ROOT, "packages/nowen-plugin-sdk/host-api-contract.json");
const IPC_MESSAGE_BYTES = 2 * 1024 * 1024;
const HOST_CALL_ARGS_BYTES = 256 * 1024;
const HOST_CALL_RESULT_BYTES = 1024 * 1024;
const RUNTIMES = new Set(["node-action", "sandbox-js"]);
const PLUGIN_PERMISSIONS = new Set([
  "notes:read", "notes:write", "notebooks:read", "notebooks:write",
  "tags:read", "tags:write", "tasks:read", "tasks:write",
  "attachments:read", "attachments:write", "diary:read", "diary:write",
  "mindmaps:read", "mindmaps:write", "plugin-storage:read", "plugin-storage:write",
  "external:fetch", "secrets:use",
]);

const SDK_METHODS = new Map([
  ["notes.get", { permission: "notes:read", signature: "get(input: { noteId: string }): Promise<Note | null>;" }],
  ["notes.list", { permission: "notes:read", signature: "list(input?: { limit?: number }): Promise<NoteSummary[]>;" }],
  ["notes.create", { permission: "notes:write", signature: "create(input: { notebookId: string; title?: string; content?: string; contentFormat?: \"markdown\" | \"html\" | \"tiptap-json\" }): Promise<{ id: string; version?: number }>;" }],
  ["notes.update", { permission: "notes:write", signature: "update(input: { noteId: string; title?: string; content?: string; contentFormat?: \"markdown\" | \"html\" | \"tiptap-json\" }): Promise<{ id: string; version: number }>;" }],
  ["notebooks.get", { permission: "notebooks:read", signature: "get(input: { notebookId: string }): Promise<Notebook | null>;" }],
  ["notebooks.list", { permission: "notebooks:read", signature: "list(): Promise<Notebook[]>;" }],
  ["notebooks.create", { permission: "notebooks:write", signature: "create(input: { name: string; workspaceId?: string | null; parentId?: string | null; icon?: string; color?: string | null }): Promise<{ id: string }>;" }],
  ["tags.list", { permission: "tags:read", signature: "list(): Promise<Tag[]>;" }],
  ["tags.create", { permission: "tags:write", signature: "create(input: { name: string; color?: string; workspaceId?: string | null }): Promise<{ id: string }>;" }],
  ["tags.addToNote", { permission: "tags:write", signature: "addToNote(input: { noteId: string; tagId: string }): Promise<{ success: true }>;" }],
  ["tags.removeFromNote", { permission: "tags:write", signature: "removeFromNote(input: { noteId: string; tagId: string }): Promise<{ success: true }>;" }],
  ["tasks.get", { permission: "tasks:read", signature: "get(input: { taskId: string }): Promise<Task>;" }],
  ["tasks.list", { permission: "tasks:read", signature: "list(input?: { limit?: number }): Promise<Task[]>;" }],
  ["tasks.create", { permission: "tasks:write", signature: "create(input: { title: string; workspaceId?: string | null; description?: string; priority?: number; dueDate?: string | null; noteId?: string | null }): Promise<{ id: string }>;" }],
  ["tasks.update", { permission: "tasks:write", signature: "update(input: { taskId: string; title?: string; description?: string; isCompleted?: boolean; priority?: number; dueDate?: string | null }): Promise<{ id: string }>;" }],
  ["attachments.get", { permission: "attachments:read", signature: "get(input: { attachmentId: string }): Promise<Attachment>;" }],
  ["attachments.list", { permission: "attachments:read", signature: "list(input?: { limit?: number }): Promise<Attachment[]>;" }],
  ["diary.get", { permission: "diary:read", signature: "get(input: { diaryId: string }): Promise<DiaryEntry>;" }],
  ["diary.list", { permission: "diary:read", signature: "list(input?: { limit?: number }): Promise<DiaryEntry[]>;" }],
  ["diary.create", { permission: "diary:write", signature: "create(input: { workspaceId?: string | null; contentText: string; mood?: string; createdAt?: string }): Promise<{ id: string }>;" }],
  ["mindmaps.get", { permission: "mindmaps:read", signature: "get(input: { mindmapId: string }): Promise<Mindmap>;" }],
  ["mindmaps.list", { permission: "mindmaps:read", signature: "list(input?: { limit?: number }): Promise<Mindmap[]>;" }],
  ["mindmaps.create", { permission: "mindmaps:write", signature: "create(input: { workspaceId?: string | null; title?: string; data?: unknown }): Promise<{ id: string }>;" }],
  ["mindmaps.update", { permission: "mindmaps:write", signature: "update(input: { mindmapId: string; title?: string; data?: unknown }): Promise<{ id: string }>;" }],
  ["storage.get", { permission: "plugin-storage:read", signature: "get(input: { key: string; scopeType?: \"user\" | \"workspace\"; scopeId?: string }): Promise<unknown>;" }],
  ["storage.set", { permission: "plugin-storage:write", signature: "set(input: { key: string; value: unknown; scopeType?: \"user\" | \"workspace\"; scopeId?: string }): Promise<{ success: true }>;" }],
  ["storage.delete", { permission: "plugin-storage:write", signature: "delete(input: { key: string; scopeType?: \"user\" | \"workspace\"; scopeId?: string }): Promise<{ success: true }>;" }],
  ["external.fetch", { permission: "external:fetch", signature: "fetch(input: { url: string; method?: string; headers?: Record<string, string>; body?: unknown; connection?: string }): Promise<{ status: number; ok: boolean; headers: { \"content-type\": string | null }; body: string }>;" }],
  ["runtime.capabilities", { permission: null, signature: "capabilities(): Promise<RuntimeCapabilities>;" }],
]);

const INTERFACE_NAMES = {
  notes: "NotesApi",
  notebooks: "NotebooksApi",
  tags: "TagsApi",
  tasks: "TasksApi",
  attachments: "AttachmentsApi",
  diary: "DiaryApi",
  mindmaps: "MindmapsApi",
  storage: "StorageApi",
  external: "ExternalApi",
  runtime: "RuntimeApi",
};

function fail(message) {
  throw new Error(`Host API 合同无效: ${message}`);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compareCodePoints(left, right) {
  const leftPoints = [...left].map((character) => character.codePointAt(0));
  const rightPoints = [...right].map((character) => character.codePointAt(0));
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index] - rightPoints[index];
  }
  return leftPoints.length - rightPoints.length;
}

function requireExactKeys(value, expected, location) {
  if (!isObject(value)) fail(`${location} 必须是对象`);
  const actual = Object.keys(value).sort(compareCodePoints);
  const wanted = [...expected].sort(compareCodePoints);
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${location} 字段必须严格为 ${wanted.join(", ")}`);
  }
}

function validateContract(value) {
  requireExactKeys(value, ["contractVersion", "budgets", "combinationPermissions", "methods"], "根对象");
  if (!Number.isInteger(value.contractVersion) || value.contractVersion < 1) fail("contractVersion 必须是正整数");
  requireExactKeys(value.budgets, ["ipcMessageBytes", "hostCallArgsBytes", "hostCallResultBytes"], "budgets");
  if (value.budgets.ipcMessageBytes !== IPC_MESSAGE_BYTES) fail("IPC 预算必须是 2MB");
  if (value.budgets.hostCallArgsBytes !== HOST_CALL_ARGS_BYTES) fail("Host Call 参数预算必须是 256KB");
  if (value.budgets.hostCallResultBytes !== HOST_CALL_RESULT_BYTES) fail("Host Call 结果预算必须是 1MB");
  if (!Array.isArray(value.combinationPermissions)
    || value.combinationPermissions.length !== 1
    || value.combinationPermissions[0] !== "secrets:use") {
    fail("combinationPermissions 必须严格等于 [\"secrets:use\"]");
  }
  if (!Array.isArray(value.methods) || value.methods.length === 0) fail("methods 必须是非空数组");
  const methods = new Set();
  for (const [index, entry] of value.methods.entries()) {
    requireExactKeys(entry, ["method", "sinceApiVersion", "permission", "runtimes", "maxArgsBytes", "maxResultBytes"], `methods[${index}]`);
    if (typeof entry.method !== "string" || !/^[a-z][A-Za-z0-9]*\.[a-z][A-Za-z0-9]*$/.test(entry.method)) fail(`非法 method ${String(entry.method)}`);
    if (methods.has(entry.method)) fail(`重复 method ${entry.method}`);
    methods.add(entry.method);
    if (entry.sinceApiVersion !== 1 && entry.sinceApiVersion !== 2) fail(`${entry.method} 的 sinceApiVersion 只能是 1 或 2`);
    if (entry.permission !== null && !PLUGIN_PERMISSIONS.has(entry.permission)) fail(`${entry.method} 使用未知权限 ${String(entry.permission)}`);
    if (entry.permission === "attachments:write") fail(`${entry.method} 不得使用 V2 不支持的 attachments:write`);
    if (!Array.isArray(entry.runtimes) || entry.runtimes.length === 0) fail(`${entry.method} 的 runtimes 必须是非空数组`);
    const runtimes = new Set();
    for (const runtime of entry.runtimes) {
      if (!RUNTIMES.has(runtime)) fail(`${entry.method} 使用未知 runtime ${String(runtime)}`);
      if (runtimes.has(runtime)) fail(`${entry.method} 重复 runtime ${runtime}`);
      runtimes.add(runtime);
    }
    if (entry.maxArgsBytes !== HOST_CALL_ARGS_BYTES) fail(`${entry.method} 参数预算必须是 256KB`);
    if (entry.maxResultBytes !== HOST_CALL_RESULT_BYTES) fail(`${entry.method} 结果预算必须是 1MB`);
    const sdkMethod = SDK_METHODS.get(entry.method);
    if (!sdkMethod) fail(`${entry.method} 缺少 SDK 类型签名`);
    if (entry.permission !== sdkMethod.permission) {
      fail(`${entry.method} 权限必须是 ${sdkMethod.permission === null ? "null" : sdkMethod.permission}`);
    }
  }
  for (const method of SDK_METHODS.keys()) {
    if (!methods.has(method)) fail(`SDK 类型签名 ${method} 不在合同中`);
  }
  if (methods.has("storage.list")) fail("storage.list 未由 Broker 实现，禁止写入合同");
  return {
    ...value,
    methods: [...value.methods].sort((left, right) => compareCodePoints(left.method, right.method)),
  };
}

function generatedHeader(source = "packages/nowen-plugin-sdk/host-api-contract.json") {
  return `// 此文件由 scripts/generate-plugin-host-api.mjs 根据 ${source} 生成，请勿手动修改。\n`;
}

function renderBackend(contract) {
  const permissions = [...new Set([
    ...contract.methods.map((entry) => entry.permission).filter(Boolean),
    ...contract.combinationPermissions,
  ])].sort(compareCodePoints);
  return `${generatedHeader()}import type { PluginPermission } from "./types.js";\nimport type { HostApiContractEntry } from "./hostApiContract.js";\n\nfunction deepFreeze<T>(value: T): T {\n  if (value && typeof value === "object" && !Object.isFrozen(value)) {\n    for (const nested of Object.values(value)) deepFreeze(nested);\n    Object.freeze(value);\n  }\n  return value;\n}\n\nexport const HOST_API_CONTRACT_VERSION = ${contract.contractVersion} as const;\n\nexport const HOST_API_BUDGETS = deepFreeze(${JSON.stringify(contract.budgets, null, 2)} as const);\n\nexport const HOST_API_CONTRACT = deepFreeze(${JSON.stringify(contract.methods, null, 2)} as const) satisfies readonly HostApiContractEntry[];\n\nexport const V2_COMBINATION_PLUGIN_PERMISSIONS = deepFreeze(${JSON.stringify(contract.combinationPermissions, null, 2)} as const) satisfies readonly PluginPermission[];\n\nexport const V2_SUPPORTED_PLUGIN_PERMISSIONS = deepFreeze(${JSON.stringify(permissions, null, 2)} as const) satisfies readonly PluginPermission[];\n`;
}

function renderSdk(contract) {
  const permissions = [...new Set([
    ...contract.methods.map((entry) => entry.permission).filter(Boolean),
    ...contract.combinationPermissions,
  ])].sort(compareCodePoints);
  const methods = contract.methods.map((entry) => entry.method);
  const grouped = new Map();
  for (const entry of contract.methods) {
    const [namespace] = entry.method.split(".");
    if (!grouped.has(namespace)) grouped.set(namespace, []);
    grouped.get(namespace).push(SDK_METHODS.get(entry.method).signature);
  }
  const interfaces = Object.entries(INTERFACE_NAMES).map(([namespace, interfaceName]) => {
    const signatures = grouped.get(namespace);
    if (!signatures) fail(`合同缺少 SDK namespace ${namespace}`);
    return `export interface ${interfaceName} {\n${signatures.map((signature) => `  ${signature}`).join("\n")}\n}`;
  }).join("\n\n");
  const hostProperties = Object.entries(INTERFACE_NAMES)
    .map(([namespace, interfaceName]) => `  ${namespace}: ${interfaceName};`)
    .join("\n");
  return `${generatedHeader()}import type { Attachment, DiaryEntry, Mindmap, Note, Notebook, NoteSummary, Tag, Task } from "./index.js";\n\nfunction deepFreeze<T>(value: T): T {\n  if (value && typeof value === "object" && !Object.isFrozen(value)) {\n    for (const nested of Object.values(value)) deepFreeze(nested);\n    Object.freeze(value);\n  }\n  return value;\n}\n\nexport type PluginHostRuntime = "node-action" | "sandbox-js";\nexport type HostApiPermission = ${permissions.map((permission) => JSON.stringify(permission)).join(" | ")};\nexport type HostApiMethod = ${methods.map((method) => JSON.stringify(method)).join(" | ")};\n\nexport interface HostApiContractEntry {\n  method: HostApiMethod;\n  sinceApiVersion: 1 | 2;\n  permission: HostApiPermission | null;\n  runtimes: readonly PluginHostRuntime[];\n  maxArgsBytes: number;\n  maxResultBytes: number;\n}\n\nexport interface HostApiBudgets {\n  readonly ipcMessageBytes: number;\n  readonly hostCallArgsBytes: number;\n  readonly hostCallResultBytes: number;\n}\n\nexport const HOST_API_CONTRACT_VERSION = ${contract.contractVersion} as const;\nexport const HOST_API_BUDGETS: HostApiBudgets = deepFreeze(${JSON.stringify(contract.budgets, null, 2)});\nexport const HOST_API_CONTRACT: readonly HostApiContractEntry[] = deepFreeze(${JSON.stringify(contract.methods, null, 2)});\n\nexport interface RuntimeCapabilities {\n  apiVersion: number;\n  runtime: PluginHostRuntime;\n  platform: "server" | "desktop-full";\n  contractVersion: number;\n  budgets: HostApiBudgets;\n  methods: readonly HostApiContractEntry[];\n  hostApis: string[];\n  notes?: { read: number; write: number };\n  notebooks?: { read: number; write: number };\n  tasks?: { read: number; write: number };\n  automation?: number;\n  workspace?: number;\n  declarativeContributions?: number;\n}\n\n${interfaces}\n\nexport interface PluginProgress { current?: number; total?: number; message?: string }\nexport type PluginProgressCallback = (input: PluginProgress) => void;\n\nexport interface NowenHostApi {\n${hostProperties}\n  progress: PluginProgressCallback;\n}\n`;
}

function renderMarkdown(contract) {
  const rows = contract.methods.map((entry) => `| \`${entry.method}\` | V${entry.sinceApiVersion} | ${entry.permission ? `\`${entry.permission}\`` : "无"} | ${entry.runtimes.map((runtime) => `\`${runtime}\``).join(", ")} | ${entry.maxArgsBytes} | ${entry.maxResultBytes} |`);
  return `<!-- 此文件由 scripts/generate-plugin-host-api.mjs 根据 packages/nowen-plugin-sdk/host-api-contract.json 生成，请勿手动修改。 -->\n# Host API 合同\n\n合同版本：${contract.contractVersion}\n\n固定预算：IPC 消息 ${contract.budgets.ipcMessageBytes} 字节，Host Call 参数 ${contract.budgets.hostCallArgsBytes} 字节，Host Call 结果 ${contract.budgets.hostCallResultBytes} 字节。\n\n| 方法 | 起始 API | 权限 | Runtime | 参数上限（字节） | 结果上限（字节） |\n| --- | --- | --- | --- | ---: | ---: |\n${rows.join("\n")}\n\n说明：\`progress\` 是运行时事件，不是 Broker Host Call。V2 不支持 \`attachments:write\`，\`secrets:use\` 仅用于 \`external.fetch\` 的 Connection 密钥注入。\n`;
}

async function atomicWrite(target, content) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.tmp`);
  try {
    await writeFile(temporary, content, "utf8");
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

const args = new Set(process.argv.slice(2));
if ([...args].some((argument) => argument !== "--check")) {
  throw new Error("仅支持 --check 参数");
}

const contract = validateContract(JSON.parse(await readFile(CONTRACT_PATH, "utf8")));
const outputs = new Map([
  [path.join(ROOT, "backend/src/plugins/hostApiContract.generated.ts"), renderBackend(contract)],
  [path.join(ROOT, "packages/nowen-plugin-sdk/src/hostApi.generated.ts"), renderSdk(contract)],
  [path.join(ROOT, "docs/plugin-platform/host-api.generated.md"), renderMarkdown(contract)],
]);

if (args.has("--check")) {
  const stale = [];
  for (const [target, content] of outputs) {
    const current = await readFile(target, "utf8").catch(() => null);
    if (current !== content) stale.push(path.relative(ROOT, target));
  }
  if (stale.length > 0) {
    console.error(`Host API 生成物未同步:\n${stale.map((target) => `- ${target}`).join("\n")}`);
    process.exitCode = 1;
  } else {
    console.log("Host API 生成物已同步");
  }
} else {
  for (const [target, content] of outputs) await atomicWrite(target, content);
  console.log(`已生成 ${outputs.size} 个 Host API 文件`);
}
