# Extension Ecosystem V2 RC1 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法跟踪进度。用户已明确禁止编写或执行测试用例；不得调用任何 test 脚本，也不得新增测试文件。

**目标：** 在 `release/v1.5.0` 上完成设计规格列出的全部 P0 与 P1 生产收口，同时保持 V1 插件兼容和核心应用离线可用。

**架构：** 先建立 v97 数据模型、唯一 Host API 合同和兼容策略，再把 QuickJS 移入独立子进程并接入安全网络层。随后用持久化更新日志、正式生命周期、内置 Trust Root、单调 Registry 元数据和分级 Advisory 收口供应链，最后完成 Registry 服务、对象存储、遥测、离线 Marketplace 和前端状态展示。

**技术栈：** TypeScript、Node.js、Hono、SQLite/`better-sqlite3`、PostgreSQL DDL、QuickJS/WASM、Node IPC、Ed25519、S3 SigV4、React/Vite。

**验证限制：** 只运行 TypeScript 编译、生产构建、JSON/schema/config 生成检查和启动级检查；不编写或运行测试用例。

---

## 文件结构

### Backend Core

- 创建 `backend/src/db/extensionEcosystemRc1Migration.ts`：SQLite v97 生命周期、更新日志、Registry 状态、Advisory、审计和遥测 consent 数据。
- 创建 `backend/src/db/postgres/067_extension_ecosystem_rc1.sql`：PostgreSQL 同构 DDL。
- 创建 `backend/src/plugins/hostApiContract.ts`：唯一 Host API 方法、权限、版本、Runtime 和预算合同。
- 创建 `backend/src/plugins/secureExternalFetch.ts`：DNS 固定、私网判断、逐跳重定向和响应预算。
- 创建 `backend/src/plugins/sandboxProtocol.ts`、`sandbox-child.mjs`：Sandbox IPC 合同与独立 QuickJS 运行进程。
- 创建 `backend/src/plugins/extensionCompatibility.ts`：V1/V2/source/trust/runtime/advisory 统一分流。
- 创建 `backend/src/plugins/pluginLifecycle.ts`：正式生命周期状态转换。
- 创建 `backend/src/plugins/pluginUpdateCoordinator.ts`、`pluginUpdateRecovery.ts`：原子 staging/switch/recovery。
- 创建 `backend/src/plugins/registryTrust.ts`、`registryMetadataGuard.ts`、`securityAdvisoryService.ts`：Trust Root、轮换、防重放与 Advisory。
- 创建 `backend/src/plugins/extensionTelemetry.ts`、`marketplaceCache.ts`：隐私遥测与离线 Catalog。

### SDK、生成物与文档

- 创建 `packages/nowen-plugin-sdk/host-api-contract.json`：跨包合同源。
- 创建 `scripts/generate-plugin-host-api.mjs`：生成 Backend/SDK/Markdown 合同。
- 创建 `backend/src/plugins/hostApiContract.generated.ts`、`packages/nowen-plugin-sdk/src/hostApi.generated.ts`、`docs/plugin-platform/host-api.generated.md`。

### Registry Service

- 创建 `packages/nowen-extension-registry/src/config.ts`。
- 创建 `packages/nowen-extension-registry/src/db/migrations.ts`。
- 创建 `packages/nowen-extension-registry/src/security/{session,csrf,rateLimit,totp,audit}.ts`。
- 创建 `packages/nowen-extension-registry/src/storage/{artifactStore,localArtifactStore,s3ArtifactStore}.ts`。
- 创建 `packages/nowen-extension-registry/src/routes/{oauth,publish,artifacts,telemetry,admin,health}.ts`。
- 重构 `packages/nowen-extension-registry/src/index.ts` 为组合入口。

---

### 任务 1：建立 v97 RC1 数据模型

