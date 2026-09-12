# AI 原生扩展平台 V2.1 设计规格

## 1. 产品目标

把 Nowen Note 从“支持安装插件”升级为“普通用户可以用 AI 安全创造插件”的知识工作平台，同时让主题、模板、便利操作、Office/PDF/媒体处理和未来文档类型共用一套可持续扩展的能力底座。

核心闭环：

```text
用户描述需求
→ AI 形成结构化 Plugin Spec
→ 选择稳定 Capability 与模板
→ 生成声明或 Sandbox Action
→ Validate / Build / Test / Dry-run
→ 用户确认权限并安装
→ 可选签名与发布
→ Marketplace 反馈反哺模板和 Capability
```

## 2. 成功标准

### 2.1 用户成功

- 非开发者可以用自然语言创建主题、笔记模板、Prompt Pack、Automation 和简单便利插件。
- 开发者可以查看并编辑 AI 生成的 Manifest、源码、测试和文档。
- AI 生成插件在安装前必须通过真实的 Schema、构建、Sandbox、权限与测试门禁。
- 用户始终知道插件会读取什么、修改什么、访问哪些网络服务。

### 2.2 平台成功

- Host API、SDK 类型、Capability Catalog、AI 上下文、Mock 和开发者文档来自同一合同源。
- 新插件能力采用 Registry，而不是在产品页面增加散落的类型判断。
- Marketplace Community 插件继续只运行在 `sandbox-js`；声明式插件不启动代码 Runtime。
- Plugin/Marketplace 故障不能阻塞 Nowen 启动、编辑、同步或已安装插件的离线使用。

### 2.3 生态成功

- 每种新 Capability 至少有一个官方参考插件、一个 AI 模板、一组回归测试和一篇开发文档。
- 能测量首次成功时间、生成成功率、安装启用率、7 日使用率、崩溃率和回滚率。

## 3. 不在首期范围

- 不允许插件注入任意 React、CSS、DOM、Tiptap Schema 或原生 Electron/Capacitor API。
- 不允许 AI 自动授予权限、自动切换到 `node-action`、访问发布私钥或自动发布。
- 不在首期开放完整 Word/Excel/PPT 编辑、多人 Office 协同、PPT 动画或 Excel 公式引擎。
- 不实现任意 npm 依赖安装、插件自定义构建脚本或通用 Shell。
- 不把 Plugin Studio 本身做成普通插件；它是 Developer Mode 的第一方能力。

## 4. 当前资产与缺口

### 4.1 已有资产

- Plugin API V2、Manifest V2、QuickJS/WASM Sandbox、Host API Broker、权限和 ACL。
- Ed25519 Publisher/Registry 签名、SHA-256 Artifact、Security Advisory、更新、Probation 与回滚。
- `@nowen/plugin-sdk`、`create-nowen-plugin`、`nowen-plugin` CLI、Developer Mode。
- Commands、Menus、Settings、Automation Templates 声明式贡献。
- App Appearance Registry 与受控 Semantic Token 投影。
- `frontend/src/office` 下的 OPC、DocxIR、DOCX Parser/Serializer、Word Viewer 和导出能力。

### 4.2 关键缺口

- Manifest 仍强制要求可执行 `runtime/main/actions`，不能表达纯主题或模板包。
- Contribution 类型不足，缺少 Appearance、Prompt、Note Template、Importer、Exporter 和 Document Type。
- Host API 只适合小型 JSON 调用，无法安全处理大体积二进制文件。
- 没有 Plugin Studio 项目模型、受限构建器、生成记录、Dry-run 和 AI 修复循环。
- 当前 Marketplace 更接近安装入口，缺少创作、发布、模板复用和质量反馈闭环。

### 4.3 用户场景与能力阶段

| 用户需求 | 平台形态 | 交付阶段 |
| --- | --- | --- |
| 自动整理、打标签、任务汇总、日记回顾、外部服务连接 | Sandbox Action + Command/Automation | 当前能力可扩充示例 |
| 自定义主题、笔记模板、Prompt/Agent 模板 | Declarative Contribution | R1 |
| Word 导入导出、PDF/OCR、媒体压缩、附件批处理 | File Handle + Importer/Exporter | R2 |
| Word/Excel/PPT 和第三方格式只读预览 | Document Type ViewModel | R3 |
| 完整 Office 编辑、第三方编辑器节点、任意自定义 UI | Document Edit/Isolated UI Runtime | 延期评估 |

AI Studio 必须根据这张能力表判断需求是否可生成。超出当前阶段时，应解释缺少的 Capability 并形成平台需求，不能虚构接口或退回不安全实现。

