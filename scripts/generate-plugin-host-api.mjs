import crypto from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SDK_ROOT = path.join(ROOT, "packages/nowen-plugin-sdk");
const HOST_CONTRACT_PATH = path.join(SDK_ROOT, "host-api-contract.json");
const CONTRIBUTION_CONTRACT_PATH = path.join(SDK_ROOT, "contribution-contract.json");
const ERROR_CONTRACT_PATH = path.join(SDK_ROOT, "error-code-contract.json");
const IPC_MESSAGE_BYTES = 2 * 1024 * 1024;
const HOST_CALL_ARGS_BYTES = 256 * 1024;
const HOST_CALL_RESULT_BYTES = 1024 * 1024;
const HOST_RUNTIMES = new Set(["node-action", "sandbox-js"]);
const CONTRIBUTION_RUNTIMES = new Set(["declarative", "node-action", "sandbox-js"]);

function fail(message) {
  throw new Error(`Extension capability contract 无效: ${message}`);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compareCodePoints(left, right) {
  const a = [...String(left)].map((character) => character.codePointAt(0));
  const b = [...String(right)].map((character) => character.codePointAt(0));
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

function requireExactKeys(value, expected, location) {
  if (!isObject(value)) fail(`${location} 必须是对象`);
  const actual = Object.keys(value).sort(compareCodePoints);
  const wanted = [...expected].sort(compareCodePoints);
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${location} 字段必须严格为 ${wanted.join(", ")}`);
  }
}

function uniqueStrings(values, location, allowed) {
  if (!Array.isArray(values) || values.length === 0) fail(`${location} 必须是非空数组`);
  const result = new Set();
  for (const value of values) {
    if (typeof value !== "string" || !value) fail(`${location} 只能包含非空字符串`);
    if (allowed && !allowed.has(value)) fail(`${location} 包含未知值 ${value}`);
    if (result.has(value)) fail(`${location} 包含重复值 ${value}`);
    result.add(value);
  }
  return result;
}

function validateHostContract(value) {
  requireExactKeys(value, ["contractVersion", "budgets", "platforms", "permissions", "combinationPermissions", "templates", "methods"], "Host API 根对象");
  if (!Number.isInteger(value.contractVersion) || value.contractVersion < 2) fail("Host API contractVersion 必须 >= 2");
  requireExactKeys(value.budgets, ["ipcMessageBytes", "hostCallArgsBytes", "hostCallResultBytes"], "Host API budgets");
  if (value.budgets.ipcMessageBytes !== IPC_MESSAGE_BYTES) fail("IPC 预算必须是 2MB");
  if (value.budgets.hostCallArgsBytes !== HOST_CALL_ARGS_BYTES) fail("Host Call 参数预算必须是 256KB");
  if (value.budgets.hostCallResultBytes !== HOST_CALL_RESULT_BYTES) fail("Host Call 结果预算必须是 1MB");

  if (!Array.isArray(value.platforms) || value.platforms.length === 0) fail("platforms 必须是非空数组");
  const platformIds = new Set();
  for (const [index, platform] of value.platforms.entries()) {
    requireExactKeys(platform, ["id", "kind", "description"], `platforms[${index}]`);
    if (!/^[a-z][a-z0-9-]*$/.test(platform.id)) fail(`非法 platform id ${platform.id}`);
    if (!new Set(["runtime", "ui"]).has(platform.kind)) fail(`非法 platform kind ${platform.kind}`);
    if (platformIds.has(platform.id)) fail(`重复 platform ${platform.id}`);
    platformIds.add(platform.id);
  }

  if (!Array.isArray(value.permissions) || value.permissions.length === 0) fail("permissions 必须是非空数组");
  const permissions = new Set();
  for (const [index, permission] of value.permissions.entries()) {
    requireExactKeys(permission, ["id", "description", "risk"], `permissions[${index}]`);
    if (!/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/.test(permission.id)) fail(`非法 permission ${permission.id}`);
    if (permissions.has(permission.id)) fail(`重复 permission ${permission.id}`);
    permissions.add(permission.id);
  }
  if (permissions.has("attachments:write")) fail("V2.1 R1 不得提前开放 attachments:write");

  const combinationPermissions = uniqueStrings(value.combinationPermissions, "combinationPermissions");
  for (const permission of combinationPermissions) if (!permissions.has(permission)) fail(`组合权限未声明: ${permission}`);
  requireExactKeys(value.templates, ["extensionId", "contributionId", "v21EngineRange", "declarativeRuntime"], "templates");
  if (value.templates.v21EngineRange !== ">=1.6.0") fail("V2.1 engine range 必须是 >=1.6.0");
  if (value.templates.declarativeRuntime !== "declarative") fail("declarativeRuntime 必须为 declarative");

  if (!Array.isArray(value.methods) || value.methods.length === 0) fail("methods 必须是非空数组");
  const methods = new Set();
  for (const [index, entry] of value.methods.entries()) {
    requireExactKeys(entry, ["method", "sinceApiVersion", "permission", "runtimes", "platforms", "maxArgsBytes", "maxResultBytes", "inputSchema", "outputSchema", "examples", "sdkSignature"], `methods[${index}]`);
    if (typeof entry.method !== "string" || !/^[a-z][A-Za-z0-9]*\.[a-z][A-Za-z0-9]*$/.test(entry.method)) fail(`非法 method ${String(entry.method)}`);
    if (methods.has(entry.method)) fail(`重复 method ${entry.method}`);
    methods.add(entry.method);
    if (![1, 2].includes(entry.sinceApiVersion)) fail(`${entry.method} sinceApiVersion 无效`);
    if (entry.permission !== null && !permissions.has(entry.permission)) fail(`${entry.method} 使用未知权限 ${String(entry.permission)}`);
    uniqueStrings(entry.runtimes, `${entry.method}.runtimes`, HOST_RUNTIMES);
    const platforms = uniqueStrings(entry.platforms, `${entry.method}.platforms`);
    for (const platform of platforms) if (!platformIds.has(platform)) fail(`${entry.method} 使用未知 platform ${platform}`);
    if (entry.maxArgsBytes !== HOST_CALL_ARGS_BYTES) fail(`${entry.method} 参数预算必须是 256KB`);
    if (entry.maxResultBytes !== HOST_CALL_RESULT_BYTES) fail(`${entry.method} 结果预算必须是 1MB`);
    if (!isObject(entry.inputSchema) || !isObject(entry.outputSchema)) fail(`${entry.method} Schema 必须是对象`);
    if (!Array.isArray(entry.examples)) fail(`${entry.method}.examples 必须是数组`);
    if (typeof entry.sdkSignature !== "string" || !entry.sdkSignature.trim()) fail(`${entry.method} 缺少 SDK signature`);
  }
  if (methods.has("storage.list")) fail("storage.list 未由 Broker 实现，禁止写入合同");

  return {
    ...value,
    platforms: [...value.platforms].sort((a, b) => compareCodePoints(a.id, b.id)),
    permissions: [...value.permissions].sort((a, b) => compareCodePoints(a.id, b.id)),
    methods: [...value.methods].sort((a, b) => compareCodePoints(a.method, b.method)),
  };
}

function validateContributionContract(value) {
  requireExactKeys(value, ["contractVersion", "namespaceTemplate", "runtimes", "types", "appearance", "noteTemplate", "promptPack"], "Contribution 根对象");
  if (!Number.isInteger(value.contractVersion) || value.contractVersion < 1) fail("Contribution contractVersion 必须是正整数");
  uniqueStrings(value.runtimes, "Contribution runtimes", CONTRIBUTION_RUNTIMES);
  if (value.namespaceTemplate !== "<pluginId>/<contributionId>") fail("Contribution namespaceTemplate 无效");
  if (!Array.isArray(value.types) || value.types.length === 0) fail("Contribution types 必须是非空数组");
  const ids = new Set();
  for (const [index, entry] of value.types.entries()) {
    requireExactKeys(entry, ["id", "since", "runtimes", "declarative", "description"], `Contribution types[${index}]`);
    if (!/^[a-z][A-Za-z0-9]*$/.test(entry.id)) fail(`非法 Contribution id ${entry.id}`);
    if (ids.has(entry.id)) fail(`重复 Contribution id ${entry.id}`);
    ids.add(entry.id);
    const runtimes = uniqueStrings(entry.runtimes, `Contribution ${entry.id}.runtimes`, CONTRIBUTION_RUNTIMES);
    if (entry.declarative === true && !runtimes.has("declarative")) fail(`${entry.id} 标记 declarative 但未开放 declarative runtime`);
    if (entry.declarative !== true && entry.declarative !== false) fail(`${entry.id}.declarative 必须是 boolean`);
  }
  for (const required of ["commands", "menus", "settings", "automationTemplates", "appearances", "noteTemplates", "promptPacks"]) {
    if (!ids.has(required)) fail(`缺少 Contribution type ${required}`);
  }
  requireExactKeys(value.appearance, ["schemaVersion", "bases", "editableTokens", "fontCategories", "maxAppearancesPerPlugin"], "appearance contribution");
  requireExactKeys(value.noteTemplate, ["schemaVersion", "maxTemplatesPerPlugin", "maxBodyBytes"], "noteTemplate contribution");
  requireExactKeys(value.promptPack, ["schemaVersion", "maxPromptsPerPlugin", "maxPromptBytes"], "promptPack contribution");
  uniqueStrings(value.appearance.bases, "appearance.bases");
  uniqueStrings(value.appearance.editableTokens, "appearance.editableTokens");
  uniqueStrings(value.appearance.fontCategories, "appearance.fontCategories");
  return { ...value, types: [...value.types].sort((a, b) => compareCodePoints(a.id, b.id)) };
}

function validateErrorContract(value) {
  requireExactKeys(value, ["contractVersion", "errors"], "Error 根对象");
  if (!Number.isInteger(value.contractVersion) || value.contractVersion < 1) fail("Error contractVersion 必须是正整数");
  if (!Array.isArray(value.errors) || value.errors.length === 0) fail("errors 必须是非空数组");
  const codes = new Set();
  for (const [index, entry] of value.errors.entries()) {
    requireExactKeys(entry, ["code", "category", "retryable", "description"], `errors[${index}]`);
    if (!/^[A-Z][A-Z0-9_]+$/.test(entry.code)) fail(`非法 error code ${entry.code}`);
    if (codes.has(entry.code)) fail(`重复 error code ${entry.code}`);
    codes.add(entry.code);
    if (typeof entry.retryable !== "boolean") fail(`${entry.code}.retryable 必须为 boolean`);
  }
  return { ...value, errors: [...value.errors].sort((a, b) => compareCodePoints(a.code, b.code)) };
}

function generatedHeader(sources) {
  return `// 此文件由 scripts/generate-plugin-host-api.mjs 根据 ${sources.join(", ")} 生成，请勿手动修改。\n`;
}

function deepFreezeSource() {
  return `function deepFreeze<T>(value: T): T {\n  if (value && typeof value === "object" && !Object.isFrozen(value)) {\n    for (const nested of Object.values(value)) deepFreeze(nested);\n    Object.freeze(value);\n  }\n  return value;\n}\n`;
}

function hostRuntimeEntries(host) {
  return host.methods.map(({ method, sinceApiVersion, permission, runtimes, maxArgsBytes, maxResultBytes }) => ({
    method, sinceApiVersion, permission, runtimes, maxArgsBytes, maxResultBytes,
  }));
}

function renderBackendHost(host) {
  const supportedPermissions = [...new Set([
    ...host.methods.map((entry) => entry.permission).filter(Boolean),
    ...host.combinationPermissions,
  ])].sort(compareCodePoints);
  return `${generatedHeader(["packages/nowen-plugin-sdk/host-api-contract.json"])}import type { PluginPermission } from "./types.js";\nimport type { HostApiContractEntry } from "./hostApiContract.js";\n\n${deepFreezeSource()}\nexport const HOST_API_CONTRACT_VERSION = ${host.contractVersion} as const;\n\nexport const HOST_API_BUDGETS = deepFreeze(${JSON.stringify(host.budgets, null, 2)} as const);\n\nexport const HOST_API_CONTRACT = deepFreeze(${JSON.stringify(hostRuntimeEntries(host), null, 2)} as const) satisfies readonly HostApiContractEntry[];\n\nexport const V2_COMBINATION_PLUGIN_PERMISSIONS = deepFreeze(${JSON.stringify(host.combinationPermissions, null, 2)} as const) satisfies readonly PluginPermission[];\n\nexport const V2_SUPPORTED_PLUGIN_PERMISSIONS = deepFreeze(${JSON.stringify(supportedPermissions, null, 2)} as const) satisfies readonly PluginPermission[];\n`;
}

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

function renderSdkHost(host) {
  const supportedPermissions = [...new Set([
    ...host.methods.map((entry) => entry.permission).filter(Boolean),
    ...host.combinationPermissions,
  ])].sort(compareCodePoints);
  const methods = host.methods.map((entry) => entry.method);
  const grouped = new Map();
  for (const entry of host.methods) {
    const [namespace] = entry.method.split(".");
    if (!grouped.has(namespace)) grouped.set(namespace, []);
    grouped.get(namespace).push(entry.sdkSignature);
  }
  const interfaces = Object.entries(INTERFACE_NAMES).map(([namespace, interfaceName]) => {
    const signatures = grouped.get(namespace);
    if (!signatures) fail(`Host API 缺少 SDK namespace ${namespace}`);
    return `export interface ${interfaceName} {\n${signatures.map((signature) => `  ${signature}`).join("\n")}\n}`;
  }).join("\n\n");
  const hostProperties = Object.entries(INTERFACE_NAMES)
    .map(([namespace, interfaceName]) => `  ${namespace}: ${interfaceName};`)
    .join("\n");
  return `${generatedHeader(["packages/nowen-plugin-sdk/host-api-contract.json"])}import type { Attachment, DiaryEntry, Mindmap, Note, Notebook, NoteSummary, Tag, Task } from "./index.js";\n\n${deepFreezeSource()}\nexport type PluginHostRuntime = "node-action" | "sandbox-js";\nexport type HostApiPermission = ${supportedPermissions.map((permission) => JSON.stringify(permission)).join(" | ")};\nexport type HostApiMethod = ${methods.map((method) => JSON.stringify(method)).join(" | ")};\n\nexport interface HostApiContractEntry {\n  method: HostApiMethod;\n  sinceApiVersion: 1 | 2;\n  permission: HostApiPermission | null;\n  runtimes: readonly PluginHostRuntime[];\n  maxArgsBytes: number;\n  maxResultBytes: number;\n}\n\nexport interface HostApiBudgets {\n  readonly ipcMessageBytes: number;\n  readonly hostCallArgsBytes: number;\n  readonly hostCallResultBytes: number;\n}\n\nexport const HOST_API_CONTRACT_VERSION = ${host.contractVersion} as const;\nexport const HOST_API_BUDGETS: HostApiBudgets = deepFreeze(${JSON.stringify(host.budgets, null, 2)});\nexport const HOST_API_CONTRACT: readonly HostApiContractEntry[] = deepFreeze(${JSON.stringify(hostRuntimeEntries(host), null, 2)});\n\nexport interface RuntimeCapabilities {\n  apiVersion: number;\n  runtime: PluginHostRuntime;\n  platform: "server" | "desktop-full";\n  contractVersion: number;\n  budgets: HostApiBudgets;\n  methods: readonly HostApiContractEntry[];\n  hostApis: string[];\n  notes?: { read: number; write: number };\n  notebooks?: { read: number; write: number };\n  tasks?: { read: number; write: number };\n  automation?: number;\n  workspace?: number;\n  declarativeContributions?: number;\n}\n\n${interfaces}\n\nexport interface PluginProgress { current?: number; total?: number; message?: string }\nexport type PluginProgressCallback = (input: PluginProgress) => void;\n\nexport interface NowenHostApi {\n${hostProperties}\n  progress: PluginProgressCallback;\n}\n`;
}

function renderContributions(contributions) {
  const ids = contributions.types.map((entry) => entry.id);
  return `${generatedHeader(["packages/nowen-plugin-sdk/contribution-contract.json"])}${deepFreezeSource()}\nexport type PluginContributionRuntime = "declarative" | "sandbox-js" | "node-action";\nexport type PluginContributionType = ${ids.map((id) => JSON.stringify(id)).join(" | ")};\n\nexport interface PluginContributionContractEntry {\n  id: PluginContributionType;\n  since: string;\n  runtimes: readonly PluginContributionRuntime[];\n  declarative: boolean;\n  description: string;\n}\n\nexport const CONTRIBUTION_CONTRACT_VERSION = ${contributions.contractVersion} as const;\nexport const CONTRIBUTION_NAMESPACE_TEMPLATE = ${JSON.stringify(contributions.namespaceTemplate)} as const;\nexport const CONTRIBUTION_CONTRACT: readonly PluginContributionContractEntry[] = deepFreeze(${JSON.stringify(contributions.types, null, 2)});\nexport const APPEARANCE_CONTRIBUTION_LIMITS = deepFreeze(${JSON.stringify(contributions.appearance, null, 2)} as const);\nexport const NOTE_TEMPLATE_CONTRIBUTION_LIMITS = deepFreeze(${JSON.stringify(contributions.noteTemplate, null, 2)} as const);\nexport const PROMPT_PACK_CONTRIBUTION_LIMITS = deepFreeze(${JSON.stringify(contributions.promptPack, null, 2)} as const);\n`;
}

function renderErrors(errors) {
  const codes = errors.errors.map((entry) => entry.code);
  return `${generatedHeader(["packages/nowen-plugin-sdk/error-code-contract.json"])}${deepFreezeSource()}\nexport type NowenPluginErrorCode = ${codes.map((code) => JSON.stringify(code)).join(" | ")};\n\nexport interface NowenPluginErrorMetadata {\n  code: NowenPluginErrorCode;\n  category: string;\n  retryable: boolean;\n  description: string;\n}\n\nexport const NOWEN_PLUGIN_ERROR_CONTRACT_VERSION = ${errors.contractVersion} as const;\nexport const NOWEN_PLUGIN_ERROR_CATALOG: readonly NowenPluginErrorMetadata[] = deepFreeze(${JSON.stringify(errors.errors, null, 2)});\n`;
}

function renderMock(host) {
  const methods = host.methods.map((entry) => entry.method);
  return `${generatedHeader(["packages/nowen-plugin-sdk/host-api-contract.json"])}import { HOST_API_CONTRACT, type HostApiMethod } from "./hostApi.generated.js";\n\nexport type HostApiMockHandler = (input: unknown) => unknown | Promise<unknown>;\nexport type HostApiMockOverrides = Partial<Record<HostApiMethod, HostApiMockHandler>>;\n\nexport interface HostApiCallMock {\n  readonly methods: readonly HostApiMethod[];\n  readonly calls: ReadonlyArray<{ method: HostApiMethod; input: unknown }>;\n  call(method: HostApiMethod, input?: unknown): Promise<unknown>;\n  reset(): void;\n}\n\nexport function createHostApiCallMock(overrides: HostApiMockOverrides = {}): HostApiCallMock {\n  const calls: Array<{ method: HostApiMethod; input: unknown }> = [];\n  const allowed = new Set<HostApiMethod>(HOST_API_CONTRACT.map((entry) => entry.method));\n  return {\n    methods: ${JSON.stringify(methods, null, 2)} as readonly HostApiMethod[],\n    get calls() { return calls; },\n    async call(method, input = {}) {\n      if (!allowed.has(method)) throw new Error("Mock Host API 方法不存在: " + method);\n      calls.push({ method, input });\n      const handler = overrides[method];\n      if (!handler) throw new Error("Mock Host API 未配置处理器: " + method);\n      return handler(input);\n    },\n    reset() { calls.length = 0; },\n  };\n}\n`;
}

function renderHostMarkdown(host) {
  const rows = host.methods.map((entry) => `| \`${entry.method}\` | V${entry.sinceApiVersion} | ${entry.permission ? `\`${entry.permission}\`` : "无"} | ${entry.runtimes.map((runtime) => `\`${runtime}\``).join(", ")} | ${entry.platforms.map((platform) => `\`${platform}\``).join(", ")} | ${entry.maxArgsBytes} | ${entry.maxResultBytes} |`);
  return `<!-- 此文件由 scripts/generate-plugin-host-api.mjs 生成，请勿手动修改。 -->\n# Host API 合同\n\n合同版本：${host.contractVersion}\n\n固定预算：IPC 消息 ${host.budgets.ipcMessageBytes} 字节，Host Call 参数 ${host.budgets.hostCallArgsBytes} 字节，Host Call 结果 ${host.budgets.hostCallResultBytes} 字节。\n\n| 方法 | 起始 API | 权限 | Runtime | 平台 | 参数上限 | 结果上限 |\n| --- | --- | --- | --- | --- | ---: | ---: |\n${rows.join("\n")}\n\n说明：\`progress\` 是运行时事件，不是 Broker Host Call。R1 不开放 \`attachments:write\`；\`secrets:use\` 仅允许 Host 代注入已声明 Connection。\n`;
}

function renderContributionMarkdown(contributions) {
  const rows = contributions.types.map((entry) => `| \`${entry.id}\` | ${entry.since} | ${entry.declarative ? "是" : "否"} | ${entry.runtimes.map((runtime) => `\`${runtime}\``).join(", ")} | ${entry.description} |`);
  return `<!-- 此文件由 scripts/generate-plugin-host-api.mjs 生成，请勿手动修改。 -->\n# Contribution 合同\n\n合同版本：${contributions.contractVersion}\n\n运行时键统一为 \`${contributions.namespaceTemplate}\`。声明式 Contribution 由 Host 渲染和执行，不授予任意 React、DOM、CSS 或 Node Runtime。\n\n| 类型 | Since | 声明式 | Runtime | 说明 |\n| --- | --- | --- | --- | --- |\n${rows.join("\n")}\n\nAppearance 最大数量：${contributions.appearance.maxAppearancesPerPlugin}；Note Template 最大正文：${contributions.noteTemplate.maxBodyBytes} 字节；Prompt 最大正文：${contributions.promptPack.maxPromptBytes} 字节。\n`;
}

function buildCatalog(host, contributions, errors) {
  const catalog = {
    catalogVersion: 1,
    hostApi: host,
    contributions,
    errors,
  };
  const digest = crypto.createHash("sha256").update(JSON.stringify(catalog)).digest("hex");
  const result = { ...catalog, digest };
  const serialized = JSON.stringify(result);
  for (const forbidden of ["ELECTRON_USER_DATA", "BEGIN PRIVATE KEY", "installedPath", "registryPrivateKey", "secretValue"]) {
    if (serialized.includes(forbidden)) fail(`AI Catalog 包含禁止内容 ${forbidden}`);
  }
  return result;
}

function renderBackendCatalog(catalog) {
  return `${generatedHeader(["packages/nowen-plugin-sdk/host-api-contract.json", "packages/nowen-plugin-sdk/contribution-contract.json", "packages/nowen-plugin-sdk/error-code-contract.json"])}${deepFreezeSource()}\nexport const EXTENSION_CAPABILITY_CATALOG_DIGEST = ${JSON.stringify(catalog.digest)} as const;\nexport const EXTENSION_CAPABILITY_CATALOG = deepFreeze(${JSON.stringify(catalog, null, 2)} as const);\n`;
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
if ([...args].some((argument) => argument !== "--check")) throw new Error("仅支持 --check 参数");

const [rawHost, rawContributions, rawErrors] = await Promise.all([
  readFile(HOST_CONTRACT_PATH, "utf8"),
  readFile(CONTRIBUTION_CONTRACT_PATH, "utf8"),
  readFile(ERROR_CONTRACT_PATH, "utf8"),
]);
const host = validateHostContract(JSON.parse(rawHost));
const contributions = validateContributionContract(JSON.parse(rawContributions));
const errors = validateErrorContract(JSON.parse(rawErrors));
const catalog = buildCatalog(host, contributions, errors);

const outputs = new Map([
  [path.join(ROOT, "backend/src/plugins/hostApiContract.generated.ts"), renderBackendHost(host)],
  [path.join(ROOT, "backend/src/plugins/capabilityCatalog.generated.ts"), renderBackendCatalog(catalog)],
  [path.join(SDK_ROOT, "src/hostApi.generated.ts"), renderSdkHost(host)],
  [path.join(SDK_ROOT, "src/contributions.generated.ts"), renderContributions(contributions)],
  [path.join(SDK_ROOT, "src/errors.generated.ts"), renderErrors(errors)],
  [path.join(SDK_ROOT, "src/mock.generated.ts"), renderMock(host)],
  [path.join(SDK_ROOT, "capability-catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`],
  [path.join(ROOT, "docs/plugin-platform/host-api.generated.md"), renderHostMarkdown(host)],
  [path.join(ROOT, "docs/plugin-platform/contributions.generated.md"), renderContributionMarkdown(contributions)],
]);

if (args.has("--check")) {
  const stale = [];
  for (const [target, content] of outputs) {
    const current = await readFile(target, "utf8").catch(() => null);
    if (current !== content) stale.push(path.relative(ROOT, target));
  }
  if (stale.length) {
    console.error(`Extension capability 生成物未同步:\n${stale.map((target) => `- ${target}`).join("\n")}`);
    process.exitCode = 1;
  } else {
    console.log(`Extension capability 生成物已同步（${outputs.size} files, digest ${catalog.digest}）`);
  }
} else {
  for (const [target, content] of outputs) await atomicWrite(target, content);
  console.log(`已生成 ${outputs.size} 个 Extension capability 文件（digest ${catalog.digest}）`);
}