**文件：**
- 创建：`backend/src/db/extensionEcosystemRc1Migration.ts`
- 创建：`backend/src/db/postgres/067_extension_ecosystem_rc1.sql`
- 修改：`backend/src/db/migrations.ts`
- 修改：`backend/src/plugins/types.ts`

- [ ] **步骤 1：定义正式类型**

在 `types.ts` 增加并由后续服务统一使用：

```ts
export type PluginLifecycleState =
  | "installed" | "preflight" | "probation" | "stable"
  | "rollback_pending" | "rolling_back" | "disabled";

export type PluginUpdateStage =
  | "downloaded" | "verified" | "staged" | "switching"
  | "probation" | "stable" | "failed" | "rolled_back";

export interface RegistryMetadataState {
  sourceId: string;
  highestSeenSequence: number;
  documentDigest: string;
  generatedAt: string;
  expiresAt: string;
  verifiedAt: string;
  signerKeyId: string;
  documentJson: string;
}
```

- [ ] **步骤 2：新增 SQLite v97 迁移**

为 `plugin_registry` 增加 `lifecycleState`、`previousStableVersion`、`activeOperationId`、`stateUpdatedAt`、`nodeRuntimeConfirmedBy`、`nodeRuntimeConfirmedAt`。创建：

```sql
plugin_update_operations
plugin_registry_metadata_state
plugin_registry_root_chain
plugin_advisories
plugin_advisory_receipts
plugin_security_events
extension_telemetry_consent
```

旧数据保守映射：可证明已启用且版本目录存在的记录为 `stable`；quarantined 为 `installed`；有效 probation 为 `probation`；其他不一致记录为 `disabled`。Restore 清空 Node Runtime 确认。

- [ ] **步骤 3：补 PostgreSQL 同构 DDL**

在 `067_extension_ecosystem_rc1.sql` 创建相同字段、唯一键、索引和状态 CHECK；不删除既有数据。

- [ ] **步骤 4：注册迁移并做非测试校验**

运行：

```powershell
cd C:\UGit\nowen-note\backend
npm.cmd run build:tsc
```

预期：TypeScript 编译成功；不运行迁移测试。

- [ ] **步骤 5：提交**

```powershell
git add backend/src/db/extensionEcosystemRc1Migration.ts backend/src/db/postgres/067_extension_ecosystem_rc1.sql backend/src/db/migrations.ts backend/src/plugins/types.ts
git commit -m "feat(extensions): add rc1 lifecycle and trust schema"
```

### 任务 2：建立唯一 Host API Contract

**文件：**
- 创建：`packages/nowen-plugin-sdk/host-api-contract.json`
- 创建：`scripts/generate-plugin-host-api.mjs`
- 生成：`backend/src/plugins/hostApiContract.generated.ts`
- 生成：`packages/nowen-plugin-sdk/src/hostApi.generated.ts`
- 生成：`docs/plugin-platform/host-api.generated.md`
- 创建：`backend/src/plugins/hostApiContract.ts`
- 修改：`backend/src/plugins/hostApiBroker.ts`
- 修改：`backend/src/plugins/manifest.ts`
- 修改：`backend/src/plugins/permissions.ts`
- 修改：`packages/nowen-plugin-sdk/src/index.ts`

- [ ] **步骤 1：写入合同源和固定预算**

每个合同项必须具有：

```ts
interface HostApiContractEntry {
  method: string;
  sinceApiVersion: 1 | 2;
  permission: PluginPermission | null;
  runtimes: Array<"node-action" | "sandbox-js">;
  maxArgsBytes: number;
  maxResultBytes: number;
}
```

预算固定为 IPC 2MB、Host Call 参数 256KB、结果 1MB。合同只列出现有 Broker 真正实现的方法；`attachments:write` 对 V2 标记为 unsupported，`storage.list` 不生成到 Sandbox bridge。

- [ ] **步骤 2：实现确定性生成器**

`generate-plugin-host-api.mjs` 接受 `--check`；普通模式原子写入三个生成物，check 模式比较内存生成内容与磁盘内容，不一致时退出 1。