## 5. 用户与权限模型

### 5.1 用户角色

| 场景 | 创建草稿 | 试运行 | 安装/启用 | 发布 |
| --- | --- | --- | --- | --- |
| Desktop 个人实例管理员 | 是 | 是 | 是 | 显式确认后是 |
| Self-hosted 管理员 | 是 | 是 | 是 | 显式确认后是 |
| Self-hosted 普通成员 | 是 | 仅模拟数据 | 否，提交管理员审核 | 可导出待发布包 |
| Web/Mobile 首期 | 仅声明式草稿 | 声明预览 | 由管理员安装 | 否 |

插件安装继续是实例级行为；插件设置和外观选择可以是用户级。首期不引入每用户独立 Runtime，避免扩大隔离、资源和升级模型。

### 5.2 两种创作模式

**AI 快速创建**面向普通用户，只展示需求、Capability、权限、预览和结果。

**专业开发模式**展示项目文件、Manifest、源码、测试、构建日志、版本、签名和发布入口。两种模式使用同一项目格式，可以无损切换。

## 6. 总体架构

```text
                         ┌──────────────────────────┐
                         │ Capability Contract Root │
                         └─────────────┬────────────┘
                                       │ generate/check
              ┌────────────────────────┼────────────────────────┐
              ▼                        ▼                        ▼
        Host API Broker          Plugin SDK/Mock        AI Capability Catalog
              │                        │                        │
              └────────────────────────┴─────────────┬──────────┘
                                                     ▼
                                             AI Plugin Studio
                                                     │
                                      Spec → Generate → Verify
                                                     │
              ┌──────────────────────────────────────┼──────────────────────┐
              ▼                                      ▼                      ▼
     Declarative Contributions                Sandbox Actions        File/Document Jobs
              │                                      │                      │
              └──────────────────────────────────────┴──────────────┬───────┘
                                                                    ▼
                                                      Signed Package / Registry V2
```

## 7. Manifest V2.1

保持 `apiVersion: 2`，通过向后兼容字段扩展 V2；新插件使用 `engines.nowen: ">=1.6.0"`。旧 Nowen 客户端应因版本约束拒绝安装，而不是误读新贡献。

### 7.1 Runtime 联合类型

```ts
type ExecutableExtension = {
  runtime: "sandbox-js" | "node-action";
  main: string;
  actions: PluginActionManifest[];
};

type DeclarativeExtension = {
  runtime: "declarative";
  contributes: NonEmptyContributionManifest;
};
```

约束：

- `declarative` 禁止 `main/actions/events/eventHandlers/connections`，不创建执行进程。
- `sandbox-js/node-action` 维持当前 Preflight、权限和生命周期语义。
- 任一插件必须至少贡献一个 Action 或一个声明式 Contribution。
- Community Registry 永远不能用 `node-action` 绕过 Sandbox 策略。

### 7.2 Contribution 类型

首期稳定：

- `commands`
- `menus`
- `settings`
- `automationTemplates`
- `appearances`
- `noteTemplates`
- `promptPacks`

第二期实验：

- `importers`
- `exporters`
- `documentTypes`（先 Preview/Import/Export，Edit 暂不公开）

每个贡献 ID 都是插件内局部 ID，运行时键统一为 `${pluginId}/${contributionId}`，禁止覆盖内置 ID 或其他 Publisher 命名空间。

## 8. Capability Contract Root

将现有 `host-api-contract.json` 扩展为机器可读合同根，并增加：

- Host API method、version、permission、runtime、平台和输入输出预算。
- Contribution Schema、版本、平台、字段限制和示例。
- Error Code Catalog。
- Permission Catalog 与用户文案。
- Template Catalog 与适用 Capability。

生成物：

```text
Backend Broker types/guards
Plugin SDK types
Manifest Zod schema fragments
Plugin test mock
Developer Markdown docs
AI capability-catalog.json
AI prompt context digest
```

所有生成物支持 `--check`，CI 中发现漂移必须失败。AI 只能基于当前 Nowen 版本的 Catalog 生成，不允许凭训练记忆猜 API。

## 9. 声明式生态能力

### 9.1 Appearance Contribution

- 只允许覆盖 App Appearance 白名单 Semantic Token。
- Light/Dark 正交；缺失 Token 从指定内置 base 继承。
- 色值、圆角和字体类别结构化校验；禁止 CSS、URL、远程字体和脚本。
- Host 生成预览卡并负责选择、持久化、冷启动缓存和失效回退。
- 插件禁用/卸载/撤销时，当前主题立即回退默认并保留可恢复的 dormant reference。