- [ ] **步骤 3：Broker 合同先行**

新增：

```ts
export function requireHostMethod(
  method: string,
  apiVersion: 1 | 2,
  runtime: "node-action" | "sandbox-js",
): HostApiContractEntry;
```

`HostApiBroker.call()` 在 switch 前校验 method/runtime/version 和参数大小，执行后校验结果大小；未知方法统一 `HOST_METHOD_NOT_FOUND`。`runtime.capabilities` 返回 method 级合同。

- [ ] **步骤 4：Manifest、SDK 和文档共用合同**

V2 Manifest 请求没有真实方法支撑的权限时拒绝；V1 保持历史权限解析兼容。SDK 只导出生成类型。

- [ ] **步骤 5：生成并校验**

```powershell
cd C:\UGit\nowen-note
node scripts/generate-plugin-host-api.mjs
node scripts/generate-plugin-host-api.mjs --check
cd backend
npm.cmd run build:tsc
```

- [ ] **步骤 6：提交**

```powershell
git add packages/nowen-plugin-sdk scripts/generate-plugin-host-api.mjs backend/src/plugins/hostApiContract.ts backend/src/plugins/hostApiContract.generated.ts backend/src/plugins/hostApiBroker.ts backend/src/plugins/manifest.ts backend/src/plugins/permissions.ts docs/plugin-platform/host-api.generated.md
git commit -m "feat(extensions): centralize host api contract"
```

### 任务 3：实现攻击级 Secure External Fetch

**文件：**
- 创建：`backend/src/plugins/secureExternalFetch.ts`
- 修改：`backend/src/plugins/hostApiBroker.ts`
- 修改：`backend/src/plugins/permissions.ts`

- [ ] **步骤 1：实现 URL 与地址规范化**

仅允许 HTTPS；拒绝 userinfo、fragment、非法 IDN 和未显式白名单端口。完整识别 IPv4/IPv6 private、loopback、link-local、CGNAT、multicast、documentation、benchmark、reserved 和 IPv4-mapped IPv6。

- [ ] **步骤 2：实现 DNS 固定与逐跳重定向**

接口固定为：

```ts
export interface SecureExternalFetchOptions {
  allowedHosts: string[];
  timeoutMs: number;
  maxRedirects: number;
  maxResponseBytes: number;
}

export async function secureExternalFetch(
  request: ExternalFetchRequest,
  options: SecureExternalFetchOptions,
): Promise<ExternalFetchResponse>;
```

解析 CNAME/A/AAAA 后拒绝任一非公网地址，并通过 `https.request` 的自定义 `lookup` 固定已验证地址。关闭自动重定向，最多 5 跳，每跳重新验证。

- [ ] **步骤 3：流式读取响应并接入 Broker**

默认 10 秒超时、2MB 响应上限；超时、重定向超限、正文超限分别使用稳定错误码。`HostApiBroker.external()` 不再调用全局 `fetch`。

- [ ] **步骤 4：编译并提交**

```powershell
cd C:\UGit\nowen-note\backend
npm.cmd run build:tsc
git add src/plugins/secureExternalFetch.ts src/plugins/hostApiBroker.ts src/plugins/permissions.ts
git commit -m "feat(extensions): harden sandbox network broker"
```

### 任务 4：把 QuickJS 移入独立子进程

**文件：**
- 创建：`backend/src/plugins/sandboxProtocol.ts`
- 创建：`backend/src/plugins/sandbox-child.mjs`
- 修改：`backend/src/plugins/sandboxRunner.ts`
- 修改：`backend/src/plugins/executionManager.ts`
- 修改：`backend/build.bundle.mjs`
- 修改：`electron/builder.base.config.js`

- [ ] **步骤 1：定义严格 IPC 协议与预算**

协议只接受 `booted/preflight/ready/execute/host-call/host-result/progress/execution-result/execution-error/cancel/shutdown`。消息 JSON 不超过 2MB；单次执行最多 1,000 Host Call、32 个并发待处理 Host Call、100 条 progress。

- [ ] **步骤 2：实现 Sandbox child**

子进程内创建 QuickJS runtime，设置 64MB heap、512KB stack 和 deadline interrupt。只注入合同生成的 `nowen` bridge，不提供模块 loader、Node/browser global 或原始 IPC 对象。所有 handle、promise、context 和 runtime 在 finally 回收。

- [ ] **步骤 3：将 SandboxRunner 改为 Supervisor**

Supervisor 使用净化环境 `fork()` 子进程，设置 Node heap 128MB，负责 timeout/cancel/kill、Host Call 转发和错误码映射。子进程异常只失败当前执行，不结束 backend。

- [ ] **步骤 4：接入构建与 Electron 资源**

backend bundle 复制 `sandbox-child.mjs`；Electron 包含 QuickJS JS/WASM 运行依赖与 child 文件。

- [ ] **步骤 5：构建并提交**

```powershell
cd C:\UGit\nowen-note\backend
npm.cmd run build:tsc
npm.cmd run build
cd ..
git add backend/src/plugins/sandboxProtocol.ts backend/src/plugins/sandbox-child.mjs backend/src/plugins/sandboxRunner.ts backend/src/plugins/executionManager.ts backend/build.bundle.mjs electron/builder.base.config.js
git commit -m "feat(extensions): isolate quickjs sandbox process"
```

### 任务 5：收紧 Policy 与 V1/V2 兼容矩阵

**文件：**
- 创建：`backend/src/plugins/extensionCompatibility.ts`
- 修改：`backend/src/plugins/extensionPolicy.ts`
- 修改：`backend/src/plugins/pluginService.ts`
- 修改：`backend/src/plugins/packageInstaller.ts`
- 修改：`backend/src/plugins/registry.ts`
- 修改：`backend/src/plugins/executionManager.ts`
- 修改：`backend/src/routes/plugins.ts`
- 修改：`frontend/src/lib/pluginApi.ts`
- 修改：`frontend/src/components/settings/plugins/PluginSettingsTab.tsx`

- [ ] **步骤 1：实现唯一兼容解析器**

```ts
export interface ExtensionCompatibilityInput {
  manifest: PluginManifest;
  source: PluginSource;
  trustLevel: PluginTrustLevel;
  signatureState: string;
  advisoryState: string;
  nodeRuntimeConfirmed: boolean;
}

export function resolveExtensionCompatibility(
  input: ExtensionCompatibilityInput,
): { allowed: true; runner: "node-action" | "sandbox-js" }
 | { allowed: false; code: string; reason: string };
```

V1 仅 node-action；V2 Registry Community 仅 sandbox-js；V2 Official/Verified Node 受策略和确认控制；revoked/malicious/critical、无效签名、不兼容平台全部 fail closed。

- [ ] **步骤 2：默认策略收紧且保留 V1**

默认 `allowNodeRuntime=false` 只影响新 V2 Node 授权。V1 兼容记录继续执行。手动 V2 Node 安装首次返回 `PLUGIN_NODE_RUNTIME_CONFIRMATION_REQUIRED`，确认后持久化 actor/time；Restore 清空确认并 quarantine。

- [ ] **步骤 3：接入安装、启用和执行入口**

`PluginService` 和 `PluginExecutionManager.runner()` 都调用解析器，避免仅靠 DB runtime 选择执行器。

- [ ] **步骤 4：前端二次确认**

上传包命中 Node Runtime 确认错误后显示明确风险说明；管理员确认后携带 `confirmNodeRuntime=true` 重提。不得为 Registry Community 提供绕过按钮。

- [ ] **步骤 5：编译、构建并提交**