### 9.2 Note Template Contribution

- 模板只能包含受支持的 Tiptap JSON/Markdown、标题规则、默认标签建议和占位字段。
- 模板本身无写权限；创建笔记由 Host 在用户点击后执行。
- 禁止模板内嵌远程脚本、未受控 iframe 或外部附件下载。

### 9.3 Prompt Pack Contribution

- 声明 Prompt、输入字段、适用范围、需要的上下文类型和输出模式。
- AI 密钥和 Provider 始终由 Host 管理，插件拿不到密钥。
- Prompt Pack 不自动读取笔记；用户选择上下文后 Host 才提供最小范围数据。

## 10. File Capability Broker

Office、PDF、OCR、媒体压缩和 Importer/Exporter 都依赖安全的大文件能力。不得把整个 Blob 放入当前 JSON Host Call。

### 10.1 Opaque File Handle

```ts
interface PluginFileHandle {
  id: string;
  ownerPluginId: string;
  ownerExecutionId: string;
  ownerUserId: string;
  mode: "read" | "write";
  mimeType: string;
  size: number;
  sha256?: string;
  expiresAt: string;
}
```

Handle 是能力令牌，不包含真实路径，并绑定 plugin/execution/user、读写模式、TTL 和大小预算。执行结束、取消、超时或 Host 重启时统一清理未提交 Handle。

### 10.2 Host API

```text
files.stat
files.readChunk
files.createOutput
files.writeChunk
files.commitOutput
files.discard
attachments.openFile
attachments.createFromOutput
```

- `readChunk` 单块建议不超过 128KB；`writeChunk` 受 256KB Host 参数预算约束。
- 用户在 Importer 中主动选择的文件通过 invocation-scoped Handle 授权，不等同于任意附件读取权限。
- 打开已有附件仍要求 `attachments:read`。
- 保存为附件需要真实实现 `attachments.createFromOutput` 后才向 V2 开放 `attachments:write`。
- 所有输出先写 staging，校验大小、MIME、SHA-256 和配额后原子提交。

### 10.3 文件安全

- 限制单文件、单执行、单插件和实例总 staging 配额。
- OOXML/ZIP 必须检查条目数、解压总量、单条目大小、压缩比、路径穿越和符号链接。
- 文件内容不写入普通插件日志、AI Prompt 或 Telemetry。
- 定期回收过期 Handle；启动时清理孤立 staging。

## 11. Import / Export Engine

### 11.1 Job Pipeline

```text
Select/Input
→ Preflight
→ Parse/Convert
→ Preview
→ User Confirm
→ Transactional Commit
→ Result/Download
```

Importer 输出标准 `ImportPlan`，描述待创建的笔记、笔记本、附件、警告和冲突；Host 负责 ACL、事务、进度、取消、重试和回滚。

Exporter 接收只读 `DocumentSnapshot`，输出 committed File Handle；Host 负责文件名、下载、Android/iOS 保存和审计。

插件不得直接绕过 Pipeline 写笔记、写附件或返回任意本地路径。

### 11.2 失败语义

- Preflight 失败不创建任何数据。
- Preview 与 Commit 使用 digest/version token，源数据变化后必须重新预览。
- 部分成功默认禁止；确需批量部分成功时，结果必须逐项可追踪并提供撤销批次。
- 取消和超时清理临时文件，不改变已存在文档。

## 12. Document Type Host

Document Type 是平台能力，不只是一个页面组件。

```ts
interface DocumentTypeContribution {
  id: string;
  schemaVersion: number;
  extensions: string[];
  mimeTypes: string[];
  capabilities: Array<"preview" | "import" | "export" | "edit">;
  parserAction?: string;
  serializerAction?: string;
  viewModelSchema?: string;
  platforms: Array<"web" | "desktop" | "android" | "ios">;
  limits: { maxBytes: number };
}
```

Host 拥有：

- 文档/附件身份、保存状态和生命周期。
- ACL、Workspace、同步、冲突和版本历史。
- Undo/Redo、自动保存、加载/错误/空态。
- ViewModel 校验和实际 UI 渲染。

插件拥有：

- 格式识别、Parser/Serializer。
- 格式专属命令和可选安全 ViewModel。
- 从格式模型到 Nowen ImportPlan/Export 输出的适配。

### 12.1 Office 参考实现