```powershell
cd C:\UGit\nowen-note\backend
npm.cmd run build:tsc
cd ..\frontend
npm.cmd run build
cd ..
git add backend/src/plugins/extensionCompatibility.ts backend/src/plugins/extensionPolicy.ts backend/src/plugins/pluginService.ts backend/src/plugins/packageInstaller.ts backend/src/plugins/registry.ts backend/src/plugins/executionManager.ts backend/src/routes/plugins.ts frontend/src/lib/pluginApi.ts frontend/src/components/settings/plugins/PluginSettingsTab.tsx
git commit -m "feat(extensions): enforce runtime trust policy"
```

### 任务 6：实现原子更新、生命周期和崩溃恢复

**文件：**
- 创建：`backend/src/plugins/pluginLifecycle.ts`
- 创建：`backend/src/plugins/pluginUpdateCoordinator.ts`
- 创建：`backend/src/plugins/pluginUpdateRecovery.ts`
- 修改：`backend/src/plugins/packageInstaller.ts`
- 修改：`backend/src/plugins/registry.ts`
- 修改：`backend/src/plugins/pluginService.ts`
- 修改：`backend/src/plugins/executionManager.ts`
- 修改：`backend/src/index.ts`

- [ ] **步骤 1：集中生命周期状态机**

只允许：

```text
installed → preflight → probation → stable
preflight/probation → rollback_pending → rolling_back → stable(previous)
rolling_back → disabled
```

所有 active/current/previous/operation/state 写入同一事务；非法转换返回 `PLUGIN_LIFECYCLE_INVALID_TRANSITION`。

- [ ] **步骤 2：不可变目录和 staging**

下载与解压只写 `plugins/staging/<operationId>`；校验后原子 rename 到 `plugins/versions/<pluginId>/<version>`。相同坐标内容不同则拒绝；绝不删除已验证 previous stable。

- [ ] **步骤 3：持久化 update coordinator**

每个插件只允许一个非终态 operation。按 `downloaded/verified/staged/switching/probation/stable` 写操作日志；preflight 通过前不切换 active version。

- [ ] **步骤 4：启动恢复器和事务化 rollback**

启动后、插件执行服务前运行恢复器：清理未完成 staging；恢复 switching；目录缺失时回 previous stable；previous 也不可用时 disabled。Probation 成功耗尽计数后 stable；失败后回 previous stable 并保持 enabled，只有回滚失败才 disabled。

- [ ] **步骤 5：编译、构建并提交**

```powershell
cd C:\UGit\nowen-note\backend
npm.cmd run build:tsc
npm.cmd run build
cd ..
git add backend/src/plugins/pluginLifecycle.ts backend/src/plugins/pluginUpdateCoordinator.ts backend/src/plugins/pluginUpdateRecovery.ts backend/src/plugins/packageInstaller.ts backend/src/plugins/registry.ts backend/src/plugins/pluginService.ts backend/src/plugins/executionManager.ts backend/src/index.ts
git commit -m "feat(extensions): make updates atomic and recoverable"
```

### 任务 7：Trust Root、防降级与 Advisory

**文件：**
- 创建：`backend/src/plugins/officialRegistryTrustRoots.ts`
- 创建：`backend/src/plugins/registryTrust.ts`
- 创建：`backend/src/plugins/registryMetadataGuard.ts`
- 创建：`backend/src/plugins/securityAdvisoryService.ts`
- 修改：`backend/src/plugins/ecosystemRegistry.ts`
- 修改：`backend/src/plugins/signatures.ts`
- 修改：`backend/src/plugins/pluginService.ts`
- 修改：`backend/src/routes/plugins.ts`

- [ ] **步骤 1：内置根与自定义 pinned key 分流**

Official source 只能读取编译进客户端的 `OFFICIAL_REGISTRY_TRUST_ROOTS`；API 不接受覆盖 official 公钥。根清单为空时 Official Registry 明确禁用并 fail closed。Custom source 必须由管理员配置 pinned Ed25519 key。

- [ ] **步骤 2：实现根轮换**