- 先把现有 `frontend/src/office` 整理为内部 Office Engine，稳定 OPC、DocxIR 和 Round-trip 测试。
- Word 第一阶段只作为官方 Preview/Import/Export 参考扩展，不立刻移出核心代码。
- Excel 先实现只读单 Sheet/基础样式/公式结果；PPT 先实现只读 SVG/ViewModel。
- 至少经过 Word、Excel、第三方非 Office 格式三个实现验证后，再冻结 Public Document Type SDK。

## 13. AI Plugin Studio

### 13.1 Spec-first

AI 第一步必须输出结构化 `PluginSpec`，不能直接输出代码。内容包括：

- 用户问题和验收场景。
- 插件类型与所需 Capability。
- 数据范围、权限、外部 Host 和平台。
- 输入、输出、失败语义和测试计划。
- 是否可用声明式实现；只有不足时才生成 Sandbox Action。

“支持 Office”必须拆分为 attach/open、preview、import、export、edit、collaboration 六级能力，由用户确认范围。

### 13.2 受限项目模型

Studio 项目存放在独立 `plugin-projects` 根目录，不直接写 `plugins/installed` 或 `plugins-dev`。项目只允许白名单文件：

```text
plugin-spec.json
manifest.json
src/index.ts
tests/*.test.ts
README.md
CHANGELOG.md
assets/*（受 MIME/大小限制）
```

所有路径通过 canonical root 校验；禁止绝对路径、`..`、符号链接和越界写入。

### 13.3 固定工具链

- 不执行模型生成的 Shell、package scripts 或 `npm install`。
- 使用 Nowen 内置 TypeScript、Bundler、SDK、Test Harness 和 Sandbox Runner。
- 依赖只允许 `@nowen/plugin-sdk` 和版本化 allowlist；首期建议零第三方依赖。
- 生成、构建、测试和修复均记录输入摘要、Catalog 版本、模型信息、结果和错误码，但不记录用户正文或 Secret。

### 13.4 自动修复循环

```text
Generate
→ Type Check
→ Manifest Validate
→ Contract Test
→ Sandbox Test
→ Permission Audit
→ Package Validate
→ Failure summary returned to AI
→ Patch only failed files
```

最多三轮自动修复；仍失败则停在可检查状态，不得通过降低测试、扩大权限或切换 Node Runtime“修复”。

### 13.5 安装与发布

- 安装前展示 Manifest Diff、权限、网络域名、测试报告和生成来源。
- 用户明确确认后，Studio 调用现有安装/Preflight 流程，不能直接写 Registry DB。
- 发布由用户显式触发，Publisher 私钥只由 CLI/CI 签名层使用，AI 和 Studio 服务拿不到私钥明文。
- AI 生成标识放在 Registry 发布元数据中，用于审核与统计，不作为低信任标签或自动拒绝理由。

## 14. 数据模型

使用下一个可用 SQLite migration 版本和对应 PostgreSQL DDL；实施时先读取 `CURRENT_SCHEMA_VERSION`，不得预先猜测版本号。

新增概念表：

- `plugin_studio_projects`：项目、Owner、模式、状态、目标 API/Nowen 版本。
- `plugin_studio_generations`：Spec/Generate/Fix 运行、Catalog digest、模型和结果摘要。
- `plugin_studio_artifacts`：构建产物 digest、验证报告和过期时间，不保存发布私钥。
- `plugin_file_handles`：Opaque Handle 元数据；真实 staging 路径仅服务端可见。
- `plugin_file_jobs`：Importer/Exporter 状态、进度、preview digest、结果和错误码。
- `plugin_contribution_cache`：已启用声明贡献的规范化缓存和 manifest checksum。

用户主题选择、自定义 Token、Prompt Pack 偏好进入用户偏好同步；插件安装和项目构建产物不自动进入多端用户偏好。

## 15. 生命周期与兼容

- 安装/升级时验证全部 Contribution；任一声明非法则整个版本 Preflight 失败。
- 禁用、卸载、回滚、安全撤销会原子撤销对应 Contribution。
- 当前正在使用的主题、模板或 Document Type 失效时，Host 使用明确 fallback，不保留悬空运行状态。
- API V1/V2 既有插件行为不改变；新 V2.1 Contribution 通过 `engines.nowen` 隔离旧客户端。
- Contribution Schema 独立版本化；新增 Token/字段优先使用继承与默认值，避免迫使所有插件同步升级。

## 16. UI/UX

### 16.1 扩展中心

保留“已安装 / 市场 / 更新与安全 / 开发者”，在开发者页增加“使用 AI 创建插件”。插件详情展示：

- 来源、Publisher、签名、Runtime、平台。
- Contributions 与 Actions。
- 权限、网络域名和更新差异。
- 测试/Preflight、最近错误、回滚和安全公告。

### 16.2 Studio

- 左：需求对话和范围确认。
- 中：Plugin Spec、文件与 Diff。
- 右：权限、测试、预览、构建和 Sandbox 日志。
- 小屏使用分步流程，不在 Mobile 首期提供代码编辑或本地构建。

### 16.3 Host-owned UI

主题预览、模板表单、Importer Preview、Exporter Download、权限确认和错误状态都由 Nowen 渲染。插件只能提供受 Schema 限制的数据，确保 App Appearance、键盘、无障碍和移动端一致。

## 17. 威胁模型

必须覆盖：

- AI 生成恶意或过度权限代码。
- 用户 Prompt 或现有插件文件中的 Prompt Injection。
- ZIP Bomb、路径穿越、符号链接和伪造 MIME。
- File Handle 越权、跨执行复用、过期重放和 staging 泄漏。
- Sandbox 逃逸、Host Call 超限、内存/CPU DoS。
- 外部网络 SSRF、重定向和 DNS Rebinding。
- Marketplace 包替换、签名降级、撤销绕过。
- AI 日志、Telemetry、构建报告泄露正文、Token 或 Secret。

所有拒绝使用稳定错误码；日志只记录 project/plugin/execution/job/correlation 与结构化原因，不记录用户内容和二进制正文。

## 18. 发布阶段

### R1：Declarative Ecosystem + Studio Alpha

- Capability Catalog。
- `declarative` Runtime。
- Appearance、Note Template、Prompt Pack。
- AI Spec、声明式生成、预览和本地安装。
- 简单 Sandbox Action 生成与测试。

### R2：File Processing + Import/Export

- Opaque File Handle。
- Importer/Exporter Contribution 与 Job Pipeline。
- Office-to-Note、Note-to-DOCX 官方参考插件。
- PDF/OCR/媒体类插件具备同一入口。

### R3：Document Type Preview

- Internal Document Type Registry。
- Word/Excel/PPT 只读 ViewModel。
- 跨平台 Preview、缓存、错误和大文件门禁。
- Public API 仍标记 Experimental。

### R4：Ecosystem GA

- 经三个真实文档类型验证后冻结稳定 SDK。
- Marketplace 模板复用、质量指标、审核和兼容矩阵。
- 评估受限自定义 Panel 与 Document Edit API；不默认承诺开放。

## 19. 测试与发布门禁

### 自动化

- Manifest/Contribution Schema 单元测试和兼容矩阵。
- Capability 生成物漂移检查。
- Sandbox 攻击矩阵和 Permission Contract。
- File Handle 越权、TTL、配额、崩溃清理和 ZIP Bomb 测试。
- Import Preview/Commit 版本变化、取消、部分失败和回滚测试。
- Appearance 冷启动、缺失插件和禁用回退测试。
- AI 生成 Golden Spec、Build/Fix 上限和禁止降级测试。
- Office Corpus、Round-trip、损坏 OOXML 和大文件性能测试。

### 真实验收

- Web、Electron、Android、iOS 的声明式插件消费。
- Desktop Studio 从一句需求到安装成功。
- 多用户服务器中成员创建草稿、管理员审核安装。
- Registry 离线、插件撤销、更新回滚和设备缺插件行为。
- Word/Excel/PPT 真实样本在 Microsoft Office、WPS、LibreOffice 交叉打开。

## 20. 产品指标

- `time_to_first_successful_plugin`
- `spec_confirmation_rate`
- `first_build_pass_rate`
- `auto_fix_success_rate`
- `install_enable_conversion`
- `permission_abandon_rate`
- `plugin_7d_active_rate`
- `sandbox_failure_rate`
- `automatic_rollback_rate`
- `draft_to_publish_conversion`
- `template_reuse_count`

Telemetry 继续遵守固定白名单和可关闭原则，不上传 Prompt、代码、笔记内容、Action 输入输出、附件名或 Secret。

## 21. 固定决策与延期决策

### 固定决策

- Plugin Studio 是第一方 Developer Mode 能力。
- Community AI 插件只生成 `declarative` 或 `sandbox-js`。
- AI 先生成 Spec，后生成代码。
- 不开放任意 UI/CSS/DOM/Shell/npm install。
- Office 先复用内部 IR 并作为平台参考实现，不由 AI 从零重写。
- 插件数据能力必须通过 Host API/Job/Handle，不提供数据库或真实文件路径。

### 延期决策

- 每用户独立插件 Runtime。
- 云端代码构建。
- 第三方 React Panel。
- Public Document Edit API。
- Excel 完整公式/图表与 PPT 动画。