根轮换信封包含 key ID、parent key ID、rotation sequence、validFrom/validUntil 和新公钥，必须由当前 active root 签名；只接受更高 sequence 的前向变化。

- [ ] **步骤 3：实现 metadata guard**

`EcosystemIndex` 强制 `sequence/generatedAt/expiresAt/signerKeyId`。拒绝 sequence 回退、同 sequence digest 变化、过期、生成时间异常和签名无效；保存 `highestSeenSequence` 与完整已验证文档。

- [ ] **步骤 4：实现 Advisory service**

Advisory 强制唯一 ID、sequence、issuedAt、expiresAt、severity、version range、action/replaces。critical 自动禁用；high 建议禁用；medium warning；low info。失效、回退、过期或未签名公告不改变状态；撤回必须更高 sequence。

- [ ] **步骤 5：编译并提交**

```powershell
cd C:\UGit\nowen-note\backend
npm.cmd run build:tsc
cd ..
git add backend/src/plugins/officialRegistryTrustRoots.ts backend/src/plugins/registryTrust.ts backend/src/plugins/registryMetadataGuard.ts backend/src/plugins/securityAdvisoryService.ts backend/src/plugins/ecosystemRegistry.ts backend/src/plugins/signatures.ts backend/src/plugins/pluginService.ts backend/src/routes/plugins.ts
git commit -m "feat(extensions): enforce registry trust and freshness"
```

### 任务 8：Registry 配置、迁移与安全边界

**文件：**
- 创建：`packages/nowen-extension-registry/src/config.ts`
- 创建：`packages/nowen-extension-registry/src/db/migrations.ts`
- 创建：`packages/nowen-extension-registry/src/security/session.ts`
- 创建：`packages/nowen-extension-registry/src/security/csrf.ts`
- 创建：`packages/nowen-extension-registry/src/security/rateLimit.ts`
- 创建：`packages/nowen-extension-registry/src/security/totp.ts`
- 创建：`packages/nowen-extension-registry/src/security/audit.ts`
- 创建：`packages/nowen-extension-registry/src/routes/oauth.ts`
- 创建：`packages/nowen-extension-registry/src/routes/admin.ts`
- 创建：`packages/nowen-extension-registry/src/routes/health.ts`
- 修改：`packages/nowen-extension-registry/src/schema.ts`
- 修改：`packages/nowen-extension-registry/src/index.ts`
- 修改：`packages/nowen-extension-registry/package.json`

- [ ] **步骤 1：配置 fail-fast**

生产环境强制 Registry signing key/session secret/public URL/GitHub OAuth callback/allowed origins/trusted proxy 配置；开发环境使用显式 `REGISTRY_ENV=development` 才允许本地默认值。

- [ ] **步骤 2：版本化 Registry schema**

新增 `registry_schema_migrations`、`oauth_states`、`sessions`、`rate_limit_buckets`、`publisher_quotas`、`admin_users`、`admin_totp`、`audit_log`、`registry_metadata_sequence`、`artifact_objects`、`registry_mirrors`。迁移在事务内逐版本运行。

- [ ] **步骤 3：Session/OAuth/CSRF**

OAuth 使用 PKCE + 一次性持久化 state；Session token 只保存哈希，支持 rotation/revocation/TTL；Cookie 为 HttpOnly/Secure/SameSite=Lax。所有 cookie 身份写请求要求 origin 与 CSRF token。

- [ ] **步骤 4：限流、滥用控制和审计**

实现全局/IP/账户/Publisher 分层 token bucket，发布冷却、日配额和 artifact 大小门禁。Publisher/key/review/report/advisory/admin 动作写不可变审计日志。日志脱敏 authorization/cookie/secret/token。

- [ ] **步骤 5：管理员 TOTP 与健康检查**

敏感 admin route 同时要求管理员 Session 和当前 TOTP。`/health` 分别报告 DB、artifact store、signer，并保持 Marketplace 故障不影响 Nowen backend 健康。

- [ ] **步骤 6：typecheck 并提交**

```powershell
cd C:\UGit\nowen-note\packages\nowen-extension-registry
npm.cmd install --no-audit --no-fund
npm.cmd run typecheck
git add package.json package-lock.json src
git commit -m "feat(registry): add production security foundation"
```

### 任务 9：ArtifactStore、S3、CDN 与镜像

**文件：**
- 创建：`packages/nowen-extension-registry/src/storage/artifactStore.ts`
- 创建：`packages/nowen-extension-registry/src/storage/localArtifactStore.ts`
- 创建：`packages/nowen-extension-registry/src/storage/s3ArtifactStore.ts`
- 创建：`packages/nowen-extension-registry/src/routes/publish.ts`
- 创建：`packages/nowen-extension-registry/src/routes/artifacts.ts`
- 修改：`packages/nowen-extension-registry/src/config.ts`
- 修改：`packages/nowen-extension-registry/src/index.ts`
- 修改：`packages/nowen-extension-registry/package.json`

- [ ] **步骤 1：定义存储合同**

```ts
export interface ArtifactStore {
  stage(operationId: string, bytes: Buffer): Promise<string>;
  commit(stagedKey: string, sha256: string): Promise<string>;
  read(key: string): Promise<ReadableStream<Uint8Array> | NodeJS.ReadableStream>;
  exists(key: string): Promise<boolean>;
  removeStaged(stagedKey: string): Promise<void>;
  health(): Promise<{ ok: boolean; detail?: string }>;
}
```

最终 key 为 `sha256/<first2>/<digest>.nowen-plugin`，同 digest 幂等，不允许覆盖不同内容。

- [ ] **步骤 2：实现 Local 与 S3**

Local 仅供开发；S3 兼容 endpoint/path-style/region/bucket/prefix，使用临时 key 上传，校验 digest 后复制/提交到内容寻址 key。凭据只来自环境。

- [ ] **步骤 3：发布与下载接入 CDN/镜像**

数据库只存 artifact key/digest/size/signature。主 URL 由 CDN base 生成；signed index 可列镜像 base URL。镜像不获得新信任，客户端仍验证同 digest/signature/sequence。

- [ ] **步骤 4：typecheck 并提交**

```powershell
cd C:\UGit\nowen-note\packages\nowen-extension-registry
npm.cmd install --no-audit --no-fund
npm.cmd run typecheck
git add package.json package-lock.json src/storage src/routes/publish.ts src/routes/artifacts.ts src/config.ts src/index.ts
git commit -m "feat(registry): add immutable artifact storage"
```

### 任务 10：Telemetry、离线 Marketplace 与前端状态

**文件：**
- 创建：`backend/src/plugins/extensionTelemetry.ts`
- 创建：`backend/src/plugins/marketplaceCache.ts`
- 创建：`packages/nowen-extension-registry/src/routes/telemetry.ts`
- 修改：`backend/src/plugins/ecosystemRegistry.ts`
- 修改：`backend/src/plugins/pluginService.ts`
- 修改：`backend/src/routes/plugins.ts`
- 修改：`packages/nowen-extension-registry/src/index.ts`
- 修改：`frontend/src/lib/pluginApi.ts`
- 修改：`frontend/src/components/settings/plugins/PluginSettingsTab.tsx`

- [ ] **步骤 1：客户端遥测白名单和 consent**

只允许 `extensionId/version/platform/eventType/errorCode/timeBucket`；拒绝额外字段。默认匿名聚合开启，设置可关闭；关闭时停止入队并清空队列。容量 5,000、TTL 30 天、批量 100、指数退避上限 24 小时。

- [ ] **步骤 2：Registry 严格接收**

Telemetry route 限制 body 大小、exact keys、枚举和字段长度；只按日/extension/version/platform/event/error 聚合，不存 IP 与原始 payload。

- [ ] **步骤 3：离线 Catalog**

保存完整已签名 index、verifiedAt、expiresAt 和 graceUntil。在线失败时只返回仍在 grace 内的缓存并标记 `offline=true`；缓存过期禁止安装/更新，但不影响核心启动、已安装插件与 Automation。

- [ ] **步骤 4：镜像安全切换**

按 signed metadata 中镜像顺序尝试 artifact，任何镜像都必须通过同 digest、Publisher signature 和当前 Registry sequence；镜像失败只切换下载源，不降低验证。

- [ ] **步骤 5：前端切换 V2 Marketplace**

市场调用 `/ecosystem/catalog`；展示 online/offline/stale、缓存时间和禁止安装原因。更新与安全页展示 lifecycle、probation、rollback 和 Advisory severity。开发者页增加遥测开关。

- [ ] **步骤 6：编译、构建并提交**

```powershell
cd C:\UGit\nowen-note\backend
npm.cmd run build:tsc
cd ..\packages\nowen-extension-registry
npm.cmd run typecheck
cd ..\..\frontend
npm.cmd run build
cd ..
git add backend/src/plugins/extensionTelemetry.ts backend/src/plugins/marketplaceCache.ts backend/src/plugins/ecosystemRegistry.ts backend/src/plugins/pluginService.ts backend/src/routes/plugins.ts packages/nowen-extension-registry/src/routes/telemetry.ts packages/nowen-extension-registry/src/index.ts frontend/src/lib/pluginApi.ts frontend/src/components/settings/plugins/PluginSettingsTab.tsx
git commit -m "feat(extensions): add private telemetry and offline marketplace"
```

### 任务 11：文档与非测试验收

**文件：**
- 修改：`docs/plugin-platform/extension-platform-v2.md`
- 修改：`docs/plugin-platform/permissions.md`
- 修改：`packages/nowen-extension-registry/README.md`
- 修改：`docs/superpowers/plans/2026-08-24-extension-ecosystem-v2-rc1.md`

- [ ] **步骤 1：更新生产配置与故障语义**

记录 Trust Root 注入、Root Rotation、Registry sequence/expiry、S3/CDN/镜像、OAuth/Session/TOTP、遥测 consent、离线宽限和更新恢复操作。明确生产私钥不进入仓库。

- [ ] **步骤 2：运行生成与编译检查**

```powershell
cd C:\UGit\nowen-note
node scripts/generate-plugin-host-api.mjs --check
cd backend
npm.cmd run build:tsc
npm.cmd run build
cd ..\packages\nowen-plugin-sdk
npm.cmd run build
cd ..\nowen-extension-registry
npm.cmd run typecheck
cd ..\..\frontend
npm.cmd run build
```

预期：全部命令 exit 0；不得运行包含 `test` 的命令。

- [ ] **步骤 3：配置与 schema 校验**

使用 Registry 提供的 `config:check` 与 `migrate:check` 脚本校验开发配置和迁移注册表；Official Trust Root 为空时必须报告 Official Registry disabled，而不是回退到网络公钥。

- [ ] **步骤 4：启动级检查**

启动 Registry development 模式和根目录 `npm.cmd run dev`，确认 Registry health、backend API 和 Vite ready 后停止进程。不得执行 API 行为测试或测试用例。

- [ ] **步骤 5：检查范围与工作区**

```powershell
git diff --check
git status --short
git log --oneline -12
```

确认只包含 P0～P1 代码、计划和文档；保留任务开始前已有的 `backend/package-lock.json`、`scripts/dev-dependency-manager.mjs`、`scripts/tests/dev-dependency-manager.test.mjs` 与 `frontend/vitest-report.json` 所属改动。

- [ ] **步骤 6：提交文档收口**

```powershell
git add docs/plugin-platform/extension-platform-v2.md docs/plugin-platform/permissions.md packages/nowen-extension-registry/README.md docs/superpowers/plans/2026-08-24-extension-ecosystem-v2-rc1.md
git commit -m "docs: document extension ecosystem rc1 operations"
```
